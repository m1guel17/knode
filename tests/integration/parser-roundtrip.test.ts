// Integration test: parser → chunker → backend roundtrip with a stub extractor.
// Spins up Neo4j via Testcontainers; LLM call is mocked.

import { resolve } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentChunker, buildDefaultRegistry } from '../../src/parsers/index.js';
import { classifyFile } from '../../src/scanner/index.js';
import type { ExtractionResult } from '../../src/shared/types.js';
import { Neo4jBackend } from '../../src/storage/index.js';

const FIXTURE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const FIXTURE_DOCX = resolve(__dirname, '..', 'fixtures', 'sample.docx');

let container: StartedTestContainer;
let backend: Neo4jBackend;

beforeAll(async () => {
  container = await new GenericContainer('neo4j:5.24-community')
    .withEnvironment({
      NEO4J_AUTH: 'neo4j/test-password-12345',
      NEO4J_dbms_security_procedures_unrestricted: 'apoc.*',
    })
    .withExposedPorts(7687, 7474)
    .withWaitStrategy(Wait.forLogMessage(/Started\.$/, 1))
    .withStartupTimeout(120_000)
    .start();

  const port = container.getMappedPort(7687);
  backend = new Neo4jBackend({
    uri: `bolt://${container.getHost()}:${port}`,
    user: 'neo4j',
    password: 'test-password-12345',
    database: 'neo4j',
  });
  await backend.connect();
  await backend.applySchema();
}, 180_000);

afterAll(async () => {
  if (backend) await backend.disconnect();
  if (container) await container.stop();
}, 60_000);

function stubExtraction(): ExtractionResult {
  return {
    entities: [
      {
        name: 'Acme Corp',
        type: 'Organization',
        aliases: ['Acme'],
        properties: { industry: 'enterprise software' },
        confidence: 0.95,
        sourceChunkId: '',
      },
      {
        name: 'Jane Wilson',
        type: 'Person',
        aliases: [],
        properties: { role: 'CEO' },
        confidence: 0.9,
        sourceChunkId: '',
      },
    ],
    relationships: [
      {
        sourceEntity: 'Jane Wilson',
        relationship: 'works_at',
        targetEntity: 'Acme Corp',
        properties: {},
        confidence: 0.92,
        evidence: 'CEO Jane Wilson cited the launch of the v2.0 release.',
      },
    ],
    confidence: 0.9,
  };
}

describe('parser → chunker → Neo4j roundtrip', () => {
  it('writes a connected layout + semantic graph for the PDF fixture', async () => {
    const job = await classifyFile(FIXTURE_PDF);
    const parsers = buildDefaultRegistry();
    const parser = parsers.getParserFor(job);
    const parsed = await parser.parse(job);
    expect(parsed.sections.length).toBeGreaterThan(0);

    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const chunks = chunker.chunk(parsed);
    expect(chunks.length).toBeGreaterThan(0);

    const extractions = new Map<string, ExtractionResult>();
    for (const c of chunks) {
      const r = stubExtraction();
      r.entities = r.entities.map((e) => ({ ...e, sourceChunkId: c.id }));
      extractions.set(c.id, r);
    }

    const result = await backend.writeDocumentGraph({
      parsed,
      chunks,
      extractions,
    });
    expect(result.documentId).toBe(job.id);
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.entityCount).toBeGreaterThanOrEqual(2);

    const counts = (await backend.executeCypher(
      `MATCH (d:Document { id: $id })
       OPTIONAL MATCH (d)-[:HAS_PAGE]->(p:Page)
       OPTIONAL MATCH (e:Entity)-[:MENTIONED_IN]->(:Paragraph { documentId: $id })
       RETURN d.contentHash AS hash,
              count(DISTINCT p) AS pageCount,
              count(DISTINCT e) AS entityCount`,
      { id: job.id }
    )) as {
      hash: string;
      pageCount: { toNumber(): number };
      entityCount: { toNumber(): number };
    }[];

    expect(counts).toHaveLength(1);
    const row = counts[0];
    if (!row) throw new Error('no row');
    expect(row.hash).toBe(job.contentHash);
    expect(row.pageCount.toNumber()).toBeGreaterThan(0);
    expect(row.entityCount.toNumber()).toBeGreaterThanOrEqual(2);

    // Idempotency: re-run with the same input should not add new nodes.
    const before = (await backend.executeCypher('MATCH (n) RETURN count(n) AS c')) as {
      c: { toNumber(): number };
    }[];
    await backend.writeDocumentGraph({ parsed, chunks, extractions });
    const after = (await backend.executeCypher('MATCH (n) RETURN count(n) AS c')) as {
      c: { toNumber(): number };
    }[];
    const beforeCount = before[0]?.c.toNumber();
    const afterCount = after[0]?.c.toNumber();
    expect(beforeCount).toBeDefined();
    expect(afterCount).toBe(beforeCount);
  });

  it('parses the DOCX fixture into a similar number of chunks as the PDF', async () => {
    const pdfJob = await classifyFile(FIXTURE_PDF);
    const docxJob = await classifyFile(FIXTURE_DOCX);
    const parsers = buildDefaultRegistry();

    const pdfParsed = await parsers.getParserFor(pdfJob).parse(pdfJob);
    const docxParsed = await parsers.getParserFor(docxJob).parse(docxJob);

    const chunker = new DocumentChunker({ targetTokens: 500, overlapTokens: 50 });
    const pdfChunks = chunker.chunk(pdfParsed);
    const docxChunks = chunker.chunk(docxParsed);

    expect(pdfChunks.length).toBeGreaterThan(0);
    expect(docxChunks.length).toBeGreaterThan(0);
    // Same content so chunk counts should be in the same ballpark.
    expect(Math.abs(pdfChunks.length - docxChunks.length)).toBeLessThanOrEqual(2);
  });
});
