// Parser registry pre-loaded with all Phase 2 adapters.

import { DocxParser } from './adapters/docx-parser.js';
import { PdfParser } from './adapters/pdf-parser.js';
import { PptxParser } from './adapters/pptx-parser.js';
import { XlsxParser } from './adapters/xlsx-parser.js';
import { ParserRegistry } from './registry.js';

export { DocumentChunker } from './chunker.js';
export type { ChunkerOptions } from './chunker.js';
export type { DocumentParser } from './interfaces.js';
export { ParserRegistry } from './registry.js';
export { PdfParser } from './adapters/pdf-parser.js';
export { DocxParser } from './adapters/docx-parser.js';
export { XlsxParser } from './adapters/xlsx-parser.js';
export { PptxParser } from './adapters/pptx-parser.js';

export function buildDefaultRegistry(): ParserRegistry {
  const r = new ParserRegistry();
  r.register(new PdfParser());
  r.register(new DocxParser());
  r.register(new XlsxParser());
  r.register(new PptxParser());
  return r;
}
