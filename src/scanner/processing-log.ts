// SQLite-backed log of every file the pipeline has touched. Phase 2's
// incremental processing keys off this — keep the schema stable.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as Db } from 'better-sqlite3';

export type ProcessingStatus = 'completed' | 'failed' | 'in_progress';

export interface ProcessingLogEntry {
  filePath: string;
  contentHash: string;
  processedAt: number; // unix epoch ms
  status: ProcessingStatus;
  errorMessage: string | null;
  documentId: string | null;
  costUsd?: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS processing_log (
    file_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    processed_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    document_id TEXT,
    cost_usd REAL
  );
  CREATE INDEX IF NOT EXISTS idx_log_hash ON processing_log(content_hash);
`;

// Migration: ensure cost_usd column exists on pre-existing databases.
const ENSURE_COST_COLUMN = `
  -- SQLite has no IF NOT EXISTS for ADD COLUMN. We probe via PRAGMA in code.
  ALTER TABLE processing_log ADD COLUMN cost_usd REAL
`;

interface Row {
  file_path: string;
  content_hash: string;
  processed_at: number;
  status: string;
  error_message: string | null;
  document_id: string | null;
  cost_usd: number | null;
}

function rowToEntry(r: Row): ProcessingLogEntry {
  return {
    filePath: r.file_path,
    contentHash: r.content_hash,
    processedAt: r.processed_at,
    status: r.status as ProcessingStatus,
    errorMessage: r.error_message,
    documentId: r.document_id,
    ...(r.cost_usd != null ? { costUsd: r.cost_usd } : {}),
  };
}

export class ProcessingLog {
  private readonly db: Db;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.ensureCostColumn();
  }

  private ensureCostColumn(): void {
    const cols = this.db.prepare('PRAGMA table_info(processing_log)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'cost_usd')) {
      this.db.exec(ENSURE_COST_COLUMN);
    }
  }

  record(entry: ProcessingLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO processing_log
           (file_path, content_hash, processed_at, status, error_message, document_id, cost_usd)
         VALUES (@filePath, @contentHash, @processedAt, @status, @errorMessage, @documentId, @costUsd)
         ON CONFLICT(file_path) DO UPDATE SET
           content_hash = excluded.content_hash,
           processed_at = excluded.processed_at,
           status = excluded.status,
           error_message = excluded.error_message,
           document_id = excluded.document_id,
           cost_usd = excluded.cost_usd`
      )
      .run({ ...entry, costUsd: entry.costUsd ?? null });
  }

  findByPath(filePath: string): ProcessingLogEntry | null {
    const row = this.db.prepare('SELECT * FROM processing_log WHERE file_path = ?').get(filePath) as
      | Row
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  findByHash(contentHash: string): ProcessingLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM processing_log WHERE content_hash = ?')
      .all(contentHash) as Row[];
    return rows.map(rowToEntry);
  }

  markFailed(filePath: string, errorMessage: string, contentHash: string): void {
    const existing = this.findByPath(filePath);
    this.record({
      filePath,
      contentHash: existing?.contentHash ?? contentHash,
      processedAt: Date.now(),
      status: 'failed',
      errorMessage,
      documentId: existing?.documentId ?? null,
    });
  }

  close(): void {
    this.db.close();
  }
}
