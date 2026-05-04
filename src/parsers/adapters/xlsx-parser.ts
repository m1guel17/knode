// XLSX adapter (SheetJS). Each worksheet becomes a DocumentSection. Heuristic:
// the first row containing unique non-empty string values + ≥50% column-typed
// rows below it ⇒ "data table" mode (schema summary + sample rows). Otherwise
// "report" mode (cell-by-cell with position metadata).
//
// Formulas evaluate to displayed value, not formula text — SheetJS exposes
// both `.v` (value) and `.f` (formula). We always read `.v`.

import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { ParserError } from '../../shared/errors.js';
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

const SAMPLE_ROW_COUNT = 8;
const COLUMN_TYPE_CONSISTENCY_THRESHOLD = 0.5;

interface AnalyzedSheet {
  name: string;
  isDataTable: boolean;
  headers: string[];
  columnTypes: Record<string, string>;
  rowCount: number;
  sampleRows: string[][];
  reportContent: string;
  rawTable: string[][];
}

function classifyColumnType(values: unknown[]): string {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (nonNull.length === 0) return 'empty';
  let nums = 0;
  let dates = 0;
  let strings = 0;
  for (const v of nonNull) {
    if (typeof v === 'number') nums++;
    else if (v instanceof Date) dates++;
    else if (typeof v === 'string') strings++;
    else strings++;
  }
  const total = nums + dates + strings;
  const top = Math.max(nums, dates, strings);
  if (top / total >= COLUMN_TYPE_CONSISTENCY_THRESHOLD) {
    if (nums === top) return 'number';
    if (dates === top) return 'date';
    return 'string';
  }
  return 'mixed';
}

function rowsToCsv(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell === null || cell === undefined) return '';
          const s = String(cell instanceof Date ? cell.toISOString().slice(0, 10) : cell);
          if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        })
        .join(',')
    )
    .join('\n');
}

function rowsToTabular(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) =>
          cell === null || cell === undefined
            ? ''
            : String(cell instanceof Date ? cell.toISOString().slice(0, 10) : cell)
        )
        .join('\t')
    )
    .join('\n');
}

function analyzeSheet(sheet: XLSX.WorkSheet, name: string): AnalyzedSheet {
  // sheet_to_json(header:1) returns the matrix raw (first row first).
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  if (matrix.length === 0) {
    return {
      name,
      isDataTable: false,
      headers: [],
      columnTypes: {},
      rowCount: 0,
      sampleRows: [],
      reportContent: '',
      rawTable: [],
    };
  }
  const firstRow = matrix[0] ?? [];
  const headerStrings = firstRow.map((c) => (typeof c === 'string' ? c.trim() : ''));
  const allUniqueStrings =
    headerStrings.length > 1 &&
    headerStrings.every((h) => h.length > 0) &&
    new Set(headerStrings).size === headerStrings.length;

  let isDataTable = false;
  const columnTypes: Record<string, string> = {};
  if (allUniqueStrings && matrix.length > 1) {
    let consistentCols = 0;
    for (let col = 0; col < headerStrings.length; col++) {
      const values = matrix.slice(1).map((r) => r[col]);
      const t = classifyColumnType(values);
      const header = headerStrings[col];
      if (header) columnTypes[header] = t;
      if (t !== 'mixed' && t !== 'empty') consistentCols++;
    }
    isDataTable =
      headerStrings.length > 0 && consistentCols / headerStrings.length >= COLUMN_TYPE_CONSISTENCY_THRESHOLD;
  }

  const rawTable = matrix.map((r) => r.map((c) => (c == null ? '' : String(c))));
  const sampleRows = isDataTable
    ? matrix.slice(1, 1 + SAMPLE_ROW_COUNT).map((r) => r.map((c) => (c == null ? '' : String(c))))
    : [];

  let reportContent = '';
  if (!isDataTable) {
    // Report mode: cell-by-cell joined as tab-delimited rows so the chunker
    // sees it as a table chunk (preserves table semantics).
    reportContent = rowsToTabular(matrix);
  }

  return {
    name,
    isDataTable,
    headers: headerStrings,
    columnTypes,
    rowCount: matrix.length - (allUniqueStrings ? 1 : 0),
    sampleRows,
    reportContent,
    rawTable,
  };
}

export class XlsxParser implements DocumentParser {
  readonly supportedTypes: ParserType[] = ['xlsx'];

  canHandle(job: FileJob): boolean {
    return job.fileType === 'xlsx';
  }

  async parse(job: FileJob): Promise<ParsedDocument> {
    const buf = await readFile(job.filePath);
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buf, { type: 'buffer', cellDates: true });
    } catch (e) {
      throw new ParserError(
        'XLSX parse failed',
        { filePath: job.filePath },
        e
      );
    }

    const sections: DocumentSection[] = [];
    const tables: ExtractedTable[] = [];
    const images: ExtractedImage[] = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const analyzed = analyzeSheet(sheet, sheetName);

      sections.push({
        heading: sheetName,
        headingLevel: 1,
        content: sheetName,
        children: [],
      });

      if (analyzed.isDataTable) {
        const colDescriptions = analyzed.headers
          .map((h) => `${h} (${analyzed.columnTypes[h] ?? 'mixed'})`)
          .join(', ');
        const summary =
          `This worksheet contains ${analyzed.rowCount} rows with columns: ${colDescriptions}.`;
        const csv = rowsToCsv([
          analyzed.headers,
          ...analyzed.sampleRows.map((r) => r as unknown[]),
        ]);
        sections.push({
          heading: null,
          headingLevel: 0,
          content: `${summary}\n\nSample rows (first ${analyzed.sampleRows.length}):\n${csv}`,
          children: [],
        });
        tables.push({ rows: analyzed.rawTable });
      } else if (analyzed.reportContent) {
        sections.push({
          heading: null,
          headingLevel: 0,
          content: analyzed.reportContent,
          children: [],
        });
        tables.push({ rows: analyzed.rawTable });
      }
    }

    const wordCount = sections
      .map((s) => s.content)
      .join(' ')
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    const props = workbook.Props ?? {};
    const metadata: DocumentMetadata = {
      wordCount,
      customProperties: {},
    };
    if (typeof props.Title === 'string' && props.Title) metadata.title = props.Title;
    if (typeof props.Author === 'string' && props.Author) metadata.author = props.Author;
    if (workbook.SheetNames.length) metadata.pageCount = workbook.SheetNames.length;

    return {
      sourceFile: job,
      sections,
      tables,
      images,
      metadata,
    };
  }
}
