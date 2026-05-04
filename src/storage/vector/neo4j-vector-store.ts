// Neo4j-native vector index store. Phase 2 ships only this backend; Qdrant
// and in-memory implementations are Phase 4.

import type { Driver } from 'neo4j-driver';
import { StorageError } from '../../shared/errors.js';
import { createChildLogger } from '../../shared/logger.js';
import type { MetadataFilter, SimilarityResult, VectorStore } from '../interfaces.js';

const log = createChildLogger('storage.vector.neo4j');

export type Neo4jVectorTarget = 'Paragraph' | 'Entity';

export interface Neo4jVectorStoreOptions {
  driver: Driver;
  database: string;
  label: Neo4jVectorTarget;
  property: string; // 'embedding'
  indexName: string;
}

export class Neo4jVectorStore implements VectorStore {
  constructor(private readonly opts: Neo4jVectorStoreOptions) {}

  async upsert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<void> {
    await this.upsertMany([{ id, vector, metadata }]);
  }

  async upsertMany(
    items: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>
  ): Promise<void> {
    if (items.length === 0) return;
    const session = this.opts.driver.session({ database: this.opts.database });
    try {
      // db.create.setNodeVectorProperty validates dimension against the index
      // and is the recommended way to write vectors in Neo4j 5.
      await session.executeWrite(async (tx) => {
        for (const item of items) {
          await tx.run(
            `MATCH (n:${this.opts.label} { id: $id })
             CALL db.create.setNodeVectorProperty(n, $prop, $vector)
             SET n.embeddingModel = coalesce($model, n.embeddingModel),
                 n.embeddedAt = timestamp()`,
            {
              id: item.id,
              prop: this.opts.property,
              vector: item.vector,
              model: item.metadata?.model ?? null,
            }
          );
        }
      });
    } catch (e) {
      throw new StorageError(
        'Neo4jVectorStore.upsertMany failed',
        { label: this.opts.label, count: items.length },
        e
      );
    } finally {
      await session.close();
    }
  }

  async search(
    queryVector: number[],
    topK: number,
    filter?: MetadataFilter
  ): Promise<SimilarityResult[]> {
    const session = this.opts.driver.session({ database: this.opts.database });
    try {
      const filterEntries = Object.entries(filter ?? {});
      const params: Record<string, unknown> = {
        index: this.opts.indexName,
        topK,
        vec: queryVector,
      };
      let whereClause = '';
      if (filterEntries.length > 0) {
        const parts: string[] = [];
        for (const [k, v] of filterEntries) {
          const pkey = `f_${k.replace(/[^a-zA-Z0-9_]/g, '_')}`;
          parts.push(`node.${k} = $${pkey}`);
          params[pkey] = v;
        }
        whereClause = `WHERE ${parts.join(' AND ')}`;
      }
      const result = await session.run(
        `CALL db.index.vector.queryNodes($index, toInteger($topK), $vec)
         YIELD node, score
         ${whereClause}
         RETURN node.id AS id, score, properties(node) AS props`,
        params
      );
      return result.records.map((rec) => ({
        id: rec.get('id') as string,
        score: rec.get('score') as number,
        metadata: rec.get('props') as Record<string, unknown>,
      }));
    } catch (e) {
      log.error(
        { error: e instanceof Error ? e.message : String(e), index: this.opts.indexName },
        'vector.search_failed'
      );
      throw new StorageError(
        'Neo4jVectorStore.search failed',
        { index: this.opts.indexName },
        e
      );
    } finally {
      await session.close();
    }
  }

  async delete(id: string): Promise<void> {
    const session = this.opts.driver.session({ database: this.opts.database });
    try {
      await session.run(
        `MATCH (n:${this.opts.label} { id: $id }) REMOVE n.${this.opts.property}, n.embeddingModel, n.embeddedAt`,
        { id }
      );
    } finally {
      await session.close();
    }
  }
}
