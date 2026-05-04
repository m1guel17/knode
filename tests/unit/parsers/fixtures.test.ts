// Smoke tests for the actual fixture files. These exercise the real parsers
// but don't require Docker.

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocumentChunker, buildDefaultRegistry } from '../../../src/parsers/index.js';
import { classifyFile } from '../../../src/scanner/index.js';

const FIXTURE_PDF = resolve(__dirname, '..', '..', 'fixtures', 'sample.pdf');
const FIXTURE_DOCX = resolve(__dirname, '..', '..', 'fixtures', 'sample.docx');
const FIXTURE_XLSX = resolve(__dirname, '..', '..', 'fixtures', 'sample.xlsx');
const FIXTURE_PPTX = resolve(__dirname, '..', '..', 'fixtures', 'sample.pptx');

describe('fixture parsing', () => {
  it('parses sample.pdf into multiple sections with content', async () => {
    const job = await classifyFile(FIXTURE_PDF);
    const parser = buildDefaultRegistry().getParserFor(job);
    const parsed = await parser.parse(job);
    expect(parsed.sections.length).toBeGreaterThan(0);
    expect(parsed.metadata.pageCount).toBeGreaterThanOrEqual(2);
    expect(parsed.metadata.wordCount).toBeGreaterThan(20);
    // At least one paragraph mentions Acme Corp.
    const text = parsed.sections.map((s) => s.content).join(' ');
    expect(text).toContain('Acme Corp');
  });

  it('parses sample.docx with at least one heading', async () => {
    const job = await classifyFile(FIXTURE_DOCX);
    const parser = buildDefaultRegistry().getParserFor(job);
    const parsed = await parser.parse(job);
    expect(parsed.sections.some((s) => (s.headingLevel ?? 0) > 0)).toBe(true);
    const text = parsed.sections.map((s) => s.content).join(' ');
    expect(text).toContain('Acme Corp');
  });

  it('parses sample.xlsx — distinguishes data table from report', async () => {
    const job = await classifyFile(FIXTURE_XLSX);
    const parser = buildDefaultRegistry().getParserFor(job);
    const parsed = await parser.parse(job);
    expect(parsed.sections.length).toBeGreaterThan(0);
    // Two sheets → both worksheet headings appear.
    const headings = parsed.sections
      .filter((s) => s.headingLevel > 0)
      .map((s) => s.heading);
    expect(headings).toContain('Q3 Sales');
    expect(headings).toContain('Summary');
    // Data table mode emits a "contains N rows with columns" summary.
    const text = parsed.sections.map((s) => s.content).join(' ');
    expect(text).toMatch(/rows with columns/);
    // Report mode preserves Acme Corp as text.
    expect(text).toContain('Acme Corp');
  });

  it('parses sample.pptx — title heading per slide + speaker notes appended', async () => {
    const job = await classifyFile(FIXTURE_PPTX);
    const parser = buildDefaultRegistry().getParserFor(job);
    const parsed = await parser.parse(job);
    const headings = parsed.sections
      .filter((s) => s.headingLevel > 0)
      .map((s) => s.heading);
    expect(headings.length).toBeGreaterThanOrEqual(3);
    const text = parsed.sections.map((s) => s.content).join(' ');
    expect(text).toContain('Acme Corp');
    // Speaker notes delimiter present.
    expect(text).toContain('SPEAKER NOTES');
  });

  it('chunker produces non-empty chunks for all fixtures', async () => {
    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const registry = buildDefaultRegistry();

    for (const path of [FIXTURE_PDF, FIXTURE_DOCX, FIXTURE_XLSX, FIXTURE_PPTX]) {
      const job = await classifyFile(path);
      const parsed = await registry.getParserFor(job).parse(job);
      const chunks = chunker.chunk(parsed);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.content.trim().length).toBeGreaterThan(0);
        expect(c.tokenEstimate).toBeGreaterThan(0);
      }
    }
  });
});
