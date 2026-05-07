// BullMQ queue plumbing. Two queues (PRD §3 critical decision):
//   - file-jobs    : LLM-bound, low concurrency (2–4 typical)
//   - resolution-jobs : graph-DB-bound, higher concurrency
// Producers enqueue; the worker process(es) consume.
//
// Processing log + content hashes guarantee restart safety: re-enqueueing a
// job whose document was already completed is a no-op (Pipeline.processFile
// returns 'skipped').

import { type ConnectionOptions, Queue, type QueueOptions } from 'bullmq';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger('scanner.queue');

export const FILE_QUEUE = 'file-jobs';
export const RESOLUTION_QUEUE = 'resolution-jobs';
// BullMQ v5+ forbids `:` in queue names (Redis key namespacing collision).
export const FILE_DEAD_QUEUE = 'file-jobs-dead';
export const RESOLUTION_DEAD_QUEUE = 'resolution-jobs-dead';

export interface FileJobPayload {
  filePath: string;
  enqueuedAt: number;
}

export interface ResolutionJobPayload {
  documentId: string;
  enqueuedAt: number;
}

export interface QueueDeps {
  redisUrl: string;
  rateLimitMax?: number;
  rateLimitDurationMs?: number;
  retryAttempts?: number;
  retryBackoffBaseMs?: number;
}

export class JobQueues {
  readonly file: Queue<FileJobPayload>;
  readonly resolution: Queue<ResolutionJobPayload>;
  readonly dead: { file: Queue; resolution: Queue };
  private readonly connection: ConnectionOptions;

  constructor(deps: QueueDeps) {
    this.connection = parseRedisUrl(deps.redisUrl);
    const options: QueueOptions = {
      connection: this.connection,
      defaultJobOptions: {
        attempts: deps.retryAttempts ?? 3,
        backoff: {
          type: 'exponential',
          delay: deps.retryBackoffBaseMs ?? 5_000,
        },
        // Smaller files get lower priority numbers (= higher BullMQ priority);
        // the scanner sets `priority` on the job itself.
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      },
    };
    this.file = new Queue<FileJobPayload>(FILE_QUEUE, options);
    this.resolution = new Queue<ResolutionJobPayload>(RESOLUTION_QUEUE, options);
    this.dead = {
      file: new Queue(FILE_DEAD_QUEUE, { connection: this.connection }),
      resolution: new Queue(RESOLUTION_DEAD_QUEUE, { connection: this.connection }),
    };
  }

  // Submit a file. `priority` is the BullMQ priority (lower = higher
  // priority). The scanner derives this from byte size (smaller = higher).
  async enqueueFile(filePath: string, priority: number): Promise<void> {
    await this.file.add(
      `file:${filePath}`,
      { filePath, enqueuedAt: Date.now() },
      { priority, jobId: jobIdForFile(filePath) }
    );
    log.debug({ filePath, priority }, 'queue.file_enqueued');
  }

  async enqueueResolution(documentId: string): Promise<void> {
    await this.resolution.add(
      `resolution:${documentId}`,
      { documentId, enqueuedAt: Date.now() },
      { jobId: `resolution:${documentId}` }
    );
    log.debug({ documentId }, 'queue.resolution_enqueued');
  }

  getConnection(): ConnectionOptions {
    return this.connection;
  }

  async close(): Promise<void> {
    await Promise.all([
      this.file.close(),
      this.resolution.close(),
      this.dead.file.close(),
      this.dead.resolution.close(),
    ]);
  }
}

// File-size-driven priority. BullMQ priority is 1..2^21; smaller numbers run
// first. We map bytes log-scale into 1..1000 so very-small files run first
// while very-large ones queue up at the end.
export function priorityForSize(bytes: number): number {
  if (bytes <= 0) return 1;
  const logged = Math.log10(bytes + 1);
  return Math.max(1, Math.min(1000, Math.round(logged * 100)));
}

function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  const port = u.port ? Number.parseInt(u.port, 10) : 6379;
  const conn: ConnectionOptions = {
    host: u.hostname || 'localhost',
    port,
  };
  if (u.password) (conn as Record<string, unknown>).password = u.password;
  if (u.username) (conn as Record<string, unknown>).username = u.username;
  if (u.pathname && u.pathname.length > 1) {
    (conn as Record<string, unknown>).db = Number.parseInt(u.pathname.slice(1), 10);
  }
  return conn;
}

function jobIdForFile(filePath: string): string {
  // Deterministic job ID per filePath: re-enqueue is a no-op while the job is
  // active or in the wait queue (BullMQ deduplicates). On a restart after
  // completion the entry has already been removed (removeOnComplete).
  return `file:${filePath}`;
}
