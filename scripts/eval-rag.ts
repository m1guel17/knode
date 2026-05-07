#!/usr/bin/env tsx
// scripts/eval-rag.ts — runs a curated set of (question, expected_documents,
// expected_answer_substring) tuples against the live RAG pipeline.
//
// Reports source-precision, source-recall, answer-faithfulness, latency, and
// per-question cost. Writes a JSON report to docs/rag-eval-report.json so it
// can be diffed across runs (the markdown summary in docs/rag-tuning.md is
// hand-curated from this output).
//
// Usage:
//   tsx scripts/eval-rag.ts \
//       [--config config/default.toml] \
//       [--set tests/fixtures/rag-eval-set.json] \
//       [--report docs/rag-eval-report.json] \
//       [--paragraph-top-k 10] [--entity-top-k 10] [--max-hops 2] [--alpha 0.7]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { CostController } from '../src/extraction/cost-controller.js';
import { EmbeddingGenerator } from '../src/extraction/embedding-generator.js';
import { GraphExpander, RagPipeline } from '../src/query/index.js';
import { loadConfig } from '../src/shared/config.js';
import { createChildLogger } from '../src/shared/logger.js';
import { Neo4jBackend } from '../src/storage/index.js';

const log = createChildLogger('eval-rag');

interface EvalQuestion {
  id: string;
  question: string;
  expectedDocuments: string[];
  expectedAnswerSubstring: string;
  tags?: string[];
}

interface EvalSet {
  version: string;
  description: string;
  questions: EvalQuestion[];
}

interface QuestionResult {
  id: string;
  question: string;
  durationMs: number;
  costUsd: number;
  retrievedDocuments: string[];
  expectedDocuments: string[];
  precision: number;
  recall: number;
  answerHasSubstring: boolean;
  expectedSubstring: string;
  answer: string;
  confident: boolean;
  contextTokens: number;
  orphanCitations: number[];
}

interface EvalReport {
  generatedAt: string;
  set: string;
  parameters: Record<string, unknown>;
  questions: QuestionResult[];
  summary: {
    questionCount: number;
    avgPrecision: number;
    avgRecall: number;
    answerFaithfulness: number;
    avgLatencyMs: number;
    totalCostUsd: number;
  };
}

