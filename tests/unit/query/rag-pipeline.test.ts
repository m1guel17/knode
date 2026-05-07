// RAG pipeline orchestration test. The expander and embedding generator are
// stubbed so we exercise the three-step glue + answer cross-checking without
// hitting Neo4j or an LLM.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RagPipeline } from '../../../src/query/rag-pipeline.js';
import type {
  EntityRecord,
  ExpansionFilters,
  ParagraphRecord,
  RelationshipRecord,
  SubGraphFragment,
} from '../../../src/query/graph-expander.js';

class StubExpander {
  vectorParagraphAnchorsCalls = 0;
  vectorEntityAnchorsCalls = 0;

  constructor(
    private readonly anchors: ParagraphRecord[],
    private readonly entityAnchors: EntityRecord[] = [],
    private readonly expanded: SubGraphFragment = {
      paragraphs: [],
      entities: [],
      relationships: [],
    }
  ) {}

  async vectorParagraphAnchors(
    _vec: number[],
    _topK: number,
    _filters?: ExpansionFilters
  ): Promise<ParagraphRecord[]> {
    this.vectorParagraphAnchorsCalls++;
    return this.anchors;
  }
  async vectorEntityAnchors(): Promise<EntityRecord[]> {
    this.vectorEntityAnchorsCalls++;
    return this.entityAnchors;
  }
  async layoutExpand(): Promise<SubGraphFragment> {
    return { paragraphs: this.expanded.paragraphs, entities: [], relationships: [] };
  }
  async semanticExpand(): Promise<SubGraphFragment> {
    return { paragraphs: [], entities: this.expanded.entities, relationships: this.expanded.relationships };
  }
  async crossExpand(): Promise<SubGraphFragment> {
    return { paragraphs: [], entities: [], relationships: [] };
  }
  async hydrateParagraphs(): Promise<ParagraphRecord[]> {
    return [];
  }
  async paragraphEntityMentions(): Promise<Map<string, string[]>> {
    return new Map();
  }
}

const stubEmbeddings = {
  dimensions: 4,
  modelName: 'stub-embed',
  async embedOne() {
    return { id: 'q', vector: [0.1, 0.2, 0.3, 0.4], dimensions: 4, model: 'stub-embed' };
  },
} as never;

function p(overrides: Partial<ParagraphRecord>): ParagraphRecord {
  return {
    id: 'p1',
    documentId: 'd1',
    fileName: 'doc.pdf',
    content: 'Acme reported revenue.',
    pageNumber: 1,
    sectionHeading: 'Intro',
    sequenceIndex: 0,
    vectorScore: 0.9,
    ...overrides,
  };
}

describe('RagPipeline.query', () => {
  it('returns sources matching the anchor paragraphs and a synthesized answer', async () => {
    const expander = new StubExpander([p({ id: 'p1', content: 'Acme reported revenue of 45M.' })]);
    const pipeline = new RagPipeline({
      expander: expander as never,
      embeddings: stubEmbeddings,
      answerModel: 'stub-model',
      answerTemperature: 0,
      defaultParagraphTopK: 5,
      defaultEntityTopK: 5,
      defaultMaxHops: 2,
      defaultLayoutWindow: 1,
      defaultMaxContextTokens: 4000,
      defaultRankAlpha: 0.7,
      maxAnswerTokens: 200,
      generate: (async (_args: unknown) => ({
        object: { answer: 'Acme reported $45M [1].', citations: [1], confident: true },
        usage: { promptTokens: 100, completionTokens: 8 },
      })) as never,
    });

    const result = await pipeline.query({ question: "What did Acme report?" });
    expect(result.answer).toMatch(/Acme.*\[1\]/);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.documentName).toBe('doc.pdf');
    expect(result.sources[0]?.citationKey).toBe(1);
    expect(result.diagnostics.confident).toBe(true);
    expect(result.diagnostics.orphanCitations).toEqual([]);
  });

  it('detects orphan citations when the LLM cites a missing source', async () => {
    const expander = new StubExpander([p({ id: 'p1' })]);
    const pipeline = new RagPipeline({
      expander: expander as never,
      embeddings: stubEmbeddings,
      answerModel: 'stub-model',
      answerTemperature: 0,
      defaultParagraphTopK: 5,
      defaultEntityTopK: 5,
      defaultMaxHops: 2,
      defaultLayoutWindow: 1,
      defaultMaxContextTokens: 4000,
      defaultRankAlpha: 0.7,
      maxAnswerTokens: 200,
      generate: (async () => ({
        object: { answer: 'A [1] and B [99] and C [42].', citations: [1, 99, 42], confident: true },
      })) as never,
    });
    const result = await pipeline.query({ question: 'q' });
    expect(result.diagnostics.orphanCitations).toEqual([42, 99]);
  });

  it('attaches a trace when diagnose is set', async () => {
    const expander = new StubExpander([p({ id: 'p1' })]);
    const pipeline = new RagPipeline({
      expander: expander as never,
      embeddings: stubEmbeddings,
      answerModel: 'stub-model',
      answerTemperature: 0,
      defaultParagraphTopK: 5,
      defaultEntityTopK: 5,
      defaultMaxHops: 2,
      defaultLayoutWindow: 1,
      defaultMaxContextTokens: 4000,
      defaultRankAlpha: 0.7,
      maxAnswerTokens: 200,
      generate: (async () => ({
        object: { answer: 'A [1].', citations: [1], confident: true },
      })) as never,
    });
    const result = await pipeline.query({ question: 'q', diagnose: true });
    expect(result.trace).toBeTruthy();
    expect(result.trace?.assembledContext).toMatch(/\[1\]/);
    expect(result.trace?.systemPrompt).toMatch(/cite/i);
    expect(result.trace?.anchorParagraphs).toHaveLength(1);
  });
});
