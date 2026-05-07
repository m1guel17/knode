// Per-document and per-run cost summaries. The plugin reads from the
// cost controller via injection (so it isn't tied to a global). On
// onDocumentCompleted it logs the per-document spend; on onRunCompleted it
// logs the full report.

import type { CostController } from '../extraction/cost-controller.js';
import type { Logger } from 'pino';
import { createChildLogger } from '../shared/logger.js';
import type {
  OnDocumentCompletedCtx,
  OnRunCompletedCtx,
  PipelinePlugin,
} from './interfaces.js';

export interface CostReporterOptions {
  costController: CostController;
  logger?: Logger;
}

export class CostReporterPlugin implements PipelinePlugin {
  readonly name = 'cost-reporter';
  private readonly cc: CostController;
  private readonly logger: Logger;

  constructor(opts: CostReporterOptions) {
    this.cc = opts.costController;
    this.logger = opts.logger ?? createChildLogger('plugins.cost-reporter');
  }

  async onDocumentCompleted(ctx: OnDocumentCompletedCtx): Promise<void> {
    if (!ctx.stats.documentId) return;
    const costUsd = this.cc.costForDocument(ctx.stats.documentId);
    this.logger.info(
      {
        filePath: ctx.job.filePath,
        documentId: ctx.stats.documentId,
        costUsd: round(costUsd, 6),
        chunkCount: ctx.stats.chunkCount,
        entityCount: ctx.stats.entityCount,
      },
      'cost_reporter.document_done'
    );
  }

  async onRunCompleted(ctx: OnRunCompletedCtx): Promise<void> {
    const summary = this.cc.reportSummary();
    this.logger.info(
      {
        documentsProcessed: ctx.documentsProcessed,
        totalDurationMs: ctx.totalDurationMs,
        ...summary,
      },
      'cost_reporter.run_complete'
    );
  }
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
