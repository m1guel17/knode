// Three-stage entity resolver. Per PRD §2 workstream 3:
//   Stage 1 — normalize() pivot. Cheap, deterministic, no LLM.
//   Stage 2 — embedding cosine similarity. Medium cost (one query per entity).
//   Stage 3 — LLM `same | different`. Expensive, only for ambiguous pairs.
//
// Each merge is logged for audit; failures roll back atomically (one Cypher
// transaction per merge).

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { ExtractionError } from '../shared/errors.js';
import { createChildLogger } from '../shared/logger.js';
import { generateId } from '../shared/utils.js';
import type { Neo4jBackend } from '../storage/backends/neo4j-backend.js';
import { ENTITY_VECTOR_INDEX } from '../storage/schema.js';
import { Neo4jVectorStore } from '../storage/vector/neo4j-vector-store.js';
import {
  type EmbeddingGenerator,
  buildEntityEmbeddingText,
} from './embedding-generator.js';
import { normalizeEntityName } from './normalize.js';
import {
  type ResolutionPair,
  ResolutionResponseSchema,
  buildResolutionPrompt,
} from './prompts/resolution-prompt.js';

const log = createChildLogger('extraction.resolver');

export interface ResolverOptions {
  enabled: boolean;
  model: string;
  similarityThreshold: number; // default 0.92
  highConfidenceThreshold?: number; // default 0.99 — pairs above this still go through LLM (PRD risk mitigation)
  maxCandidatesPerEntity: number; // default 5
  skipTypes: string[];
  // When true, compute merges and log them but do not apply.
  dryRun?: boolean;
  // Injection points for tests.
  generate?: typeof generateObject;
  // Cost-controller hook — called for every LLM call the resolver makes.
  recordCall?: (info: {
    callType: 'resolution';
    model: string;
    inputTokens: number;
    outputTokens: number;
  }) => void;
  // When true, the resolver halts before issuing more LLM calls (cost stop).
  shouldHalt?: () => boolean;
}

export interface MergeRecord {
  canonicalId: string;
  mergedId: string;
  canonicalName: string;
  mergedName: string;
  type: string;
  similarity: number;
  llmDecision: 'same' | 'different' | 'skipped';
  llmConfidence: number;
  reason: string;
  appliedAt: number;
  applied: boolean;
}

export interface ResolveDocumentInput {
  documentId: string;
  // The (name, type) pairs newly extracted from this document. The resolver
  // queries the existing graph for candidates against each.
  newEntities: Array<{ name: string; type: string }>;
}

export interface ResolveResult {
  candidatesConsidered: number;
  llmCalls: number;
  merges: MergeRecord[];
  halted: boolean;
}

interface CandidateEntity {
  id: string;
  name: string;
  normalizedName: string;
  type: string;
  aliases: string[];
  mentionCount: number;
  firstSeen: number;
  embedding?: number[];
  contextSentences: string[];
}

const DEFAULT_HIGH_CONFIDENCE = 0.99;

export class EntityResolver {
  private readonly vectorStore: Neo4jVectorStore;
  private readonly generate: typeof generateObject;
  private readonly mergeLog: MergeRecord[] = [];

  constructor(
    private readonly backend: Neo4jBackend,
    private readonly embeddings: EmbeddingGenerator,
    private readonly opts: ResolverOptions
  ) {
    this.vectorStore = new Neo4jVectorStore({
      driver: backend.getDriver(),
      database: backend.getDatabase(),
      label: 'Entity',
      property: 'embedding',
      indexName: ENTITY_VECTOR_INDEX,
    });
    this.generate = opts.generate ?? generateObject;
  }

  // Returns the cumulative merge log captured by this resolver instance.
  getMergeLog(): readonly MergeRecord[] {
    return this.mergeLog;
  }

