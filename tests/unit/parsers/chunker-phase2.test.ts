// Phase 2 chunker behaviors: heading hierarchy through nested sections, table
// chunking, sentence-boundary fallback, deterministic IDs, isFirstInSection /
// isLastInSection metadata.

import { describe, expect, it } from 'vitest';
import { DocumentChunker } from '../../../src/parsers/chunker.js';
import type { FileJob, ParsedDocument } from '../../../src/shared/types.js';

function job(): FileJob {
  return {
    id: 'doc-fixed',
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

function parsed(sections: ParsedDocument['sections']): ParsedDocument {
  return {
    sourceFile: job(),
    sections,
    tables: [],
    images: [],
    metadata: { wordCount: 0, customProperties: {} },
  };
}

describe('Phase 2 chunker', () => {
  it('builds heading hierarchy for 3-level nested sections', () => {
    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const chunks = chunker.chunk(
      parsed([
        { heading: 'Chapter 3', headingLevel: 1, content: 'Chapter 3', children: [] },
        { heading: 'Section 3.2', headingLevel: 2, content: 'Section 3.2', children: [] },
        {
          heading: 'Revenue Analysis',
          headingLevel: 3,
          content: 'Revenue Analysis',
          children: [],
        },
        { heading: null, headingLevel: 0, content: 'Revenue grew 10% year-over-year.', children: [] },
      ])
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingHierarchy).toEqual([
      'Chapter 3',
      'Section 3.2',
      'Revenue Analysis',
    ]);
  });

  it('never bleeds across sections — each section gets its own chunk', () => {
    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const chunks = chunker.chunk(
      parsed([
        { heading: 'Section 3.2.1', headingLevel: 3, content: 'Section 3.2.1', children: [] },
        { heading: null, headingLevel: 0, content: 'A in 3.2.1.', children: [] },
        { heading: 'Section 3.3', headingLevel: 3, content: 'Section 3.3', children: [] },
        { heading: null, headingLevel: 0, content: 'B in 3.3.', children: [] },
      ])
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.content).toContain('A in 3.2.1.');
    expect(chunks[0]?.content).not.toContain('B in 3.3.');
    expect(chunks[1]?.content).toContain('B in 3.3.');
  });

  it('emits tables as their own chunks regardless of section context', () => {
    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const chunks = chunker.chunk(
      parsed([
        { heading: 'Section', headingLevel: 1, content: 'Section', children: [] },
        { heading: null, headingLevel: 0, content: 'preamble before table.', children: [] },
        {
          heading: null,
          headingLevel: 0,
          content: 'col1\tcol2\nval1\tval2\nval3\tval4',
          children: [],
        },
        { heading: null, headingLevel: 0, content: 'postamble after table.', children: [] },
      ])
    );
    const tableChunks = chunks.filter((c) => c.chunkType === 'table');
    expect(tableChunks).toHaveLength(1);
    expect(tableChunks[0]?.content).toContain('col1\tcol2');
  });

  it('falls back to sentence boundaries for an oversized paragraph', () => {
    const sentence = 'This is a sentence about something interesting that adds tokens. ';
    const big = sentence.repeat(40); // way over target
    const chunker = new DocumentChunker({ targetTokens: 50, overlapTokens: 5 });
    const chunks = chunker.chunk(
      parsed([{ heading: null, headingLevel: 0, content: big, children: [] }])
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThan(80); // small target ± room for overlap
    }
  });

  it('produces deterministic chunk IDs for the same input (cacheable)', () => {
    const chunker = new DocumentChunker({ targetTokens: 200, overlapTokens: 20 });
    const input = parsed([
      { heading: 'A', headingLevel: 1, content: 'A', children: [] },
      { heading: null, headingLevel: 0, content: 'first paragraph here.', children: [] },
      { heading: null, headingLevel: 0, content: 'second paragraph here.', children: [] },
    ]);
    const a = chunker.chunk(input);
    const b = chunker.chunk(input);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]?.id).toBe(b[i]?.id);
      expect(a[i]?.content).toBe(b[i]?.content);
    }
  });

  it('flags isFirstInSection and isLastInSection correctly', () => {
    const chunker = new DocumentChunker({ targetTokens: 50, overlapTokens: 5 });
    // Two sections, each with multiple paragraphs that overflow the 50-token target.
    const chunks = chunker.chunk(
      parsed([
        { heading: 'Sec A', headingLevel: 1, content: 'Sec A', children: [] },
        { heading: null, headingLevel: 0, content: 'a '.repeat(40), children: [] },
        { heading: null, headingLevel: 0, content: 'b '.repeat(40), children: [] },
        { heading: 'Sec B', headingLevel: 1, content: 'Sec B', children: [] },
        { heading: null, headingLevel: 0, content: 'c '.repeat(40), children: [] },
        { heading: null, headingLevel: 0, content: 'd '.repeat(40), children: [] },
      ])
    );
    const secA = chunks.filter((c) => c.metadata.sectionTitle === 'Sec A');
    const secB = chunks.filter((c) => c.metadata.sectionTitle === 'Sec B');
    expect(secA[0]?.metadata.isFirstInSection).toBe(true);
    expect(secA.at(-1)?.metadata.isLastInSection).toBe(true);
    expect(secB[0]?.metadata.isFirstInSection).toBe(true);
    expect(secB.at(-1)?.metadata.isLastInSection).toBe(true);
  });

  it('prepends heading hierarchy to text only when sent to extractor (not stored)', () => {
    // The chunker stores heading hierarchy separately; pipeline.ts is what
    // prepends to the extractor input. This test asserts the storage shape.
    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const chunks = chunker.chunk(
      parsed([
        { heading: 'Chapter', headingLevel: 1, content: 'Chapter', children: [] },
        { heading: null, headingLevel: 0, content: 'paragraph body only.', children: [] },
      ])
    );
    expect(chunks[0]?.content).toBe('paragraph body only.');
    expect(chunks[0]?.headingHierarchy).toEqual(['Chapter']);
  });
});
