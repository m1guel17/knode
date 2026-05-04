#!/usr/bin/env node
// Generate the 20-document benchmark corpus described in PRD §2.7. The
// fixtures are deliberately synthetic and small so the benchmark stays
// reproducible and runnable end-to-end without external data. Each generated
// document has a matching expected/<name>.json file listing entities and
// relationships that the extractor should find (lower bound).
//
// To extend the corpus: add a new entry to DOCS, optionally with an expected
// JSON. Re-running this script is idempotent.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import PDFDocument from 'pdfkit';
import pptxgen from 'pptxgenjs';
import * as XLSX from 'xlsx';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', 'tests', 'fixtures', 'benchmark-corpus');
const EXPECTED = resolve(ROOT, 'expected');
mkdirSync(ROOT, { recursive: true });
mkdirSync(EXPECTED, { recursive: true });

// --- Document plans -------------------------------------------------------

const DOCS = [
  // 5 PDFs
  pdfDoc('pdf-01-press-release', 'Acme Corp Q3 2024 Press Release', [
    'NEW YORK — Acme Corp announced its third-quarter 2024 results today, reporting revenue of $4.2 million and 15% year-over-year growth.',
    'CEO Jane Wilson cited the launch of v2.0 of the CRM platform as the primary growth driver. Acme Corp competes with Globex Inc in enterprise software.',
  ], expected({
    entities: [
      { name: 'Acme Corp', type: 'Organization' },
      { name: 'Jane Wilson', type: 'Person' },
      { name: 'Globex Inc', type: 'Organization' },
      { name: 'Q3 2024', type: 'Date' },
    ],
    relationships: [
      { source: 'Jane Wilson', relationship: 'works_at', target: 'Acme Corp' },
    ],
  })),
  pdfDoc('pdf-02-technical-paper', 'Vector Index Performance', [
    'This paper evaluates HNSW and IVF-PQ indexes against the GIST-1M dataset.',
    'The HNSW configuration achieved a recall of 0.97 at a query latency of 4ms on commodity hardware.',
    'Authors: Dr. Maria Chen, Prof. David Lopez. Affiliation: Stanford University.',
  ], expected({
    entities: [
      { name: 'Maria Chen', type: 'Person' },
      { name: 'David Lopez', type: 'Person' },
      { name: 'Stanford University', type: 'Organization' },
    ],
  })),
  pdfDoc('pdf-03-financial', 'Fiscal Year 2023 Annual Report', [
    'Globex Inc reported total revenue of $128 million for fiscal year 2023, up from $114 million in fiscal year 2022.',
    'CEO Marcus Reynolds attributed growth to expansion in the Asia-Pacific region.',
  ], expected({
    entities: [
      { name: 'Globex Inc', type: 'Organization' },
      { name: 'Marcus Reynolds', type: 'Person' },
    ],
  })),
  pdfDoc('pdf-04-multi-section', 'Methodology Overview', [
    'Section 1 — Approach. Our methodology combines static analysis with runtime tracing.',
    'Section 2 — Tooling. We rely on the open-source TraceRunner suite.',
    'Section 3 — Results. The combined approach reduced detection time by 35%.',
  ], expected({})),
  pdfDoc('pdf-05-acme-mention', 'Industry Roundtable Notes', [
    'The roundtable convened in London on October 18, 2024.',
    'Acme Corporation, represented by CEO Jane Wilson, discussed the v2.0 release.',
  ], expected({
    entities: [
      { name: 'Acme Corporation', type: 'Organization' },
      { name: 'Jane Wilson', type: 'Person' },
      { name: 'London', type: 'Location' },
    ],
    // Resolution test: Acme Corp == Acme Corporation
    resolutionPairs: [['Acme Corp', 'Acme Corporation', 'Organization']],
  })),

  // 5 DOCXs
  docxDoc('docx-01-memo', 'Internal Memo — Q4 Planning', [
    { type: 'h1', text: 'Internal Memo — Q4 Planning' },
    { type: 'p', text: 'From: John Smith, CFO. To: Executive Team. Subject: 2025 budget priorities.' },
    { type: 'h2', text: 'Priorities' },
    { type: 'p', text: 'The board approved the 2025 expansion plan focused on the Asia-Pacific region.' },
  ], expected({
    entities: [
      { name: 'John Smith', type: 'Person' },
      { name: 'Asia-Pacific', type: 'Location' },
    ],
  })),
  docxDoc('docx-02-contract', 'Service Agreement', [
    { type: 'h1', text: 'Master Service Agreement' },
    { type: 'p', text: 'This agreement is between Acme Corp ("Provider") and TechStar Ltd ("Customer"), effective January 1, 2024.' },
  ], expected({
    entities: [
      { name: 'Acme Corp', type: 'Organization' },
      { name: 'TechStar Ltd', type: 'Organization' },
    ],
  })),
  docxDoc('docx-03-spec', 'Technical Specification', [
    { type: 'h1', text: 'Authentication Module Spec' },
    { type: 'p', text: 'Author: Dr. Jane Wilson. Reviewer: John Smith.' },
    { type: 'h2', text: 'Token Rotation' },
    { type: 'p', text: 'Tokens rotate every 24 hours via the central key service.' },
  ], expected({
    entities: [
      { name: 'Jane Wilson', type: 'Person' },
      { name: 'John Smith', type: 'Person' },
    ],
    // Resolution test across docx-01 and docx-03
    resolutionPairs: [['Dr. Jane Wilson', 'Jane Wilson', 'Person']],
  })),
  docxDoc('docx-04-minutes', 'Board Meeting Minutes', [
    { type: 'h1', text: 'Board Meeting — November 5, 2024' },
    { type: 'p', text: 'Present: Jane Wilson (CEO), John Smith (CFO), Marcus Reynolds (Director).' },
    { type: 'p', text: 'The board approved the v2.0 launch and the New York office expansion.' },
  ], expected({
    entities: [
      { name: 'Jane Wilson', type: 'Person' },
      { name: 'John Smith', type: 'Person' },
      { name: 'Marcus Reynolds', type: 'Person' },
      { name: 'New York', type: 'Location' },
    ],
  })),
  docxDoc('docx-05-handout', 'Customer Workshop Handout', [
    { type: 'h1', text: 'CRM v2.0 — Customer Workshop' },
    { type: 'p', text: 'This handout covers the new features released in the v2.0 update.' },
    { type: 'h2', text: 'Migration Path' },
    { type: 'p', text: 'Existing v1.x customers can opt-in via the Acme Inc. customer portal.' },
  ], expected({
    entities: [
      { name: 'Acme Inc.', type: 'Organization' },
    ],
    resolutionPairs: [['Acme Corp', 'Acme Inc.', 'Organization']],
  })),

  // 5 XLSXs
  xlsxDoc('xlsx-01-sales', [
    {
      name: 'Q3 Sales',
      rows: [
        ['Date', 'Product', 'Region', 'Revenue', 'Units'],
        ['2024-07-15', 'Widget A', 'North America', 12500, 250],
        ['2024-07-16', 'Widget B', 'EMEA', 8900, 178],
        ['2024-08-02', 'Widget A', 'Asia-Pacific', 15400, 308],
      ],
    },
  ], expected({})),
  xlsxDoc('xlsx-02-report', [
    {
      name: 'Summary',
      rows: [
        ['Acme Corp Quarterly Summary'],
        [],
        ['CFO:', 'John Smith'],
        ['Revenue:', '$4.2M'],
        ['Notes:', 'Asia-Pacific expansion launched.'],
      ],
    },
  ], expected({
    entities: [
      { name: 'Acme Corp', type: 'Organization' },
      { name: 'John Smith', type: 'Person' },
    ],
  })),
  xlsxDoc('xlsx-03-mixed', [
    {
      name: 'Data',
      rows: [
        ['ID', 'Customer', 'Tier'],
        [1, 'Globex Inc', 'Enterprise'],
        [2, 'TechStar Ltd', 'Mid-market'],
      ],
    },
    {
      name: 'Notes',
      rows: [
        ['Pipeline notes from Marcus Reynolds:'],
        ['Globex Inc deal closes Q4 2024.'],
      ],
    },
  ], expected({
    entities: [
      { name: 'Globex Inc', type: 'Organization' },
      { name: 'TechStar Ltd', type: 'Organization' },
    ],
  })),
  xlsxDoc('xlsx-04-csv-style', [
    {
      name: 'Sheet1',
      rows: [
        ['col_a', 'col_b', 'col_c'],
        ['x', 1, true],
        ['y', 2, false],
        ['z', 3, true],
      ],
    },
  ], expected({})),
  xlsxDoc('xlsx-05-single-cell', [
    { name: 'Inbox', rows: [['No data yet — populated weekly.']] },
  ], expected({})),

  // 5 PPTXs
  pptxDoc('pptx-01-product', 'CRM v2.0 Launch', [
    { title: 'CRM v2.0 Launch', body: 'Released by Acme Corp in July 2024.', notes: 'Emphasize the architecture rewrite.' },
    { title: 'Adoption Metrics', body: '78% adoption across the customer base.' },
    { title: 'Roadmap', body: 'Asia-Pacific expansion planned for 2025.' },
  ], expected({
    entities: [
      { name: 'Acme Corp', type: 'Organization' },
    ],
  })),
  pptxDoc('pptx-02-board', 'Board Update — November 2024', [
    { title: 'Board Update — November 2024', body: 'Presented by John Smith, CFO.' },
    { title: 'Financial Highlights', body: 'Revenue: $4.2M. Growth: 15% YoY.' },
  ], expected({
    entities: [
      { name: 'John Smith', type: 'Person' },
    ],
  })),
  pptxDoc('pptx-03-customer', 'Customer Briefing — TechStar Ltd', [
    { title: 'Customer Briefing — TechStar Ltd', body: 'Renewal scheduled for January 2025.' },
    { title: 'Use Cases', body: 'TechStar Ltd uses CRM v2.0 for global pipeline management.' },
  ], expected({
    entities: [
      { name: 'TechStar Ltd', type: 'Organization' },
    ],
  })),
  pptxDoc('pptx-04-strategy', '2025 Strategic Plan', [
    { title: '2025 Strategic Plan', body: 'Focus areas: Asia-Pacific expansion, CRM v2.0 adoption, enterprise contracts.' },
    { title: 'Risks', body: 'Currency exposure in EMEA; talent retention in San Francisco.' },
  ], expected({
    entities: [
      { name: 'San Francisco', type: 'Location' },
    ],
  })),
  pptxDoc('pptx-05-roundtable', 'Industry Roundtable — London 2024', [
    { title: 'Industry Roundtable — London 2024', body: 'Attendees: Acme Corporation, Globex Inc, TechStar Ltd.' },
    { title: 'Key Discussions', body: 'Vector search adoption, enterprise data privacy.' },
  ], expected({
    entities: [
      { name: 'Acme Corporation', type: 'Organization' },
      { name: 'London', type: 'Location' },
    ],
  })),
];

