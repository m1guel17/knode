// Step 2 of the RAG pipeline: graph expansion around the anchors returned
// from vector retrieval. Three strategies, each composable:
//
//   1. layoutExpand   — walk [:NEXT] paragraph windows + heading hierarchy
//                       around each paragraph anchor (document context).
//   2. semanticExpand — walk variable-length entity-to-entity edges from
//                       each entity anchor (collect neighbors + edges).
//   3. crossExpand    — from paragraph anchors, hop through entities the
//                       paragraph mentions, then back to *other* paragraphs
//                       those entities are mentioned in. This is the bit
//                       that makes graph-augmented retrieval beat pure
//                       vector search.
//
// Each function returns a SubGraph fragment. The RAG pipeline composes them.
// All Cypher is parameterized — no string interpolation of user input.

import type { Driver, Session } from 'neo4j-driver';
import { StorageError } from '../shared/errors.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger('query.expander');

export interface ParagraphRecord {
  id: string;
  documentId: string;
  fileName: string;
  content: string;
  pageNumber: number | null;
  sectionHeading: string | null;
  sequenceIndex: number;
  // Score is a vector-similarity score when retrieved by vector, or a
  // heuristic score when retrieved by graph expansion (we mark these
  // separately so the ranker knows what kind of weight to give them).
  vectorScore?: number;
}

export interface EntityRecord {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  vectorScore?: number;
}

export interface RelationshipRecord {
  type: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  targetId: string;
  targetName: string;
  targetType: string;
  evidence: string[];
  confidence: number;
}

export interface SubGraphFragment {
  paragraphs: ParagraphRecord[];
  entities: EntityRecord[];
  relationships: RelationshipRecord[];
}

export interface ExpansionFilters {
  documentTypes?: string[];
  documentIds?: string[];
  entityTypes?: string[];
  // Paragraph score floor — drop anchors below this before expansion.
  minVectorScore?: number;
}

interface ExpanderDeps {
  driver: Driver;
  database: string;
}

function emptyFragment(): SubGraphFragment {
  return { paragraphs: [], entities: [], relationships: [] };
}

function paragraphFromRecord(rec: {
  get: (key: string) => unknown;
}): ParagraphRecord {
  const sectionHeading = rec.get('sectionHeading') as string | null;
  return {
    id: rec.get('id') as string,
    documentId: rec.get('documentId') as string,
    fileName: (rec.get('fileName') as string | null) ?? '',
    content: (rec.get('content') as string) ?? '',
    pageNumber: toNumber(rec.get('pageNumber')),
    sectionHeading: sectionHeading && sectionHeading.length > 0 ? sectionHeading : null,
    sequenceIndex: toNumber(rec.get('sequenceIndex')) ?? 0,
  };
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const n = (value as { toNumber?: () => number }).toNumber?.();
    return typeof n === 'number' ? n : null;
  }
  return null;
}

function uniquePushBy<T>(arr: T[], item: T, keyFn: (x: T) => string): void {
  const key = keyFn(item);
  if (!arr.some((existing) => keyFn(existing) === key)) arr.push(item);
}

export class GraphExpander {
  constructor(private readonly deps: ExpanderDeps) {}

  private session(): Session {
    return this.deps.driver.session({ database: this.deps.database });
  }

