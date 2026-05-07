// CLI entry point. Three invocation modes:
//   - Single file:  npx tsx src/index.ts --file <path>
//   - Folder mode:  npx tsx src/index.ts --folder <path>
//   - API mode:     npx tsx src/index.ts --mode api  (Phase 3)
// Folder mode enqueues each supported file via BullMQ and starts workers in
// the same process; for scale-out, run separate worker processes. API mode
// starts the Hono query server and waits for SIGTERM/SIGINT.

import { stat } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { Command } from 'commander';
import { CostController } from './extraction/cost-controller.js';
import { EmbeddingGenerator } from './extraction/embedding-generator.js';
import { EntityResolver } from './extraction/entity-resolver.js';
import { AnthropicTripleExtractor, loadOntology } from './extraction/index.js';
import { DocumentChunker, buildDefaultRegistry } from './parsers/index.js';
import { Pipeline } from './pipeline.js';
import { buildPluginManager } from './plugins/index.js';
import { GraphExpander, HybridSearch, RagPipeline, createApiServer } from './query/index.js';
import {
  JobQueues,
  ProcessingLog,
  priorityForSize,
  startWorkers,
  walkFolder,
} from './scanner/index.js';
import { loadConfig } from './shared/config.js';
import { createChildLogger, logger } from './shared/logger.js';
import { Neo4jBackend } from './storage/index.js';

const log = createChildLogger('cli');

interface CliOptions {
  file?: string;
  folder?: string;
  mode?: string;
  config?: string;
  logLevel?: string;
  continueOverBudget?: boolean;
  // Commander.js maps `--no-X` flags to `options.X = false` (NOT `options.noX = true`).
  // These three default to true; passing `--no-queue` etc. flips them to false.
  queue?: boolean;
  resolver?: boolean;
  embeddings?: boolean;
}

async function runApiMode(options: CliOptions): Promise<void> {
  const cfgOpts = options.config ? { configPath: options.config } : {};
  const config = loadConfig(cfgOpts);
  const apiToken = process.env.API_TOKEN;
  if (!apiToken || apiToken.length < 8) {
    log.error('API_TOKEN env var is required (>= 8 chars) for --mode api');
    process.exit(2);
  }

  const backend = new Neo4jBackend(config.storage.neo4j);
  await backend.connect();

  // RAG and hybrid search both need embeddings (to embed the user query)
  // and the GraphExpander. If embeddings are disabled in config, both
  // endpoints return 503; the cypher endpoint still works.
  const embeddings = config.embedding.enabled
    ? new EmbeddingGenerator({
        provider: config.embedding.provider,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        batchSize: config.embedding.batchSize,
      })
    : null;

  const expander = new GraphExpander({
    driver: backend.getDriver(),
    database: backend.getDatabase(),
  });

  const rag =
    embeddings && config.rag.enabled
      ? new RagPipeline({
          expander,
          embeddings,
          answerModel: config.rag.answerModel,
          answerTemperature: config.rag.answerTemperature,
          defaultParagraphTopK: config.rag.paragraphTopK,
          defaultEntityTopK: config.rag.entityTopK,
          defaultMaxHops: config.rag.maxHops,
          defaultLayoutWindow: config.rag.layoutWindow,
          defaultMaxContextTokens: config.rag.maxContextTokens,
          defaultRankAlpha: config.rag.rankAlpha,
          maxAnswerTokens: config.rag.maxAnswerTokens,
        })
      : null;

  const hybrid =
    embeddings && config.hybridSearch.enabled
      ? new HybridSearch({
          expander,
          embeddings,
          defaultParagraphTopK: config.hybridSearch.paragraphTopK,
          defaultEntityTopK: config.hybridSearch.entityTopK,
          defaultMaxHops: config.hybridSearch.maxHops,
          defaultLayoutWindow: config.hybridSearch.layoutWindow,
        })
      : null;

  const app = createApiServer({
    backend,
    apiConfig: config.api,
    apiToken,
    rag,
    hybridSearch: hybrid,
  });

  const server = serve({
    fetch: app.fetch,
    hostname: config.api.host,
    port: config.api.port,
  });

  log.info(
    { host: config.api.host, port: config.api.port },
    'cli.api_listening'
  );

  let shutting = false;
  const shutdown = async (sig: string) => {
    if (shutting) return;
    shutting = true;
    log.warn({ signal: sig }, 'cli.api_shutting_down');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await backend.disconnect();
    } catch (e) {
      log.warn({ error: e instanceof Error ? e.message : String(e) }, 'shutdown.backend');
    }
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void shutdown(sig));
  }
}

