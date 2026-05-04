// Per-run + per-document budget controller. Wraps every LLM call. The
// controller is injected into the extractor, resolver, and embedding generator
// (all of which call recordCall after each LLM response). When a budget is
// exceeded, shouldHalt() returns true and consumers stop accepting new work.
//
// Pricing comes from a TOML file (config/pricing.toml). Missing entries log a
// warning and are treated as zero — a stale table should not crash a run.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ConfigError } from '../shared/errors.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger('extraction.cost');

export type CallType = 'extraction' | 'resolution' | 'embedding' | 'description';

export interface CallRecord {
  callType: CallType;
  model: string;
  documentId: string | null;
  chunkId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  at: number;
}

export interface CostControllerOptions {
  pricingPath: string;
  budgetPerRunUsd?: number;
  budgetPerDocumentUsd?: number;
  warnAtFraction?: number; // default 0.80
  // Allow continuing past the per-run budget (CLI --continue-over-budget).
  continueOverBudget?: boolean;
}

export interface PricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
}

const STALE_PRICING_DAYS = 90;

interface RunningTotals {
  totalUsd: number;
  byModel: Map<string, number>;
  byCallType: Map<CallType, number>;
  byDocument: Map<string, number>;
  callCount: number;
  // Quick approximate counters for averages.
  chunkExtractionCalls: number;
  entityResolutionCalls: number;
}

export class CostController {
  private readonly pricing: Map<string, PricingEntry>;
  private readonly missingModels = new Set<string>();
  private readonly opts: CostControllerOptions;
  private readonly totals: RunningTotals = {
    totalUsd: 0,
    byModel: new Map(),
    byCallType: new Map(),
    byDocument: new Map(),
    callCount: 0,
    chunkExtractionCalls: 0,
    entityResolutionCalls: 0,
  };
  private readonly calls: CallRecord[] = [];
  private warned = false;
  private halted = false;

  constructor(opts: CostControllerOptions) {
    this.opts = opts;
    this.pricing = loadPricing(opts.pricingPath);
  }

  // Static factory: keeps the constructor cheap.
  static fromConfig(opts: CostControllerOptions): CostController {
    return new CostController(opts);
  }

  recordCall(input: {
    callType: CallType;
    model: string;
    inputTokens: number;
    outputTokens: number;
    documentId?: string | null;
    chunkId?: string | null;
  }): CallRecord {
    const entry = this.pricing.get(input.model);
    let costUsd = 0;
    if (entry) {
      costUsd =
        (input.inputTokens / 1_000_000) * entry.inputPerMillion +
        (input.outputTokens / 1_000_000) * entry.outputPerMillion;
    } else if (!this.missingModels.has(input.model)) {
      log.warn(
        { model: input.model, callType: input.callType },
        'cost.missing_pricing_entry_treating_as_zero'
      );
      this.missingModels.add(input.model);
    }

    const record: CallRecord = {
      callType: input.callType,
      model: input.model,
      documentId: input.documentId ?? null,
      chunkId: input.chunkId ?? null,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd,
      at: Date.now(),
    };
    this.calls.push(record);
    this.totals.totalUsd += costUsd;
    this.totals.byModel.set(input.model, (this.totals.byModel.get(input.model) ?? 0) + costUsd);
    this.totals.byCallType.set(
      input.callType,
      (this.totals.byCallType.get(input.callType) ?? 0) + costUsd
    );
    if (input.documentId) {
      this.totals.byDocument.set(
        input.documentId,
        (this.totals.byDocument.get(input.documentId) ?? 0) + costUsd
      );
    }
    this.totals.callCount++;
    if (input.callType === 'extraction') this.totals.chunkExtractionCalls++;
    if (input.callType === 'resolution') this.totals.entityResolutionCalls++;
    this.evaluateBudget();
    return record;
  }

  shouldHalt(): boolean {
    if (this.opts.continueOverBudget) return false;
    return this.halted;
  }

