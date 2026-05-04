// THE most impactful artifact in the project. Every change must be reviewed
// and benchmarked. Four sections per project.md §3.3: system context, ontology,
// chunk, output schema reminder.

import type { Chunk, Ontology } from '../../shared/types.js';

export interface BuiltPrompt {
  system: string;
  user: string;
}

function renderEntityTypes(ontology: Ontology): string {
  return ontology.entityTypes
    .map((t) => {
      const props = t.properties.length > 0 ? ` (properties: ${t.properties.join(', ')})` : '';
      const ex = t.examples.length > 0 ? ` Examples: ${t.examples.join(' / ')}.` : '';
      return `- ${t.name}: ${t.description}.${props}${ex}`;
    })
    .join('\n');
}

function renderRelationshipTypes(ontology: Ontology): string {
  return ontology.relationshipTypes
    .map((r) => {
      const src = r.source_types.includes('*') ? 'any' : r.source_types.join('/');
      const tgt = r.target_types.includes('*') ? 'any' : r.target_types.join('/');
      return `- ${r.name}: ${r.description} (${src} → ${tgt}).`;
    })
    .join('\n');
}

function renderHeadingHierarchy(headings: string[]): string {
  if (headings.length === 0) return '(no surrounding headings)';
  return headings.join(' > ');
}

export function buildExtractionPrompt(chunk: Chunk, ontology: Ontology): BuiltPrompt {
  const system = [
    'You are a knowledge-graph construction assistant.',
    'Read the supplied text and extract entities and relationships that are explicitly supported by the text.',
    '',
    'Rules:',
    '1. Use only the entity and relationship types listed in the ontology below. If something does not fit, omit it.',
    '2. Prefer canonical names. Capture aliases (initialisms, abbreviations, alternate spellings) you see in the text.',
    '3. Every relationship must cite a single sentence of evidence drawn verbatim from the text.',
    '4. Do not hallucinate. If the text does not assert it, do not extract it.',
    '5. Confidence is your honest 0-1 estimate of how well-supported the assertion is by the text.',
    '6. Use snake_case relationship names exactly as listed.',
    '',
    '### Entity types',
    renderEntityTypes(ontology),
    '',
    '### Relationship types',
    renderRelationshipTypes(ontology),
  ].join('\n');

  const user = [
    `Heading context: ${renderHeadingHierarchy(chunk.headingHierarchy)}`,
    chunk.metadata.sectionTitle ? `Section: ${chunk.metadata.sectionTitle}` : null,
    `Pages: ${chunk.pageNumbers.join(', ') || 'unknown'}`,
    '',
    '### Text',
    chunk.content,
    '',
    'Return entities and relationships as structured output. Set the overall `confidence` to your aggregate confidence in the extraction (0-1).',
  ]
    .filter((s): s is string => s !== null)
    .join('\n');

  return { system, user };
}
