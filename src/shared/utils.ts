// Stateless helpers used across modules.

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

export function sha256(input: Buffer | string): string {
  const h = createHash('sha256');
  h.update(input);
  return h.digest('hex');
}

// Coarse token estimate for English text — char count / 4. Fast, good enough
// for chunk-size budgeting. Phase 2 may swap this for a real tokenizer.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function generateId(): string {
  return uuidv4();
}

export function safeFilename(path: string): string {
  return basename(path).replace(/[^a-zA-Z0-9._-]/g, '_');
}
