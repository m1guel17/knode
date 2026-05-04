import { describe, expect, it } from 'vitest';
import { priorityForSize } from '../../../src/scanner/queue.js';

describe('priorityForSize', () => {
  it('returns 1 for empty/zero-byte files (highest priority)', () => {
    expect(priorityForSize(0)).toBe(1);
    expect(priorityForSize(-1)).toBe(1);
  });

  it('orders smaller files ahead of larger ones', () => {
    const small = priorityForSize(1024);
    const medium = priorityForSize(1024 * 1024);
    const large = priorityForSize(50 * 1024 * 1024);
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
  });

  it('clamps to 1..1000', () => {
    expect(priorityForSize(1)).toBeGreaterThanOrEqual(1);
    expect(priorityForSize(1)).toBeLessThanOrEqual(1000);
    expect(priorityForSize(1e15)).toBeLessThanOrEqual(1000);
  });
});
