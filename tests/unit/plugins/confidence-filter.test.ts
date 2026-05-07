import { describe, expect, it } from 'vitest';
import { ConfidenceFilterPlugin } from '../../../src/plugins/index.js';
import type {
  Chunk,
  ExtractionResult,
  FileJob,
} from '../../../src/shared/types.js';

const JOB: FileJob = {
  id: 'j',
  filePath: '/x.pdf',
  relativePath: 'x.pdf',
  fileType: 'pdf',
  contentHash: 'h',
  fileSizeBytes: 1,
  createdAt: new Date(0),
  modifiedAt: new Date(0),
  priority: 1,
};

function chunk(id: string): Chunk {
  return {
    id,
    documentId: 'd',
    sequenceIndex: 0,
    content: 'x',
    headingHierarchy: [],
    pageNumbers: [1],
    tokenEstimate: 1,
    chunkType: 'text',
    metadata: {
      sectionTitle: null,
      isFirstInSection: true,
      isLastInSection: true,
      overlapWithPrevious: 0,
    },
  };
}

describe('ConfidenceFilterPlugin', () => {
  it('drops entities below the threshold', async () => {
    const plugin = new ConfidenceFilterPlugin({
      minEntityConfidence: 0.7,
      minRelationshipConfidence: 0.6,
    });
    const result: ExtractionResult = {
      entities: [
        { name: 'A', type: 'X', aliases: [], properties: {}, confidence: 0.9, sourceChunkId: 'c1' },
        { name: 'B', type: 'X', aliases: [], properties: {}, confidence: 0.4, sourceChunkId: 'c1' },
      ],
      relationships: [],
      confidence: 0.9,
    };
    const out = await plugin.onEntitiesExtracted({
      job: JOB,
      chunks: [chunk('c1')],
      extractions: new Map([['c1', result]]),
    });
    const r = out.get('c1');
    expect(r?.entities.map((e) => e.name)).toEqual(['A']);
  });

  it('drops relationships below the threshold OR with missing endpoints', async () => {
    const plugin = new ConfidenceFilterPlugin({
      minEntityConfidence: 0.7,
      minRelationshipConfidence: 0.6,
    });
    const result: ExtractionResult = {
      entities: [
        { name: 'A', type: 'X', aliases: [], properties: {}, confidence: 0.9, sourceChunkId: 'c1' },
        { name: 'B', type: 'X', aliases: [], properties: {}, confidence: 0.5, sourceChunkId: 'c1' }, // dropped
      ],
      relationships: [
        // confidence-low → drop
        {
          sourceEntity: 'A',
          relationship: 'RELATED',
          targetEntity: 'A',
          properties: {},
          confidence: 0.3,
          evidence: 'lo',
        },
        // confidence-OK but B was dropped → drop
        {
          sourceEntity: 'A',
          relationship: 'RELATED',
          targetEntity: 'B',
          properties: {},
          confidence: 0.9,
          evidence: 'mid',
        },
      ],
      confidence: 0.9,
    };
    const out = await plugin.onEntitiesExtracted({
      job: JOB,
      chunks: [chunk('c1')],
      extractions: new Map([['c1', result]]),
    });
    const r = out.get('c1');
    expect(r?.relationships).toHaveLength(0);
  });

  it('uses defaults when options are not supplied', async () => {
    const plugin = new ConfidenceFilterPlugin();
    const result: ExtractionResult = {
      entities: [
        { name: 'A', type: 'X', aliases: [], properties: {}, confidence: 0.49, sourceChunkId: 'c1' },
      ],
      relationships: [],
      confidence: 0.5,
    };
    const out = await plugin.onEntitiesExtracted({
      job: JOB,
      chunks: [chunk('c1')],
      extractions: new Map([['c1', result]]),
    });
    expect(out.get('c1')?.entities).toHaveLength(0);
  });
});
