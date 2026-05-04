// File classifier. Pure: filesystem + hash → FileJob. The orchestrator decides
// whether to skip based on the processing log; the classifier never consults it.

import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { UnsupportedFileTypeError } from '../shared/errors.js';
import type { FileJob, ParserType } from '../shared/types.js';
import { generateId, sha256 } from '../shared/utils.js';

// Phase 2 supports the four core business-document formats.
const SUPPORTED_EXTENSIONS: Record<string, ParserType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
};

export interface ClassifyOptions {
  watchRoot?: string;
}

export async function classifyFile(filePath: string, opts: ClassifyOptions = {}): Promise<FileJob> {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath);
  const ext = extname(absolutePath).toLowerCase();
  const fileType = SUPPORTED_EXTENSIONS[ext];
  if (!fileType) {
    throw new UnsupportedFileTypeError(`Unsupported file extension: ${ext || '(none)'}`, {
      filePath: absolutePath,
      extension: ext,
    });
  }

  const [stats, buf] = await Promise.all([stat(absolutePath), readFile(absolutePath)]);

  const watchRoot = opts.watchRoot ? resolve(opts.watchRoot) : resolve('.');
  const relativePath = relative(watchRoot, absolutePath) || absolutePath;

  return {
    id: generateId(),
    filePath: absolutePath,
    relativePath,
    fileType,
    contentHash: sha256(buf),
    fileSizeBytes: stats.size,
    createdAt: stats.birthtime,
    modifiedAt: stats.mtime,
    priority: 0,
  };
}
