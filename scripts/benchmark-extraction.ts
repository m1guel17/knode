// Standalone CLI for re-running the 20-document benchmark with metrics output:
// precision/recall against expected entities, cost per document, time per
// document. Used to compare prompt changes during ongoing development.
//
// Usage: npx tsx scripts/benchmark-extraction.ts [--budget 5]

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { CostController } from '../src/extraction/cost-controller.js';
import { EmbeddingGenerator } from '../src/extraction/embedding-generator.js';
import { EntityResolver } from '../src/extraction/entity-resolver.js';
import { AnthropicTripleExtractor, loadOntology } from '../src/extraction/index.js';
import { DocumentChunker, buildDefaultRegistry } from '../src/parsers/index.js';
import { Pipeline } from '../src/pipeline.js';
import { ProcessingLog, walkFolder } from '../src/scanner/index.js';
import { loadConfig } from '../src/shared/config.js';
import { Neo4jBackend } from '../src/storage/index.js';

interface CliOpts {
  budget?: string;
  corpus?: string;
}

async function main(opts: CliOpts): Promise<void> {
  const config = loadConfig();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required'); // eslint-disable-line no-console
    process.exit(2);
  }
  const budget = opts.budget ? Number(opts.budget) : (config.cost.budgetPerRunUsd ?? 5);
  const corpusRoot =
    opts.corpus ?? resolve(__dirname, '..', 'tests', 'fixtures', 'benchmark-corpus');
  const expectedDir = resolve(corpusRoot, 'expected');

  const ontology = loadOntology(config.extraction.ontologyPath);
  const costController = new CostController({
    pricingPath: config.cost.pricingPath,
    budgetPerRunUsd: budget,
  });
  const embeddings = new EmbeddingGenerator({
    provider: config.embedding.provider,
    model: config.embedding.model,
    dimensions: config.embedding.dimensions,
    batchSize: config.embedding.batchSize,
  });
  embeddings.setUsageHook((info) =>
    costController.recordCall({
      callType: 'embedding',
      model: info.model,
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
    })
  );

  const backend = new Neo4jBackend(config.storage.neo4j);
  await backend.connect();
  await backend.applySchema({
    paragraphEmbeddingDims: embeddings.dimensions,
    entityEmbeddingDims: embeddings.dimensions,
    embeddingModel: embeddings.modelName,
  });

  const extractor = new AnthropicTripleExtractor({
    model: config.extraction.model,
    temperature: config.extraction.temperature,
    maxRetries: config.extraction.maxRetries,
    ontology,
    recordCall: (info) => costController.recordCall(info),
    shouldHalt: () => costController.shouldHalt(),
  });
  const resolver = new EntityResolver(backend, embeddings, {
    enabled: true,
    model: config.extraction.resolution.model,
    similarityThreshold: config.extraction.resolution.similarityThreshold,
    maxCandidatesPerEntity: config.extraction.resolution.maxCandidatesPerEntity,
    skipTypes: config.extraction.resolution.skipTypes,
    recordCall: (info) =>
      costController.recordCall({
        callType: info.callType,
        model: info.model,
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
      }),
    shouldHalt: () => costController.shouldHalt(),
  });
  const tmp = mkdtempSync(join(tmpdir(), 'knode-bench-'));
  const log = new ProcessingLog(join(tmp, 'log.db'));

  const pipeline = new Pipeline({
    parsers: buildDefaultRegistry(),
    chunker: new DocumentChunker({
      targetTokens: config.chunker.targetTokens,
      overlapTokens: config.chunker.overlapTokens,
    }),
    extractor,
    backend,
    log,
    embeddings,
    resolver,
    costController,
    extractionBatchSize: config.extraction.batchSize,
  });

  const files = await walkFolder(corpusRoot, {});
  const perDoc: Array<{ file: string; durationMs: number; costUsd: number; entities: number }> = [];
  for (const f of files) {
    const t0 = Date.now();
    const stats = await pipeline.processFile(f);
    perDoc.push({
      file: f,
      durationMs: Date.now() - t0,
      costUsd: costController.costForDocument(stats.documentId ?? ''),
      entities: stats.entityCount,
    });
  }
  await resolver.resolveByNormalization();

  // Recall against expected/
  const expectedFiles = readdirSync(expectedDir).filter((n) => n.endsWith('.json'));
  let total = 0;
  let found = 0;
  for (const ef of expectedFiles) {
    const spec = JSON.parse(readFileSync(resolve(expectedDir, ef), 'utf8')) as {
      entities?: { name: string; type: string }[];
    };
    for (const ent of spec.entities ?? []) {
      total++;
      const rows = (await backend.executeCypher(
        `MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($name) RETURN count(e) AS n`,
        { name: ent.name }
      )) as Array<{ n: { toNumber(): number } }>;
      if ((rows[0]?.n.toNumber() ?? 0) > 0) found++;
    }
  }

  const summary = costController.reportSummary();
  console.log(JSON.stringify({ summary, perDoc, recall: { found, total, fraction: total ? found / total : 0 } }, null, 2)); // eslint-disable-line no-console

  await backend.disconnect();
  log.close();
}

const program = new Command();
program
  .name('benchmark-extraction')
  .option('--budget <usd>', 'override per-run budget in USD')
  .option('--corpus <path>', 'override corpus root (defaults to tests/fixtures/benchmark-corpus)')
  .action((opts: CliOpts) => {
    void main(opts).catch((e) => {
      console.error(e); // eslint-disable-line no-console
      process.exit(1);
    });
  });
program.parseAsync(process.argv).catch((e) => {
  console.error(e); // eslint-disable-line no-console
  process.exit(1);
});
