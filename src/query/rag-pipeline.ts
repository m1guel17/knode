// The RAG pipeline. Three steps, each method-per-step so they can be unit
// tested independently:
//   retrieveAnchors → expandGraph → assembleContext → generateAnswer
//
// Stateless: each query() call is independent. Caching is deferred to a
// future phase (see project.md §5.2 trade-offs).

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject, type generateObject as GenerateObject } from 'ai';
import { ExtractionError } from '../shared/errors.js';
import {
  buildRagAnswerPrompt,
  findOrphanCitations,
  RagAnswerSchema,
  type RagAnswer,
} from '../extraction/prompts/rag-answer-prompt.js';
import { createChildLogger } from '../shared/logger.js';
import type { CostController } from '../extraction/cost-controller.js';
import type { EmbeddingGenerator } from '../extraction/embedding-generator.js';
import {
  assembleContext,
  type AssembledContext,
} from './context-assembler.js';
import {
  type EntityRecord,
  GraphExpander,
  type ParagraphRecord,
  type RelationshipRecord,
  type SubGraphFragment,
  type ExpansionFilters,
} from './graph-expander.js';

const log = createChildLogger('query.rag');

export interface RagFilters {
  documentTypes?: string[];
  documentIds?: string[];
  entityTypes?: string[];
}

export interface RAGQuery {
  question: string;
  topKParagraphs?: number;
  topKEntities?: number;
  maxHops?: number;
  layoutWindow?: number;
  maxContextTokens?: number;
  rankAlpha?: number;
  filters?: RagFilters;
  // When true, attach the full pipeline trace to the response.
  diagnose?: boolean;
}

export interface RAGSource {
  citationKey: number;
  documentName: string;
  pageNumber: number | null;
  sectionHeading: string | null;
  relevantText: string;
  confidence: number;
  // Original paragraph id — useful for follow-up queries.
  paragraphId: string;
}

export interface RAGResponse {
  answer: string;
  sources: RAGSource[];
  graphContext: {
    entities: { id: string; name: string; type: string }[];
    relationships: { source: string; relation: string; target: string }[];
  };
  diagnostics: {
    vectorRetrievalCount: number;
    expansionNodeCount: number;
    contextTokens: number;
    answerTokens: number;
    totalDurationMs: number;
    confident: boolean;
    orphanCitations: number[]; // citations the LLM made that we couldn't verify
    truncatedContext: boolean;
  };
  // Only populated when `diagnose: true` was requested.
  trace?: RAGTrace;
}

export interface RAGTrace {
  question: string;
  filters: RagFilters | null;
  anchorParagraphs: ParagraphRecord[];
  anchorEntities: EntityRecord[];
  expandedParagraphs: ParagraphRecord[];
  expandedEntities: EntityRecord[];
  expandedRelationships: RelationshipRecord[];
  assembledContext: string;
  systemPrompt: string;
  rawAnswer: RagAnswer;
}

export interface RagPipelineOptions {
  expander: GraphExpander;
  embeddings: EmbeddingGenerator;
  // The model that synthesizes the final answer. Tier this against extraction.
  answerModel: string;
  answerTemperature: number;
  defaultParagraphTopK: number;
  defaultEntityTopK: number;
  defaultMaxHops: number;
  defaultLayoutWindow: number;
  defaultMaxContextTokens: number;
  defaultRankAlpha: number;
  maxAnswerTokens: number;
  // Cost controller hook — invoked after every LLM call.
  costController?: CostController | null;
  // Test injection point.
  generate?: typeof generateObject;
}

export class RagPipeline {
  private readonly generate: typeof generateObject;

  constructor(private readonly opts: RagPipelineOptions) {
    this.generate = opts.generate ?? generateObject;
  }

