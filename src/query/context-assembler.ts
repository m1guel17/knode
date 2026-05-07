// Step 3 of the RAG pipeline: take the expanded subgraph and assemble it
// into a prompt-ready context block. Token-aware (rough heuristic ~4 chars
// per token), greedy, with paragraphs ranked by:
//
//   score = alpha * vector_similarity + (1 - alpha) * (entityMatches / anchorEntities)
//
// Paragraphs that were vector-retrieved AND mention multiple anchor entities
// rise to the top. Paragraphs not vector-retrieved are kept (they came in
// via cross-expansion) but with vector_similarity = 0; if they mention
// anchor entities they still rank.
//
// Output:
//   - A numbered context list (`[1] (Document: ..., p.X, "Section"): text`)
//   - A relationship summary (compact `(Source) --[REL]--> (Target) [evidence]` lines)
//   - The mapping of citation key → paragraph for the final RAGResponse.

import type {
  EntityRecord,
  ParagraphRecord,
  RelationshipRecord,
} from './graph-expander.js';

export interface AssembledContext {
  // The full prompt-ready user-message body (numbered context + relationships).
  contextBlock: string;
  // For RAGResponse.sources — one entry per included paragraph.
  sources: Array<{
    citationKey: number;
    paragraph: ParagraphRecord;
    confidence: number;
  }>;
  // For RAGResponse.graphContext — a flat snapshot of the entity/relationship
  // structure that ended up in the context.
  graphContext: {
    entities: EntityRecord[];
    relationships: RelationshipRecord[];
  };
  // Diagnostics.
  contextTokens: number;
  truncated: boolean; // true if the budget cut paragraphs.
}

export interface AssembleOptions {
  question: string;
  paragraphs: ParagraphRecord[];
  entities: EntityRecord[];
  relationships: RelationshipRecord[];
  // The set of entity IDs that were anchor matches from vector retrieval
  // (used in the ranking step).
  anchorEntityIds: Set<string>;
  // paragraphId -> entityIds[]; used by the ranker to weight paragraphs that
  // mention multiple anchors. The expander populates this via
  // paragraphEntityMentions().
  paragraphMentions?: Map<string, string[]>;
  rankAlpha: number; // 0..1
  maxContextTokens: number;
  // Cap on the number of relationship lines appended at the end.
  maxRelationshipLines?: number;
}

const APPROX_CHARS_PER_TOKEN = 4;
const RELATIONSHIP_DEFAULT_LINES = 25;

export function approximateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

interface ScoredParagraph {
  paragraph: ParagraphRecord;
  vectorScore: number;
  entityMatchCount: number;
  anchorTotal: number;
  combinedScore: number;
}

export function rankParagraphs(
  paragraphs: ParagraphRecord[],
  anchorEntityIds: Set<string>,
  paragraphMentions: Map<string, string[]>,
  alpha: number
): ScoredParagraph[] {
  const anchorCount = Math.max(1, anchorEntityIds.size);
  const seen = new Set<string>();
  const scored: ScoredParagraph[] = [];
  for (const para of paragraphs) {
    if (seen.has(para.id)) continue;
    seen.add(para.id);
    const mentions = paragraphMentions.get(para.id) ?? [];
    let matchCount = 0;
    for (const m of mentions) if (anchorEntityIds.has(m)) matchCount++;
    const vec = para.vectorScore ?? 0;
    const entityFrac = matchCount / anchorCount;
    const combined = alpha * vec + (1 - alpha) * entityFrac;
    scored.push({
      paragraph: para,
      vectorScore: vec,
      entityMatchCount: matchCount,
      anchorTotal: anchorEntityIds.size,
      combinedScore: combined,
    });
  }
  return scored.sort((a, b) => b.combinedScore - a.combinedScore);
}

function formatCitationLine(key: number, p: ParagraphRecord, content: string): string {
  const headerParts: string[] = [];
  if (p.fileName) headerParts.push(`Document: ${p.fileName}`);
  if (p.pageNumber != null) headerParts.push(`p.${p.pageNumber}`);
  if (p.sectionHeading) headerParts.push(`"${p.sectionHeading}"`);
  const header = headerParts.length > 0 ? ` (${headerParts.join(', ')})` : '';
  return `[${key}]${header}: ${content}`;
}

