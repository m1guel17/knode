// Phase 2 milestone gate. Runs the full pipeline against the 20-document
// benchmark corpus and asserts: every document is in the graph, ≥80% of
// expected entities are present (LLM noise tolerated), entity count after
// resolution is meaningfully lower than before, every Paragraph has an
// embedding, total cost ≤ configured budget.
//
// Gated behind RUN_BENCHMARK=1 + ANTHROPIC_API_KEY because it costs money.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CostController } from '../../src/extraction/cost-controller.js';
import { EmbeddingGenerator } from '../../src/extraction/embedding-generator.js';
import { EntityResolver } from '../../src/extraction/entity-resolver.js';
import { AnthropicTripleExtractor, loadOntology } from '../../src/extraction/index.js';
import { DocumentChunker, buildDefaultRegistry } from '../../src/parsers/index.js';
import { Pipeline } from '../../src/pipeline.js';
import { ProcessingLog, walkFolder } from '../../src/scanner/index.js';
import { Neo4jBackend } from '../../src/storage/index.js';

const SHOULD_RUN =
  process.env.RUN_BENCHMARK === '1' && !!process.env.ANTHROPIC_API_KEY;

const CORPUS_ROOT = resolve(__dirname, '..', 'fixtures', 'benchmark-corpus');
const EXPECTED_DIR = resolve(CORPUS_ROOT, 'expected');
const ONTOLOGY_PATH = resolve(__dirname, '..', '..', 'config', 'ontology', 'default-ontology.json');
const PRICING_PATH = resolve(__dirname, '..', '..', 'config', 'pricing.toml');

let container: StartedTestContainer;
let backend: Neo4jBackend;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  container = await new GenericContainer('neo4j:5.24-community')
    .withEnvironment({
      NEO4J_AUTH: 'neo4j/test-password-12345',
      NEO4J_PLUGINS: '["apoc"]',
      NEO4J_dbms_security_procedures_unrestricted: 'apoc.*',
    })
    .withExposedPorts(7687, 7474)
    .withWaitStrategy(Wait.forLogMessage(/Started\.$/, 1))
    .withStartupTimeout(240_000)
    .start();
  const port = container.getMappedPort(7687);
  backend = new Neo4jBackend({
    uri: `bolt://${container.getHost()}:${port}`,
    user: 'neo4j',
    password: 'test-password-12345',
    database: 'neo4j',
  });
  await backend.connect();
}, 300_000);

afterAll(async () => {
  if (backend) await backend.disconnect();
  if (container) await container.stop();
}, 60_000);

