import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CostController } from '../../../src/extraction/cost-controller.js';

function writePricing(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'knode-pricing-'));
  const file = join(dir, 'pricing.toml');
  writeFileSync(file, content);
  return file;
}

const PRICING = `
[models."test-model-cheap"]
input_per_million = 1.00
output_per_million = 2.00

[models."test-model-expensive"]
input_per_million = 10.00
output_per_million = 50.00
`;

describe('CostController', () => {
  it('records calls and computes USD costs', () => {
    const path = writePricing(PRICING);
    const c = new CostController({ pricingPath: path });
    const rec = c.recordCall({
      callType: 'extraction',
      model: 'test-model-cheap',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    // 1M input * 1.00 + 0.5M output * 2.00 = 2.00
    expect(rec.costUsd).toBeCloseTo(2.0);
    expect(c.snapshot().totalUsd).toBeCloseTo(2.0);
  });

  it('treats missing pricing as zero with a warning (no throw)', () => {
    const path = writePricing(PRICING);
    const c = new CostController({ pricingPath: path });
    const rec = c.recordCall({
      callType: 'embedding',
      model: 'unknown-model',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(rec.costUsd).toBe(0);
  });

  it('halts when per-run budget is exceeded', () => {
    const path = writePricing(PRICING);
    const c = new CostController({ pricingPath: path, budgetPerRunUsd: 1.0 });
    expect(c.shouldHalt()).toBe(false);
    c.recordCall({
      callType: 'extraction',
      model: 'test-model-expensive',
      inputTokens: 100_000,
      outputTokens: 0,
    });
    // 0.1M * 10 = 1.00 → halts
    expect(c.shouldHalt()).toBe(true);
  });

  it('does not halt when continueOverBudget is set', () => {
    const path = writePricing(PRICING);
    const c = new CostController({
      pricingPath: path,
      budgetPerRunUsd: 0.0001,
      continueOverBudget: true,
    });
    c.recordCall({
      callType: 'extraction',
      model: 'test-model-expensive',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(c.shouldHalt()).toBe(false);
  });

  it('reports per-document and per-model breakdowns', () => {
    const path = writePricing(PRICING);
    const c = new CostController({ pricingPath: path });
    c.recordCall({
      callType: 'extraction',
      model: 'test-model-cheap',
      inputTokens: 1_000_000,
      outputTokens: 0,
      documentId: 'doc-A',
    });
    c.recordCall({
      callType: 'resolution',
      model: 'test-model-expensive',
      inputTokens: 100_000,
      outputTokens: 0,
      documentId: 'doc-A',
    });
    c.recordCall({
      callType: 'extraction',
      model: 'test-model-cheap',
      inputTokens: 500_000,
      outputTokens: 0,
      documentId: 'doc-B',
    });
    const summary = c.reportSummary();
    expect(summary.totalUsd).toBeCloseTo(2.5);
    expect(summary.byModel['test-model-cheap']).toBeCloseTo(1.5);
    expect(summary.byModel['test-model-expensive']).toBeCloseTo(1.0);
    expect(summary.byCallType.extraction).toBeCloseTo(1.5);
    expect(summary.byCallType.resolution).toBeCloseTo(1.0);
    expect(summary.topDocuments[0]?.documentId).toBe('doc-A');
  });
});
