import type {
  Chunk,
  ExtractionResult,
  GraphEdge,
  GraphNode,
  NodeQuery,
  ParsedDocument,
} from '../shared/types.js';

export interface SubGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Transaction {
  run(query: string, params?: Record<string, unknown>): Promise<unknown>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DocumentGraphInput {
  parsed: ParsedDocument;
  chunks: Chunk[];
  extractions: Map<string, ExtractionResult>; // keyed by chunk.id
  // Optional vectors — keyed by chunk.id. When provided, the backend writes
  // them onto the corresponding Paragraph node atomically with the rest of
  // the document graph (no second round-trip).
  chunkEmbeddings?: Map<string, number[]>;
  embeddingModel?: string;
}

export interface DocumentWriteResult {
  documentId: string;
  pageCount: number;
  paragraphCount: number;
  entityCount: number;
  relationshipCount: number;
}

export interface SchemaApplyOptions {
  paragraphEmbeddingDims?: number;
  entityEmbeddingDims?: number;
  embeddingModel?: string;
}

export interface GraphBackend {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  applySchema(opts?: SchemaApplyOptions): Promise<void>;

  writeDocumentGraph(input: DocumentGraphInput): Promise<DocumentWriteResult>;

  // Generic CRUD — useful for tests and future tooling.
  upsertNode(node: GraphNode): Promise<string>;
  upsertEdge(edge: GraphEdge): Promise<string>;
  getNode(nodeId: string): Promise<GraphNode | null>;
  findNodes(query: NodeQuery): Promise<GraphNode[]>;

  // Escape hatch.
  executeCypher(query: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface SimilarityResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface MetadataFilter {
  [key: string]: unknown;
}

export interface VectorStore {
  upsert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<void>;
  upsertMany(
    items: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>
  ): Promise<void>;
  search(queryVector: number[], topK: number, filter?: MetadataFilter): Promise<SimilarityResult[]>;
  delete(id: string): Promise<void>;
}