  // Stage-1 pass: for every newly-extracted entity, find any other entity
  // with the same (normalizedName, type) and merge. No LLM; very cheap.
  async resolveByNormalization(scope?: { documentId?: string }): Promise<MergeRecord[]> {
    if (!this.opts.enabled) return [];
    const driver = this.backend.getDriver();
    const session = driver.session({ database: this.backend.getDatabase() });
    const merges: MergeRecord[] = [];
    try {
      // Find duplicate clusters.
      const skip = this.opts.skipTypes.length
        ? `AND NOT e.type IN $skipTypes`
        : '';
      const docFilter = scope?.documentId
        ? `WITH e WHERE EXISTS { MATCH (e)-[:MENTIONED_IN]->(:Paragraph { documentId: $documentId }) }`
        : '';
      const result = await session.run(
        `MATCH (e:Entity)
         WHERE e.normalizedName IS NOT NULL AND e.normalizedName <> '' ${skip}
         ${docFilter}
         WITH e.normalizedName AS norm, e.type AS type, collect(e) AS group
         WHERE size(group) > 1
         RETURN norm, type, [n IN group | { id: n.id, name: n.name, mentionCount: coalesce(n.mentionCount, 0), firstSeen: coalesce(n.firstSeen, 0) }] AS members`,
        {
          skipTypes: this.opts.skipTypes,
          documentId: scope?.documentId ?? null,
        }
      );

      for (const rec of result.records) {
        const members = rec.get('members') as Array<{
          id: string;
          name: string;
          mentionCount: number | { toNumber(): number };
          firstSeen: number | { toNumber(): number };
        }>;
        if (members.length < 2) continue;
        // Pick canonical: highest mentionCount, tiebreak earliest firstSeen.
        const numeric = members
          .map((m) => ({
            id: m.id,
            name: m.name,
            mentionCount: typeof m.mentionCount === 'number' ? m.mentionCount : m.mentionCount.toNumber(),
            firstSeen: typeof m.firstSeen === 'number' ? m.firstSeen : m.firstSeen.toNumber(),
          }))
          .sort((a, b) => {
            if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
            return a.firstSeen - b.firstSeen;
          });
        const canonical = numeric[0];
        if (!canonical) continue;
        for (let i = 1; i < numeric.length; i++) {
          const merged = numeric[i];
          if (!merged) continue;
          const record: MergeRecord = {
            canonicalId: canonical.id,
            mergedId: merged.id,
            canonicalName: canonical.name,
            mergedName: merged.name,
            type: rec.get('type') as string,
            similarity: 1.0, // exact normalized match
            llmDecision: 'skipped',
            llmConfidence: 1.0,
            reason: 'normalized name matches',
            appliedAt: Date.now(),
            applied: false,
          };
          if (!this.opts.dryRun) {
            await this.applyMerge(canonical.id, merged.id);
            record.applied = true;
          }
          merges.push(record);
          this.mergeLog.push(record);
        }
      }
    } finally {
      await session.close();
    }
    log.info(
      { merges: merges.length, scope, stage: 'normalization' },
      'resolver.stage1_complete'
    );
    return merges;
  }

