// `POST /api/v1/hybrid-search` — return a ranked SubGraph instead of a synthesized answer.
//
// Reuses the RAG anchor retrieval and graph expansion, then attaches scores
// to nodes/edges so callers can render a graph view. The trade-off vs. RAG:
// no LLM call (faster, cheaper) but the caller has to do their own
// synthesis. Use when the consumer is a UI or another agent.

import type { Hono } from 'hono';
import { z } from 'zod';
import type { EmbeddingGenerator } from '../extraction/embedding-generator.js';
import {
  type EntityRecord,
  GraphExpander,
  type ParagraphRecord,
  type RelationshipRecord,
} from './graph-expander.js';

export interface HybridSearchRequest {
  query: string;
  topKParagraphs?: number;
  topKEntities?: number;
  maxHops?: number;
  layoutWindow?: number;
  filters?: {
    documentTypes?: string[];
    documentIds?: string[];
    entityTypes?: string[];
  };
  // Min vector similarity for an anchor to count.
  minVectorScore?: number;
}

export interface ScoredParagraph extends ParagraphRecord {
  // 0..1 — vector similarity if anchor, otherwise a graph-derived score
  // (bounded by 1.0 / hop_distance) when reached via expansion.
  score: number;
  origin: 'vector' | 'expansion';
}

export interface ScoredEntity extends EntityRecord {
  score: number;
  origin: 'vector' | 'expansion';
}

export interface ScoredRelationship extends RelationshipRecord {
  score: number;
}

export interface HybridSearchResponse {
  paragraphs: ScoredParagraph[];
  entities: ScoredEntity[];
  relationships: ScoredRelationship[];
  diagnostics: {
    vectorRetrievalCount: number;
    expansionNodeCount: number;
    totalDurationMs: number;
  };
}

export interface HybridSearchOptions {
  expander: GraphExpander;
  embeddings: EmbeddingGenerator;
  defaultParagraphTopK: number;
  defaultEntityTopK: number;
  defaultMaxHops: number;
  defaultLayoutWindow: number;
}

// `HybridSearchService` is the abstract interface registered with the API
// server — keeps the endpoint layer decoupled from the implementation class.
export interface HybridSearchService {
  search(req: HybridSearchRequest): Promise<HybridSearchResponse>;
}

export class HybridSearch implements HybridSearchService {
  constructor(private readonly opts: HybridSearchOptions) {}