describe.skipIf(!SHOULD_RUN)('Phase 2 benchmark', () => {
  it('processes 20 documents within budget and produces a coherent graph', async () => {
    const ontology = loadOntology(ONTOLOGY_PATH);
    const costController = new CostController({
      pricingPath: PRICING_PATH,
      budgetPerRunUsd: Number(process.env.BENCH_BUDGET_USD ?? '5'),
    });
    const embeddings = new EmbeddingGenerator({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    embeddings.setUsageHook((info) =>
      costController.recordCall({
        callType: 'embedding',
        model: info.model,
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
      })
    );
    await backend.applySchema({
      paragraphEmbeddingDims: embeddings.dimensions,
      entityEmbeddingDims: embeddings.dimensions,
      embeddingModel: embeddings.modelName,
    });

    const extractor = new AnthropicTripleExtractor({
      model: 'claude-haiku-4-5-20251001',
      temperature: 0,
      maxRetries: 2,
      ontology,
      recordCall: (info) => costController.recordCall(info),
      shouldHalt: () => costController.shouldHalt(),
    });
    const resolver = new EntityResolver(backend, embeddings, {
      enabled: true,
      model: 'claude-sonnet-4-6',
      similarityThreshold: 0.92,
      maxCandidatesPerEntity: 5,
      skipTypes: ['Date', 'Metric'],
      recordCall: (info) =>
        costController.recordCall({
          callType: info.callType,
          model: info.model,
          inputTokens: info.inputTokens,
          outputTokens: info.outputTokens,
        }),
      shouldHalt: () => costController.shouldHalt(),
    });
    const dir = mkdtempSync(join(tmpdir(), 'knode-bench-'));
    const log = new ProcessingLog(join(dir, 'log.db'));

    const pipeline = new Pipeline({
      parsers: buildDefaultRegistry(),
      chunker: new DocumentChunker({ targetTokens: 500, overlapTokens: 50 }),
      extractor,
      backend,
      log,
      embeddings,
      resolver,
      costController,
      extractionBatchSize: 5,
    });

    const files = await walkFolder(CORPUS_ROOT, {});
    expect(files.length).toBeGreaterThanOrEqual(20);

    let preResolutionEntityCount = 0;
    for (const f of files) {
      const stats = await pipeline.processFile(f);
      preResolutionEntityCount += stats.entityCount;
      // eslint-disable-next-line no-console
      console.log(`[bench] ${f}: ${stats.entityCount} entities, ${stats.relationshipCount} rels`);
    }

    // End-of-batch resolution pass for cross-document duplicates.
    const stage1 = await resolver.resolveByNormalization();
    // eslint-disable-next-line no-console
    console.log(`[bench] end-of-batch stage-1 merges: ${stage1.length}`);

    // --- Assertions ---

    // Each document has a Document node.
    const docCount = (
      (await backend.executeCypher(`MATCH (d:Document) RETURN count(d) AS n`)) as Array<{
        n: { toNumber(): number };
      }>
    )[0]?.n.toNumber();
    expect(docCount).toBeGreaterThanOrEqual(20);

    // Every Paragraph has an embedding.
    const paraStats = (
      (await backend.executeCypher(
        `MATCH (p:Paragraph) RETURN count(p) AS total, count(p.embedding) AS embedded`
      )) as Array<{ total: { toNumber(): number }; embedded: { toNumber(): number } }>
    )[0];
    expect(paraStats?.total.toNumber()).toBeGreaterThan(0);
    expect(paraStats?.embedded.toNumber()).toBe(paraStats?.total.toNumber());

    // Entity count after resolution is meaningfully lower than the sum of
    // per-document entity counts.
    const finalEntityCount = (
      (await backend.executeCypher(`MATCH (e:Entity) RETURN count(e) AS n`)) as Array<{
        n: { toNumber(): number };
      }>
    )[0]?.n.toNumber() ?? 0;
    // Sanity check: resolver collapsed at least 1 duplicate (the corpus has
    // multiple "Acme Corp"/"Acme Corporation"/"Acme Inc." mentions).
    expect(finalEntityCount).toBeLessThan(preResolutionEntityCount);

    // Total cost ≤ configured budget.
    const summary = costController.reportSummary();
    // eslint-disable-next-line no-console
    console.log('[bench] cost summary', summary);
    const budget = Number(process.env.BENCH_BUDGET_USD ?? '5');
    expect(summary.totalUsd).toBeLessThanOrEqual(budget);

    // Recall: ≥80% of expected entities (case-insensitive substring match).
    const expectedFiles = readdirSync(EXPECTED_DIR).filter((n) => n.endsWith('.json'));
    let expectedTotal = 0;
    let foundTotal = 0;
    for (const ef of expectedFiles) {
      const spec = JSON.parse(readFileSync(resolve(EXPECTED_DIR, ef), 'utf8'));
      for (const ent of spec.entities ?? []) {
        expectedTotal++;
        const rows = (await backend.executeCypher(
          `MATCH (e:Entity)
           WHERE toLower(e.name) CONTAINS toLower($name)
              OR ANY(a IN coalesce(e.aliases, []) WHERE toLower(a) CONTAINS toLower($name))
           RETURN count(e) AS n`,
          { name: ent.name }
        )) as Array<{ n: { toNumber(): number } }>;
        if ((rows[0]?.n.toNumber() ?? 0) > 0) foundTotal++;
      }
    }
    if (expectedTotal > 0) {
      const recall = foundTotal / expectedTotal;
      // eslint-disable-next-line no-console
      console.log(`[bench] recall: ${foundTotal}/${expectedTotal} = ${recall.toFixed(3)}`);
      expect(recall).toBeGreaterThanOrEqual(0.8);
    }

    log.close();
  }, 1_800_000);
});
