// DOCX parser. mammoth → HTML, cheerio → walk DOM. Maps h1-h6 to heading
// levels, <p> to paragraphs, <table> to tab-joined cells. Image content lives
// in ParsedDocument.images but isn't described — that's Phase 2.

import { readFile } from 'node:fs/promises';
import { load as cheerioLoad } from 'cheerio';
import mammoth from 'mammoth';
import type {
  DocumentMetadata,
  DocumentSection,
  ExtractedImage,
  ExtractedTable,
  FileJob,
  ParsedDocument,
  ParserType,
} from '../../shared/types.js';
import type { DocumentParser } from '../interfaces.js';

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export class DocxParser implements DocumentParser {
  readonly supportedTypes: ParserType[] = ['docx'];

  canHandle(job: FileJob): boolean {
    return job.fileType === 'docx';
  }

  async parse(job: FileJob): Promise<ParsedDocument> {
    const buf = await readFile(job.filePath);
    const { value: html } = await mammoth.convertToHtml({ buffer: buf });

    const $ = cheerioLoad(html);
    const sections: DocumentSection[] = [];
    const tables: ExtractedTable[] = [];
    const images: ExtractedImage[] = [];

    let imgCounter = 0;
    $('body')
      .children()
      .each((_, el) => {
        const tag = (el.type === 'tag' ? el.name : '').toLowerCase();
        const $el = $(el);
        if (HEADING_TAGS.has(tag)) {
          const level = Number.parseInt(tag.slice(1), 10);
          const heading = $el.text().trim();
          if (heading) {
            sections.push({
              heading,
              headingLevel: level,
              content: heading,
              children: [],
            });
          }
          return;
        }
        if (tag === 'p') {
          const text = $el.text().replace(/\s+/g, ' ').trim();
          if (!text) return;
          sections.push({
            heading: null,
            headingLevel: 0,
            content: text,
            children: [],
          });
          return;
        }
        if (tag === 'table') {
          const rows: string[][] = [];
          $el.find('tr').each((_, tr) => {
            const cells: string[] = [];
            $(tr)
              .find('th, td')
              .each((_, c) => {
                cells.push($(c).text().replace(/\s+/g, ' ').trim());
              });
            if (cells.length > 0) rows.push(cells);
          });
          if (rows.length === 0) return;
          tables.push({ rows });
          // Render as a section with tab-joined cells so the chunker has
          // something textual to work with.
          const rendered = rows.map((r) => r.join('\t')).join('\n');
          sections.push({
            heading: null,
            headingLevel: 0,
            content: rendered,
            children: [],
          });
          return;
        }
        if (tag === 'ul' || tag === 'ol') {
          const items: string[] = [];
          $el.find('> li').each((_, li) => {
            const t = $(li).text().replace(/\s+/g, ' ').trim();
            if (t) items.push(`- ${t}`);
          });
          if (items.length === 0) return;
          sections.push({
            heading: null,
            headingLevel: 0,
            content: items.join('\n'),
            children: [],
          });
          return;
        }
        // Other top-level elements (figures, divs from custom styles): take text.
        const text = $el.text().replace(/\s+/g, ' ').trim();
        if (text) {
          sections.push({
            heading: null,
            headingLevel: 0,
            content: text,
            children: [],
          });
        }
      });

    $('img').each((_, el) => {
      imgCounter += 1;
      const src = $(el).attr('src') ?? '';
      const alt = $(el).attr('alt');
      const image: ExtractedImage = { reference: `image-${imgCounter}` };
      if (alt) image.altText = alt;
      images.push(image);
      // Don't store the base64 src — that's huge and we don't need it in Phase 1.
      void src;
    });

    const wordCount = $('body')
      .text()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    const metadata: DocumentMetadata = {
      wordCount,
      customProperties: {},
    };

    return {
      sourceFile: job,
      sections,
      tables,
      images,
      metadata,
    };
  }
}
