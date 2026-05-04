// Wraps the AI SDK's embed/embedMany. Provider-agnostic: pick `model` and
// `provider` from config; OpenAI text-embedding-3-small is the default. Cost
// of embedding is paid once at write time (see PRD §2 workstream 2).

import { openai } from '@ai-sdk/openai';
import { embed, embedMany, type EmbeddingModel } from 'ai';
import { ExtractionError } from '../shared/errors.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger('extraction.embedding');

export type EmbeddingProvider = 'openai' | 'ollama';

export interface EmbeddingGeneratorOptions {
  provider: EmbeddingProvider;
  model: string;
  // Required: Neo4j vector indexes pin the dimension at creation. Mismatch is
  // caught at startup; we never resize the index silently.
  dimensions: number;
  batchSize?: number;
  maxRetries?: number;
  // Optional injection point for tests + cost-controller wrapping.
  embedManyImpl?: typeof embedMany;
  embedImpl?: typeof embed;
}

export interface EmbeddingResult {
  id: string;
  vector: number[];
  dimensions: number;
  model: string;
  // Token counts as reported by the provider (sum across the batch attributed
  // pro-rata back to each input by the caller if needed). Often zero for
  // local/Ollama; that's fine.
  tokenUsage?: number;
}

export interface EmbeddingInput {
  id: string;
  text: string;
}

// Minimal cost-controller hook. The cost controller (workstream 4) sits in
// front of every LLM call; embedding-generator calls it with a batch summary
// after each successful request. We accept it as an option to keep the
// generator decoupled from the controller class itself.
export type EmbeddingUsageHook = (info: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  batchSize: number;
}) => void;

const DEFAULT_BATCH = 100;

function buildModel(provider: EmbeddingProvider, modelId: string): EmbeddingModel<string> {
  if (provider === 'openai') return openai.embedding(modelId);
  // Ollama exposes an OpenAI-compatible /v1/embeddings endpoint; we route
  // through the openai provider with a base URL override later (Phase 4).
  if (provider === 'ollama') return openai.embedding(modelId);
  throw new ExtractionError(`Unknown embedding provider: ${provider}`, { provider });
}

export class EmbeddingGenerator {
  private readonly model: EmbeddingModel<string>;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly embedMany: typeof embedMany;
  private readonly embed: typeof embed;
  private usageHook?: EmbeddingUsageHook;

  constructor(private readonly opts: EmbeddingGeneratorOptions) {
    if (!opts.dimensions || opts.dimensions <= 0)
      throw new ExtractionError('embedding dimensions must be positive', {
        model: opts.model,
      });
    this.model = buildModel(opts.provider, opts.model);
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
    this.maxRetries = opts.maxRetries ?? 2;
    this.embedMany = opts.embedManyImpl ?? embedMany;
    this.embed = opts.embedImpl ?? embed;
  }

  setUsageHook(hook: EmbeddingUsageHook): void {
    this.usageHook = hook;
  }

  get dimensions(): number {
    return this.opts.dimensions;
  }

  get modelName(): string {
    return this.opts.model;
  }

  async embedOne(text: string): Promise<EmbeddingResult> {
    const result = await this.embed({
      model: this.model,
      value: text,
      maxRetries: this.maxRetries,
    });
    const usage = (result as { usage?: { tokens?: number } }).usage ?? {};
    if (this.usageHook) {
      this.usageHook({
        model: this.opts.model,
        inputTokens: usage.tokens ?? 0,
        outputTokens: 0,
        batchSize: 1,
      });
    }
    const vector = result.embedding;
    this.assertDims(vector);
    return {
      id: 'one',
      vector,
      dimensions: this.opts.dimensions,
      model: this.opts.model,
      ...(usage.tokens !== undefined ? { tokenUsage: usage.tokens } : {}),
    };
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<EmbeddingResult[]> {
    if (inputs.length === 0) return [];
    const out: EmbeddingResult[] = [];
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const slice = inputs.slice(i, i + this.batchSize);
      const values = slice.map((s) => s.text);
      const startedAt = Date.now();
      try {
        const result = await this.embedMany({
          model: this.model,
          values,
          maxRetries: this.maxRetries,
        });
        const usage = (result as { usage?: { tokens?: number } }).usage ?? {};
        log.debug(
          {
            model: this.opts.model,
            batchSize: slice.length,
            durationMs: Date.now() - startedAt,
            tokens: usage.tokens,
          },
          'embedding.batch_success'
        );
        if (this.usageHook) {
          this.usageHook({
            model: this.opts.model,
            inputTokens: usage.tokens ?? 0,
            outputTokens: 0,
            batchSize: slice.length,
          });
        }
        const embeddings = result.embeddings;
        embeddings.forEach((vector, idx) => {
          this.assertDims(vector);
          const input = slice[idx];
          if (!input) return;
          out.push({
            id: input.id,
            vector,
            dimensions: this.opts.dimensions,
            model: this.opts.model,
          });
        });
      } catch (e) {
        log.error(
          {
            model: this.opts.model,
            batchSize: slice.length,
            error: e instanceof Error ? e.message : String(e),
          },
          'embedding.batch_failed'
        );
        throw new ExtractionError(
          'Embedding batch failed',
          { model: this.opts.model, batchSize: slice.length },
          e
        );
      }
    }
    return out;
  }

  private assertDims(vector: number[]): void {
    if (vector.length !== this.opts.dimensions) {
      throw new ExtractionError('Embedding dimension mismatch', {
        configured: this.opts.dimensions,
        actual: vector.length,
        model: this.opts.model,
      });
    }
  }
}

// Convenience factory: build "${name} (${type}): ${context}" for entity
// embeddings. Context is concatenated MENTIONED_IN sentences capped at ~500
// chars (PRD §2 workstream 2).
export function buildEntityEmbeddingText(
  name: string,
  type: string,
  contextSentences: string[]
): string {
  const ctx = contextSentences.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  return ctx ? `${name} (${type}): ${ctx}` : `${name} (${type})`;
}