function intersection<T>(a: T[], b: T[]): T[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

function precisionAt(retrieved: string[], expected: string[]): number {
  if (retrieved.length === 0) return 0;
  return intersection(retrieved, expected).length / retrieved.length;
}

function recallAt(retrieved: string[], expected: string[]): number {
  if (expected.length === 0) return 1;
  return intersection(retrieved, expected).length / expected.length;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .option('-c, --config <path>', 'config path', 'config/default.toml')
    .option('-s, --set <path>', 'eval set JSON', 'tests/fixtures/rag-eval-set.json')
    .option('-r, --report <path>', 'JSON report output', 'docs/rag-eval-report.json')
    .option('--paragraph-top-k <n>', 'paragraph top-K', (v) => Number(v))
    .option('--entity-top-k <n>', 'entity top-K', (v) => Number(v))
    .option('--max-hops <n>', 'max hops', (v) => Number(v))
    .option('--alpha <n>', 'rank alpha', (v) => Number(v))
    .parse(process.argv);
  const opts = program.opts();

  const config = loadConfig(opts.config ? { configPath: opts.config } : {});
  const setPath = resolve(opts.set);
  const set = JSON.parse(readFileSync(setPath, 'utf8')) as EvalSet;

  if (!process.env.ANTHROPIC_API_KEY) {
    log.error('ANTHROPIC_API_KEY is required');
    process.exit(2);
  }
  if (!process.env.OPENAI_API_KEY && config.embedding.provider === 'openai') {
    log.error('OPENAI_API_KEY is required for the configured embedding provider');
    process.exit(2);
  }

  const costController = new CostController({
    pricingPath: config.cost.pricingPath,
    warnAtFraction: 1.1, // never warn during eval
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
  // Read-only on the eval — do not re-apply schema (avoid spurious mutation).

  const expander = new GraphExpander({
    driver: backend.getDriver(),
    database: backend.getDatabase(),
  });

  const pipeline = new RagPipeline({
    expander,
    embeddings,
    answerModel: config.rag.answerModel,
    answerTemperature: config.rag.answerTemperature,
    defaultParagraphTopK: opts.paragraphTopK ?? config.rag.paragraphTopK,
    defaultEntityTopK: opts.entityTopK ?? config.rag.entityTopK,
    defaultMaxHops: opts.maxHops ?? config.rag.maxHops,
    defaultLayoutWindow: config.rag.layoutWindow,
    defaultMaxContextTokens: config.rag.maxContextTokens,
    defaultRankAlpha: opts.alpha ?? config.rag.rankAlpha,
    maxAnswerTokens: config.rag.maxAnswerTokens,
    costController,
  });

  const params = {
    paragraphTopK: opts.paragraphTopK ?? config.rag.paragraphTopK,
    entityTopK: opts.entityTopK ?? config.rag.entityTopK,
    maxHops: opts.maxHops ?? config.rag.maxHops,
    rankAlpha: opts.alpha ?? config.rag.rankAlpha,
    maxContextTokens: config.rag.maxContextTokens,
  };
  log.info({ setPath, parameters: params }, 'eval.starting');

  const results: QuestionResult[] = [];

  for (const q of set.questions) {
    const startCost = costController.snapshot().totalUsd;
    const startTime = Date.now();
    try {
      const response = await pipeline.query({ question: q.question });
      const elapsed = Date.now() - startTime;
      const cost = costController.snapshot().totalUsd - startCost;
      const retrieved = [...new Set(response.sources.map((s) => s.documentName))];
      const lower = response.answer.toLowerCase();
      const answerHasSubstring =
        q.expectedAnswerSubstring.length === 0 ||
        lower.includes(q.expectedAnswerSubstring.toLowerCase());

      const result: QuestionResult = {
        id: q.id,
        question: q.question,
        durationMs: elapsed,
        costUsd: cost,
        retrievedDocuments: retrieved,
        expectedDocuments: q.expectedDocuments,
        precision: precisionAt(retrieved, q.expectedDocuments),
        recall: recallAt(retrieved, q.expectedDocuments),
        answerHasSubstring,
        expectedSubstring: q.expectedAnswerSubstring,
        answer: response.answer,
        confident: response.diagnostics.confident,
        contextTokens: response.diagnostics.contextTokens,
        orphanCitations: response.diagnostics.orphanCitations,
      };
      results.push(result);
      log.info(
        {
          id: q.id,
          precision: result.precision,
          recall: result.recall,
          faithful: result.answerHasSubstring,
          confident: result.confident,
          durationMs: elapsed,
        },
        'eval.question_done'
      );
    } catch (e) {
      log.error(
        { id: q.id, error: e instanceof Error ? e.message : String(e) },
        'eval.question_failed'
      );
    }
  }

  const summary = {
    questionCount: results.length,
    avgPrecision: avg(results.map((r) => r.precision)),
    avgRecall: avg(results.map((r) => r.recall)),
    answerFaithfulness: results.length
      ? results.filter((r) => r.answerHasSubstring).length / results.length
      : 0,
    avgLatencyMs: avg(results.map((r) => r.durationMs)),
    totalCostUsd: results.reduce((acc, r) => acc + r.costUsd, 0),
  };

  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    set: setPath,
    parameters: params,
    questions: results,
    summary,
  };

  const reportPath = resolve(opts.report);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log.info({ reportPath, ...summary }, 'eval.complete');

  await backend.disconnect();
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

main().catch((e) => {
  log.error({ error: e instanceof Error ? e.message : String(e) }, 'eval.fatal');
  process.exit(1);
});
