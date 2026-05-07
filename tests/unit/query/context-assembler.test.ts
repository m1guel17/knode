import { describe, expect, it } from 'vitest';
import {
  approximateTokens,
  assembleContext,
  rankParagraphs,
} from '../../../src/query/context-assembler.js';
import type {
  EntityRecord,
  ParagraphRecord,
  RelationshipRecord,
} from '../../../src/query/graph-expander.js';

function p(overrides: Partial<ParagraphRecord>): ParagraphRecord {
  return {
    id: 'p1',
    documentId: 'd1',
    fileName: 'doc.pdf',
    content: 'lorem ipsum dolor sit amet',
    pageNumber: 1,
    sectionHeading: 'Intro',
    sequenceIndex: 0,
    ...overrides,
  };
}

describe('rankParagraphs', () => {
  it('orders by combinedScore descending', () => {
    const anchors = new Set(['e1', 'e2']);
    const mentions = new Map([
      ['p1', ['e1', 'e2']], // both
      ['p2', ['e1']], // one
      ['p3', []], // none
    ]);
    const paragraphs = [
      p({ id: 'p1', vectorScore: 0.5 }),
      p({ id: 'p2', vectorScore: 0.9 }),
      p({ id: 'p3', vectorScore: 0.95 }),
    ];
    // alpha=0.0 → only entity matches matter → p1 wins.
    const ranked = rankParagraphs(paragraphs, anchors, mentions, 0.0);
    expect(ranked[0]?.paragraph.id).toBe('p1');

    // alpha=1.0 → only vector → p3 wins.
    const ranked2 = rankParagraphs(paragraphs, anchors, mentions, 1.0);
    expect(ranked2[0]?.paragraph.id).toBe('p3');
  });

  it('dedupes paragraphs by id', () => {
    const anchors = new Set<string>();
    const ranked = rankParagraphs(
      [p({ id: 'p1' }), p({ id: 'p1' }), p({ id: 'p2' })],
      anchors,
      new Map(),
      0.7
    );
    expect(ranked).toHaveLength(2);
  });
});

describe('assembleContext', () => {
  it('includes a numbered citation per paragraph and respects token budget', () => {
    const paragraphs: ParagraphRecord[] = [
      p({ id: 'p1', vectorScore: 0.9, content: 'Acme reported revenue of $45M.' }),
      p({ id: 'p2', vectorScore: 0.7, content: 'TechStar raised a Series B.' }),
    ];
    const result = assembleContext({
      question: 'What about Acme?',
      paragraphs,
      entities: [],
      relationships: [],
      anchorEntityIds: new Set(),
      paragraphMentions: new Map(),
      rankAlpha: 0.7,
      maxContextTokens: 4000,
    });
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]?.citationKey).toBe(1);
    expect(result.sources[1]?.citationKey).toBe(2);
    expect(result.contextBlock).toMatch(/\[1\].*Acme/);
    expect(result.contextBlock).toMatch(/\[2\].*TechStar/);
    expect(result.truncated).toBe(false);
  });

  it('truncates when the budget is exceeded', () => {
    // Build a paragraph that will be way over the budget.
    const big = 'word '.repeat(20_000);
    const result = assembleContext({
      question: 'Q?',
      paragraphs: [p({ id: 'p1', vectorScore: 0.9, content: big })],
      entities: [],
      relationships: [],
      anchorEntityIds: new Set(),
      paragraphMentions: new Map(),
      rankAlpha: 0.7,
      maxContextTokens: 200,
    });
    expect(result.truncated).toBe(true);
    // contextTokens stays within budget (allow a small overshoot for the
    // header — the assembler estimates and caps approximately).
    expect(result.contextTokens).toBeLessThanOrEqual(220);
  });

  it('appends relationships only when their endpoints involve anchors', () => {
    const entityA: EntityRecord = { id: 'a', name: 'Acme', type: 'Organization', aliases: [] };
    const entityB: EntityRecord = { id: 'b', name: 'Foo', type: 'Organization', aliases: [] };
    const rels: RelationshipRecord[] = [
      {
        type: 'COMPETES_WITH',
        sourceId: 'a',
        sourceName: 'Acme',
        sourceType: 'Organization',
        targetId: 'b',
        targetName: 'Foo',
        targetType: 'Organization',
        evidence: ['saw it'],
        confidence: 0.9,
      },
    ];
    const result = assembleContext({
      question: 'q',
      paragraphs: [p({ id: 'p1', content: 'hi' })],
      entities: [entityA, entityB],
      relationships: rels,
      anchorEntityIds: new Set(['a']),
      paragraphMentions: new Map(),
      rankAlpha: 0.7,
      maxContextTokens: 4000,
    });
    expect(result.contextBlock).toMatch(/\(Acme\) --\[COMPETES_WITH\]--> \(Foo\)/);
    expect(result.graphContext.relationships).toHaveLength(1);
  });

  it('includes only the anchored entities in graphContext.entities', () => {
    const entityA: EntityRecord = { id: 'a', name: 'Acme', type: 'Organization', aliases: [] };
    const entityB: EntityRecord = { id: 'b', name: 'Foo', type: 'Organization', aliases: [] };
    const result = assembleContext({
      question: 'q',
      paragraphs: [],
      entities: [entityA, entityB],
      relationships: [],
      anchorEntityIds: new Set(['a']),
      paragraphMentions: new Map(),
      rankAlpha: 0.7,
      maxContextTokens: 1000,
    });
    expect(result.graphContext.entities.map((e) => e.id)).toEqual(['a']);
  });
});

describe('approximateTokens', () => {
  it('roughly equals chars/4', () => {
    expect(approximateTokens('a'.repeat(40))).toBe(10);
    expect(approximateTokens('')).toBe(0);
  });
});
