import { describe, expect, it } from 'vitest';
import {
  ENTITY_VECTOR_INDEX,
  PARAGRAPH_VECTOR_INDEX,
  PHASE_1_SCHEMA_STATEMENTS,
  PHASE_2_SCHEMA_STATEMENTS,
  buildVectorIndexCypher,
} from '../../../src/storage/schema.js';

describe('Phase 1 schema', () => {
  it('declares uniqueness on Document.id and Document.contentHash', () => {
    const text = PHASE_1_SCHEMA_STATEMENTS.join('\n');
    expect(text).toMatch(/Document.*REQUIRE n\.id IS UNIQUE/);
    expect(text).toMatch(/Document.*REQUIRE n\.contentHash IS UNIQUE/);
  });

  it('declares composite uniqueness on Entity (name, type)', () => {
    const text = PHASE_1_SCHEMA_STATEMENTS.join('\n');
    expect(text).toMatch(/Entity.*REQUIRE \(n\.name, n\.type\) IS UNIQUE/);
  });

  it('uses IF NOT EXISTS to remain idempotent', () => {
    for (const stmt of PHASE_1_SCHEMA_STATEMENTS) {
      expect(stmt).toContain('IF NOT EXISTS');
    }
  });

  it('includes a fulltext index over name and aliases', () => {
    const text = PHASE_1_SCHEMA_STATEMENTS.join('\n');
    expect(text).toMatch(/FULLTEXT INDEX.*Entity.*n\.name.*n\.aliases/s);
  });
});

describe('Phase 2 schema additions', () => {
  it('declares an index on (normalizedName, type) for the resolver', () => {
    const text = PHASE_2_SCHEMA_STATEMENTS.join('\n');
    expect(text).toMatch(/Entity.*normalizedName/);
  });

  it('declares the _SchemaVersion sentinel constraint', () => {
    const text = PHASE_2_SCHEMA_STATEMENTS.join('\n');
    expect(text).toMatch(/_SchemaVersion/);
  });

  it('builds a parameterized vector-index cypher statement', () => {
    const cy = buildVectorIndexCypher({
      name: PARAGRAPH_VECTOR_INDEX,
      label: 'Paragraph',
      property: 'embedding',
      dimensions: 1536,
      similarity: 'cosine',
    });
    expect(cy).toMatch(/CREATE VECTOR INDEX paragraph_embedding_index IF NOT EXISTS/);
    expect(cy).toContain('1536');
    expect(cy).toContain("'cosine'");
    expect(cy).toContain('Paragraph');
  });

  it('exposes stable index names', () => {
    expect(PARAGRAPH_VECTOR_INDEX).toBe('paragraph_embedding_index');
    expect(ENTITY_VECTOR_INDEX).toBe('entity_embedding_index');
  });
});
