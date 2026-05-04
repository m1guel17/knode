// PPTX adapter. PPTX files are ZIP archives — unpack with jszip, then walk
// each slide's XML with xml2js. Each slide becomes a DocumentSection with the
// title (text in a <p:ph type="title"/> placeholder) as its heading. Speaker
// notes are appended after a delimiter so the LLM has the full context.

import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { ParserError } from '../../shared/errors.js';
import type {
  DocumentMetadata,
  DocumentSection,
  ExtractedImage,
  FileJob,
  ParsedDocument,
  ParserType,
} from '../../shared/types.js';
import type { DocumentParser } from '../interfaces.js';

const SPEAKER_NOTES_DELIM = '\n\n---SPEAKER NOTES---\n';

interface SlideContent {
  index: number;
  title: string | null;
  body: string;
  notes: string;
}

interface XmlNode {
  $$?: XmlNode[];
  $?: Record<string, string>;
  _?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function flattenText(node: XmlNode): string[] {
  // Walk and capture every <a:t> text run anywhere under this node. xml2js
  // with explicitArray:true wraps each element in an array; text content is
  // either a plain string (no attributes) or an object with `_` property.
  const out: string[] = [];
  const visit = (n: unknown, parentKey: string | null): void => {
    if (n == null) return;
    if (typeof n === 'string') {
      if (parentKey === 'a:t') out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      for (const item of n) visit(item, parentKey);
      return;
    }
    if (typeof n !== 'object') return;
    const obj = n as XmlNode;
    if (parentKey === 'a:t' && typeof obj._ === 'string') out.push(obj._);
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$' || k === '_') continue;
      visit(v, k);
    }
  };
  visit(node, null);
  return out;
}

interface ShapeText {
  text: string;
  isTitlePlaceholder: boolean;
}

function collectShapes(slideXml: XmlNode): ShapeText[] {
  // Walk every <p:sp>, recording its text and whether nvSpPr.nvPr.ph[type] is
  // a title placeholder. Many tools (pptxgenjs, simple exporters) emit shapes
  // without placeholder metadata; in that case findTitle/extractBodyText fall
  // back to the first-shape heuristic.
  const shapes: ShapeText[] = [];
  const visit = (node: unknown, parentKey: string | null): void => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parentKey);
      return;
    }
    const obj = node as XmlNode;
    if (parentKey === 'p:sp') {
      const ph = obj['p:nvSpPr']?.[0]?.['p:nvPr']?.[0]?.['p:ph']?.[0];
      const type = ph?.$?.type;
      const txBody = obj['p:txBody']?.[0];
      if (txBody) {
        const text = flattenText(txBody).join(' ').replace(/\s+/g, ' ').trim();
        if (text) {
          shapes.push({
            text,
            isTitlePlaceholder: type === 'title' || type === 'ctrTitle',
          });
        }
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$' || k === '_') continue;
      visit(v, k);
    }
  };
  visit(slideXml, null);
  return shapes;
}

function findTitle(slideXml: XmlNode): string | null {
  const shapes = collectShapes(slideXml);
  // Prefer an explicit title placeholder. Fall back to the first shape that
  // looks title-like (short, single line) — common in tools that don't emit
  // placeholder metadata.
  const explicit = shapes.find((s) => s.isTitlePlaceholder);
  if (explicit) return explicit.text;
  const candidate = shapes[0];
  if (!candidate) return null;
  // Heuristic: a title is short and has no newlines.
  if (candidate.text.length <= 120 && !candidate.text.includes('\n')) return candidate.text;
  return null;
}

function extractBodyText(slideXml: XmlNode): string {
  const shapes = collectShapes(slideXml);
  const explicitTitle = shapes.find((s) => s.isTitlePlaceholder);
  let bodyShapes = shapes;
  if (explicitTitle) {
    bodyShapes = shapes.filter((s) => !s.isTitlePlaceholder);
  } else if (shapes.length > 1) {
    // Drop the inferred title (first short shape).
    const first = shapes[0];
    if (first && first.text.length <= 120 && !first.text.includes('\n')) {
      bodyShapes = shapes.slice(1);
    }
  }
  return bodyShapes.map((s) => s.text).join('\n');
}

async function parseSlideXml(xml: string): Promise<XmlNode> {
  return (await parseStringPromise(xml, {
    explicitArray: true,
    preserveChildrenOrder: true,
    mergeAttrs: false,
  })) as XmlNode;
}

export class PptxParser implements DocumentParser {
  readonly supportedTypes: ParserType[] = ['pptx'];

  canHandle(job: FileJob): boolean {
    return job.fileType === 'pptx';
  }

  async parse(job: FileJob): Promise<ParsedDocument> {
    const buf = await readFile(job.filePath);
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch (e) {
      throw new ParserError('PPTX is not a valid zip', { filePath: job.filePath }, e);
    }

    const slideFiles = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => slideNumber(a) - slideNumber(b));

    const slides: SlideContent[] = [];
    const images: ExtractedImage[] = [];

    for (const path of slideFiles) {
      const idx = slideNumber(path);
      const file = zip.files[path];
      if (!file) continue;
      const xml = await file.async('string');
      const parsed = await parseSlideXml(xml);
      const title = findTitle(parsed);
      const body = extractBodyText(parsed);

      // Speaker notes live in ppt/notesSlides/notesSlide{N}.xml.
      let notes = '';
      const notesPath = `ppt/notesSlides/notesSlide${idx}.xml`;
      const notesFile = zip.files[notesPath];
      if (notesFile) {
        const notesXml = await notesFile.async('string');
        const notesParsed = await parseSlideXml(notesXml);
        notes = flattenText(notesParsed).join(' ').replace(/\s+/g, ' ').trim();
      }

      slides.push({ index: idx, title, body, notes });
    }

    // Image references: ppt/media/* — we record but don't describe.
    for (const path of Object.keys(zip.files)) {
      if (/^ppt\/media\/.+$/.test(path)) {
        images.push({ reference: path });
      }
    }

    const sections: DocumentSection[] = [];
    for (const slide of slides) {
      if (slide.title) {
        sections.push({
          heading: slide.title,
          headingLevel: 1,
          content: slide.title,
          pageNumber: slide.index,
          children: [],
        });
      }
      const content = slide.notes
        ? `${slide.body}${SPEAKER_NOTES_DELIM}${slide.notes}`
        : slide.body;
      if (content.trim()) {
        sections.push({
          heading: null,
          headingLevel: 0,
          content,
          pageNumber: slide.index,
          children: [],
        });
      }
    }

    const wordCount = sections
      .map((s) => s.content)
      .join(' ')
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    const metadata: DocumentMetadata = {
      wordCount,
      pageCount: slides.length,
      customProperties: {},
    };

    return {
      sourceFile: job,
      sections,
      tables: [],
      images,
      metadata,
    };
  }
}

function slideNumber(path: string): number {
  const m = path.match(/slide(\d+)\.xml$/);
  return m?.[1] ? Number.parseInt(m[1], 10) : 0;
}
