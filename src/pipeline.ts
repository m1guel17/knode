// End-to-end orchestrator. Phase 2 wires embeddings, the entity resolver, and
// the cost controller. Per-document chunk extraction runs in batches of
// `extraction.batch_size`, then a single graph write transaction commits.

import type { Logger } from 'pino';
import type { CostController } from './extraction/cost-controller.js';
import type { EmbeddingGenerator } from './extraction/embedding-generator.js';
import type { EntityResolver } from './extraction/entity-resolver.js';
import type { TripleExtractor } from './extraction/index.js';
import type { DocumentChunker, ParserRegistry } from './parsers/index.js';
import { type ProcessingLog, classifyFile } from './scanner/index.js';
import { createChildLogger } from './shared/logger.js';
import type { Chunk, ExtractionResult, ProcessingStats } from './shared/types.js';
import type { GraphBackend } from './storage/index.js';

export interface PipelineDeps {
  parsers: ParserRegistry;
  chunker: DocumentChunker;
  extractor: TripleExtractor;
  backend: GraphBackend;
  log: ProcessingLog;
  embeddings?: EmbeddingGenerator | null;
  resolver?: EntityResolver | null;
  costController?: CostController | null;
  // Concurrency for chunk extraction within a single file.
  extractionBatchSize?: number;
  logger?: Logger;
}

export class Pipeline {
  private readonly logger: Logger;

  constructor(private readonly deps: PipelineDeps) {
    this.logger = deps.logger ?? createChildLogger('pipeline');
  }

