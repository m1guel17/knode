// Workers for the file-jobs and resolution-jobs queues. Each worker holds a
// single instance of the parser registry, extractor, embedding generator,
// resolver, and graph backend — wired by the caller. Workers can run in the
// same process as the queue producer or as separate processes.

import { type Job, Worker, type WorkerOptions, UnrecoverableError } from 'bullmq';
import type { Pipeline } from '../pipeline.js';
import type { CostController } from '../extraction/cost-controller.js';
import type { EntityResolver } from '../extraction/entity-resolver.js';
import { createChildLogger } from '../shared/logger.js';
import {
  FILE_DEAD_QUEUE,
  FILE_QUEUE,
  type FileJobPayload,
  type JobQueues,
  RESOLUTION_DEAD_QUEUE,
  RESOLUTION_QUEUE,
  type ResolutionJobPayload,
} from './queue.js';

const log = createChildLogger('scanner.worker');

export interface WorkersDeps {
  queues: JobQueues;
  pipeline: Pipeline;
  resolver?: EntityResolver | null;
  costController?: CostController | null;
  fileConcurrency: number;
  resolutionConcurrency: number;
  rateLimitMax?: number;
  rateLimitDurationMs?: number;
}

export interface RunningWorkers {
  file: Worker<FileJobPayload>;
  resolution: Worker<ResolutionJobPayload>;
  close(): Promise<void>;
}

export function startWorkers(deps: WorkersDeps): RunningWorkers {
  const connection = deps.queues.getConnection();

  const fileWorkerOpts: WorkerOptions = {
    connection,
    concurrency: deps.fileConcurrency,
  };
  if (deps.rateLimitMax && deps.rateLimitDurationMs) {
    fileWorkerOpts.limiter = {
      max: deps.rateLimitMax,
      duration: deps.rateLimitDurationMs,
    };
  }

  const file = new Worker<FileJobPayload>(
    FILE_QUEUE,
    async (job: Job<FileJobPayload>) => {
      const { filePath } = job.data;
      log.info({ filePath, attemptsMade: job.attemptsMade }, 'worker.file_start');
      // Cost-budget halt: throw a non-retryable error so the job moves to
      // failed without burning attempts. Operator restarts with --continue-over-budget.
      if (deps.costController?.shouldHalt()) {
        throw new UnrecoverableError('cost.budget_exceeded');
      }
      const stats = await deps.pipeline.processFile(filePath);
      // Successful processing → enqueue a per-document resolution job.
      if (stats.status === 'completed' && stats.documentId && deps.resolver) {
        await deps.queues.enqueueResolution(stats.documentId);
      }
      return stats;
    },
    fileWorkerOpts
  );

  const resolution = new Worker<ResolutionJobPayload>(
    RESOLUTION_QUEUE,
    async (job: Job<ResolutionJobPayload>) => {
      const { documentId } = job.data;
      log.info({ documentId }, 'worker.resolution_start');
      if (!deps.resolver) {
        log.warn({ documentId }, 'worker.resolution_skipped_no_resolver');
        return { skipped: true };
      }
      // Resolver work has been done inline by the pipeline at write-time, but
      // the per-document resolution job runs an additional cross-document
      // pass to catch entities extracted nearly simultaneously (PRD §2.3).
      await deps.resolver.embedNewEntities(documentId);
      const stage1 = await deps.resolver.resolveByNormalization();
      const stage23 = await deps.resolver.resolveByEmbedding({
        documentId,
        newEntities: [], // empty triggers global pass via vector neighbors
      });
      return {
        stage1Merges: stage1.length,
        stage23Merges: stage23.merges.length,
      };
    },
    {
      connection,
      concurrency: deps.resolutionConcurrency,
    }
  );

  // Dead-letter handling: when a job exhausts attempts, push to the *_dead
  // queue so an operator can inspect with scripts/inspect-dead-jobs.ts.
  file.on('failed', (job: Job<FileJobPayload> | undefined, err: Error) => {
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 0)) {
      void deps.queues.dead.file
        .add(`dead:${job.id}`, {
          original: job.data,
          error: err.message,
          attempts: job.attemptsMade,
          failedAt: Date.now(),
        })
        .then(() => log.error({ jobId: job.id, error: err.message }, 'worker.file_dead_letter'));
    }
  });
  resolution.on('failed', (job: Job<ResolutionJobPayload> | undefined, err: Error) => {
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 0)) {
      void deps.queues.dead.resolution
        .add(`dead:${job.id}`, {
          original: job.data,
          error: err.message,
          attempts: job.attemptsMade,
          failedAt: Date.now(),
        })
        .then(() =>
          log.error({ jobId: job.id, error: err.message }, 'worker.resolution_dead_letter')
        );
    }
  });

  void FILE_DEAD_QUEUE;
  void RESOLUTION_DEAD_QUEUE;

  return {
    file,
    resolution,
    close: async () => {
      await Promise.all([file.close(), resolution.close()]);
    },
  };
}
