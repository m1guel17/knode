// RAG answer-generation prompt + structured-output schema. The prompt
// instructs the LLM to cite using [N] markers; the response shape includes
// the citations as a list so we can cross-check that every cited number
// exists in the assembled context.

import { z } from 'zod';

export const RagAnswerSchema = z.object({
  answer: z
    .string()
    .min(1)
    .describe('The answer text. Must cite using [N] markers when stating facts.'),
  citations: z
    .array(z.number().int().nonnegative())
    .default([])
    .describe('The set of citation keys [N] referenced in the answer.'),
  confident: z
    .boolean()
    .default(false)
    .describe(
      'Whether the LLM believes the context contained enough information to answer the question.'
    ),
});

export type RagAnswer = z.infer<typeof RagAnswerSchema>;

export interface BuiltAnswerPrompt {
  system: string;
  user: string;
}

export function buildRagAnswerPrompt(contextBlock: string): BuiltAnswerPrompt {
  const system = [
    'You are a knowledge assistant grounded in a knowledge graph.',
    'Answer the user question using ONLY the provided Context. Do not use prior knowledge.',
    '',
    'Rules:',
    '1. Cite every factual claim using [N] markers that match the numbered context entries.',
    '2. If multiple sources support a claim, cite all of them, e.g. [1][3].',
    '3. If the context does not contain enough information to answer confidently, say so explicitly. Set `confident: false`.',
    '4. Do not invent citation numbers. Every [N] you write must be a number that appears in the Context section.',
    '5. Quote sparingly; paraphrase where possible. Keep the answer direct.',
    '6. The Relationships block at the end of the context is auxiliary — use it to ground assertions about how entities relate, but cite the paragraph evidence ([N]) for the underlying facts.',
    '',
    'Output JSON with three fields: `answer` (the prose), `citations` (the array of [N] integers used), `confident` (boolean).',
  ].join('\n');

  return {
    system,
    user: contextBlock,
  };
}

// Cross-check that every citation in the answer body appears in the
// allowedKeys set. Returns the offending list (empty when clean).
export function findOrphanCitations(answer: string, allowedKeys: Set<number>): number[] {
  const matches = answer.match(/\[(\d+)\]/g) ?? [];
  const cited = new Set<number>();
  for (const m of matches) {
    const n = Number(m.slice(1, -1));
    if (Number.isFinite(n)) cited.add(n);
  }
  const orphans: number[] = [];
  for (const c of cited) if (!allowedKeys.has(c)) orphans.push(c);
  return orphans.sort((a, b) => a - b);
}
