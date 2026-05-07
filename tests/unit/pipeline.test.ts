// Pipeline orchestrator unit test with all dependencies stubbed.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TripleExtractor } from '../../src/extraction/index.js';
import { DocxParser } from '../../src/parsers/adapters/docx-parser.js';
import { DocumentChunker, ParserRegistry } from '../../src/parsers/index.js';
import { Pipeline } from '../../src/pipeline.js';
import {
  PLUGIN_SKIP_FILE,
  PluginManager,
  type PipelinePlugin,
} from '../../src/plugins/index.js';
import { ProcessingLog } from '../../src/scanner/index.js';
import type {
  Chunk,
  ExtractionResult,
  GraphEdge,
  GraphNode,
  NodeQuery,
} from '../../src/shared/types.js';
import type {
  DocumentGraphInput,
  DocumentWriteResult,
  GraphBackend,
} from '../../src/storage/interfaces.js';

const FIXTURE_DOCX = resolve(__dirname, '..', 'fixtures', 'sample.docx');

class StubExtractor implements TripleExtractor {
  async extract(chunk: Chunk): Promise<ExtractionResult> {
    return {
      entities: [
        {
          name: 'Acme Corp',
          type: 'Organization',
          aliases: [],
          properties: {},
          confidence: 0.9,
          sourceChunkId: chunk.id,
        },
      ],
      relationships: [],
      confidence: 0.9,
    };
  }
}

class StubBackend implements GraphBackend {
  writes: DocumentGraphInput[] = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async applySchema(): Promise<void> {}
  async writeDocumentGraph(input: DocumentGraphInput): Promise<DocumentWriteResult> {
    this.writes.push(input);
    let entityCount = 0;
    for (const r of input.extractions.values()) entityCount += r.entities.length;
    return {
      documentId: input.parsed.sourceFile.id,
      pageCount: 1,
      paragraphCount: input.chunks.length,
      entityCount,
      relationshipCount: 0,
    };
  }
  async upsertNode(node: GraphNode): Promise<string> {
    return node.id;
  }
  async upsertEdge(edge: GraphEdge): Promise<string> {
    return edge.id;
  }
  async getNode(): Promise<GraphNode | null> {
    return null;
  }
  async findNodes(_q: NodeQuery): Promise<GraphNode[]> {
    return [];
  }
  async executeCypher(): Promise<unknown> {
    return [];
  }
}

describe('Pipeline orchestrator', () => {
  let log: ProcessingLog;
  let backend: StubBackend;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'knode-pipeline-'));
    log = new ProcessingLog(join(dir, 'log.db'));
    backend = new StubBackend();
  });

  afterEach(() => {
    log.close();
  });

  function makePipeline(): Pipeline {
    const parsers = new ParserRegistry();
    parsers.register(new DocxParser());
    return new Pipeline({
      parsers,
      chunker: new DocumentChunker({ targetTokens: 500, overlapTokens: 50 }),
      extractor: new StubExtractor(),
      backend,
      log,
    });
  }

  it('processes a docx fixture end-to-end with stubs', async () => {
    const pipeline = makePipeline();
    const stats = await pipeline.processFile(FIXTURE_DOCX);
    expect(stats.status).toBe('completed');
    expect(stats.chunkCount).toBeGreaterThan(0);
    expect(stats.entityCount).toBeGreaterThan(0);
    expect(backend.writes).toHaveLength(1);
  });

  it('skips already-processed file with same content hash', async () => {
    const pipeline = makePipeline();
    const first = await pipeline.processFile(FIXTURE_DOCX);
    expect(first.status).toBe('completed');

    const second = await pipeline.processFile(FIXTURE_DOCX);
    expect(second.status).toBe('skipped');
    expect(backend.writes).toHaveLength(1);
  });

  it('runs plugin lifecycle hooks in order', async () => {
    const calls: string[] = [];
    const plugin: PipelinePlugin = {
      name: 'lifecycle-tracker',
      async onFileDiscovered() {
        calls.push('onFileDiscovered');
      },
      async onDocumentParsed() {
        calls.push('onDocumentParsed');
      },
      async onEntitiesExtracted() {
        calls.push('onEntitiesExtracted');
      },
      async onDocumentCompleted() {
        calls.push('onDocumentCompleted');
      },
    };
    const manager = new PluginManager();
    manager.register({ plugin, errorMode: 'continue' });
    const parsers = new ParserRegistry();
    parsers.register(new DocxParser());
    const pipeline = new Pipeline({
      parsers,
      chunker: new DocumentChunker({ targetTokens: 500, overlapTokens: 50 }),
      extractor: new StubExtractor(),
      backend,
      log,
      plugins: manager,
    });
    const stats = await pipeline.processFile(FIXTURE_DOCX);
    expect(stats.status).toBe('completed');
    expect(calls).toEqual([
      'onFileDiscovered',
      'onDocumentParsed',
      'onEntitiesExtracted',
      'onDocumentCompleted',
    ]);
  });

  it('plugin can skip a file by returning null from onFileDiscovered', async () => {
    const onCompleted = vi.fn();
    const skipper: PipelinePlugin = {
      name: 'skipper',
      async onFileDiscovered() {
        return PLUGIN_SKIP_FILE;
      },
      onDocumentCompleted: onCompleted,
    };
    const manager = new PluginManager();
    manager.register({ plugin: skipper, errorMode: 'continue' });
    const parsers = new ParserRegistry();
    parsers.register(new DocxParser());
    const pipeline = new Pipeline({
      parsers,
      chunker: new DocumentChunker({ targetTokens: 500, overlapTokens: 50 }),
      extractor: new StubExtractor(),
      backend,
      log,
      plugins: manager,
    });
    const stats = await pipeline.processFile(FIXTURE_DOCX);
    expect(stats.status).toBe('skipped');
    expect(onCompleted).not.toHaveBeenCalled();
    expect(backend.writes).toHaveLength(0);
  });

  it('continue-mode plugin errors do not stop the pipeline', async () => {
    const broken: PipelinePlugin = {
      name: 'broken',
      async onDocumentParsed() {
        throw new Error('plugin boom');
      },
    };
    const manager = new PluginManager();
    manager.register({ plugin: broken, errorMode: 'continue' });
    const parsers = new ParserRegistry();
    parsers.register(new DocxParser());
    const pipeline = new Pipeline({
      parsers,
      chunker: new DocumentChunker({ targetTokens: 500, overlapTokens: 50 }),
      extractor: new StubExtractor(),
      backend,
      log,
      plugins: manager,
    });
    const stats = await pipeline.processFile(FIXTURE_DOCX);
    expect(stats.status).toBe('completed');
    expect(backend.writes).toHaveLength(1);
  });

  it('records failure when extractor throws', async () => {
    const failing: TripleExtractor = {
      async extract() {
        throw new Error('forced extraction failure');
      },
    };
    const parsers = new ParserRegistry();
    parsers.register(new DocxParser());
    const pipeline = new Pipeline({
      parsers,
      chunker: new DocumentChunker({ targetTokens: 500, overlapTokens: 50 }),
      extractor: failing,
      backend,
      log,
    });

    await expect(pipeline.processFile(FIXTURE_DOCX)).rejects.toThrow(/forced extraction failure/);
    const entry = log.findByPath(FIXTURE_DOCX);
    expect(entry?.status).toBe('failed');
    expect(entry?.errorMessage).toContain('extract');
  });
});
