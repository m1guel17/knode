// TOML config loader: default.toml + {NODE_ENV}.toml + env overrides, validated by Zod.
// Read once at boot, passed explicitly down — no global singleton.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { ConfigError } from './errors.js';

const ChunkerConfigSchema = z.object({
  targetTokens: z.number().int().positive(),
  overlapTokens: z.number().int().nonnegative(),
  ocrThresholdCharsPerPage: z.number().int().nonnegative(),
  minChunkTokens: z.number().int().nonnegative().optional(),
  maxChunkTokens: z.number().int().positive().optional(),
  splitOn: z.array(z.enum(['heading', 'paragraph', 'sentence'])).optional(),
});

const ResolutionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().min(1),
  similarityThreshold: z.number().min(0).max(1).default(0.92),
  highConfidenceThreshold: z.number().min(0).max(1).default(0.99),
  maxCandidatesPerEntity: z.number().int().positive().default(5),
  skipTypes: z.array(z.string()).default([]),
});

const ExtractionConfigSchema = z.object({
  provider: z.literal('anthropic'),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxRetries: z.number().int().min(0).max(5),
  ontologyPath: z.string().min(1),
  batchSize: z.number().int().positive().default(5),
  resolution: ResolutionConfigSchema,
});

const EmbeddingConfigSchema = z.object({
  provider: z.enum(['openai', 'ollama', 'google']),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  batchSize: z.number().int().positive().default(100),
  enabled: z.boolean().default(true),
});

const Neo4jConfigSchema = z.object({
  uri: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1),
  database: z.string().min(1),
});

const StorageConfigSchema = z.object({
  neo4j: Neo4jConfigSchema,
});

const ProcessingLogConfigSchema = z.object({
  path: z.string().min(1),
});

const QueueConfigSchema = z.object({
  redisUrl: z.string().min(1).default('redis://localhost:6379'),
  fileConcurrency: z.number().int().positive().default(2),
  resolutionConcurrency: z.number().int().positive().default(4),
  rateLimitMax: z.number().int().positive().default(10),
  rateLimitDurationMs: z.number().int().positive().default(60_000),
  retryAttempts: z.number().int().positive().default(3),
  retryBackoffBaseMs: z.number().int().positive().default(5_000),
});

const ScannerConfigSchema = z.object({
  ignorePatterns: z.array(z.string()).default([]),
  queue: QueueConfigSchema.default({} as never),
});

const CostConfigSchema = z.object({
  pricingPath: z.string().min(1).default('config/pricing.toml'),
  budgetPerRunUsd: z.number().nonnegative().optional(),
  budgetPerDocumentUsd: z.number().nonnegative().optional(),
  warnAtFraction: z.number().min(0).max(1).default(0.8),
});

const ApiConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().positive().default(3030),
  // Cypher endpoint guard rails. The denylist below is a last-line defense in
  // addition to neo4j's READ session mode.
  cypherTimeoutMs: z.number().int().positive().default(30_000),
  cypherMaxRows: z.number().int().positive().default(10_000),
  // Logged at info-level — the query text itself is hashed; this sets whether
  // the raw query is also logged at debug level for triage.
  logQueryText: z.boolean().default(false),
});

const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // The model that synthesizes the final answer. Tier this against extraction:
  // RAG quality lives or dies on this model, so default to Sonnet.
  answerModel: z.string().min(1).default('claude-sonnet-4-6'),
  answerTemperature: z.number().min(0).max(2).default(0.0),
  // Step 1 retrieval breadth.
  paragraphTopK: z.number().int().positive().default(10),
  entityTopK: z.number().int().positive().default(10),
  // Step 2 expansion.
  maxHops: z.number().int().positive().max(4).default(2),
  layoutWindow: z.number().int().nonnegative().default(1),
  // Step 3 packing.
  maxContextTokens: z.number().int().positive().default(4000),
  maxAnswerTokens: z.number().int().positive().default(1024),
  // Ranking weight: alpha * vector + (1-alpha) * entity_match_count/total_anchors.
  rankAlpha: z.number().min(0).max(1).default(0.7),
});

const HybridSearchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paragraphTopK: z.number().int().positive().default(15),
  entityTopK: z.number().int().positive().default(15),
  maxHops: z.number().int().positive().max(4).default(2),
  layoutWindow: z.number().int().nonnegative().default(1),
});

const PluginEntrySchema = z.object({
  name: z.string().min(1),
  errorMode: z.enum(['continue', 'halt']).default('continue'),
  options: z.record(z.unknown()).default({}),
});

const PluginsConfigSchema = z.object({
  // Plugins are listed by name; the actual class is wired in code (no dynamic
  // import, no sandbox). PluginManager looks up the constructor in a static
  // registry and calls it with `options`.
  enabled: z.array(PluginEntrySchema).default([]),
});