// --- Builders -------------------------------------------------------------

function expected(spec) {
  return spec;
}

function pdfDoc(name, title, paragraphs, expectedSpec) {
  return {
    name,
    ext: '.pdf',
    expected: expectedSpec,
    write: async () => {
      const path = resolve(ROOT, `${name}.pdf`);
      await new Promise((resolveP, reject) => {
        const doc = new PDFDocument({ size: 'LETTER', margin: 72, compress: false });
        const chunks = [];
        doc.on('data', (b) => chunks.push(b));
        doc.on('end', () => {
          writeFileSync(path, Buffer.concat(chunks));
          resolveP();
        });
        doc.on('error', reject);
        doc.fontSize(18).text(title, { align: 'center' });
        doc.moveDown();
        doc.fontSize(11);
        for (const p of paragraphs) {
          doc.text(p, { align: 'left' });
          doc.moveDown();
        }
        doc.end();
      });
    },
  };
}

function docxDoc(name, _title, blocks, expectedSpec) {
  return {
    name,
    ext: '.docx',
    expected: expectedSpec,
    write: async () => {
      const path = resolve(ROOT, `${name}.docx`);
      const children = blocks.map((b) => {
        if (b.type === 'h1') {
          return new Paragraph({
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.LEFT,
            children: [new TextRun(b.text)],
          });
        }
        if (b.type === 'h2') {
          return new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun(b.text)],
          });
        }
        return new Paragraph({ children: [new TextRun(b.text)] });
      });
      const doc = new Document({ sections: [{ children }] });
      const buf = await Packer.toBuffer(doc);
      writeFileSync(path, buf);
    },
  };
}

