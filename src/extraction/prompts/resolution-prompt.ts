// Stage-3 LLM prompt. Short, structured, asks for `same` | `different` only.

import { z } from 'zod';

export const ResolutionResponseSchema = z.object({
  decision: z.enum(['same', 'different']),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(280).optional().default(''),
});
export type ResolutionResponse = z.infer<typeof ResolutionResponseSchema>;

export interface ResolutionPair {
  type: string;
  a: { name: string; aliases: string[]; context: string };
  b: { name: string; aliases: string[]; context: string };
}

export interface BuiltResolutionPrompt {
  system: string;
  user: string;
}

export function buildResolutionPrompt(pair: ResolutionPair): BuiltResolutionPrompt {
  const system = [
    'You are an entity-resolution judge for a knowledge graph.',
    'Decide whether two entity surface forms refer to the same real-world thing.',
    '',
    'Rules:',
    '1. Output exactly one of `same` or `different`.',
    '2. "same" means: same real-world referent, even if spelled differently or one form is a subset (alias, abbreviation, common form).',
    '3. "different" means: distinct referents that happen to look similar (e.g., Mercury the element vs. Mercury the planet vs. Mercury the company).',
    '4. Be conservative — if in doubt, return `different`. False merges damage the graph.',
    '5. Confidence is your honest 0-1 estimate; reason is a one-sentence justification (≤280 chars).',
  ].join('\n');

  const aliasA = pair.a.aliases.length ? ` (aliases: ${pair.a.aliases.join(', ')})` : '';
  const aliasB = pair.b.aliases.length ? ` (aliases: ${pair.b.aliases.join(', ')})` : '';
  const user = [
    `Type: ${pair.type}`,
    `Entity A: ${pair.a.name}${aliasA}`,
    `Context for A: ${pair.a.context || '(none)'}`,
    '',
    `Entity B: ${pair.b.name}${aliasB}`,
    `Context for B: ${pair.b.context || '(none)'}`,
    '',
    'Are A and B the same real-world entity? Reply with `same` or `different`.',
  ].join('\n');

  return { system, user };
}
