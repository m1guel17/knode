// `POST /api/v1/rag` — natural-language question, cited answer.
// Body validated by Zod; the pipeline does the work; ?diagnose=true returns
// the full trace.

import type { Hono } from 'hono';
import { z } from 'zod';
import type { RagPipeline, RAGQuery } from './rag-pipeline.js';

export type RagService = RagPipeline;

const RagFiltersSchema = z
  .object({
    documentTypes: z.array(z.string()).optional(),
    documentIds: z.array(z.string()).optional(),
    entityTypes: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const RagRequestSchema = z.object({
  question: z.string().min(1).max(4_000),
  topKParagraphs: z.number().int().positive().max(50).optional(),
  topKEntities: z.number().int().positive().max(50).optional(),
  maxHops: z.number().int().min(1).max(4).optional(),
  layoutWindow: z.number().int().nonnegative().max(5).optional(),
  maxContextTokens: z.number().int().positive().max(16_000).optional(),
  rankAlpha: z.number().min(0).max(1).optional(),
  filters: RagFiltersSchema,
});

export function registerRagEndpoint(app: Hono, rag: RagService): void {
  app.post('/api/v1/rag', async (c) => {
    const diagnose = c.req.query('diagnose') === 'true';
    const body = (await c.req.json().catch(() => ({}))) as unknown;
    const parsed = RagRequestSchema.safeParse(body);
    if (!parsed.success) throw parsed.error;
    // Build the RAGQuery without undefined values — exactOptionalPropertyTypes
    // forbids passing { topK: undefined } where the target property is `topK?: number`.
    const req: RAGQuery = { question: parsed.data.question };
    if (parsed.data.topKParagraphs !== undefined) req.topKParagraphs = parsed.data.topKParagraphs;
    if (parsed.data.topKEntities !== undefined) req.topKEntities = parsed.data.topKEntities;
    if (parsed.data.maxHops !== undefined) req.maxHops = parsed.data.maxHops;
    if (parsed.data.layoutWindow !== undefined) req.layoutWindow = parsed.data.layoutWindow;
    if (parsed.data.maxContextTokens !== undefined)
      req.maxContextTokens = parsed.data.maxContextTokens;
    if (parsed.data.rankAlpha !== undefined) req.rankAlpha = parsed.data.rankAlpha;
    if (parsed.data.filters) {
      const f = parsed.data.filters;
      const filters: NonNullable<RAGQuery['filters']> = {};
      if (f.documentTypes) filters.documentTypes = f.documentTypes;
      if (f.documentIds) filters.documentIds = f.documentIds;
      if (f.entityTypes) filters.entityTypes = f.entityTypes;
      req.filters = filters;
    }
    if (diagnose) req.diagnose = true;
    const response = await rag.query(req);
    return c.json(response);
  });
}