const ConfigSchema = z.object({
  chunker: ChunkerConfigSchema,
  extraction: ExtractionConfigSchema,
  embedding: EmbeddingConfigSchema,
  storage: StorageConfigSchema,
  processingLog: ProcessingLogConfigSchema,
  scanner: ScannerConfigSchema.default({} as never),
  cost: CostConfigSchema.default({} as never),
  api: ApiConfigSchema.default({} as never),
  rag: RagConfigSchema.default({} as never),
  hybridSearch: HybridSearchConfigSchema.default({} as never),
  plugins: PluginsConfigSchema.default({} as never),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ChunkerConfig = z.infer<typeof ChunkerConfigSchema>;
export type ExtractionConfig = z.infer<typeof ExtractionConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type ResolutionConfig = z.infer<typeof ResolutionConfigSchema>;
export type Neo4jConfig = z.infer<typeof Neo4jConfigSchema>;
export type ScannerConfig = z.infer<typeof ScannerConfigSchema>;
export type QueueConfig = z.infer<typeof QueueConfigSchema>;
export type CostConfig = z.infer<typeof CostConfigSchema>;
export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type RagConfig = z.infer<typeof RagConfigSchema>;
export type HybridSearchConfig = z.infer<typeof HybridSearchConfigSchema>;
export type PluginEntry = z.infer<typeof PluginEntrySchema>;
export type PluginsConfig = z.infer<typeof PluginsConfigSchema>;

interface LoadOptions {
  configDir?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

function readTomlIfExists(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, 'utf8');
    return parseToml(raw) as Record<string, unknown>;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new ConfigError(`Failed to read config at ${path}`, { path }, e);
  }
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>
): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const existing = out[k];
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (env.NEO4J_URI || env.NEO4J_USER || env.NEO4J_PASSWORD || env.NEO4J_DATABASE) {
    const neo4j: Record<string, unknown> = {};
    if (env.NEO4J_URI) neo4j.uri = env.NEO4J_URI;
    if (env.NEO4J_USER) neo4j.user = env.NEO4J_USER;
    if (env.NEO4J_PASSWORD) neo4j.password = env.NEO4J_PASSWORD;
    if (env.NEO4J_DATABASE) neo4j.database = env.NEO4J_DATABASE;
    out.storage = { neo4j };
  }
  if (env.KNODE_DATA_DIR) {
    out.processingLog = { path: `${env.KNODE_DATA_DIR}/processing-log.db` };
  }
  if (env.KNODE_EXTRACTION_MODEL) {
    out.extraction = { model: env.KNODE_EXTRACTION_MODEL };
  }
  if (env.KNODE_RESOLUTION_MODEL) {
    out.extraction = {
      ...((out.extraction as Record<string, unknown>) ?? {}),
      resolution: { model: env.KNODE_RESOLUTION_MODEL },
    };
  }
  if (env.REDIS_URL) {
    out.scanner = { queue: { redisUrl: env.REDIS_URL } };
  }
  if (env.KNODE_BUDGET_PER_RUN_USD) {
    out.cost = {
      ...((out.cost as Record<string, unknown>) ?? {}),
      budgetPerRunUsd: Number(env.KNODE_BUDGET_PER_RUN_USD),
    };
  }
  if (env.KNODE_API_PORT || env.KNODE_API_HOST) {
    const api: Record<string, unknown> = {};
    if (env.KNODE_API_PORT) api.port = Number(env.KNODE_API_PORT);
    if (env.KNODE_API_HOST) api.host = env.KNODE_API_HOST;
    out.api = { ...((out.api as Record<string, unknown>) ?? {}), ...api };
  }
  if (env.KNODE_RAG_ANSWER_MODEL) {
    out.rag = {
      ...((out.rag as Record<string, unknown>) ?? {}),
      answerModel: env.KNODE_RAG_ANSWER_MODEL,
    };
  }
  return out;
}

export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const nodeEnv = env.NODE_ENV ?? 'development';

  let merged: Record<string, unknown> = {};

  if (opts.configPath) {
    const explicit = readTomlIfExists(resolve(opts.configPath));
    if (!explicit) {
      throw new ConfigError(`Config file not found: ${opts.configPath}`, {
        path: opts.configPath,
      });
    }
    merged = explicit;
  } else {
    const dir = resolve(opts.configDir ?? 'config');
    const def = readTomlIfExists(resolve(dir, 'default.toml'));
    if (!def) {
      throw new ConfigError(`default.toml not found in ${dir}`, { dir });
    }
    merged = def;
    const envFile = readTomlIfExists(resolve(dir, `${nodeEnv}.toml`));
    if (envFile) merged = deepMerge(merged, envFile);
  }

  merged = deepMerge(merged, envOverrides(env));

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError('Invalid configuration', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}
