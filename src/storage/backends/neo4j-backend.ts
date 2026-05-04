// Neo4j 5.x backend. writeDocumentGraph runs the entire ingest as one
// transaction — partial writes would corrupt the layout/semantic graph
// linkage. Phase 2 also writes paragraph embeddings inline (atomic with the
// rest of the document graph) and stores normalizedName on entities so the
// resolver's stage-1 normalize step is a cheap index lookup.

import neo4j, { type Driver, type ManagedTransaction, type Session } from 'neo4j-driver';
import { StorageError } from '../../shared/errors.js';
import { createChildLogger } from '../../shared/logger.js';
import type {
  Chunk,
  ExtractionResult,
  GraphEdge,
  GraphNode,
  NodeQuery,
  ParsedDocument,
} from '../../shared/types.js';
import { generateId } from '../../shared/utils.js';
import { normalizeEntityName } from '../../extraction/normalize.js';
import type {
  DocumentGraphInput,
  DocumentWriteResult,
  GraphBackend,
  SchemaApplyOptions,
} from '../interfaces.js';
import {
  ENTITY_VECTOR_INDEX,
  PARAGRAPH_VECTOR_INDEX,
  PHASE_1_SCHEMA_STATEMENTS,
  PHASE_2_SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
  buildVectorIndexCypher,
} from '../schema.js';

const log = createChildLogger('storage.neo4j');

export interface Neo4jBackendOptions {
  uri: string;
  user: string;
  password: string;
  database: string;
  maxConnectionPoolSize?: number;
}

interface PageRow {
  id: string;
  pageNumber: number;
  documentId: string;
}

interface SectionRow {
  id: string;
  pageId: string;
  pageNumber: number;
  documentId: string;
  heading: string;
  headingLevel: number;
  sequenceIndex: number;
}

interface ParagraphRow {
  id: string;
  sectionId: string;
  documentId: string;
  pageNumber: number;
  content: string;
  chunkId: string;
  sequenceIndex: number;
  tokenCount: number;
}

interface EntityRow {
  id: string;
  name: string;
  normalizedName: string;
  type: string;
  aliases: string[];
  properties: Record<string, string>;
  confidence: number;
}

interface RelEdge {
  sourceName: string;
  sourceType: string;
  targetName: string;
  targetType: string;
  type: string;
  evidence: string;
  confidence: number;
  documentId: string;
  properties: Record<string, string>;
}

interface MentionEdge {
  entityName: string;
  entityType: string;
  paragraphId: string;
  chunkId: string;
}

const DEFAULT_SECTION_HEADING = '__no_heading__';

function relationshipTypeToCypher(rel: string): string {
  // Cypher relationship types are uppercase identifiers; sanitize the ontology
  // type. Anything off-schema becomes RELATED_TO so the write still succeeds.
  const cleaned = rel.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
  if (!cleaned) return 'RELATED_TO';
  return cleaned;
}