  async query(req: RAGQuery): Promise<RAGResponse> {
    const startedAt = Date.now();
    const filters: RagFilters = req.filters ?? {};
    const topKP = req.topKParagraphs ?? this.opts.defaultParagraphTopK;
    const topKE = req.topKEntities ?? this.opts.defaultEntityTopK;
    const maxHops = req.maxHops ?? this.opts.defaultMaxHops;
    const layoutWindow = req.layoutWindow ?? this.opts.defaultLayoutWindow;
    const maxContextTokens = req.maxContextTokens ?? this.opts.defaultMaxContextTokens;
    const rankAlpha = req.rankAlpha ?? this.opts.defaultRankAlpha;

    // Step 1 — vector retrieval.
    const anchors = await this.retrieveAnchors(req.question, topKP, topKE, filters);

    // Step 2 — graph expansion.
    const expanded = await this.expandGraph(
      anchors.paragraphs,
      anchors.entities,
      maxHops,
      layoutWindow
    );

    // Step 3 — context assembly.
    const anchorEntityIds = new Set(anchors.entities.map((e) => e.id));
    const allParagraphs = mergeParagraphs(anchors.paragraphs, expanded.paragraphs);
    const allEntities = mergeEntities(anchors.entities, expanded.entities);
    const paragraphMentions = await this.opts.expander.paragraphEntityMentions(
      allParagraphs.map((p) => p.id)
    );

    const assembled = assembleContext({
      question: req.question,
      paragraphs: allParagraphs,
      entities: allEntities,
      relationships: expanded.relationships,
      anchorEntityIds,
      paragraphMentions,
      rankAlpha,
      maxContextTokens,
    });

    // Step 4 — answer generation. Cross-check citations against the assembled
    // context so a hallucinated [99] doesn't slip through.
    const allowedKeys = new Set(assembled.sources.map((s) => s.citationKey));
    const { answer, prompt } = await this.generateAnswer(req.question, assembled);
    const orphans = findOrphanCitations(answer.answer, allowedKeys);

    const totalDurationMs = Date.now() - startedAt;

    const sources: RAGSource[] = assembled.sources.map((s) => ({
      citationKey: s.citationKey,
      documentName: s.paragraph.fileName,
      pageNumber: s.paragraph.pageNumber,
      sectionHeading: s.paragraph.sectionHeading,
      relevantText: s.paragraph.content,
      confidence: round(s.confidence, 4),
      paragraphId: s.paragraph.id,
    }));

    const response: RAGResponse = {
      answer: answer.answer,
      sources,
      graphContext: {
        entities: assembled.graphContext.entities.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
        })),
        relationships: assembled.graphContext.relationships.map((r) => ({
          source: r.sourceName,
          relation: r.type,
          target: r.targetName,
        })),
      },
      diagnostics: {
        vectorRetrievalCount: anchors.paragraphs.length + anchors.entities.length,
        expansionNodeCount:
          expanded.paragraphs.length +
          expanded.entities.length +
          expanded.relationships.length,
        contextTokens: assembled.contextTokens,
        answerTokens: approximateTokenCount(answer.answer),
        totalDurationMs,
        confident: answer.confident,
        orphanCitations: orphans,
        truncatedContext: assembled.truncated,
      },
    };

    if (req.diagnose) {
      response.trace = {
        question: req.question,
        filters: Object.keys(filters).length > 0 ? filters : null,
        anchorParagraphs: anchors.paragraphs,
        anchorEntities: anchors.entities,
        expandedParagraphs: expanded.paragraphs,
        expandedEntities: expanded.entities,
        expandedRelationships: expanded.relationships,
        assembledContext: assembled.contextBlock,
        systemPrompt: prompt.system,
        rawAnswer: answer,
      };
    }

    log.info(
      {
        question: truncateForLog(req.question, 100),
        durationMs: totalDurationMs,
        anchors: anchors.paragraphs.length + anchors.entities.length,
        expanded:
          expanded.paragraphs.length +
          expanded.entities.length +
          expanded.relationships.length,
        sources: sources.length,
        contextTokens: assembled.contextTokens,
        confident: answer.confident,
        orphans: orphans.length,
      },
      'rag.query_complete'
    );

    return response;
  }

  async retrieveAnchors(
    question: string,
    topKP: number,
    topKE: number,
    filters: RagFilters
  ): Promise<{ paragraphs: ParagraphRecord[]; entities: EntityRecord[] }> {
    const queryVec = await this.opts.embeddings.embedOne(question);
    const expansionFilters: ExpansionFilters = {};
    if (filters.documentTypes) expansionFilters.documentTypes = filters.documentTypes;
    if (filters.documentIds) expansionFilters.documentIds = filters.documentIds;
    if (filters.entityTypes) expansionFilters.entityTypes = filters.entityTypes;
    const [paragraphs, entities] = await Promise.all([
      this.opts.expander.vectorParagraphAnchors(queryVec.vector, topKP, expansionFilters),
      this.opts.expander.vectorEntityAnchors(queryVec.vector, topKE, expansionFilters),
    ]);
    return { paragraphs, entities };
  }

  async expandGraph(
    anchorParagraphs: ParagraphRecord[],
    anchorEntities: EntityRecord[],
    maxHops: number,
    layoutWindow: number
  ): Promise<SubGraphFragment> {
    const paragraphIds = anchorParagraphs.map((p) => p.id);
    const entityIds = anchorEntities.map((e) => e.id);

    const [layout, semantic, cross] = await Promise.all([
      this.opts.expander.layoutExpand(paragraphIds, layoutWindow),
      this.opts.expander.semanticExpand(entityIds, maxHops),
      this.opts.expander.crossExpand(paragraphIds, maxHops),
    ]);

    return {
      paragraphs: mergeParagraphs(layout.paragraphs, cross.paragraphs),
      entities: mergeEntities(semantic.entities, cross.entities),
      relationships: semantic.relationships,
    };
  }

  async generateAnswer(
    question: string,
    assembled: AssembledContext
  ): Promise<{ answer: RagAnswer; prompt: { system: string; user: string } }> {
    const prompt = buildRagAnswerPrompt(assembled.contextBlock);
    try {
      const result = await this.generate({
        model: anthropic(this.opts.answerModel),
        system: prompt.system,
        prompt: prompt.user,
        schema: RagAnswerSchema,
        temperature: this.opts.answerTemperature,
        maxTokens: this.opts.maxAnswerTokens,
      });
      const usage = (result as unknown as { usage?: { promptTokens?: number; completionTokens?: number } })
        .usage ?? {};
      this.opts.costController?.recordCall({
        callType: 'extraction', // RAG answer-gen costs are tracked under extraction's bucket
        model: this.opts.answerModel,
        inputTokens: usage.promptTokens ?? approximateTokenCount(prompt.user) + approximateTokenCount(prompt.system),
        outputTokens: usage.completionTokens ?? approximateTokenCount(result.object.answer),
      });
      return { answer: result.object, prompt };
    } catch (e) {
      log.error(
        { error: e instanceof Error ? e.message : String(e), question: truncateForLog(question, 80) },
        'rag.answer_failed'
      );
      throw new ExtractionError(
        'RAG answer generation failed',
        { model: this.opts.answerModel },
        e
      );
    }
  }
}

function mergeParagraphs(...lists: ParagraphRecord[][]): ParagraphRecord[] {
  const out: ParagraphRecord[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const p of list) {
      if (seen.has(p.id)) {
        // If a paragraph showed up in vector retrieval AND in expansion, keep
        // the higher vectorScore (anchor result wins).
        const existing = out.find((x) => x.id === p.id);
        if (existing && p.vectorScore !== undefined && p.vectorScore > (existing.vectorScore ?? 0)) {
          existing.vectorScore = p.vectorScore;
        }
        continue;
      }
      seen.add(p.id);
      out.push({ ...p });
    }
  }
  return out;
}

function mergeEntities(...lists: EntityRecord[][]): EntityRecord[] {
  const out: EntityRecord[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const e of list) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ ...e });
    }
  }
  return out;
}

function approximateTokenCount(s: string): number {
  return Math.ceil(s.length / 4);
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function truncateForLog(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