  async search(req: HybridSearchRequest): Promise<HybridSearchResponse> {
    const startedAt = Date.now();
    const topKP = req.topKParagraphs ?? this.opts.defaultParagraphTopK;
    const topKE = req.topKEntities ?? this.opts.defaultEntityTopK;
    const maxHops = req.maxHops ?? this.opts.defaultMaxHops;
    const layoutWindow = req.layoutWindow ?? this.opts.defaultLayoutWindow;

    const queryVec = await this.opts.embeddings.embedOne(req.query);

    const filters: Parameters<GraphExpander['vectorParagraphAnchors']>[2] = {};
    if (req.filters?.documentTypes) filters.documentTypes = req.filters.documentTypes;
    if (req.filters?.documentIds) filters.documentIds = req.filters.documentIds;
    if (req.filters?.entityTypes) filters.entityTypes = req.filters.entityTypes;
    if (req.minVectorScore !== undefined) filters.minVectorScore = req.minVectorScore;

    const [vecParagraphs, vecEntities] = await Promise.all([
      this.opts.expander.vectorParagraphAnchors(queryVec.vector, topKP, filters),
      this.opts.expander.vectorEntityAnchors(queryVec.vector, topKE, filters),
    ]);

    const paragraphIds = vecParagraphs.map((p) => p.id);
    const entityIds = vecEntities.map((e) => e.id);

    const [layout, semantic, cross] = await Promise.all([
      this.opts.expander.layoutExpand(paragraphIds, layoutWindow),
      this.opts.expander.semanticExpand(entityIds, maxHops),
      this.opts.expander.crossExpand(paragraphIds, maxHops),
    ]);

    // Score paragraphs: vector anchors get their similarity score; expanded
    // paragraphs get a 1/hopDistance heuristic, capped at 0.5 so they never
    // outrank a real anchor (preserves the vector signal as ground truth).
    const paragraphScored = new Map<string, ScoredParagraph>();
    for (const p of vecParagraphs) {
      paragraphScored.set(p.id, { ...p, score: p.vectorScore ?? 0, origin: 'vector' });
    }
    for (const p of [...layout.paragraphs, ...cross.paragraphs]) {
      if (paragraphScored.has(p.id)) continue;
      paragraphScored.set(p.id, { ...p, score: 0.4, origin: 'expansion' });
    }

    const entityScored = new Map<string, ScoredEntity>();
    for (const e of vecEntities) {
      entityScored.set(e.id, { ...e, score: e.vectorScore ?? 0, origin: 'vector' });
    }
    for (const e of [...semantic.entities, ...cross.entities]) {
      if (entityScored.has(e.id)) continue;
      entityScored.set(e.id, { ...e, score: 0.4, origin: 'expansion' });
    }

    const relScored: ScoredRelationship[] = semantic.relationships.map((r) => ({
      ...r,
      score: r.confidence,
    }));

    const paragraphs = [...paragraphScored.values()].sort((a, b) => b.score - a.score);
    const entities = [...entityScored.values()].sort((a, b) => b.score - a.score);
    const relationships = relScored.sort((a, b) => b.score - a.score);

    const totalDurationMs = Date.now() - startedAt;
    return {
      paragraphs,
      entities,
      relationships,
      diagnostics: {
        vectorRetrievalCount: vecParagraphs.length + vecEntities.length,
        expansionNodeCount:
          layout.paragraphs.length +
          semantic.entities.length +
          semantic.relationships.length +
          cross.paragraphs.length +
          cross.entities.length,
        totalDurationMs,
      },
    };
  }
}

const HybridSearchRequestSchema = z.object({
  query: z.string().min(1).max(4_000),
  topKParagraphs: z.number().int().positive().max(100).optional(),
  topKEntities: z.number().int().positive().max(100).optional(),
  maxHops: z.number().int().min(1).max(4).optional(),
  layoutWindow: z.number().int().nonnegative().max(5).optional(),
  minVectorScore: z.number().min(0).max(1).optional(),
  filters: z
    .object({
      documentTypes: z.array(z.string()).optional(),
      documentIds: z.array(z.string()).optional(),
      entityTypes: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
});

export function registerHybridSearchEndpoint(app: Hono, search: HybridSearchService): void {
  app.post('/api/v1/hybrid-search', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as unknown;
    const parsed = HybridSearchRequestSchema.safeParse(body);
    if (!parsed.success) throw parsed.error;
    // Strip undefined values — exactOptionalPropertyTypes forbids them.
    const req: HybridSearchRequest = { query: parsed.data.query };
    if (parsed.data.topKParagraphs !== undefined) req.topKParagraphs = parsed.data.topKParagraphs;
    if (parsed.data.topKEntities !== undefined) req.topKEntities = parsed.data.topKEntities;
    if (parsed.data.maxHops !== undefined) req.maxHops = parsed.data.maxHops;
    if (parsed.data.layoutWindow !== undefined) req.layoutWindow = parsed.data.layoutWindow;
    if (parsed.data.minVectorScore !== undefined) req.minVectorScore = parsed.data.minVectorScore;
    if (parsed.data.filters) {
      const f = parsed.data.filters;
      const filters: NonNullable<HybridSearchRequest['filters']> = {};
      if (f.documentTypes) filters.documentTypes = f.documentTypes;
      if (f.documentIds) filters.documentIds = f.documentIds;
      if (f.entityTypes) filters.entityTypes = f.entityTypes;
      req.filters = filters;
    }
    const result = await search.search(req);
    return c.json(result);
  });
}