  // Stage-2 + Stage-3 pass for a specific document. Embedding-driven candidate
  // search, LLM confirmation per pair (skipping skip_types, capped per entity).
  async resolveByEmbedding(input: ResolveDocumentInput): Promise<ResolveResult> {
    const result: ResolveResult = {
      candidatesConsidered: 0,
      llmCalls: 0,
      merges: [],
      halted: false,
    };
    if (!this.opts.enabled) return result;

    for (const ent of input.newEntities) {
      if (this.opts.skipTypes.includes(ent.type)) continue;
      if (this.opts.shouldHalt?.()) {
        result.halted = true;
        log.warn({ entity: ent.name }, 'resolver.halted_by_cost');
        break;
      }

      const subject = await this.loadEntity(ent.name, ent.type);
      if (!subject || !subject.embedding) continue;

      const candidates = await this.vectorStore.search(
        subject.embedding,
        this.opts.maxCandidatesPerEntity + 1, // +1 to drop self
        { type: ent.type }
      );

      for (const cand of candidates) {
        if (cand.id === subject.id) continue;
        if (cand.score < this.opts.similarityThreshold) continue;
        result.candidatesConsidered++;

        const candEntity = await this.loadEntityById(cand.id);
        if (!candEntity) continue;

        const high = this.opts.highConfidenceThreshold ?? DEFAULT_HIGH_CONFIDENCE;
        let decision: 'same' | 'different' = 'same';
        let confidence = cand.score;
        let reason = `embedding similarity ${cand.score.toFixed(3)}`;

        // Always run the LLM for pairs below the high-confidence threshold.
        // Above it, we still LLM-check (PRD risk mitigation: false-positive
        // merges are dangerous). Set a higher prior for the LLM to override.
        if (this.opts.shouldHalt?.()) {
          result.halted = true;
          break;
        }
        const llm = await this.runLlm({
          type: ent.type,
          a: {
            name: subject.name,
            aliases: subject.aliases,
            context: subject.contextSentences.join(' ').slice(0, 400),
          },
          b: {
            name: candEntity.name,
            aliases: candEntity.aliases,
            context: candEntity.contextSentences.join(' ').slice(0, 400),
          },
        });
        result.llmCalls++;
        decision = llm.decision;
        confidence = llm.confidence;
        reason = llm.reason || reason;

        if (decision !== 'same') {
          this.mergeLog.push({
            canonicalId: subject.id,
            mergedId: candEntity.id,
            canonicalName: subject.name,
            mergedName: candEntity.name,
            type: ent.type,
            similarity: cand.score,
            llmDecision: decision,
            llmConfidence: confidence,
            reason,
            appliedAt: Date.now(),
            applied: false,
          });
          continue;
        }
        void high;

        const ranked = [subject, candEntity].sort((a, b) => {
          if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
          return a.firstSeen - b.firstSeen;
        });
        const canonical = ranked[0];
        const merged = ranked[1];
        if (!canonical || !merged || canonical.id === merged.id) continue;

        const record: MergeRecord = {
          canonicalId: canonical.id,
          mergedId: merged.id,
          canonicalName: canonical.name,
          mergedName: merged.name,
          type: ent.type,
          similarity: cand.score,
          llmDecision: decision,
          llmConfidence: confidence,
          reason,
          appliedAt: Date.now(),
          applied: false,
        };
        if (!this.opts.dryRun) {
          await this.applyMerge(canonical.id, merged.id);
          // Re-embed canonical because its context just expanded.
          await this.refreshEmbedding(canonical.id);
          record.applied = true;
        }
        result.merges.push(record);
        this.mergeLog.push(record);
      }
    }
    log.info(
      {
        documentId: input.documentId,
        candidates: result.candidatesConsidered,
        llmCalls: result.llmCalls,
        merges: result.merges.length,
      },
      'resolver.embedding_complete'
    );
    return result;
  }

  // Embed every entity in this document (or all entities lacking an embedding).
  // Used as a setup step before resolveByEmbedding.
  async embedNewEntities(documentId: string): Promise<number> {
    const driver = this.backend.getDriver();
    const session = driver.session({ database: this.backend.getDatabase() });
    try {
      const result = await session.run(
        `MATCH (e:Entity)-[:MENTIONED_IN]->(p:Paragraph { documentId: $documentId })
         WHERE e.embedding IS NULL OR e.embeddingModel <> $model
         WITH e, collect(DISTINCT substring(p.content, 0, 240))[..5] AS contexts
         RETURN e.id AS id, e.name AS name, e.type AS type, contexts`,
        { documentId, model: this.embeddings.modelName }
      );
      if (result.records.length === 0) return 0;
      const inputs = result.records.map((r) => {
        const id = r.get('id') as string;
        const name = r.get('name') as string;
        const type = r.get('type') as string;
        const contexts = (r.get('contexts') as string[]) ?? [];
        return { id, text: buildEntityEmbeddingText(name, type, contexts) };
      });
      const vecs = await this.embeddings.embedBatch(inputs);
      await this.vectorStore.upsertMany(
        vecs.map((v) => ({
          id: v.id,
          vector: v.vector,
          metadata: { model: this.embeddings.modelName },
        }))
      );
      return vecs.length;
    } finally {
      await session.close();
    }
  }

