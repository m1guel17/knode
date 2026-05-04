import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkFolder } from '../../../src/scanner/folder-walker.js';

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'walker-'));
  mkdirSync(join(root, 'sub'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'a.pdf'), 'pdf');
  writeFileSync(join(root, 'b.docx'), 'docx');
  writeFileSync(join(root, 'c.xlsx'), 'xlsx');
  writeFileSync(join(root, 'd.pptx'), 'pptx');
  writeFileSync(join(root, 'note.txt'), 'no'); // unsupported ext
  writeFileSync(join(root, 'sub', 'e.pdf'), 'pdf');
  writeFileSync(join(root, '.git', 'should-not-walk.pdf'), 'pdf');
  return root;
}

describe('walkFolder', () => {
  it('returns supported extensions only, recursively', async () => {
    const root = makeTree();
    const files = await walkFolder(root);
    const names = files.map((f) => f.replace(`${root}/`, ''));
    expect(names.sort()).toEqual(['.git/should-not-walk.pdf', 'a.pdf', 'b.docx', 'c.xlsx', 'd.pptx', 'sub/e.pdf']);
  });

  it('respects ignore patterns', async () => {
    const root = makeTree();
    const files = await walkFolder(root, { ignorePatterns: ['**/.git/**'] });
    const names = files.map((f) => f.replace(`${root}/`, ''));
    expect(names).not.toContain('.git/should-not-walk.pdf');
    expect(names).toContain('a.pdf');
  });

  it('returns empty for empty folders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'walker-empty-'));
    const files = await walkFolder(root);
    expect(files).toEqual([]);
  });
});
