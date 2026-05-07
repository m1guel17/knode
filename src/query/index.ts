// Query layer surface. Exports the server factory and the building blocks
// the rest of the app uses (GraphExpander, RagPipeline, HybridSearch).

export { createApiServer, type ApiDeps } from './server.js';
export {
  GraphExpander,
  type ParagraphRecord,
  type EntityRecord,
  type RelationshipRecord,
  type SubGraphFragment,
  type ExpansionFilters,
} from './graph-expander.js';
export {
  RagPipeline,
  type RAGQuery,
  type RAGResponse,
  type RAGSource,
  type RAGTrace,
  type RagFilters,
  type RagPipelineOptions,
} from './rag-pipeline.js';
export {
  HybridSearch,
  type HybridSearchService,
  type HybridSearchRequest,
  type HybridSearchResponse,
  type ScoredParagraph,
  type ScoredEntity,
  type ScoredRelationship,
} from './hybrid-search.js';
export {
  assembleContext,
  rankParagraphs,
  approximateTokens,
  type AssembledContext,
  type AssembleOptions,
} from './context-assembler.js';
export { isReadOnlySafe, registerCypherEndpoint, type CypherDeps } from './cypher-api.js';
