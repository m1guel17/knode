import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyFile } from '../../../src/scanner/classifier.js';
import { UnsupportedFileTypeError } from '../../../src/shared/errors.js';

function makeTempFile(name: string, content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'knode-classifier-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('classifyFile', () => {
  it('produces a FileJob for a .pdf path', async () => {
    const path = makeTempFile('doc.pdf', Buffer.from('%PDF-1.4 fake content'));
    const job = await classifyFile(path);
    expect(job.fileType).toBe('pdf');
    expect(job.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(job.fileSizeBytes).toBeGreaterThan(0);
    expect(job.id).toBeDefined();
    expect(job.priority).toBe(0);
  });

  it('produces a FileJob for a .docx path', async () => {
    const path = makeTempFile('doc.docx', 'fake docx');
    const job = await classifyFile(path);
    expect(job.fileType).toBe('docx');
  });

  it('throws UnsupportedFileTypeError for unsupported extensions', async () => {
    const path = makeTempFile('notes.txt', 'plain text');
    await expect(classifyFile(path)).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });

  it('throws UnsupportedFileTypeError for files with no extension', async () => {
    const path = makeTempFile('README', 'no extension');
    await expect(classifyFile(path)).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });

  it('produces stable content hash for identical content', async () => {
    const buf = Buffer.from('repeatable content for hash test');
    const a = makeTempFile('a.pdf', buf);
    const b = makeTempFile('b.pdf', buf);
    const ja = await classifyFile(a);
    const jb = await classifyFile(b);
    expect(ja.contentHash).toBe(jb.contentHash);
  });
});