  // Vector retrieval against the paragraph index. Filter pushdown happens
  // here — applying filters at retrieval is far cheaper than after expansion.
  async vectorParagraphAnchors(
    queryVector: number[],
    topK: number,
    filters: ExpansionFilters = {}
  ): Promise<ParagraphRecord[]> {
    const session = this.session();
    try {
      const params: Record<string, unknown> = {
        topK,
        vec: queryVector,
        index: 'paragraph_embedding_index',
      };
      const wherePieces: string[] = [];
      if (filters.documentIds && filters.documentIds.length > 0) {
        wherePieces.push('node.documentId IN $docIds');
        params.docIds = filters.documentIds;
      }
      if (filters.documentTypes && filters.documentTypes.length > 0) {
        wherePieces.push('d.fileType IN $docTypes');
        params.docTypes = filters.documentTypes;
      }
      if (filters.minVectorScore !== undefined) {
        wherePieces.push('score >= $minScore');
        params.minScore = filters.minVectorScore;
      }
      const whereClause = wherePieces.length > 0 ? `WHERE ${wherePieces.join(' AND ')}` : '';

      const cy = `
        CALL db.index.vector.queryNodes($index, toInteger($topK), $vec)
        YIELD node, score
        MATCH (d:Document { id: node.documentId })
        OPTIONAL MATCH (s:Section)-[:HAS_PARAGRAPH]->(node)
        ${whereClause}
        RETURN node.id AS id,
               node.documentId AS documentId,
               coalesce(d.fileName, d.filePath, '') AS fileName,
               coalesce(node.content, '') AS content,
               node.pageNumber AS pageNumber,
               coalesce(s.heading, '') AS sectionHeading,
               coalesce(node.sequenceIndex, 0) AS sequenceIndex,
               score
        ORDER BY score DESC
      `;

      const result = await session.run(cy, params);
      return result.records.map((rec) => ({
        ...paragraphFromRecord(rec),
        vectorScore: rec.get('score') as number,
      }));
    } catch (e) {
      throw new StorageError('vectorParagraphAnchors failed', { topK }, e);
    } finally {
      await session.close();
    }
  }

  // Vector retrieval against the entity index.
  async vectorEntityAnchors(
    queryVector: number[],
    topK: number,
    filters: ExpansionFilters = {}
  ): Promise<EntityRecord[]> {
    const session = this.session();
    try {
      const params: Record<string, unknown> = {
        topK,
        vec: queryVector,
        index: 'entity_embedding_index',
      };
      const wherePieces: string[] = [];
      if (filters.entityTypes && filters.entityTypes.length > 0) {
        wherePieces.push('node.type IN $entTypes');
        params.entTypes = filters.entityTypes;
      }
      if (filters.minVectorScore !== undefined) {
        wherePieces.push('score >= $minScore');
        params.minScore = filters.minVectorScore;
      }
      const whereClause = wherePieces.length > 0 ? `WHERE ${wherePieces.join(' AND ')}` : '';

      const cy = `
        CALL db.index.vector.queryNodes($index, toInteger($topK), $vec)
        YIELD node, score
        ${whereClause}
        RETURN node.id AS id,
               node.name AS name,
               node.type AS type,
               coalesce(node.aliases, []) AS aliases,
               score
        ORDER BY score DESC
      `;
      const result = await session.run(cy, params);
      return result.records.map((rec) => ({
        id: rec.get('id') as string,
        name: rec.get('name') as string,
        type: rec.get('type') as string,
        aliases: (rec.get('aliases') as string[]) ?? [],
        vectorScore: rec.get('score') as number,
      }));
    } catch (e) {
      throw new StorageError('vectorEntityAnchors failed', { topK }, e);
    } finally {
      await session.close();
    }
  }

  // Layout expansion: walk [:NEXT] window of paragraphs and pick up the
  // section heading for the document context. `layoutWindow` is the number of
  // hops in each direction, default 1 (so a 3-paragraph window centered on
  // the anchor).
  async layoutExpand(
    paragraphIds: string[],
    layoutWindow = 1
  ): Promise<SubGraphFragment> {
    if (paragraphIds.length === 0) return emptyFragment();
    const session = this.session();
    try {
      const cy = `
        UNWIND $ids AS pid
        MATCH (anchor:Paragraph { id: pid })
        MATCH (s:Section)-[:HAS_PARAGRAPH]->(anchor)
        OPTIONAL MATCH path = (neighbor:Paragraph)
        WHERE neighbor.documentId = anchor.documentId
          AND abs(coalesce(neighbor.sequenceIndex, 0) - coalesce(anchor.sequenceIndex, 0)) <= toInteger($window)
        MATCH (d:Document { id: neighbor.documentId })
        OPTIONAL MATCH (sn:Section)-[:HAS_PARAGRAPH]->(neighbor)
        RETURN DISTINCT
          neighbor.id AS id,
          neighbor.documentId AS documentId,
          coalesce(d.fileName, d.filePath, '') AS fileName,
          coalesce(neighbor.content, '') AS content,
          neighbor.pageNumber AS pageNumber,
          coalesce(sn.heading, '') AS sectionHeading,
          coalesce(neighbor.sequenceIndex, 0) AS sequenceIndex
      `;
      const result = await session.run(cy, { ids: paragraphIds, window: layoutWindow });
      const paragraphs = result.records.map(paragraphFromRecord);
      return { paragraphs, entities: [], relationships: [] };
    } catch (e) {
      throw new StorageError('layoutExpand failed', { count: paragraphIds.length }, e);
    } finally {
      await session.close();
    }
  }

