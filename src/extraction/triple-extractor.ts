// Anthropic-backed triple extractor. Single provider in Phase 1; the interface
// makes additional providers cheap to add later.

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { ExtractionError } from '../shared/errors.js';
import { createChildLogger } from '../shared/logger.js';
import type { Chunk, ExtractionResult, Ontology } from '../shared/types.js';
import type { TripleExtractor } from './interfaces.js';
import { buildExtractionPrompt } from './prompts/extraction-prompt.js';

const log = createChildLogger('extraction.triple');

const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  properties: z.record(z.string()).default({}),
  confidence: z.number().min(0).max(1),
});

const ExtractedRelationshipSchema = z.object({
  sourceEntity: z.string().min(1),
  relationship: z.string().min(1),
  targetEntity: z.string().min(1),
  properties: z.record(z.string()).default({}),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1),
});

const ExtractionSchema = z.object({
  entities: z.array(ExtractedEntitySchema),
  relationships: z.array(ExtractedRelationshipSchema),
  confidence: z.number().min(0).max(1),
});

export interface AnthropicExtractorOptions {
  model: string;
  temperature: number;
  maxRetries: number;
  ontology: Ontology;
  // Optional override for tests — defaults to the real Anthropic provider.
  generate?: typeof generateObject;
  // Cost-controller hook. The extractor calls this after every LLM response
  // (success or failure-after-retries gets nothing). Optional so tests don't
  // need a controller.
  recordCall?: (info: {
    callType: 'extraction';
    model: string;
    inputTokens: number;
    outputTokens: number;
    documentId?: string | null;
    chunkId?: string | null;
  }) => void;
  // Returning true halts the extractor before issuing a new call (cost stop).
  shouldHalt?: () => boolean;
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (typeof status === 'number') return TRANSIENT_STATUSES.has(status);
  const name = (err as { name?: string }).name ?? '';
  return /timeout|network|fetch/i.test(name);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export class AnthropicTripleExtractor implements TripleExtractor {
  private readonly generate: typeof generateObject;

  constructor(private readonly opts: AnthropicExtractorOptions) {
    this.generate = opts.generate ?? generateObject;
  }

  async extract(chunk: Chunk): Promise<ExtractionResult> {
    if (this.opts.shouldHalt?.()) {
      throw new ExtractionError('Extraction halted by cost controller', {
        chunkId: chunk.id,
        model: this.opts.model,
      });
    }
    const { system, user } = buildExtractionPrompt(chunk, this.opts.ontology);
    const startedAt = Date.now();
    const inputCharCount = system.length + user.length;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        const result = await this.generate({
          model: anthropic(this.opts.model),
          schema: ExtractionSchema,
          system,
          prompt: user,
          temperature: this.opts.temperature,
        });

        const usage =
          (result as { usage?: { promptTokens?: number; completionTokens?: number } }).usage ?? {};
        if (this.opts.recordCall) {
          this.opts.recordCall({
            callType: 'extraction',
            model: this.opts.model,
            inputTokens: usage.promptTokens ?? 0,
            outputTokens: usage.completionTokens ?? 0,
            documentId: chunk.documentId,
            chunkId: chunk.id,
          });
        }
        log.info(
          {
            chunkId: chunk.id,
            model: this.opts.model,
            attempt,
            durationMs: Date.now() - startedAt,
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            entityCount: result.object.entities.length,
            relationshipCount: result.object.relationships.length,
          },
          'extraction.success'
        );

        const obj = result.object;
        return {
          entities: obj.entities.map((e) => ({
            name: e.name,
            type: e.type,
            aliases: e.aliases,
            properties: e.properties,
            confidence: e.confidence,
            sourceChunkId: chunk.id,
          })),
          relationships: obj.relationships,
          confidence: obj.confidence,
        };
      } catch (e) {
        lastErr = e;
        const transient = isTransient(e);
        log.warn(
          {
            chunkId: chunk.id,
            attempt,
            transient,
            error: e instanceof Error ? e.message : String(e),
          },
          'extraction.attempt_failed'
        );
        if (!transient || attempt >= this.opts.maxRetries) break;
        const backoffMs = 2 ** attempt * 500;
        await sleep(backoffMs);
      }
    }

    log.error(
      {
        chunkId: chunk.id,
        model: this.opts.model,
        durationMs: Date.now() - startedAt,
        inputCharCount,
      },
      'extraction.failed'
    );
    throw new ExtractionError(
      `Extraction failed for chunk ${chunk.id}`,
      { chunkId: chunk.id, model: this.opts.model },
      lastErr
    );
  }
}
