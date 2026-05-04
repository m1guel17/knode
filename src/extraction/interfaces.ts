import { readFileSync } from 'node:fs';
import type { Chunk, ExtractionResult, Ontology } from '../shared/types.js';

export interface TripleExtractor {
  extract(chunk: Chunk): Promise<ExtractionResult>;
}

// Ontology is data, not code — load at runtime.
export function loadOntology(path: string): Ontology {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Ontology;
}