  // Semantic expansion: from each entity anchor, walk variable-length entity
  // relationships up to maxHops. Returns visited neighbors and the edges.
  async semanticExpand(
    entityIds: string[],
    maxHops = 2
  ): Promise<SubGraphFragment> {
    if (entityIds.length === 0) return emptyFragment();
    const session = this.session();
    try {
      // Cypher disallows parameterized variable-length patterns, so the hop
      // count is interpolated — but it is bounded to [1, 4] in config and
      // sanitized here so it can never become user input.
      const safeHops = Math.max(1, Math.min(4, Math.trunc(maxHops)));
      const cy = `
        UNWIND $ids AS eid
        MATCH (anchor:Entity { id: eid })
        OPTIONAL MATCH path = (anchor)-[r*1..${safeHops}]-(neighbor:Entity)
        WITH anchor, neighbor, relationships(path) AS rels
        WHERE neighbor IS NOT NULL
        UNWIND rels AS rel
        WITH DISTINCT anchor, neighbor, rel,
             startNode(rel) AS sNode, endNode(rel) AS tNode
        WHERE sNode:Entity AND tNode:Entity
        RETURN DISTINCT
          neighbor.id AS neighborId,
          neighbor.name AS neighborName,
          neighbor.type AS neighborType,
          coalesce(neighbor.aliases, []) AS neighborAliases,
          type(rel) AS relType,
          sNode.id AS sourceId,
          sNode.name AS sourceName,
          sNode.type AS sourceType,
          tNode.id AS targetId,
          tNode.name AS targetName,
          tNode.type AS targetType,
          coalesce(rel.evidence, []) AS evidence,
          coalesce(rel.confidence, 0.0) AS confidence
      `;
      const result = await session.run(cy, { ids: entityIds });
      const entities: EntityRecord[] = [];
      const relationships: RelationshipRecord[] = [];
      for (const rec of result.records) {
        uniquePushBy(
          entities,
          {
            id: rec.get('neighborId') as string,
            name: rec.get('neighborName') as string,
            type: rec.get('neighborType') as string,
            aliases: (rec.get('neighborAliases') as string[]) ?? [],
          },
          (e) => e.id
        );
        const sourceId = rec.get('sourceId') as string;
        const targetId = rec.get('targetId') as string;
        const relType = rec.get('relType') as string;
        uniquePushBy(
          relationships,
          {
            type: relType,
            sourceId,
            sourceName: rec.get('sourceName') as string,
            sourceType: rec.get('sourceType') as string,
            targetId,
            targetName: rec.get('targetName') as string,
            targetType: rec.get('targetType') as string,
            evidence: (rec.get('evidence') as string[]) ?? [],
            confidence: (rec.get('confidence') as number) ?? 0,
          },
          (r) => `${r.sourceId}|${r.type}|${r.targetId}`
        );
      }
      return { paragraphs: [], entities, relationships };
    } catch (e) {
      throw new StorageError('semanticExpand failed', { count: entityIds.length }, e);
    } finally {
      await session.close();
    }
  }

