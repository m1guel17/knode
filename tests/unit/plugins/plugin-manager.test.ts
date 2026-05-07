import { describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_SKIP_FILE,
  PluginManager,
} from '../../../src/plugins/index.js';
import type {
  OnDocumentParsedCtx,
  OnEntitiesExtractedCtx,
  OnFileDiscoveredCtx,
  PipelinePlugin,
} from '../../../src/plugins/index.js';
import type {
  Chunk,
  ExtractionResult,
  FileJob,
  ParsedDocument,
} from '../../../src/shared/types.js';

const FAKE_JOB: FileJob = {
  id: 'job-1',
  filePath: '/tmp/file.pdf',
  relativePath: 'file.pdf',
  fileType: 'pdf',
  contentHash: 'h',
  fileSizeBytes: 1,
  createdAt: new Date(0),
  modifiedAt: new Date(0),
  priority: 1,
};

const FAKE_PARSED: ParsedDocument = {
  sourceFile: FAKE_JOB,
  sections: [],
  tables: [],
  images: [],
  metadata: { wordCount: 0, customProperties: {} },
};

describe('PluginManager.onFileDiscovered', () => {
  it('runs plugins in registration order and returns the chained result', async () => {
    const calls: string[] = [];
    const pluginA: PipelinePlugin = {
      name: 'a',
      async onFileDiscovered(ctx) {
        calls.push('a');
        return { ...ctx.job, priority: 99 };
      },
    };
    const pluginB: PipelinePlugin = {
      name: 'b',
      async onFileDiscovered(ctx) {
        calls.push('b');
        // Should see the mutated job from plugin A.
        expect(ctx.job.priority).toBe(99);
        return undefined;
      },
    };
    const m = new PluginManager();
    m.register({ plugin: pluginA, errorMode: 'continue' });
    m.register({ plugin: pluginB, errorMode: 'continue' });
    const result = await m.runOnFileDiscovered({ job: FAKE_JOB });
    expect(calls).toEqual(['a', 'b']);
    expect(result?.job.priority).toBe(99);
  });

  it('short-circuits on null (skip) — subsequent plugins are not called', async () => {
    const after = vi.fn();
    const m = new PluginManager();
    m.register({
      plugin: {
        name: 'skip',
        async onFileDiscovered() {
          return PLUGIN_SKIP_FILE;
        },
      },
      errorMode: 'continue',
    });
    m.register({
      plugin: { name: 'after', onFileDiscovered: after },
      errorMode: 'continue',
    });
    const result = await m.runOnFileDiscovered({ job: FAKE_JOB });
    expect(result).toBeNull();
    expect(after).not.toHaveBeenCalled();
  });

  it('continue-mode plugin throwing does not abort the chain', async () => {
    const after = vi.fn(async () => undefined);
    const m = new PluginManager();
    m.register({
      plugin: {
        name: 'thrower',
        async onFileDiscovered() {
          throw new Error('boom');
        },
      },
      errorMode: 'continue',
    });
    m.register({
      plugin: { name: 'after', onFileDiscovered: after },
      errorMode: 'continue',
    });
    const result = await m.runOnFileDiscovered({ job: FAKE_JOB });
    expect(result?.job).toEqual(FAKE_JOB);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('halt-mode plugin throwing rethrows', async () => {
    const m = new PluginManager();
    m.register({
      plugin: {
        name: 'thrower',
        async onFileDiscovered() {
          throw new Error('boom');
        },
      },
      errorMode: 'halt',
    });
    await expect(m.runOnFileDiscovered({ job: FAKE_JOB })).rejects.toThrow('boom');
  });
});

describe('PluginManager.onDocumentParsed', () => {
  it('chains parsed-doc mutations', async () => {
    const m = new PluginManager();
    m.register({
      plugin: {
        name: 'tag',
        async onDocumentParsed(ctx: OnDocumentParsedCtx): Promise<ParsedDocument> {
          return {
            ...ctx.parsed,
            metadata: {
              ...ctx.parsed.metadata,
              customProperties: { ...ctx.parsed.metadata.customProperties, tag: 'finance' },
            },
          };
        },
      },
      errorMode: 'continue',
    });
    const out = await m.runOnDocumentParsed({ job: FAKE_JOB, parsed: FAKE_PARSED });
    expect(out.parsed.metadata.customProperties.tag).toBe('finance');
  });
});

describe('PluginManager.onEntitiesExtracted', () => {
  it('chains extraction-map mutations', async () => {
    const m = new PluginManager();
    const original = new Map<string, ExtractionResult>([
      ['c1', { entities: [], relationships: [], confidence: 1 }],
    ]);
    m.register({
      plugin: {
        name: 'reset',
        async onEntitiesExtracted(_ctx: OnEntitiesExtractedCtx) {
          return new Map<string, ExtractionResult>();
        },
      },
      errorMode: 'continue',
    });
    const out = await m.runOnEntitiesExtracted({
      job: FAKE_JOB,
      chunks: [] as Chunk[],
      extractions: original,
    });
    expect(out.extractions.size).toBe(0);
  });
});
