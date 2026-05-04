// Walk a folder recursively, yielding paths that match the supported parser
// extensions and don't match any ignore_pattern. Used by the --folder CLI.

import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

export interface WalkOptions {
  ignorePatterns?: string[];
  // Currently a closed list mirroring the classifier. The walker doesn't
  // import the classifier to keep them decoupled — both are tied via tests.
  extensions?: string[];
}

const DEFAULT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);

export async function walkFolder(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const exts = new Set((opts.extensions ?? [...DEFAULT_EXTENSIONS]).map((e) => e.toLowerCase()));
  const ignoreMatchers = (opts.ignorePatterns ?? []).map(globToRegex);
  const out: string[] = [];

  const visit = async (dir: string): Promise<void> => {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (ignoreMatchers.some((re) => re.test(rel) || re.test(full))) continue;
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(name).toLowerCase();
      if (exts.has(ext)) out.push(full);
    }
  };

  await visit(root);
  out.sort();
  return out;
}

// Tiny glob → regex. Supports **, *, ?. Good enough for the ignore-patterns
// use case; bring in `picomatch` if we need full glob semantics later.
function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const next = glob[i + 1];
    if (c === '*' && next === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()|[]{}\\'.includes(c ?? '')) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
