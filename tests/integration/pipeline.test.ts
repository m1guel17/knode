// End-to-end pipeline test (the Phase 1 milestone gate). Spins up Neo4j via
// Testcontainers and uses a deterministic in-process stub for the LLM so the
// test is fast and free; replace the stub by setting USE_REAL_LLM=1 along with
// ANTHROPIC_API_KEY to exercise the live API path.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AnthropicTripleExtractor,
  type TripleExtractor,
  loadOntology,
} from '../../src/extraction/index.js';
import { DocumentChunker, buildDefaultRegistry } from '../../src/parsers/index.js';
import { Pipeline } from '../../src/pipeline.js';
import { ProcessingLog } from '../../src/scanner/index.js';
import type { Chunk, ExtractionResult } from '../../src/shared/types.js';
import { Neo4jBackend } from '../../src/storage/index.js';

const FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const ONTOLOGY_PATH = resolve(__dirname, '..', '..', 'config', 'ontology', 'default-ontology.json');

class StubExtractor implements TripleExtractor {
  async extract(chunk: Chunk): Promise<ExtractionResult> {
    return {
      entities: [
        {
          name: 'Acme Corp',
          type: 'Organization',
          aliases: ['Acme'],
          properties: { industry: 'enterprise software' },
          confidence: 0.95,
          sourceChunkId: chunk.id,
        },
        {
          name: 'Jane Wilson',
          type: 'Person',
          aliases: [],
          properties: { role: 'CEO' },
          confidence: 0.9,
          sourceChunkId: chunk.id,
        },
        {
          name: 'New York',
          type: 'Location',
          aliases: [],
          properties: {},
          confidence: 0.88,
          sourceChunkId: chunk.id,
        },
      ],
      relationships: [
        {
          sourceEntity: 'Jane Wilson',
          relationship: 'works_at',
          targetEntity: 'Acme Corp',
          properties: {},
          confidence: 0.92,
          evidence: 'Jane Wilson is the CEO of Acme Corp.',
        },
      ],
      confidence: 0.9,
    };
  }
}

let container: StartedTestContainer;
let backend: Neo4jBackend;

beforeAll(async () => {
  container = await new GenericContainer('neo4j:5.24-community')
    .withEnvironment({
      NEO4J_AUTH: 'neo4j/test-password-12345',
    })
    .withExposedPorts(7687, 7474)
    .withWaitStrategy(Wait.forLogMessage(/Started\.$/, 1))
    .withStartupTimeout(180_000)
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
}, 240_000);

afterAll(async () => {
  if (backend) await backend.disconnect();
  if (container) await container.stop();
}, 60_000);

describe('end-to-end pipeline', () => {
  it('processes a fixture PDF and writes the expected graph shape', async () => {
    const ontology = loadOntology(ONTOLOGY_PATH);
    const useReal = process.env.USE_REAL_LLM === '1' && !!process.env.ANTHROPIC_API_KEY;
    const extractor: TripleExtractor = useReal
      ? new AnthropicTripleExtractor({
          model: process.env.KNODE_EXTRACTION_MODEL ?? 'claude-haiku-4-5-20251001',
          temperature: 0,
          maxRetries: 2,
          ontology,
        })
      : new StubExtractor();

    const dir = mkdtempSync(join(tmpdir(), 'knode-e2e-'));
    const log = new ProcessingLog(join(dir, 'log.db'));
    const pipeline = new Pipeline({
      parsers: buildDefaultRegistry(),
      chunker: new DocumentChunker({ targetTokens: 500, overlapTokens: 50 }),
      extractor,
      backend,
      log,
    });

    try {
      const stats = await pipeline.processFile(FIXTURE);
      expect(stats.status).toBe('completed');
      expect(stats.chunkCount).toBeGreaterThan(0);
      expect(stats.entityCount).toBeGreaterThan(0);

      const rows = (await backend.executeCypher(
        `MATCH (d:Document { id: $id })
         OPTIONAL MATCH (d)-[:HAS_PAGE]->(p:Page)
         OPTIONAL MATCH (p)-[:HAS_SECTION]->(s:Section)
         OPTIONAL MATCH (s)-[:HAS_PARAGRAPH]->(para:Paragraph)
         OPTIONAL MATCH (e:Entity)-[:MENTIONED_IN]->(para)
         RETURN count(DISTINCT p) AS pages,
                count(DISTINCT s) AS sections,
                count(DISTINCT para) AS paragraphs,
                count(DISTINCT e) AS entities`,
        { id: stats.documentId }
      )) as {
        pages: { toNumber(): number };
        sections: { toNumber(): number };
        paragraphs: { toNumber(): number };
        entities: { toNumber(): number };
      }[];
      const row = rows[0];
      if (!row) throw new Error('no row');
      expect(row.pages.toNumber()).toBeGreaterThan(0);
      expect(row.sections.toNumber()).toBeGreaterThan(0);
      expect(row.paragraphs.toNumber()).toBeGreaterThanOrEqual(3);
      expect(row.entities.toNumber()).toBeGreaterThanOrEqual(3);

      // Idempotency: second run skips.
      const stats2 = await pipeline.processFile(FIXTURE);
      expect(stats2.status).toBe('skipped');
    } finally {
      log.close();
    }
  }, 180_000);
});
