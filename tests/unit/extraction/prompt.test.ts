import { describe, expect, it } from 'vitest';
import { buildExtractionPrompt } from '../../../src/extraction/prompts/extraction-prompt.js';
import type { Chunk, Ontology } from '../../../src/shared/types.js';

const ONTOLOGY: Ontology = {
  version: '1',
  name: 'Test',
  description: 'test ontology',
  entityTypes: [
    {
      name: 'Person',
      description: 'a human',
      properties: ['title'],
      examples: ['Alice'],
    },
    {
      name: 'Organization',
      description: 'a company',
      properties: [],
      examples: ['Acme Corp'],
    },
  ],
  relationshipTypes: [
    {
      name: 'works_at',
      description: 'employment',
      source_types: ['Person'],
      target_types: ['Organization'],
    },
  ],
};

const CHUNK: Chunk = {
  id: 'c1',
  documentId: 'd1',
  sequenceIndex: 0,
  content: 'Alice works at Acme Corp.',
  headingHierarchy: ['Chapter 1', 'Intro'],
  pageNumbers: [1, 2],
  tokenEstimate: 12,
  chunkType: 'text',
  metadata: {
    sectionTitle: 'Intro',
    isFirstInSection: true,
    isLastInSection: true,
    overlapWithPrevious: 0,
  },
};

describe('buildExtractionPrompt', () => {
  it('includes the heading hierarchy in the user prompt', () => {
    const { user } = buildExtractionPrompt(CHUNK, ONTOLOGY);
    expect(user).toContain('Chapter 1 > Intro');
  });

  it('includes the chunk content', () => {
    const { user } = buildExtractionPrompt(CHUNK, ONTOLOGY);
    expect(user).toContain('Alice works at Acme Corp.');
  });

  it('lists every ontology entity type in the system prompt', () => {
    const { system } = buildExtractionPrompt(CHUNK, ONTOLOGY);
    expect(system).toContain('Person');
    expect(system).toContain('Organization');
    expect(system).toContain('works_at');
  });

  it('shows page numbers', () => {
    const { user } = buildExtractionPrompt(CHUNK, ONTOLOGY);
    expect(user).toContain('Pages: 1, 2');
  });

  it('handles empty heading hierarchy', () => {
    const noHead = { ...CHUNK, headingHierarchy: [] };
    const { user } = buildExtractionPrompt(noHead, ONTOLOGY);
    expect(user).toContain('no surrounding headings');
  });
});
