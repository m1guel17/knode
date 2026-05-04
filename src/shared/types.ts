// Cross-module type definitions. The contract between layers — change with care.

export type ParserType = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'html' | 'email';

export interface FileJob {
  id: string;
  filePath: string;
  relativePath: string;
  fileType: ParserType;
  contentHash: string;
  fileSizeBytes: number;
  createdAt: Date;
  modifiedAt: Date;
  previousHash?: string;
  priority: number;
}

export interface BoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  createdDate?: Date;
  modifiedDate?: Date;
  pageCount?: number;
  wordCount: number;
  language?: string;
  customProperties: Record<string, string>;
}

export interface DocumentSection {
  heading: string | null;
  headingLevel: number;
  content: string;
  pageNumber?: number;
  boundingBox?: BoundingBox;
  children: DocumentSection[];
}

export interface ExtractedTable {
  pageNumber?: number;
  rows: string[][];
  caption?: string;
}

export interface ExtractedImage {
  pageNumber?: number;
  altText?: string;
  reference: string;
}

export interface ParsedDocument {
  sourceFile: FileJob;
  sections: DocumentSection[];
  tables: ExtractedTable[];
  images: ExtractedImage[];
  metadata: DocumentMetadata;
}

export type ChunkType = 'text' | 'table' | 'mixed';

export interface Chunk {
  id: string;
  documentId: string;
  sequenceIndex: number;
  content: string;
  headingHierarchy: string[];
  pageNumbers: number[];
  tokenEstimate: number;
  chunkType: ChunkType;
  metadata: {
    sectionTitle: string | null;
    isFirstInSection: boolean;
    isLastInSection: boolean;
    overlapWithPrevious: number;
  };
}

export interface ExtractedEntity {
  name: string;
  type: string;
  aliases: string[];
  properties: Record<string, string>;
  confidence: number;
  sourceChunkId: string;
  sourceSpan?: {
    start: number;
    end: number;
  };
}

export interface ExtractedRelationship {
  sourceEntity: string;
  relationship: string;
  targetEntity: string;
  properties: Record<string, string>;
  confidence: number;
  evidence: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  confidence: number;
}

export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  type: string;
  startNodeId: string;
  endNodeId: string;
  properties: Record<string, unknown>;
}

export interface NodeQuery {
  labels?: string[];
  where?: Record<string, unknown>;
  limit?: number;
}

export interface ProcessingStats {
  filePath: string;
  documentId: string | null;
  status: 'completed' | 'skipped' | 'failed';
  chunkCount: number;
  entityCount: number;
  relationshipCount: number;
  durationMs: number;
  error?: string;
}

export interface OntologyEntityType {
  name: string;
  description: string;
  properties: string[];
  examples: string[];
}

export interface OntologyRelationshipType {
  name: string;
  description: string;
  source_types: string[];
  target_types: string[];
}

export interface Ontology {
  version: string;
  name: string;
  description: string;
  entityTypes: OntologyEntityType[];
  relationshipTypes: OntologyRelationshipType[];
}
