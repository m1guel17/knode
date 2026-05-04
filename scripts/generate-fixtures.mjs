#!/usr/bin/env node
// Generate the Phase 1 test fixtures: sample.pdf and sample.docx with
// matching content (a fabricated press release with identifiable entities).
// Idempotent — overwrites existing fixtures.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import PDFDocument from 'pdfkit';
import pptxgen from 'pptxgenjs';
import * as XLSX from 'xlsx';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'tests', 'fixtures');
mkdirSync(OUT_DIR, { recursive: true });

const TITLE = 'Acme Corp Announces Q3 2024 Results';
const PARAGRAPHS = [
  'NEW YORK — Acme Corp announced its third-quarter 2024 results today, reporting revenue of $4.2 million and 15% year-over-year growth. The company employs more than 500 people across its New York and London offices.',
  'CEO Jane Wilson cited the launch of the v2.0 release of the CRM platform as the primary driver of the quarter\'s performance. "Our customers are embracing the new architecture," said Wilson, who has led the company since 2019.',
  'Chief Financial Officer John Smith presented the figures at the November 5, 2024 board meeting. The board approved a 2025 expansion plan focused on the Asia-Pacific region. Acme Corp competes with Globex Inc and TechStar Ltd in the enterprise software market.',
];

function writePdf() {
  return new Promise((resolveP, reject) => {
    const path = resolve(OUT_DIR, 'sample.pdf');
    // compress: false — pdf-parse@1.1.1 ships an old pdfjs that can't read
    // the compressed XRef format pdfkit emits by default.
    const doc = new PDFDocument({ size: 'LETTER', margin: 72, compress: false });
    const chunks = [];
    doc.on('data', (b) => chunks.push(b));
    doc.on('end', () => {
      writeFileSync(path, Buffer.concat(chunks));
      console.log(`[fixtures] wrote ${path}`);
      resolveP();
    });
    doc.on('error', reject);

    doc.fontSize(18).text(TITLE, { align: 'center' });
    doc.moveDown();
    doc.fontSize(11);
    for (const p of PARAGRAPHS) {
      doc.text(p, { align: 'left' });
      doc.moveDown();
    }
    // Force a second page so layout has Page count > 1.
    doc.addPage();
    doc.fontSize(13).text('Forward-looking Statements', { underline: false });
    doc.moveDown();
    doc
      .fontSize(11)
      .text(
        'This release contains forward-looking statements regarding the Asia-Pacific expansion plan and the v2.0 CRM platform. Actual results may differ materially. The forward-looking statements speak only as of November 5, 2024.'
      );

    doc.end();
  });
}

async function writeDocx() {
  const path = resolve(OUT_DIR, 'sample.docx');
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            children: [new TextRun(TITLE)],
          }),
          ...PARAGRAPHS.map((p) => new Paragraph({ children: [new TextRun(p)] })),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun('Forward-looking Statements')],
          }),
          new Paragraph({
            children: [
              new TextRun(
                'This release contains forward-looking statements regarding the Asia-Pacific expansion plan and the v2.0 CRM platform. Actual results may differ materially. The forward-looking statements speak only as of November 5, 2024.'
              ),
            ],
          }),
        ],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(path, buf);
  console.log(`[fixtures] wrote ${path}`);
}

async function writeXlsx() {
  const path = resolve(OUT_DIR, 'sample.xlsx');
  const wb = XLSX.utils.book_new();
  // Data table sheet
  const dataAOA = [
    ['Date', 'Product', 'Region', 'Revenue', 'Units Sold'],
    ['2024-07-15', 'Widget A', 'North America', 12500, 250],
    ['2024-07-16', 'Widget B', 'EMEA', 8900, 178],
    ['2024-08-02', 'Widget A', 'Asia-Pacific', 15400, 308],
    ['2024-08-21', 'Gadget X', 'North America', 22100, 110],
    ['2024-09-09', 'Gadget X', 'EMEA', 18600, 93],
  ];
  const data = XLSX.utils.aoa_to_sheet(dataAOA);
  XLSX.utils.book_append_sheet(wb, data, 'Q3 Sales');

  // Report sheet — irregular layout, not column-typed.
  const reportAOA = [
    ['Acme Corp Quarterly Report'],
    [],
    ['Prepared by:', 'John Smith, CFO'],
    ['Period:', 'Q3 2024'],
    [],
    ['Highlights:', 'Revenue up 15% YoY. Asia-Pacific expansion launched.'],
    ['Risk:', 'Currency exposure in EMEA.'],
  ];
  const report = XLSX.utils.aoa_to_sheet(reportAOA);
  XLSX.utils.book_append_sheet(wb, report, 'Summary');

  XLSX.writeFile(wb, path);
  console.log(`[fixtures] wrote ${path}`);
}

async function writePptx() {
  const path = resolve(OUT_DIR, 'sample.pptx');
  const pres = new pptxgen();
  const slide1 = pres.addSlide();
  slide1.addText('Acme Corp Q3 2024 Results', { x: 0.5, y: 0.3, fontSize: 28, bold: true, placeholder: 'title' });
  slide1.addText('Revenue: $4.2M (15% YoY)\nCEO: Jane Wilson\nLocations: New York, London', {
    x: 0.5, y: 1.5, fontSize: 18,
  });
  slide1.addNotes('Speaker notes: emphasize the Asia-Pacific expansion plan slated for 2025.');

  const slide2 = pres.addSlide();
  slide2.addText('CRM Platform v2.0', { x: 0.5, y: 0.3, fontSize: 28, bold: true, placeholder: 'title' });
  slide2.addText('Released July 2024. Adoption: 78% of customer base. New architecture cited by Wilson as primary growth driver.',
    { x: 0.5, y: 1.5, fontSize: 18 });

  const slide3 = pres.addSlide();
  slide3.addText('Competitive Landscape', { x: 0.5, y: 0.3, fontSize: 28, bold: true, placeholder: 'title' });
  slide3.addText('Acme Corp competes with Globex Inc and TechStar Ltd in the enterprise software market.',
    { x: 0.5, y: 1.5, fontSize: 18 });

  await pres.writeFile({ fileName: path });
  console.log(`[fixtures] wrote ${path}`);
}

await writePdf();
await writeDocx();
await writeXlsx();
await writePptx();