  private async runLlm(pair: ResolutionPair): Promise<{
    decision: 'same' | 'different';
    confidence: number;
    reason: string;
  }> {
    const { system, user } = buildResolutionPrompt(pair);
    try {
      const result = await this.generate({
        model: anthropic(this.opts.model),
        schema: ResolutionResponseSchema,
        system,
        prompt: user,
        temperature: 0,
      });
      const usage =
        (result as { usage?: { promptTokens?: number; completionTokens?: number } }).usage ?? {};
      this.opts.recordCall?.({
        callType: 'resolution',
        model: this.opts.model,
        inputTokens: usage.promptTokens ?? 0,
        outputTokens: usage.completionTokens ?? 0,
      });
      const obj = result.object;
      return { decision: obj.decision, confidence: obj.confidence, reason: obj.reason ?? '' };
    } catch (e) {
      log.warn(
        { error: e instanceof Error ? e.message : String(e) },
        'resolver.llm_failed_default_different'
      );
      // Fail-closed: any LLM error is treated as "different" to avoid bad merges.
      return { decision: 'different', confidence: 0, reason: 'llm_error' };
    }
  }

  private async loadEntity(name: string, type: string): Promise<CandidateEntity | null> {
    const driver = this.backend.getDriver();
    const session = driver.session({ database: this.backend.getDatabase() });
    try {
      const result = await session.run(
        `MATCH (e:Entity { name: $name, type: $type })
         OPTIONAL MATCH (e)-[:MENTIONED_IN]->(p:Paragraph)
         WITH e, collect(DISTINCT substring(p.content, 0, 240))[..5] AS contexts
         RETURN e.id AS id, e.name AS name, e.normalizedName AS norm,
                e.type AS type, e.aliases AS aliases,
                coalesce(e.mentionCount, 0) AS mentionCount,
                coalesce(e.firstSeen, 0) AS firstSeen,
                e.embedding AS embedding, contexts`,
        { name, type }
      );
      const rec = result.records[0];
      if (!rec) return null;
      return this.recordToCandidate(rec);
    } finally {
      await session.close();
    }
  }

  private async loadEntityById(id: string): Promise<CandidateEntity | null> {
    const driver = this.backend.getDriver();
    const session = driver.session({ database: this.backend.getDatabase() });
    try {
      const result = await session.run(
        `MATCH (e:Entity { id: $id })
         OPTIONAL MATCH (e)-[:MENTIONED_IN]->(p:Paragraph)
         WITH e, collect(DISTINCT substring(p.content, 0, 240))[..5] AS contexts
         RETURN e.id AS id, e.name AS name, e.normalizedName AS norm,
                e.type AS type, e.aliases AS aliases,
                coalesce(e.mentionCount, 0) AS mentionCount,
                coalesce(e.firstSeen, 0) AS firstSeen,
                e.embedding AS embedding, contexts`,
        { id }
      );
      const rec = result.records[0];
      if (!rec) return null;
      return this.recordToCandidate(rec);
    } finally {
      await session.close();
    }
  }

  private recordToCandidate(rec: {
    get(key: string): unknown;
  }): CandidateEntity {
    const toNum = (x: unknown): number => {
      if (typeof x === 'number') return x;
      if (x && typeof (x as { toNumber?: () => number }).toNumber === 'function')
        return (x as { toNumber: () => number }).toNumber();
      return 0;
    };
    const embedding = rec.get('embedding') as number[] | null;
    return {
      id: rec.get('id') as string,
      name: rec.get('name') as string,
      normalizedName: (rec.get('norm') as string) ?? '',
      type: rec.get('type') as string,
      aliases: (rec.get('aliases') as string[]) ?? [],
      mentionCount: toNum(rec.get('mentionCount')),
      firstSeen: toNum(rec.get('firstSeen')),
      ...(embedding ? { embedding } : {}),
      contextSentences: (rec.get('contexts') as string[]) ?? [],
    };
  }

