import { describe, expect, it } from 'vitest';
import {
  RagAnswerSchema,
  buildRagAnswerPrompt,
  findOrphanCitations,
} from '../../../src/extraction/prompts/rag-answer-prompt.js';

describe('buildRagAnswerPrompt', () => {
  it('puts the context in the user body and the rules in the system message', () => {
    const { system, user } = buildRagAnswerPrompt('Question: x?\n\nContext:\n[1] body');
    expect(system).toMatch(/cite every factual claim/i);
    expect(system).toMatch(/I don.t know|enough information/i);
    expect(user).toMatch(/\[1\] body/);
  });
});

describe('findOrphanCitations', () => {
  it('returns the cited keys not in the allowed set', () => {
    const allowed = new Set([1, 2, 3]);
    const orphans = findOrphanCitations(
      'Acme [1] is a corp [2]. They competed [99] with Initech [4][5].',
      allowed
    );
    expect(orphans).toEqual([4, 5, 99]);
  });

  it('returns [] when all citations are allowed', () => {
    const allowed = new Set([1, 2, 3]);
    expect(findOrphanCitations('text [1] [2] [3]', allowed)).toEqual([]);
  });

  it('returns [] when there are no citations', () => {
    expect(findOrphanCitations('plain answer', new Set([1]))).toEqual([]);
  });
});

describe('RagAnswerSchema', () => {
  it('validates the canonical shape', () => {
    const r = RagAnswerSchema.safeParse({
      answer: 'hello [1]',
      citations: [1],
      confident: true,
    });
    expect(r.success).toBe(true);
  });

  it('defaults citations to [] and confident to false', () => {
    const r = RagAnswerSchema.parse({ answer: 'x' });
    expect(r.citations).toEqual([]);
    expect(r.confident).toBe(false);
  });

  it('rejects negative citation numbers', () => {
    const r = RagAnswerSchema.safeParse({ answer: 'x', citations: [-1] });
    expect(r.success).toBe(false);
  });
});
