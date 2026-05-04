import { describe, expect, it } from 'vitest';
import { DocumentChunker } from '../../../src/parsers/chunker.js';
import type { FileJob, ParsedDocument } from '../../../src/shared/types.js';

function makeJob(): FileJob {
  return {
    id: 'doc-1',
    filePath: '/tmp/x.pdf',
    relativePath: 'x.pdf',
    fileType: 'pdf',
    contentHash: 'h',
    fileSizeBytes: 100,
    createdAt: new Date(),
    modifiedAt: new Date(),
    priority: 0,
  };
}

function makeParsed(sections: ParsedDocument['sections']): ParsedDocument {
  return {
    sourceFile: makeJob(),
    sections,
    tables: [],
    images: [],
    metadata: { wordCount: 0, customProperties: {} },
  };
}

describe('DocumentChunker', () => {
  it('emits a single chunk for a tiny document', () => {
    const parsed = makeParsed([
      {
        heading: null,
        headingLevel: 0,
        content: 'A short paragraph that is well below the limit.',
        children: [],
        pageNumber: 1,
      },
    ]);
    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const chunks = chunker.chunk(parsed);
    expect(chunks).toHaveLength(1);
    const c = chunks[0];
    if (!c) throw new Error('chunk missing');
    expect(c.metadata.isFirstInSection).toBe(true);
    expect(c.metadata.isLastInSection).toBe(true);
    expect(c.pageNumbers).toEqual([1]);
    expect(c.chunkType).toBe('text');
  });

  it('captures heading hierarchy on every chunk', () => {
    const parsed = makeParsed([
      {
        heading: 'Chapter 1',
        headingLevel: 1,
        content: 'Chapter 1',
        children: [],
      },
      {
        heading: 'Section A',
        headingLevel: 2,
        content: 'Section A',
        children: [],
      },
      {
        heading: null,
        headingLevel: 0,
        content: 'Some paragraph content under chapter 1, section A.',
        children: [],
      },
      {
        heading: 'Chapter 2',
        headingLevel: 1,
        content: 'Chapter 2',
        children: [],
      },
      {
        heading: null,
        headingLevel: 0,
        content: 'Different paragraph in chapter 2.',
        children: [],
      },
    ]);
    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const chunks = chunker.chunk(parsed);
    expect(chunks).toHaveLength(2);
    const first = chunks[0];
    const second = chunks[1];
    if (!first || !second) throw new Error('chunk missing');
    expect(first.headingHierarchy).toEqual(['Chapter 1', 'Section A']);
    expect(second.headingHierarchy).toEqual(['Chapter 2']);
  });

  it('respects targetTokens budget within ±30%', () => {
    // Build many small paragraphs to force chunk splits.
    const sections = Array.from({ length: 30 }, (_, i) => ({
      heading: null,
      headingLevel: 0,
      content: `paragraph number ${i} containing about forty characters of content.`,
      children: [],
    }));
    const parsed = makeParsed(sections);
    const chunker = new DocumentChunker({ targetTokens: 100, overlapTokens: 10 });
    const chunks = chunker.chunk(parsed);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(130);
    }
  });

  it('produces strictly increasing sequence indices', () => {
    const parsed = makeParsed(
      Array.from({ length: 10 }, (_, i) => ({
        heading: null,
        headingLevel: 0,
        content: `paragraph ${i} `.repeat(20),
        children: [],
      }))
    );
    const chunker = new DocumentChunker({ targetTokens: 100, overlapTokens: 10 });
    const chunks = chunker.chunk(parsed);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      if (!prev || !cur) throw new Error('chunk missing');
      expect(cur.sequenceIndex).toBe(prev.sequenceIndex + 1);
    }
  });

  it('emits a table chunk for tab-delimited content', () => {
    const parsed = makeParsed([
      {
        heading: null,
        headingLevel: 0,
        content: 'col1\tcol2\nval1\tval2\nval3\tval4',
        children: [],
      },
    ]);
    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const chunks = chunker.chunk(parsed);
    expect(chunks).toHaveLength(1);
    const c = chunks[0];
    if (!c) throw new Error('chunk missing');
    expect(c.chunkType).toBe('table');
  });

  it('rejects bogus options', () => {
    expect(() => new DocumentChunker({ targetTokens: 0, overlapTokens: 0 })).toThrow();
    expect(() => new DocumentChunker({ targetTokens: 100, overlapTokens: 100 })).toThrow();
  });
});