async function run(options: CliOptions): Promise<void> {
  if (options.logLevel) {
    logger.level = options.logLevel;
  }
  if (options.mode === 'api') {
    await runApiMode(options);
    return; // serve() keeps the process alive
  }
  if (!options.file && !options.folder) {
    log.error('one of --file, --folder, or --mode api is required');
    process.exit(2);
  }

  const cfgOpts = options.config ? { configPath: options.config } : {};
  const config = loadConfig(cfgOpts);
  log.info(
    {
      mode: options.folder ? 'folder' : 'file',
      target: options.folder ?? options.file,
    },
    'cli.starting'
  );

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.error('ANTHROPIC_API_KEY is not set; cannot run extraction');
    process.exit(2);
  }

  const ontology = loadOntology(config.extraction.ontologyPath);
  const parsers = buildDefaultRegistry();
  const chunker = new DocumentChunker({
    targetTokens: config.chunker.targetTokens,
    overlapTokens: config.chunker.overlapTokens,
    ...(config.chunker.minChunkTokens !== undefined
      ? { minChunkTokens: config.chunker.minChunkTokens }
      : {}),
    ...(config.chunker.maxChunkTokens !== undefined
      ? { maxChunkTokens: config.chunker.maxChunkTokens }
      : {}),
    ...(config.chunker.splitOn ? { splitOn: config.chunker.splitOn } : {}),
  });

  const costControllerOpts: ConstructorParameters<typeof CostController>[0] = {
    pricingPath: config.cost.pricingPath,
    warnAtFraction: config.cost.warnAtFraction,
  };
  if (config.cost.budgetPerRunUsd !== undefined)
    costControllerOpts.budgetPerRunUsd = config.cost.budgetPerRunUsd;
  if (config.cost.budgetPerDocumentUsd !== undefined)
    costControllerOpts.budgetPerDocumentUsd = config.cost.budgetPerDocumentUsd;
  if (options.continueOverBudget) costControllerOpts.continueOverBudget = true;
  const costController = new CostController(costControllerOpts);

  const extractor = new AnthropicTripleExtractor({
    model: config.extraction.model,
    temperature: config.extraction.temperature,
    maxRetries: config.extraction.maxRetries,
    ontology,
    recordCall: (info) => costController.recordCall(info),
    shouldHalt: () => costController.shouldHalt(),
  });

  const embeddings =
    options.embeddings !== false && config.embedding.enabled
      ? new EmbeddingGenerator({
          provider: config.embedding.provider,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
          batchSize: config.embedding.batchSize,
        })
      : null;
  if (embeddings) {
    embeddings.setUsageHook((info) =>
      costController.recordCall({
        callType: 'embedding',
        model: info.model,
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
      })
    );
  }

  const processingLog = new ProcessingLog(config.processingLog.path);
  const backend = new Neo4jBackend(config.storage.neo4j);

  await backend.connect();
  const schemaOpts: Parameters<typeof backend.applySchema>[0] = {};
  if (embeddings) {
    schemaOpts.paragraphEmbeddingDims = embeddings.dimensions;
    schemaOpts.entityEmbeddingDims = embeddings.dimensions;
    schemaOpts.embeddingModel = embeddings.modelName;
  }
  await backend.applySchema(schemaOpts);

  const resolver =
    embeddings && options.resolver !== false && config.extraction.resolution.enabled
      ? new EntityResolver(backend, embeddings, {
          enabled: config.extraction.resolution.enabled,
          model: config.extraction.resolution.model,
          similarityThreshold: config.extraction.resolution.similarityThreshold,
          highConfidenceThreshold: config.extraction.resolution.highConfidenceThreshold,
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
        })
      : null;

  // Phase 3: load plugins from config. Plugins are side-effect-free at
  // build time; their hooks are invoked by the pipeline during ingestion.
  const plugins =
    config.plugins.enabled.length > 0
      ? buildPluginManager(config.plugins.enabled, { costController })
      : null;

  const pipeline = new Pipeline({
    parsers,
    chunker,
    extractor,
    backend,
    log: processingLog,
    embeddings,
    resolver,
    costController,
    plugins,
    extractionBatchSize: config.extraction.batchSize,
  });

  const shutdown = async (code: number) => {
    log.info({ code }, 'cli.shutting_down');
    log.info(costController.reportSummary(), 'cli.cost_summary');
    try {
      await backend.disconnect();
    } catch (e) {
      log.warn({ error: e instanceof Error ? e.message : String(e) }, 'shutdown.backend');
    }
    try {
      processingLog.close();
    } catch (e) {
      log.warn({ error: e instanceof Error ? e.message : String(e) }, 'shutdown.log');
    }
    process.exit(code);
  };

  let interrupted = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (interrupted) return;
      interrupted = true;
      log.warn({ signal: sig }, 'cli.signal_received');
      void shutdown(130);
    });
  }

  try {
    if (options.file) {
      const stats = await pipeline.processFile(options.file);
      log.info(stats, 'cli.done');
      await shutdown(0);
      return;
    }
    if (options.folder) {
      const folder = options.folder;
      const files = await walkFolder(folder, { ignorePatterns: config.scanner.ignorePatterns });
      log.info({ folder, fileCount: files.length }, 'cli.folder_walked');
      if (files.length === 0) {
        log.warn({ folder }, 'cli.no_files_found');
        await shutdown(0);
        return;
      }

      if (options.queue === false) {
        // Simple sequential mode — useful for tests + small batches.
        for (const f of files) {
          try {
            const s = await pipeline.processFile(f);
            log.info({ file: f, ...s }, 'cli.file_done');
          } catch (e) {
            log.error(
              { file: f, error: e instanceof Error ? e.message : String(e) },
              'cli.file_failed'
            );
          }
        }
        // End-of-batch resolver pass to catch concurrently-extracted entities.
        if (resolver) {
          const stage1 = await resolver.resolveByNormalization();
          log.info(
            { stage1Merges: stage1.length },
            'cli.batch_end_resolution_complete'
          );
        }
        await shutdown(0);
        return;
      }

      // Queued mode — submit all jobs, run workers, drain.
      const queues = new JobQueues({
        redisUrl: config.scanner.queue.redisUrl,
        rateLimitMax: config.scanner.queue.rateLimitMax,
        rateLimitDurationMs: config.scanner.queue.rateLimitDurationMs,
        retryAttempts: config.scanner.queue.retryAttempts,
        retryBackoffBaseMs: config.scanner.queue.retryBackoffBaseMs,
      });
      const sizes = await Promise.all(
        files.map(async (f) => ({ f, size: (await stat(f)).size }))
      );
      for (const { f, size } of sizes) {
        await queues.enqueueFile(f, priorityForSize(size));
      }
      const workers = startWorkers({
        queues,
        pipeline,
        resolver,
        costController,
        fileConcurrency: config.scanner.queue.fileConcurrency,
        resolutionConcurrency: config.scanner.queue.resolutionConcurrency,
        rateLimitMax: config.scanner.queue.rateLimitMax,
        rateLimitDurationMs: config.scanner.queue.rateLimitDurationMs,
      });

      // Drain: poll counts every 2s; stop when both queues empty.
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        const fc = await queues.file.getJobCounts('waiting', 'active', 'delayed');
        const rc = await queues.resolution.getJobCounts('waiting', 'active', 'delayed');
        const fileTotal = (fc.waiting ?? 0) + (fc.active ?? 0) + (fc.delayed ?? 0);
        const resTotal = (rc.waiting ?? 0) + (rc.active ?? 0) + (rc.delayed ?? 0);
        log.debug({ fileTotal, resTotal }, 'cli.queue_drain_progress');
        if (fileTotal === 0 && resTotal === 0) break;
      }

      // End-of-batch global resolver pass.
      if (resolver) {
        const stage1 = await resolver.resolveByNormalization();
        log.info(
          { stage1Merges: stage1.length },
          'cli.batch_end_resolution_complete'
        );
      }

      await workers.close();
      await queues.close();
      await shutdown(0);
      return;
    }
  } catch (e) {
    log.error({ error: e instanceof Error ? e.message : String(e) }, 'cli.failed');
    await shutdown(1);
  }
}

const program = new Command();
program
  .name('knode')
  .description('Filesystem-to-knowledge-graph pipeline (Phase 3)')
  .option('-f, --file <path>', 'path to a single supported document to process')
  .option('--folder <path>', 'process every supported document under this folder')
  .option('-m, --mode <mode>', 'invocation mode: api (start the query server)')
  .option('-c, --config <path>', 'override config file path')
  .option('-l, --log-level <level>', 'log level (trace|debug|info|warn|error)')
  .option('--continue-over-budget', 'allow processing past the per-run cost budget')
  .option('--no-queue', 'in folder mode, process files sequentially instead of via BullMQ')
  .option('--no-resolver', 'disable the entity resolver for this run')
  .option('--no-embeddings', 'disable the embedding generator (useful for offline tests)')
  .action((opts: CliOptions) => {
    void run(opts);
  });

program.parseAsync(process.argv).catch((e) => {
  log.error({ error: e instanceof Error ? e.message : String(e) }, 'cli.fatal');
  process.exit(1);
});