function buildRows(input: DocumentGraphInput): {
  doc: GraphNode;
  pages: PageRow[];
  sections: SectionRow[];
  paragraphs: ParagraphRow[];
  paragraphOrder: { earlier: string; later: string }[];
  pageOrder: { earlier: string; later: string }[];
  entities: Map<string, EntityRow>; // keyed by `${name}${type}`
  relationships: RelEdge[];
  mentions: MentionEdge[];
} {
  const { parsed, chunks, extractions } = input;
  const docId = parsed.sourceFile.id;

  const doc: GraphNode = {
    id: docId,
    labels: ['Document'],
    properties: {
      id: docId,
      filePath: parsed.sourceFile.filePath,
      fileName: parsed.sourceFile.relativePath,
      fileType: parsed.sourceFile.fileType,
      contentHash: parsed.sourceFile.contentHash,
      processedAt: Date.now(),
      title: parsed.metadata.title ?? null,
      author: parsed.metadata.author ?? null,
      pageCount: parsed.metadata.pageCount ?? null,
      wordCount: parsed.metadata.wordCount,
    },
  };

  // Build page/section/paragraph rows from chunks. Each chunk maps to one
  // paragraph node; pages and sections are derived from chunk metadata.
  const pageMap = new Map<number, PageRow>();
  const sectionMap = new Map<string, SectionRow>(); // key: `${pageNumber}${heading}`
  const paragraphs: ParagraphRow[] = [];

  let sectionSeq = 0;
  let paragraphSeq = 0;

  for (const chunk of chunks) {
    const pageNumber = chunk.pageNumbers[0] ?? 1;

    let page = pageMap.get(pageNumber);
    if (!page) {
      page = { id: generateId(), pageNumber, documentId: docId };
      pageMap.set(pageNumber, page);
    }

    const sectionHeading = chunk.metadata.sectionTitle ?? chunk.headingHierarchy.at(-1) ?? null;
    const sectionKey = `${pageNumber}${sectionHeading ?? DEFAULT_SECTION_HEADING}`;
    let section = sectionMap.get(sectionKey);
    if (!section) {
      section = {
        id: generateId(),
        pageId: page.id,
        pageNumber,
        documentId: docId,
        heading: sectionHeading ?? '',
        headingLevel: chunk.headingHierarchy.length,
        sequenceIndex: sectionSeq++,
      };
      sectionMap.set(sectionKey, section);
    }

    paragraphs.push({
      id: generateId(),
      sectionId: section.id,
      documentId: docId,
      pageNumber,
      content: chunk.content,
      chunkId: chunk.id,
      sequenceIndex: paragraphSeq++,
      tokenCount: chunk.tokenEstimate,
    });
  }

  // Reading-order edges between adjacent paragraphs and pages.
  const paragraphOrder: { earlier: string; later: string }[] = [];
  for (let i = 1; i < paragraphs.length; i++) {
    const a = paragraphs[i - 1];
    const b = paragraphs[i];
    if (a && b) paragraphOrder.push({ earlier: a.id, later: b.id });
  }
  const pages = [...pageMap.values()].sort((a, b) => a.pageNumber - b.pageNumber);
  const pageOrder: { earlier: string; later: string }[] = [];
  for (let i = 1; i < pages.length; i++) {
    const a = pages[i - 1];
    const b = pages[i];
    if (a && b) pageOrder.push({ earlier: a.id, later: b.id });
  }

  // Entities: dedupe within this document by (name, type). The graph itself
  // also enforces this via the composite uniqueness constraint, so MERGE works
  // either way.
  const entityMap = new Map<string, EntityRow>();
  const relationships: RelEdge[] = [];
  const mentions: MentionEdge[] = [];

  // Build a chunkId -> paragraphId lookup so MENTIONED_IN edges can be wired.
  const chunkIdToParagraphId = new Map<string, string>();
  for (const p of paragraphs) chunkIdToParagraphId.set(p.chunkId, p.id);

  for (const chunk of chunks) {
    const result = extractions.get(chunk.id);
    if (!result) continue;
    const paragraphId = chunkIdToParagraphId.get(chunk.id);
    if (!paragraphId) continue;

    for (const e of result.entities) {
      const key = `${e.name}${e.type}`;
      let row = entityMap.get(key);
      if (!row) {
        row = {
          id: generateId(),
          name: e.name,
          normalizedName: normalizeEntityName(e.name, e.type),
          type: e.type,
          aliases: e.aliases,
          properties: e.properties,
          confidence: e.confidence,
        };
        entityMap.set(key, row);
      } else {
        // Merge aliases / take max confidence on collision within document.
        for (const a of e.aliases) {
          if (!row.aliases.includes(a)) row.aliases.push(a);
        }
        row.confidence = Math.max(row.confidence, e.confidence);
      }
      mentions.push({
        entityName: e.name,
        entityType: e.type,
        paragraphId,
        chunkId: chunk.id,
      });
    }

    for (const rel of result.relationships) {
      // Relationships use entity *names* as endpoints. We rely on having seen
      // both entities in the same chunk's extraction to find their type. If
      // the LLM mentions a relationship endpoint that wasn't extracted as an
      // entity, skip it — that's a quality signal worth logging.
      const sourceEntity = result.entities.find((x) => x.name === rel.sourceEntity);
      const targetEntity = result.entities.find((x) => x.name === rel.targetEntity);
      if (!sourceEntity || !targetEntity) {
        log.warn(
          {
            chunkId: chunk.id,
            relationship: rel.relationship,
            source: rel.sourceEntity,
            target: rel.targetEntity,
          },
          'extraction.relationship_missing_endpoint'
        );
        continue;
      }
      relationships.push({
        sourceName: sourceEntity.name,
        sourceType: sourceEntity.type,
        targetName: targetEntity.name,
        targetType: targetEntity.type,
        type: rel.relationship,
        evidence: rel.evidence,
        confidence: rel.confidence,
        documentId: docId,
        properties: rel.properties,
      });
    }
  }

  return {
    doc,
    pages,
    sections: [...sectionMap.values()],
    paragraphs,
    paragraphOrder,
    pageOrder,
    entities: entityMap,
    relationships,
    mentions,
  };
}

