import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessingLog } from '../../../src/scanner/processing-log.js';

describe('ProcessingLog', () => {
  let log: ProcessingLog;
  let dbPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'knode-log-'));
    dbPath = join(dir, 'log.db');
    log = new ProcessingLog(dbPath);
  });

  afterEach(() => {
    log.close();
  });

  it('round-trips entries by path', () => {
    const entry = {
      filePath: '/tmp/doc.pdf',
      contentHash: 'abc123',
      processedAt: 1700000000000,
      status: 'completed' as const,
      errorMessage: null,
      documentId: 'doc-1',
    };
    log.record(entry);
    const found = log.findByPath('/tmp/doc.pdf');
    expect(found).toEqual(entry);
  });

  it('finds entries by hash', () => {
    log.record({
      filePath: '/tmp/a.pdf',
      contentHash: 'shared-hash',
      processedAt: 1,
      status: 'completed',
      errorMessage: null,
      documentId: 'a',
    });
    log.record({
      filePath: '/tmp/b.pdf',
      contentHash: 'shared-hash',
      processedAt: 2,
      status: 'completed',
      errorMessage: null,
      documentId: 'b',
    });
    const rows = log.findByHash('shared-hash');
    expect(rows).toHaveLength(2);
  });

  it('upserts existing rows on path collision', () => {
    log.record({
      filePath: '/tmp/a.pdf',
      contentHash: 'h1',
      processedAt: 1,
      status: 'in_progress',
      errorMessage: null,
      documentId: 'a',
    });
    log.record({
      filePath: '/tmp/a.pdf',
      contentHash: 'h2',
      processedAt: 2,
      status: 'completed',
      errorMessage: null,
      documentId: 'a',
    });
    const found = log.findByPath('/tmp/a.pdf');
    expect(found?.contentHash).toBe('h2');
    expect(found?.status).toBe('completed');
  });

  it('marks failure preserving prior hash', () => {
    log.record({
      filePath: '/tmp/a.pdf',
      contentHash: 'h1',
      processedAt: 1,
      status: 'in_progress',
      errorMessage: null,
      documentId: 'a',
    });
    log.markFailed('/tmp/a.pdf', 'parse blew up', 'h1');
    const found = log.findByPath('/tmp/a.pdf');
    expect(found?.status).toBe('failed');
    expect(found?.errorMessage).toBe('parse blew up');
    expect(found?.contentHash).toBe('h1');
  });
});
