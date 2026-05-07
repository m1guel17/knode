import { describe, expect, it } from 'vitest';
import { DomainTaggerPlugin } from '../../../src/plugins/index.js';
import type { FileJob, ParsedDocument } from '../../../src/shared/types.js';

function makeCtx(relativePath: string) {
  const job: FileJob = {
    id: 'j',
    filePath: `/abs/${relativePath}`,
    relativePath,
    fileType: 'pdf',
    contentHash: 'h',
    fileSizeBytes: 1,
    createdAt: new Date(0),
    modifiedAt: new Date(0),
    priority: 1,
  };
  const parsed: ParsedDocument = {
    sourceFile: job,
    sections: [],
    tables: [],
    images: [],
    metadata: { wordCount: 0, customProperties: {} },
  };
  return { job, parsed };
}

describe('DomainTaggerPlugin', () => {
  it('tags documents by glob match', async () => {
    const plugin = new DomainTaggerPlugin({
      pathPatterns: {
        'finance/**': 'finance',
        'legal/**': 'legal',
      },
    });
    const ctx = makeCtx('finance/q3.pdf');
    const out = await plugin.onDocumentParsed(ctx);
    expect(out).toBeTruthy();
    expect(out?.metadata.customProperties.domain).toBe('finance');
  });

  it('returns void when no pattern matches', async () => {
    const plugin = new DomainTaggerPlugin({
      pathPatterns: { 'finance/**': 'finance' },
    });
    const ctx = makeCtx('marketing/intro.pdf');
    const out = await plugin.onDocumentParsed(ctx);
    expect(out).toBeUndefined();
  });

  it('respects insertion order — first match wins', async () => {
    const plugin = new DomainTaggerPlugin({
      pathPatterns: {
        '**/*.pdf': 'all-pdf',
        'finance/**': 'finance',
      },
    });
    const ctx = makeCtx('finance/q3.pdf');
    const out = await plugin.onDocumentParsed(ctx);
    expect(out?.metadata.customProperties.domain).toBe('all-pdf');
  });

  it('handles single-star (single segment) globs', async () => {
    const plugin = new DomainTaggerPlugin({
      pathPatterns: { 'reports/*.pdf': 'reports' },
    });
    expect(
      (await plugin.onDocumentParsed(makeCtx('reports/q3.pdf')))?.metadata.customProperties.domain
    ).toBe('reports');
    // Nested path should not match a single * (should fall through to no-match).
    const out = await plugin.onDocumentParsed(makeCtx('reports/subdir/q3.pdf'));
    expect(out).toBeUndefined();
  });
});