export class Neo4jBackend implements GraphBackend {
  private driver: Driver | null = null;

  constructor(private readonly opts: Neo4jBackendOptions) {}

  async connect(): Promise<void> {
    if (this.driver) return;
    const config: Parameters<typeof neo4j.driver>[2] = {};
    if (this.opts.maxConnectionPoolSize !== undefined) {
      config.maxConnectionPoolSize = this.opts.maxConnectionPoolSize;
    }
    this.driver = neo4j.driver(
      this.opts.uri,
      neo4j.auth.basic(this.opts.user, this.opts.password),
      config
    );
    try {
      await this.driver.verifyConnectivity();
    } catch (e) {
      throw new StorageError('Failed to connect to Neo4j', { uri: this.opts.uri }, e);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.driver) return;
    await this.driver.close();
    this.driver = null;
  }

  private session(): Session {
    if (!this.driver) throw new StorageError('Backend not connected', {});
    return this.driver.session({ database: this.opts.database });
  }

  // Exposed so tools that need raw vector-index access (Neo4jVectorStore,
  // tests) can use the same connection pool.
  getDriver(): Driver {
    if (!this.driver) throw new StorageError('Backend not connected', {});
    return this.driver;
  }

  getDatabase(): string {
    return this.opts.database;
  }

  async applySchema(opts: SchemaApplyOptions = {}): Promise<void> {
    const session = this.session();
    try {
      for (const stmt of PHASE_1_SCHEMA_STATEMENTS) {
        await session.run(stmt);
      }
      for (const stmt of PHASE_2_SCHEMA_STATEMENTS) {
        await session.run(stmt);
      }

      const paragraphDims = opts.paragraphEmbeddingDims;
      const entityDims = opts.entityEmbeddingDims;
      const model = opts.embeddingModel ?? null;

      // Mismatch detection: if a sentinel exists with a different model or
      // dimensions, fail loud. The operator must run a re-index script (Phase
      // 4) rather than letting us silently corrupt vector reads.
      if (paragraphDims || entityDims || model) {
        const existing = await session.run(
          `MATCH (v:_SchemaVersion { id: 'embeddings' })
           RETURN v.embeddingModel AS model,
                  v.paragraphDims AS pDims,
                  v.entityDims AS eDims`
        );
        const rec = existing.records[0];
        if (rec) {
          const oldModel = rec.get('model') as string | null;
          const oldP = rec.get('pDims') as { toNumber?: () => number } | number | null;
          const oldE = rec.get('eDims') as { toNumber?: () => number } | number | null;
          const toNum = (x: typeof oldP): number | null =>
            x == null ? null : typeof x === 'number' ? x : (x.toNumber?.() ?? null);
          if (oldModel && model && oldModel !== model) {
            throw new StorageError(
              'Embedding model mismatch. Existing index uses ' +
                `${oldModel}; configured model is ${model}. Run scripts/reindex-embeddings.ts to re-embed.`,
              { existing: oldModel, configured: model }
            );
          }
          if (paragraphDims && toNum(oldP) && toNum(oldP) !== paragraphDims) {
            throw new StorageError(
              'Paragraph embedding dimension mismatch. Existing index dims=' +
                `${toNum(oldP)}; configured dims=${paragraphDims}.`,
              { existing: toNum(oldP), configured: paragraphDims }
            );
          }
          if (entityDims && toNum(oldE) && toNum(oldE) !== entityDims) {
            throw new StorageError(
              'Entity embedding dimension mismatch. Existing index dims=' +
                `${toNum(oldE)}; configured dims=${entityDims}.`,
              { existing: toNum(oldE), configured: entityDims }
            );
          }
        }
      }

      if (paragraphDims) {
        await session.run(
          buildVectorIndexCypher({
            name: PARAGRAPH_VECTOR_INDEX,
            label: 'Paragraph',
            property: 'embedding',
            dimensions: paragraphDims,
            similarity: 'cosine',
          })
        );
      }
      if (entityDims) {
        await session.run(
          buildVectorIndexCypher({
            name: ENTITY_VECTOR_INDEX,
            label: 'Entity',
            property: 'embedding',
            dimensions: entityDims,
            similarity: 'cosine',
          })
        );
      }

      // Stamp the sentinel.
      await session.run(
        `MERGE (v:_SchemaVersion { id: 'embeddings' })
         SET v.version = $version,
             v.embeddingModel = coalesce($model, v.embeddingModel),
             v.paragraphDims = coalesce($pDims, v.paragraphDims),
             v.entityDims = coalesce($eDims, v.entityDims),
             v.appliedAt = timestamp()`,
        {
          version: SCHEMA_VERSION,
          model,
          pDims: paragraphDims ?? null,
          eDims: entityDims ?? null,
        }
      );
    } finally {
      await session.close();
    }
  }

