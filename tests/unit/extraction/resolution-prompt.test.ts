import { describe, expect, it } from 'vitest';
import {
  ResolutionResponseSchema,
  buildResolutionPrompt,
} from '../../../src/extraction/prompts/resolution-prompt.js';

describe('resolution prompt', () => {
  it('asks for `same` or `different` and includes both entities', () => {
    const { system, user } = buildResolutionPrompt({
      type: 'Organization',
      a: { name: 'Acme Corp', aliases: ['Acme'], context: 'Acme Corp announced Q3 results.' },
      b: { name: 'Acme Corporation', aliases: [], context: 'Acme Corporation board meeting.' },
    });
    expect(system).toMatch(/`same` or `different`/);
    expect(user).toContain('Acme Corp');
    expect(user).toContain('Acme Corporation');
    expect(user).toMatch(/Type: Organization/);
  });

  it('handles empty aliases / empty context cleanly', () => {
    const { user } = buildResolutionPrompt({
      type: 'Person',
      a: { name: 'A', aliases: [], context: '' },
      b: { name: 'B', aliases: [], context: '' },
    });
    expect(user).not.toMatch(/aliases:.*\)/);
    expect(user).toMatch(/\(none\)/);
  });

  it('schema validates same/different decision shape', () => {
    expect(ResolutionResponseSchema.safeParse({ decision: 'same', confidence: 0.9 }).success).toBe(
      true
    );
    expect(
      ResolutionResponseSchema.safeParse({ decision: 'different', confidence: 1, reason: 'no' })
        .success
    ).toBe(true);
    expect(
      ResolutionResponseSchema.safeParse({ decision: 'maybe', confidence: 1 }).success
    ).toBe(false);
  });
});