function xlsxDoc(name, sheets, expectedSpec) {
  return {
    name,
    ext: '.xlsx',
    expected: expectedSpec,
    write: async () => {
      const path = resolve(ROOT, `${name}.xlsx`);
      const wb = XLSX.utils.book_new();
      for (const sheet of sheets) {
        const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
        XLSX.utils.book_append_sheet(wb, ws, sheet.name);
      }
      XLSX.writeFile(wb, path);
    },
  };
}

function pptxDoc(name, _title, slides, expectedSpec) {
  return {
    name,
    ext: '.pptx',
    expected: expectedSpec,
    write: async () => {
      const path = resolve(ROOT, `${name}.pptx`);
      const pres = new pptxgen();
      for (const slide of slides) {
        const s = pres.addSlide();
        s.addText(slide.title, { x: 0.5, y: 0.3, fontSize: 28, bold: true });
        s.addText(slide.body, { x: 0.5, y: 1.5, fontSize: 18 });
        if (slide.notes) s.addNotes(slide.notes);
      }
      await pres.writeFile({ fileName: path });
    },
  };
}

// --- Entry ----------------------------------------------------------------

const indexRows = [];
for (const doc of DOCS) {
  await doc.write();
  console.log(`[corpus] wrote ${doc.name}${doc.ext}`);
  if (doc.expected) {
    const expectedPath = resolve(EXPECTED, `${doc.name}.json`);
    writeFileSync(expectedPath, JSON.stringify(doc.expected, null, 2));
  }
  indexRows.push({ name: `${doc.name}${doc.ext}`, hasExpected: !!doc.expected });
}

writeFileSync(
  resolve(ROOT, 'index.json'),
  JSON.stringify({ count: DOCS.length, docs: indexRows }, null, 2)
);
console.log(`[corpus] wrote ${DOCS.length} documents + index.json`);
