// pdf-parse adapter. Phase 1 heading detection is intentionally minimal —
// short lines with no terminal punctuation followed by a blank line. Font-size
// analysis lands in Phase 2.

import { readFile } from 'node:fs/promises';
// pdf-parse@1.1.1 has a debug code path in index.js that tries to read a
// fixture file at import time and crashes if it isn't present. Importing the
// inner lib bypasses that.
// @ts-expect-error — no published types for the lib path
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { ParserError } from '../../shared/errors.js';
import type {
  DocumentMetadata,
  DocumentSection,
  FileJob,
  ParsedDocument,
  ParserType,
} from '../../shared/types.js';
import type { DocumentParser } from '../interfaces.js';

const HEADING_MAX_LEN = 80;

function isHeadingCandidate(line: string, nextLine: string | undefined): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > HEADING_MAX_LEN) return false;
  // Followed by blank line (paragraph separator)
  if (nextLine !== undefined && nextLine.trim() !== '') return false;
  // Doesn't end with sentence-final punctuation
  if (/[.!?:;]$/.test(trimmed)) return false;
  // Has at least one letter (skip page numbers, separators)
  if (!/[A-Za-z]/.test(trimmed)) return false;
  return true;
}

function splitPageIntoSections(pageText: string, pageNumber: number): DocumentSection[] {
  // Normalize line endings, drop pure-whitespace runs of >1 blank line.
  const lines = pageText.replace(/\r\n?/g, '\n').split('\n');

  // Group into paragraphs by blank-line boundaries, recording detected headings.
  const sections: DocumentSection[] = [];
  let buffer: string[] = [];

  const flushParagraph = (heading: string | null, headingLevel: number) => {
    if (buffer.length === 0) return;
    const content = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (!content) return;
    sections.push({
      heading,
      headingLevel,
      content,
      pageNumber,
      children: [],
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const next = lines[i + 1];
    if (line.trim() === '') {
      flushParagraph(null, 0);
      continue;
    }
    if (buffer.length === 0 && isHeadingCandidate(line, next)) {
      // Emit the heading as its own zero-content section so the chunker can
      // pick it up in the heading hierarchy.
      sections.push({
        heading: line.trim(),
        headingLevel: 1,
        content: line.trim(),
        pageNumber,
        children: [],
      });
      // Skip the blank line that confirmed it as a heading.
      i++;
      continue;
    }
    buffer.push(line);
  }
  flushParagraph(null, 0);

  return sections;
}

export class PdfParser implements DocumentParser {
  readonly supportedTypes: ParserType[] = ['pdf'];

  canHandle(job: FileJob): boolean {
    return job.fileType === 'pdf';
  }

  async parse(job: FileJob): Promise<ParsedDocument> {
    const buf = await readFile(job.filePath);

    const pageTexts: string[] = [];
    const result = await pdfParse(buf, {
      pagerender: async (pageData: {
        getTextContent: (opts: {
          normalizeWhitespace: boolean;
          disableCombineTextItems: boolean;
        }) => Promise<{ items: { str: string; transform?: number[] }[] }>;
      }) => {
        const tc = await pageData.getTextContent({
          normalizeWhitespace: true,
          disableCombineTextItems: false,
        });
        // Reconstruct lines using the y-coordinate of each text item; pdf-parse
        // ships everything together otherwise.
        const lines = new Map<number, string[]>();
        for (const item of tc.items) {
          const y = item.transform?.[5] ?? 0;
          const key = Math.round(y);
          const arr = lines.get(key) ?? [];
          arr.push(item.str);
          lines.set(key, arr);
        }
        const sortedKeys = [...lines.keys()].sort((a, b) => b - a);
        const text = sortedKeys.map((k) => (lines.get(k) ?? []).join(' ')).join('\n');
        pageTexts.push(text);
        return text;
      },
    });

    const pageCount = result.numpages || pageTexts.length || 1;

    // OCR threshold: total chars / pages. Below this, we can't get useful text.
    const totalChars = pageTexts.join('').length;
    const charsPerPage = totalChars / Math.max(1, pageCount);
    if (charsPerPage < 50) {
      throw new ParserError(
        `PDF appears to be image-only (avg ${charsPerPage.toFixed(0)} chars/page < 50). OCR fallback is Phase 4.`,
        {
          filePath: job.filePath,
          pageCount,
          totalChars,
          charsPerPage,
        }
      );
    }

    const sections: DocumentSection[] = [];
    pageTexts.forEach((text, idx) => {
      sections.push(...splitPageIntoSections(text, idx + 1));
    });

    const wordCount = result.text.split(/\s+/).filter((w: string) => w.length > 0).length;

    const info = (result.info ?? {}) as Record<string, unknown>;
    const metadata: DocumentMetadata = {
      pageCount,
      wordCount,
      customProperties: {},
    };
    if (typeof info.Title === 'string' && info.Title) metadata.title = info.Title;
    if (typeof info.Author === 'string' && info.Author) metadata.author = info.Author;
    if (typeof info.CreationDate === 'string')
      metadata.customProperties.creationDate = info.CreationDate;

    return {
      sourceFile: job,
      sections,
      tables: [],
      images: [],
      metadata,
    };
  }
}
