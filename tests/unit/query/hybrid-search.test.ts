// Hybrid search orchestration test. Stubs the expander and embedding generator.

import { describe, expect, it } from 'vitest';
import { HybridSearch } from '../../../src/query/hybrid-search.js';
import type {
  EntityRecord,
  ParagraphRecord,
  RelationshipRecord,
  SubGraphFragment,
} from '../../../src/query/graph-expander.js';

const stubEmbeddings = {
  dimensions: 4,
  modelName: 'stub',
  async embedOne() {
    return { id: 'q', vector: [0, 0, 0, 0], dimensions: 4, model: 'stub' };
  },
} as never;

class StubExpander {
  constructor(
    private readonly anchors: ParagraphRecord[],
    private readonly entityAnchors: EntityRecord[],
    private readonly expanded: SubGraphFragment
  ) {}
  async vectorParagraphAnchors(): Promise<ParagraphRecord[]> {
    return this.anchors;
  }
  async vectorEntityAnchors(): Promise<EntityRecord[]> {
    return this.entityAnchors;
  }
  async layoutExpand(): Promise<SubGraphFragment> {
    return { paragraphs: this.expanded.paragraphs, entities: [], relationships: [] };
  }
  async semanticExpand(): Promise<SubGraphFragment> {
    return {
      paragraphs: [],
      entities: this.expanded.entities,
      relationships: this.expanded.relationships,
    };
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

function p(id: string, score?: number): ParagraphRecord {
  const out: ParagraphRecord = {
    id,
    documentId: 'd',
    fileName: 'doc.pdf',
    content: 'x',
    pageNumber: 1,
    sectionHeading: '',
    sequenceIndex: 0,
  };
  if (score !== undefined) out.vectorScore = score;
  return out;
}

function e(id: string, score?: number): EntityRecord {
  const out: EntityRecord = { id, name: id, type: 'X', aliases: [] };
  if (score !== undefined) out.vectorScore = score;
  return out;
}

describe('HybridSearch.search', () => {
  it('marks vector results with origin=vector and expansion results with origin=expansion', async () => {
    const expander = new StubExpander(
      [p('p_anchor', 0.9)],
      [e('e_anchor', 0.85)],
      {
        paragraphs: [p('p_expand')],
        entities: [e('e_expand')],
        relationships: [
          {
            type: 'REL',
            sourceId: 'e_anchor',
            sourceName: 'A',
            sourceType: 'X',
            targetId: 'e_expand',
            targetName: 'B',
            targetType: 'X',
            evidence: ['e'],
            confidence: 0.7,
          } satisfies RelationshipRecord,
        ],
      }
    );
    const hs = new HybridSearch({
      expander: expander as never,
      embeddings: stubEmbeddings,
      defaultParagraphTopK: 10,
      defaultEntityTopK: 10,
      defaultMaxHops: 2,
      defaultLayoutWindow: 1,
    });
    const result = await hs.search({ query: 'find stuff' });
    const byId = Object.fromEntries(result.paragraphs.map((x) => [x.id, x]));
    expect(byId.p_anchor?.origin).toBe('vector');
    expect(byId.p_anchor?.score).toBe(0.9);
    expect(byId.p_expand?.origin).toBe('expansion');
    // Expansion paragraphs always score 0.4 (never beat vector).
    expect(byId.p_expand?.score).toBe(0.4);
    // Sorted descending — vector first.
    expect(result.paragraphs[0]?.id).toBe('p_anchor');
  });

  it('reuses vectorScore for relationship score and propagates confidence', async () => {
    const expander = new StubExpander(
      [],
      [e('a', 0.9), e('b', 0.8)],
      {
        paragraphs: [],
        entities: [],
        relationships: [
          {
            type: 'REL',
            sourceId: 'a',
            sourceName: 'A',
            sourceType: 'X',
            targetId: 'b',
            targetName: 'B',
            targetType: 'X',
            evidence: ['e'],
            confidence: 0.55,
          },
        ],
      }
    );
    const hs = new HybridSearch({
      expander: expander as never,
      embeddings: stubEmbeddings,
      defaultParagraphTopK: 10,
      defaultEntityTopK: 10,
      defaultMaxHops: 2,
      defaultLayoutWindow: 1,
    });
    const result = await hs.search({ query: 'q' });
    expect(result.relationships[0]?.score).toBe(0.55);
    expect(result.entities.find((x) => x.id === 'a')?.score).toBe(0.9);
  });
});