  // Atomic merge: redirect every relationship and MENTIONED_IN edge from
  // mergedId to canonicalId; absorb aliases; delete the merged node. Single
  // Cypher transaction — failure rolls back.
  private async applyMerge(canonicalId: string, mergedId: string): Promise<void> {
    if (canonicalId === mergedId) return;
    const driver = this.backend.getDriver();
    const session = driver.session({ database: this.backend.getDatabase() });
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `MATCH (canonical:Entity { id: $canonicalId })
           MATCH (merged:Entity { id: $mergedId })
           // Redirect outgoing edges (excluding MENTIONED_IN, handled below).
           CALL {
             WITH canonical, merged
             MATCH (merged)-[r]->(other)
             WHERE type(r) <> 'MENTIONED_IN'
             WITH canonical, merged, other, r, type(r) AS rt, properties(r) AS props
             CALL apoc.merge.relationship(canonical, rt, props, props, other) YIELD rel
             DELETE r
             RETURN count(*) AS outgoing
           }
           CALL {
             WITH canonical, merged
             MATCH (other)-[r]->(merged)
             WHERE type(r) <> 'MENTIONED_IN'
             WITH canonical, merged, other, r, type(r) AS rt, properties(r) AS props
             CALL apoc.merge.relationship(other, rt, props, props, canonical) YIELD rel
             DELETE r
             RETURN count(*) AS incoming
           }
           // MENTIONED_IN: redirect from merged to canonical, dedup by chunkId.
           CALL {
             WITH canonical, merged
             MATCH (merged)-[m:MENTIONED_IN]->(p:Paragraph)
             WITH canonical, merged, p, m, m.chunkId AS chunkId
             MERGE (canonical)-[mc:MENTIONED_IN { chunkId: chunkId }]->(p)
             ON CREATE SET mc.context = m.context
             DELETE m
             RETURN count(*) AS mentions
           }
           // Absorb aliases.
           SET canonical.aliases =
                 [a IN coalesce(canonical.aliases, []) WHERE a <> merged.name] +
                 [merged.name] +
                 [a IN coalesce(merged.aliases, []) WHERE NOT a IN coalesce(canonical.aliases, []) AND a <> canonical.name],
               canonical.mentionCount = coalesce(canonical.mentionCount, 0) + coalesce(merged.mentionCount, 0),
               canonical.firstSeen = CASE
                 WHEN coalesce(merged.firstSeen, canonical.firstSeen) < coalesce(canonical.firstSeen, merged.firstSeen)
                 THEN merged.firstSeen ELSE canonical.firstSeen END,
               canonical.lastSeen = timestamp()
           DETACH DELETE merged`,
          { canonicalId, mergedId }
        );
        // Audit row in the merge_log node.
        await tx.run(
          `CREATE (m:_MergeAudit {
             id: $auditId,
             canonicalId: $canonicalId,
             mergedId: $mergedId,
             at: timestamp()
           })`,
          { auditId: generateId(), canonicalId, mergedId }
        );
      });
    } catch (e) {
      throw new ExtractionError(
        'Entity merge transaction failed',
        { canonicalId, mergedId },
        e
      );
    } finally {
      await session.close();
    }
  }

  private async refreshEmbedding(entityId: string): Promise<void> {
    const ent = await this.loadEntityById(entityId);
    if (!ent) return;
    const text = buildEntityEmbeddingText(ent.name, ent.type, ent.contextSentences);
    const vec = await this.embeddings.embedOne(text);
    await this.vectorStore.upsert(entityId, vec.vector, { model: this.embeddings.modelName });
  }
}