  // Per-document budget check. Returns true if processing should stop for the
  // given document. Soft ceiling — the per-doc budget is informational unless
  // the per-run budget triggers the hard stop above.
  isDocumentOverBudget(documentId: string): boolean {
    if (!this.opts.budgetPerDocumentUsd) return false;
    return (this.totals.byDocument.get(documentId) ?? 0) >= this.opts.budgetPerDocumentUsd;
  }

  // Snapshot of running totals.
  snapshot(): {
    totalUsd: number;
    byModel: Record<string, number>;
    byCallType: Record<string, number>;
    byDocument: Record<string, number>;
    callCount: number;
  } {
    return {
      totalUsd: this.totals.totalUsd,
      byModel: Object.fromEntries(this.totals.byModel),
      byCallType: Object.fromEntries(this.totals.byCallType),
      byDocument: Object.fromEntries(this.totals.byDocument),
      callCount: this.totals.callCount,
    };
  }

  // End-of-run summary, intended to be logged via pino.
  reportSummary(): {
    totalUsd: number;
    callCount: number;
    byModel: Record<string, number>;
    byCallType: Record<string, number>;
    topDocuments: { documentId: string; costUsd: number }[];
    avgCostPerExtractionCall: number;
    avgCostPerResolutionCall: number;
  } {
    const byDoc = [...this.totals.byDocument.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([documentId, costUsd]) => ({ documentId, costUsd }));

    return {
      totalUsd: this.totals.totalUsd,
      callCount: this.totals.callCount,
      byModel: Object.fromEntries(this.totals.byModel),
      byCallType: Object.fromEntries(this.totals.byCallType),
      topDocuments: byDoc,
      avgCostPerExtractionCall:
        this.totals.chunkExtractionCalls > 0
          ? (this.totals.byCallType.get('extraction') ?? 0) / this.totals.chunkExtractionCalls
          : 0,
      avgCostPerResolutionCall:
        this.totals.entityResolutionCalls > 0
          ? (this.totals.byCallType.get('resolution') ?? 0) / this.totals.entityResolutionCalls
          : 0,
    };
  }

  // For SQLite processing_log writes.
  costForDocument(documentId: string): number {
    return this.totals.byDocument.get(documentId) ?? 0;
  }

  private evaluateBudget(): void {
    const cap = this.opts.budgetPerRunUsd;
    if (!cap) return;
    const fraction = this.totals.totalUsd / cap;
    const warnAt = this.opts.warnAtFraction ?? 0.8;
    if (!this.warned && fraction >= warnAt && fraction < 1) {
      this.warned = true;
      log.warn(
        { totalUsd: this.totals.totalUsd, capUsd: cap, fraction },
        'cost.budget_warning'
      );
    }
    if (fraction >= 1 && !this.halted) {
      this.halted = true;
      log.error(
        { totalUsd: this.totals.totalUsd, capUsd: cap },
        'cost.budget_exceeded_halting'
      );
    }
  }
}

interface PricingFile {
  models?: Record<string, { input_per_million?: number; output_per_million?: number }>;
}

function loadPricing(path: string): Map<string, PricingEntry> {
  const abs = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new ConfigError(`Failed to read pricing file: ${abs}`, { path: abs }, e);
  }
  const parsed = parseToml(raw) as PricingFile;
  const out = new Map<string, PricingEntry>();
  for (const [model, entry] of Object.entries(parsed.models ?? {})) {
    out.set(model, {
      inputPerMillion: entry.input_per_million ?? 0,
      outputPerMillion: entry.output_per_million ?? 0,
    });
  }
  // Stale-pricing warning. mtime-based; a sloppy git pull resets mtime so this
  // is best-effort but useful for "we forgot to update pricing for a year".
  try {
    const stats = statSync(abs);
    const ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays > STALE_PRICING_DAYS) {
      log.warn(
        { ageDays: Math.round(ageDays), path: abs },
        'cost.pricing_table_may_be_stale'
      );
    }
  } catch {
    // ignore stat errors — already loaded the file
  }
  return out;
}