  async processFile(filePath: string): Promise<ProcessingStats> {
    const startedAt = Date.now();
    let documentId: string | null = null;
    let chunkCount = 0;
    let entityCount = 0;
    let relationshipCount = 0;
    let stage = 'classify';

    try {
      const job = await classifyFile(filePath);
      documentId = job.id;
      this.logger.info(
        {
          filePath: job.filePath,
          fileType: job.fileType,
          contentHash: job.contentHash,
          fileSizeBytes: job.fileSizeBytes,
        },
        'pipeline.classified'
      );

      // Idempotency: skip if same path + same hash + previously completed.
      const prior = this.deps.log.findByPath(job.filePath);
      if (prior && prior.contentHash === job.contentHash && prior.status === 'completed') {
        this.logger.info({ filePath: job.filePath }, 'pipeline.skipped_already_processed');
        return {
          filePath: job.filePath,
          documentId: prior.documentId,
          status: 'skipped',
          chunkCount: 0,
          entityCount: 0,
          relationshipCount: 0,
          durationMs: Date.now() - startedAt,
        };
      }

      this.deps.log.record({
        filePath: job.filePath,
        contentHash: job.contentHash,
        processedAt: Date.now(),
        status: 'in_progress',
        errorMessage: null,
        documentId: job.id,
      });

      stage = 'parse';
      const parser = this.deps.parsers.getParserFor(job);
      const parsed = await parser.parse(job);
      this.logger.info(
        {
          filePath: job.filePath,
          sectionCount: parsed.sections.length,
          pageCount: parsed.metadata.pageCount,
          wordCount: parsed.metadata.wordCount,
        },
        'pipeline.parsed'
      );

      stage = 'chunk';
      const chunks: Chunk[] = this.deps.chunker.chunk(parsed);
      chunkCount = chunks.length;
      this.logger.info({ filePath: job.filePath, chunkCount: chunks.length }, 'pipeline.chunked');

      stage = 'extract';
      const extractions = await this.runExtractionBatched(chunks);
      for (const r of extractions.values()) {
        entityCount += r.entities.length;
        relationshipCount += r.relationships.length;
      }
      this.logger.info(
        { filePath: job.filePath, entityCount, relationshipCount },
        'pipeline.extracted'
      );

      stage = 'embed';
      let chunkEmbeddings: Map<string, number[]> | undefined;
      let embeddingModel: string | undefined;
      if (this.deps.embeddings) {
        const inputs = chunks.map((c) => ({
          id: c.id,
          // Heading hierarchy prepended so the embedding has full context (PRD §2.2).
          text: c.headingHierarchy.length
            ? `${c.headingHierarchy.join(' > ')}\n\n${c.content}`
            : c.content,
        }));
        const vecs = await this.deps.embeddings.embedBatch(inputs);
        chunkEmbeddings = new Map(vecs.map((v) => [v.id, v.vector]));
        embeddingModel = this.deps.embeddings.modelName;
        this.logger.info(
          { filePath: job.filePath, embeddedCount: vecs.length, model: embeddingModel },
          'pipeline.embedded'
        );
      }

      stage = 'write';
      const writeInput: Parameters<typeof this.deps.backend.writeDocumentGraph>[0] = {
        parsed,
        chunks,
        extractions,
      };
      if (chunkEmbeddings) writeInput.chunkEmbeddings = chunkEmbeddings;
      if (embeddingModel) writeInput.embeddingModel = embeddingModel;
      const writeResult = await this.deps.backend.writeDocumentGraph(writeInput);
      this.logger.info({ filePath: job.filePath, ...writeResult }, 'pipeline.written');

      stage = 'resolve';
      if (this.deps.resolver) {
        // 1. Embed any new/changed entities so the resolver has vectors to query.
        await this.deps.resolver.embedNewEntities(job.id);
        // 2. Stage-1 normalization pass: cheap exact-match dedup.
        const stage1 = await this.deps.resolver.resolveByNormalization({ documentId: job.id });
        // 3. Stage-2/3 embedding + LLM pass for this document's new entities.
        const newEntities: Array<{ name: string; type: string }> = [];
        const seen = new Set<string>();
        for (const r of extractions.values()) {
          for (const e of r.entities) {
            const k = `${e.name}|${e.type}`;
            if (seen.has(k)) continue;
            seen.add(k);
            newEntities.push({ name: e.name, type: e.type });
          }
        }
        const stage23 = await this.deps.resolver.resolveByEmbedding({
          documentId: job.id,
          newEntities,
        });
        this.logger.info(
          {
            filePath: job.filePath,
            stage1Merges: stage1.length,
            stage23Merges: stage23.merges.length,
            llmCalls: stage23.llmCalls,
            halted: stage23.halted,
          },
          'pipeline.resolved'
        );
      }

      const costUsd = this.deps.costController?.costForDocument(job.id) ?? 0;
      this.deps.log.record({
        filePath: job.filePath,
        contentHash: job.contentHash,
        processedAt: Date.now(),
        status: 'completed',
        errorMessage: null,
        documentId: job.id,
        costUsd,
      });

      return {
        filePath: job.filePath,
        documentId: job.id,
        status: 'completed',
        chunkCount,
        entityCount,
        relationshipCount,
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ filePath, stage, error: message }, 'pipeline.failed');
      try {
        this.deps.log.markFailed(filePath, `[${stage}] ${message}`, '');
      } catch {
        // Swallow — the original error is what matters.
      }
      throw e;
    }
  }

  // Batched chunk extraction: up to `extraction.batch_size` chunks of one
  // document run in parallel. The cost controller's halt signal is checked
  // between batches so we stop cleanly mid-document.
  private async runExtractionBatched(
    chunks: Chunk[]
  ): Promise<Map<string, ExtractionResult>> {
    const out = new Map<string, ExtractionResult>();
    const batchSize = Math.max(1, this.deps.extractionBatchSize ?? 5);
    for (let i = 0; i < chunks.length; i += batchSize) {
      if (this.deps.costController?.shouldHalt()) {
        this.logger.warn(
          { processedChunks: i, totalChunks: chunks.length },
          'pipeline.extraction_halted_by_cost'
        );
        break;
      }
      const slice = chunks.slice(i, i + batchSize);
      const results = await Promise.all(slice.map((c) => this.deps.extractor.extract(c)));
      slice.forEach((c, idx) => {
        const r = results[idx];
        if (r) out.set(c.id, r);
      });
    }
    return out;
  }
}