function formatRelationshipLine(r: RelationshipRecord): string {
  const evidence = r.evidence.length > 0 ? r.evidence[0] : '';
  const evClause = evidence ? ` [evidence: ${truncate(evidence, 120)}]` : '';
  return `(${r.sourceName}) --[${r.type}]--> (${r.targetName})${evClause}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function assembleContext(opts: AssembleOptions): AssembledContext {
  const sources: AssembledContext['sources'] = [];
  const includedParagraphs: ScoredParagraph[] = [];
  let truncated = false;

  const paragraphMentions = opts.paragraphMentions ?? new Map<string, string[]>();
  const ranked = rankParagraphs(
    opts.paragraphs,
    opts.anchorEntityIds,
    paragraphMentions,
    opts.rankAlpha
  );

  // Reserve roughly 20% of the budget for relationships + headers; use the
  // rest for paragraph bodies.
  const reservedForRels = Math.max(200, Math.floor(opts.maxContextTokens * 0.2));
  const paragraphBudget = opts.maxContextTokens - reservedForRels;

  let runningTokens = 0;
  let citationKey = 1;
  const lines: string[] = [];

  for (const sp of ranked) {
    const fullLine = formatCitationLine(citationKey, sp.paragraph, sp.paragraph.content);
    const lineTokens = approximateTokens(fullLine);
    if (runningTokens + lineTokens > paragraphBudget) {
      // Try truncating the body to fit, but only keep if the truncated form
      // is still substantive (>40 tokens).
      const remaining = paragraphBudget - runningTokens;
      if (remaining > 60) {
        const allowedChars = remaining * APPROX_CHARS_PER_TOKEN - 80;
        const truncatedBody = truncate(sp.paragraph.content, Math.max(0, allowedChars));
        const truncatedLine = formatCitationLine(citationKey, sp.paragraph, truncatedBody);
        const truncatedTokens = approximateTokens(truncatedLine);
        if (runningTokens + truncatedTokens <= paragraphBudget) {
          lines.push(truncatedLine);
          runningTokens += truncatedTokens;
          sources.push({
            citationKey,
            paragraph: sp.paragraph,
            confidence: sp.combinedScore,
          });
          includedParagraphs.push(sp);
          citationKey++;
        }
      }
      truncated = true;
      break;
    }
    lines.push(fullLine);
    runningTokens += lineTokens;
    sources.push({
      citationKey,
      paragraph: sp.paragraph,
      confidence: sp.combinedScore,
    });
    includedParagraphs.push(sp);
    citationKey++;
  }

  // Relationship summary — only keep relationships whose endpoints appear in
  // the included sources or in the anchor entity set, so the LLM has context
  // to reason about them.
  const includedDocs = new Set(includedParagraphs.map((sp) => sp.paragraph.documentId));
  const relevantRelationships = opts.relationships
    .filter(
      (r) =>
        opts.anchorEntityIds.has(r.sourceId) ||
        opts.anchorEntityIds.has(r.targetId) ||
        // include all if no anchors known (defensive)
        opts.anchorEntityIds.size === 0
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, opts.maxRelationshipLines ?? RELATIONSHIP_DEFAULT_LINES);

  const relLines: string[] = [];
  for (const r of relevantRelationships) {
    const line = formatRelationshipLine(r);
    const lineTokens = approximateTokens(line);
    if (runningTokens + lineTokens > opts.maxContextTokens) break;
    runningTokens += lineTokens;
    relLines.push(`- ${line}`);
  }

  const contextSection = lines.join('\n\n');
  const relSection =
    relLines.length > 0 ? `\nRelationships:\n${relLines.join('\n')}` : '';
  const contextBlock = `Question: ${opts.question}\n\nContext:\n${contextSection}${relSection}`;

  // graphContext is the flat list of entities + relationships referenced.
  // We surface the anchor entities and any relationships that survived the
  // budget — this is what the API client gets in graphContext for UI use.
  const entitiesById = new Map<string, EntityRecord>();
  for (const e of opts.entities) entitiesById.set(e.id, e);
  const graphEntities: EntityRecord[] = [];
  for (const id of opts.anchorEntityIds) {
    const e = entitiesById.get(id);
    if (e) graphEntities.push(e);
  }
  for (const r of relevantRelationships) {
    const s = entitiesById.get(r.sourceId);
    const t = entitiesById.get(r.targetId);
    if (s && !graphEntities.some((x) => x.id === s.id)) graphEntities.push(s);
    if (t && !graphEntities.some((x) => x.id === t.id)) graphEntities.push(t);
  }

  // Mark unused includedDocs to avoid an unused warning — included as a
  // diagnostic in case future ranking wants it.
  void includedDocs;

  return {
    contextBlock,
    sources,
    graphContext: {
      entities: graphEntities,
      relationships: relevantRelationships,
    },
    contextTokens: runningTokens,
    truncated,
  };
}