  async writeDocumentGraph(input: DocumentGraphInput): Promise<DocumentWriteResult> {
    const rows = buildRows(input);
    const session = this.session();
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        // 1. Document — MERGE by contentHash so re-runs are idempotent.
        await tx.run(
          `MERGE (d:Document { contentHash: $hash })
           ON CREATE SET d += $props
           ON MATCH SET d.processedAt = $props.processedAt`,
          {
            hash: rows.doc.properties.contentHash,
            props: rows.doc.properties,
          }
        );

        // 2. Pages — MERGE by (documentId, pageNumber).
        await tx.run(
          `UNWIND $rows AS row
           MATCH (d:Document { id: row.documentId })
           MERGE (p:Page { documentId: row.documentId, pageNumber: row.pageNumber })
           ON CREATE SET p.id = row.id
           MERGE (d)-[:HAS_PAGE]->(p)`,
          { rows: rows.pages }
        );

        // 2b. Page reading order.
        if (rows.pageOrder.length > 0) {
          await tx.run(
            `UNWIND $rows AS row
             MATCH (a:Page { documentId: $docId, pageNumber: row.earlier })
             MATCH (b:Page { documentId: $docId, pageNumber: row.later })
             MERGE (a)-[:NEXT]->(b)`,
            {
              rows: rows.pageOrder.map((o) => ({
                earlier: rows.pages.find((p) => p.id === o.earlier)?.pageNumber ?? 0,
                later: rows.pages.find((p) => p.id === o.later)?.pageNumber ?? 0,
              })),
              docId: rows.doc.properties.id,
            }
          );
        }

        // 3. Sections.
        await tx.run(
          `UNWIND $rows AS row
           MATCH (p:Page { documentId: row.documentId, pageNumber: row.pageNumber })
           MERGE (s:Section { documentId: row.documentId, heading: row.heading, pageNumber: row.pageNumber })
           ON CREATE SET s.id = row.id, s.headingLevel = row.headingLevel, s.sequenceIndex = row.sequenceIndex
           MERGE (p)-[:HAS_SECTION]->(s)`,
          { rows: rows.sections }
        );

        // 4. Paragraphs.
        await tx.run(
          `UNWIND $rows AS row
           MATCH (s:Section { id: row.sectionId })
           MERGE (para:Paragraph { documentId: row.documentId, chunkId: row.chunkId })
           ON CREATE SET para.id = row.id,
             para.content = row.content,
             para.pageNumber = row.pageNumber,
             para.sequenceIndex = row.sequenceIndex,
             para.tokenCount = row.tokenCount
           MERGE (s)-[:HAS_PARAGRAPH]->(para)`,
          { rows: rows.paragraphs }
        );

        // 4b. Paragraph reading order.
        if (rows.paragraphOrder.length > 0) {
          await tx.run(
            `UNWIND $rows AS row
             MATCH (a:Paragraph { id: row.earlier })
             MATCH (b:Paragraph { id: row.later })
             MERGE (a)-[:NEXT]->(b)`,
            { rows: rows.paragraphOrder }
          );
        }

        // 5. Entities — MERGE by (name, type) composite. Phase 2 also stamps
        // `normalizedName` so the resolver's stage-1 lookup is a cheap index hit.
        const entityRows = [...rows.entities.values()];
        if (entityRows.length > 0) {
          await tx.run(
            `UNWIND $rows AS row
             MERGE (e:Entity { name: row.name, type: row.type })
             ON CREATE SET e.id = row.id,
               e.normalizedName = row.normalizedName,
               e.aliases = row.aliases,
               e.properties = row.properties,
               e.confidence = row.confidence,
               e.firstSeen = timestamp(),
               e.lastSeen = timestamp(),
               e.mentionCount = 0
             ON MATCH SET e.lastSeen = timestamp(),
               e.normalizedName = coalesce(e.normalizedName, row.normalizedName),
               e.aliases = [a IN row.aliases WHERE NOT a IN coalesce(e.aliases, [])] + coalesce(e.aliases, []),
               e.confidence = CASE WHEN row.confidence > coalesce(e.confidence, 0) THEN row.confidence ELSE e.confidence END`,
            {
              rows: entityRows.map((r) => ({
                ...r,
                // Neo4j doesn't accept nested object properties on nodes — flatten.
                properties: JSON.stringify(r.properties),
              })),
            }
          );
        }

        // 6. Semantic relationships — MERGE per relationship type. Cypher
        // doesn't allow parameterized relationship types, so we group by type.
        const relsByType = new Map<string, RelEdge[]>();
        for (const r of rows.relationships) {
          const cy = relationshipTypeToCypher(r.type);
          const arr = relsByType.get(cy) ?? [];
          arr.push(r);
          relsByType.set(cy, arr);
        }
        for (const [cyType, arr] of relsByType) {
          await tx.run(
            `UNWIND $rows AS row
             MATCH (s:Entity { name: row.sourceName, type: row.sourceType })
             MATCH (t:Entity { name: row.targetName, type: row.targetType })
             MERGE (s)-[r:${cyType}]->(t)
             ON CREATE SET r.id = row.id,
               r.evidence = [row.evidence],
               r.confidence = row.confidence,
               r.sourceDocuments = [row.documentId],
               r.properties = row.properties,
               r.extractedAt = timestamp()
             ON MATCH SET r.evidence = CASE WHEN row.evidence IN coalesce(r.evidence, []) THEN r.evidence ELSE coalesce(r.evidence, []) + row.evidence END,
               r.sourceDocuments = CASE WHEN row.documentId IN coalesce(r.sourceDocuments, []) THEN r.sourceDocuments ELSE coalesce(r.sourceDocuments, []) + row.documentId END,
               r.confidence = CASE WHEN row.confidence > coalesce(r.confidence, 0) THEN row.confidence ELSE r.confidence END`,
            {
              rows: arr.map((r) => ({
                id: generateId(),
                sourceName: r.sourceName,
                sourceType: r.sourceType,
                targetName: r.targetName,
                targetType: r.targetType,
                evidence: r.evidence,
                confidence: r.confidence,
                documentId: r.documentId,
                properties: JSON.stringify(r.properties),
              })),
            }
          );
        }

        // 7. MENTIONED_IN edges from each entity to its paragraph(s).
        if (rows.mentions.length > 0) {
          await tx.run(
            `UNWIND $rows AS row
             MATCH (e:Entity { name: row.entityName, type: row.entityType })
             MATCH (p:Paragraph { id: row.paragraphId })
             MERGE (e)-[m:MENTIONED_IN { chunkId: row.chunkId }]->(p)
             ON CREATE SET m.context = substring(p.content, 0, 240)
             SET e.mentionCount = coalesce(e.mentionCount, 0) + 1`,
            { rows: rows.mentions }
          );
        }

        // 8. Paragraph embeddings (Phase 2). Inline with the rest of the
        // graph so the write is atomic — partial embedding state is invisible.
        // db.create.setNodeVectorProperty validates dimension against the
        // index and throws cleanly on mismatch.
        if (input.chunkEmbeddings && input.chunkEmbeddings.size > 0) {
          const model = input.embeddingModel ?? null;
          const embeddingRows: { paragraphId: string; vector: number[] }[] = [];
          for (const para of rows.paragraphs) {
            const vec = input.chunkEmbeddings.get(para.chunkId);
            if (vec) embeddingRows.push({ paragraphId: para.id, vector: vec });
          }
          for (const row of embeddingRows) {
            await tx.run(
              `MATCH (p:Paragraph { id: $id })
               CALL db.create.setNodeVectorProperty(p, 'embedding', $vector)
               SET p.embeddingModel = $model, p.embeddedAt = timestamp()`,
              { id: row.paragraphId, vector: row.vector, model }
            );
          }
        }
      });

      return {
        documentId: rows.doc.properties.id as string,
        pageCount: rows.pages.length,
        paragraphCount: rows.paragraphs.length,
        entityCount: rows.entities.size,
        relationshipCount: rows.relationships.length,
      };
    } catch (e) {
      throw new StorageError(
        'writeDocumentGraph failed',
        { documentId: rows.doc.properties.id as string },
        e
      );
    } finally {
      await session.close();
    }
  }

  async upsertNode(node: GraphNode): Promise<string> {
    const session = this.session();
    try {
      const labels = node.labels.length > 0 ? `:${node.labels.join(':')}` : '';
      await session.run(`MERGE (n${labels} { id: $id }) SET n += $props`, {
        id: node.id,
        props: node.properties,
      });
      return node.id;
    } finally {
      await session.close();
    }
  }

  async upsertEdge(edge: GraphEdge): Promise<string> {
    const session = this.session();
    try {
      const cy = relationshipTypeToCypher(edge.type);
      await session.run(
        `MATCH (a { id: $start }), (b { id: $end })
         MERGE (a)-[r:${cy} { id: $id }]->(b)
         SET r += $props`,
        {
          start: edge.startNodeId,
          end: edge.endNodeId,
          id: edge.id,
          props: edge.properties,
        }
      );
      return edge.id;
    } finally {
      await session.close();
    }
  }

  async getNode(nodeId: string): Promise<GraphNode | null> {
    const session = this.session();
    try {
      const result = await session.run(
        'MATCH (n { id: $id }) RETURN labels(n) AS labels, properties(n) AS props LIMIT 1',
        { id: nodeId }
      );
      const rec = result.records[0];
      if (!rec) return null;
      return {
        id: nodeId,
        labels: rec.get('labels'),
        properties: rec.get('props'),
      };
    } finally {
      await session.close();
    }
  }

  async findNodes(query: NodeQuery): Promise<GraphNode[]> {
    const session = this.session();
    try {
      const labels = query.labels && query.labels.length > 0 ? `:${query.labels.join(':')}` : '';
      const whereEntries = Object.entries(query.where ?? {});
      const whereClause =
        whereEntries.length === 0
          ? ''
          : `WHERE ${whereEntries.map(([k]) => `n.${k} = $where_${k}`).join(' AND ')}`;
      const params: Record<string, unknown> = {};
      for (const [k, v] of whereEntries) params[`where_${k}`] = v;
      const limit = query.limit ?? 100;
      const result = await session.run(
        `MATCH (n${labels}) ${whereClause} RETURN n LIMIT toInteger($limit)`,
        { ...params, limit }
      );
      return result.records.map((rec) => {
        const node = rec.get('n');
        return {
          id: (node.properties.id as string) ?? '',
          labels: node.labels,
          properties: node.properties,
        };
      });
    } finally {
      await session.close();
    }
  }

  async executeCypher(query: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const session = this.session();
    try {
      const result = await session.run(query, params);
      return result.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }
}
