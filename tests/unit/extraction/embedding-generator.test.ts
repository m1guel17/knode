import { describe, expect, it } from 'vitest';
import {
  EmbeddingGenerator,
  buildEntityEmbeddingText,
} from '../../../src/extraction/embedding-generator.js';

// Type-only import for the AI SDK signatures so we can stub.
type EmbedManyResult = { embeddings: number[][]; usage?: { tokens?: number } };
type EmbedResult = { embedding: number[]; usage?: { tokens?: number } };

describe('EmbeddingGenerator', () => {
  it('batches embedBatch into batchSize-sized requests', async () => {
    const calls: number[] = [];
    const stub = async (input: { values: string[] }): Promise<EmbedManyResult> => {
      calls.push(input.values.length);
      const embeddings = input.values.map(() => Array(8).fill(0.1) as number[]);
      return { embeddings, usage: { tokens: input.values.length * 10 } };
    };
    const g = new EmbeddingGenerator({
      provider: 'openai',
      model: 'test-embed',
      dimensions: 8,
      batchSize: 3,
      embedManyImpl: stub as never,
    });
    const inputs = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, text: `t${i}` }));
    const out = await g.embedBatch(inputs);
    expect(out).toHaveLength(7);
    expect(calls).toEqual([3, 3, 1]);
    for (const r of out) expect(r.vector).toHaveLength(8);
  });

  it('throws on dimension mismatch', async () => {
    const stub = async (): Promise<EmbedManyResult> => ({
      embeddings: [[0.1, 0.2, 0.3]], // 3 dims
    });
    const g = new EmbeddingGenerator({
      provider: 'openai',
      model: 'test-embed',
      dimensions: 8,
      embedManyImpl: stub as never,
    });
    await expect(g.embedBatch([{ id: 'x', text: 't' }])).rejects.toThrow(/Embedding/);
  });

  it('records usage via the hook on every batch', async () => {
    const stub = async (input: { values: string[] }): Promise<EmbedManyResult> => ({
      embeddings: input.values.map(() => Array(4).fill(0)),
      usage: { tokens: 25 },
    });
    const usageHook: Array<{ batchSize: number; inputTokens: number }> = [];
    const g = new EmbeddingGenerator({
      provider: 'openai',
      model: 'test-embed',
      dimensions: 4,
      batchSize: 2,
      embedManyImpl: stub as never,
    });
    g.setUsageHook((info) =>
      usageHook.push({ batchSize: info.batchSize, inputTokens: info.inputTokens })
    );
    await g.embedBatch([
      { id: '1', text: 'a' },
      { id: '2', text: 'b' },
      { id: '3', text: 'c' },
    ]);
    expect(usageHook).toEqual([
      { batchSize: 2, inputTokens: 25 },
      { batchSize: 1, inputTokens: 25 },
    ]);
  });

  it('embedOne calls the single-embed API', async () => {
    const stub = async (): Promise<EmbedResult> => ({
      embedding: Array(4).fill(0.5),
    });
    const g = new EmbeddingGenerator({
      provider: 'openai',
      model: 'test-embed',
      dimensions: 4,
      embedImpl: stub as never,
    });
    const r = await g.embedOne('hello');
    expect(r.dimensions).toBe(4);
    expect(r.vector).toHaveLength(4);
  });
});

describe('buildEntityEmbeddingText', () => {
  it('formats ${name} (${type}): ${context}', () => {
    expect(buildEntityEmbeddingText('Acme Corp', 'Organization', ['One.', 'Two.'])).toBe(
      'Acme Corp (Organization): One. Two.'
    );
  });
  it('drops the colon and context when no contexts are supplied', () => {
    expect(buildEntityEmbeddingText('Acme Corp', 'Organization', [])).toBe(
      'Acme Corp (Organization)'
    );
  });
  it('caps context at ~500 chars', () => {
    const big = ['a'.repeat(2000)];
    const out = buildEntityEmbeddingText('X', 'Y', big);
    expect(out.length).toBeLessThanOrEqual(520);
  });
});
