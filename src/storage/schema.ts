// Phase 2 schema. Adds vector indexes (one per Paragraph.embedding and
// Entity.embedding), a normalizedName index for cheap entity-resolver stage 1
// lookups, and a _schema_version sentinel node so future migrations can
// detect existing graph state.
//
// All statements use IF NOT EXISTS so the applier is idempotent.

export const PHASE_1_SCHEMA_STATEMENTS: string[] = [
  // Uniqueness on Document.id, Page.id, Section.id, Paragraph.id, Entity.id
  'CREATE CONSTRAINT document_id_unique IF NOT EXISTS FOR (n:Document) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT document_hash_unique IF NOT EXISTS FOR (n:Document) REQUIRE n.contentHash IS UNIQUE',
  'CREATE CONSTRAINT page_id_unique IF NOT EXISTS FOR (n:Page) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT section_id_unique IF NOT EXISTS FOR (n:Section) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT paragraph_id_unique IF NOT EXISTS FOR (n:Paragraph) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT entity_id_unique IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE',
  // Composite uniqueness on Entity (name, type) — Phase 1's cheap dedup.
  // Phase 2 adds the resolver but keeps this constraint: the resolver works
  // against the canonical entities, and intra-document upserts still use it.
  'CREATE CONSTRAINT entity_name_type_unique IF NOT EXISTS FOR (n:Entity) REQUIRE (n.name, n.type) IS UNIQUE',
  // Indexes for lookups.
  'CREATE INDEX entity_name_index IF NOT EXISTS FOR (n:Entity) ON (n.name)',
  'CREATE FULLTEXT INDEX entity_search_index IF NOT EXISTS FOR (n:Entity) ON EACH [n.name, n.aliases]',
];

// Phase 2 additions — kept separate from Phase 1 so it is obvious where the
// Phase boundary is.
export const PHASE_2_SCHEMA_STATEMENTS: string[] = [
  // Stage-1 resolver pivot — composite index on (normalizedName, type).
  'CREATE INDEX entity_normalized_name_index IF NOT EXISTS FOR (n:Entity) ON (n.normalizedName, n.type)',
  // Schema-version sentinel. Used by SchemaApplier to detect dimension
  // mismatches before re-creating vector indexes.
  'CREATE CONSTRAINT schema_version_unique IF NOT EXISTS FOR (n:_SchemaVersion) REQUIRE n.id IS UNIQUE',
];

export interface VectorIndexSpec {
  name: string;
  label: 'Paragraph' | 'Entity';
  property: string;
  dimensions: number;
  similarity: 'cosine' | 'euclidean';
}

export function buildVectorIndexCypher(spec: VectorIndexSpec): string {
  return `CREATE VECTOR INDEX ${spec.name} IF NOT EXISTS
    FOR (n:${spec.label}) ON (n.${spec.property})
    OPTIONS { indexConfig: {
      \`vector.dimensions\`: ${spec.dimensions},
      \`vector.similarity_function\`: '${spec.similarity}'
    } }`;
}

export const PARAGRAPH_VECTOR_INDEX = 'paragraph_embedding_index';
export const ENTITY_VECTOR_INDEX = 'entity_embedding_index';

// SCHEMA_VERSION: bump when the Phase boundaries change shape. The applier
// stores this on the _SchemaVersion sentinel node.
export const SCHEMA_VERSION = '2.0.0';