  // Cross-graph traversal: from a paragraph anchor, find the entities it
  // mentions, hop semantically (1..maxHops), then walk back to *other*
  // paragraphs the neighbor entities are mentioned in. This produces the
  // graph-aware paragraph picks that pure vector retrieval misses.
  async crossExpand(
    paragraphIds: string[],
    maxHops = 2,
    paragraphLimitPerAnchor = 5
  ): Promise<SubGraphFragment> {
    if (paragraphIds.length === 0) return emptyFragment();
    const session = this.session();
    try {
      const safeHops = Math.max(1, Math.min(4, Math.trunc(maxHops)));
      const cy = `
        UNWIND $ids AS pid
        MATCH (anchor:Paragraph { id: pid })
        MATCH (anchor)<-[:MENTIONED_IN]-(e:Entity)
        WITH anchor, e
        OPTIONAL MATCH (e)-[r*1..${safeHops}]-(neighbor:Entity)
        WHERE neighbor IS NOT NULL AND neighbor <> e
        WITH anchor, neighbor
        OPTIONAL MATCH (neighbor)-[:MENTIONED_IN]->(p:Paragraph)
        WHERE p.id <> anchor.id
        WITH anchor, neighbor, p
        ORDER BY anchor.id, neighbor.id, p.sequenceIndex
        WITH anchor, neighbor, collect(p)[..toInteger($limit)] AS paragraphs
        UNWIND paragraphs AS para
        MATCH (d:Document { id: para.documentId })
        OPTIONAL MATCH (s:Section)-[:HAS_PARAGRAPH]->(para)
        RETURN DISTINCT
          para.id AS id,
          para.documentId AS documentId,
          coalesce(d.fileName, d.filePath, '') AS fileName,
          coalesce(para.content, '') AS content,
          para.pageNumber AS pageNumber,
          coalesce(s.heading, '') AS sectionHeading,
          coalesce(para.sequenceIndex, 0) AS sequenceIndex,
          neighbor.id AS neighborEntityId,
          neighbor.name AS neighborEntityName,
          neighbor.type AS neighborEntityType
      `;
      const result = await session.run(cy, {
        ids: paragraphIds,
        limit: paragraphLimitPerAnchor,
      });
      const paragraphs: ParagraphRecord[] = [];
      const entities: EntityRecord[] = [];
      for (const rec of result.records) {
        uniquePushBy(paragraphs, paragraphFromRecord(rec), (p) => p.id);
        const neighborId = rec.get('neighborEntityId') as string | null;
        if (neighborId) {
          uniquePushBy(
            entities,
            {
              id: neighborId,
              name: rec.get('neighborEntityName') as string,
              type: rec.get('neighborEntityType') as string,
              aliases: [],
            },
            (e) => e.id
          );
        }
      }
      return { paragraphs, entities, relationships: [] };
    } catch (e) {
      throw new StorageError('crossExpand failed', { count: paragraphIds.length }, e);
    } finally {
      await session.close();
    }
  }

  // Fetch full data for a set of paragraph IDs (used after expansion when
  // the SubGraph fragments only had IDs; here, we already populate, but
  // exposing the method makes it usable from hybrid search downstream).
  async hydrateParagraphs(paragraphIds: string[]): Promise<ParagraphRecord[]> {
    if (paragraphIds.length === 0) return [];
    const session = this.session();
    try {
      const cy = `
        MATCH (p:Paragraph) WHERE p.id IN $ids
        MATCH (d:Document { id: p.documentId })
        OPTIONAL MATCH (s:Section)-[:HAS_PARAGRAPH]->(p)
        RETURN
          p.id AS id,
          p.documentId AS documentId,
          coalesce(d.fileName, d.filePath, '') AS fileName,
          coalesce(p.content, '') AS content,
          p.pageNumber AS pageNumber,
          coalesce(s.heading, '') AS sectionHeading,
          coalesce(p.sequenceIndex, 0) AS sequenceIndex
      `;
      const result = await session.run(cy, { ids: paragraphIds });
      return result.records.map(paragraphFromRecord);
    } catch (e) {
      throw new StorageError('hydrateParagraphs failed', { count: paragraphIds.length }, e);
    } finally {
      await session.close();
    }
  }

  // Find which entities each paragraph mentions — used by the ranker so
  // paragraphs that mention many of the anchor entities rise to the top.
  async paragraphEntityMentions(
    paragraphIds: string[]
  ): Promise<Map<string, string[]>> {
    if (paragraphIds.length === 0) return new Map();
    const session = this.session();
    try {
      const cy = `
        MATCH (e:Entity)-[:MENTIONED_IN]->(p:Paragraph)
        WHERE p.id IN $ids
        RETURN p.id AS pid, collect(DISTINCT e.id) AS entities
      `;
      const result = await session.run(cy, { ids: paragraphIds });
      const out = new Map<string, string[]>();
      for (const rec of result.records) {
        out.set(rec.get('pid') as string, (rec.get('entities') as string[]) ?? []);
      }
      return out;
    } catch (e) {
      log.warn(
        { error: e instanceof Error ? e.message : String(e) },
        'expander.mentions_lookup_failed'
      );
      return new Map();
    } finally {
      await session.close();
    }
  }
}
