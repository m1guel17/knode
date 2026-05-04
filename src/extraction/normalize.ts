// Pure normalization for the resolver's stage 1. No I/O, no LLM. Tested
// extensively in unit tests because the rest of the resolver pivots on it.
//
// The output is intentionally lossy and deterministic: two surface forms that
// refer to the same real-world thing should map to the same normalized string
// in 95%+ of "easy" cases (PRD §2 workstream 3).

const ORG_SUFFIX_PATTERN =
  /(?:,?\s*(inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|limited|llc|llp|gmbh|s\.?\s?a\.?|ag|n\.?\s?v\.?|plc|pty\.?|spa)\b\.?)+$/i;

const PERSON_HONORIFIC_PATTERN =
  /^(?:dr\.?|mr\.?|mrs\.?|ms\.?|miss|prof\.?|professor|sir|dame|hon\.?|rev\.?)\s+/i;

const PERSON_CREDENTIAL_PATTERN =
  /,?\s+(?:phd|ph\.d\.?|md|m\.d\.?|esq\.?|jr\.?|sr\.?|ii|iii|iv|cpa|cfa|mba|jd)\b\.?$/i;

const PUNCT_KEEP_HYPHEN = /[^\p{L}\p{N}\s-]/gu;

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeDate(input: string): string {
  // Best-effort ISO normalization. Native Date parsing is brittle but good
  // enough for "Q3 2024" → fallback, "March 15, 2023" → 2023-03-15. Anything
  // else falls back to whitespace-collapsed lowercase.
  const trimmed = input.trim();
  if (!trimmed) return '';
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    const d = new Date(ts);
    return d.toISOString().slice(0, 10);
  }
  return collapseWhitespace(trimmed.toLowerCase());
}

export function normalizeEntityName(name: string, type: string): string {
  if (!name) return '';
  if (type === 'Date') return normalizeDate(name);

  let s = stripDiacritics(name).toLowerCase();
  s = collapseWhitespace(s);

  if (type === 'Organization') {
    // Strip common suffixes (potentially repeated, e.g. "Acme Inc Co.").
    while (ORG_SUFFIX_PATTERN.test(s)) {
      const next = s.replace(ORG_SUFFIX_PATTERN, '');
      if (next === s) break;
      s = collapseWhitespace(next);
    }
  }

  if (type === 'Person') {
    while (PERSON_HONORIFIC_PATTERN.test(s)) {
      const next = s.replace(PERSON_HONORIFIC_PATTERN, '');
      if (next === s) break;
      s = next;
    }
    while (PERSON_CREDENTIAL_PATTERN.test(s)) {
      const next = s.replace(PERSON_CREDENTIAL_PATTERN, '');
      if (next === s) break;
      s = next;
    }
  }

  // Remove punctuation except hyphens within words.
  s = s.replace(PUNCT_KEEP_HYPHEN, ' ');
  s = collapseWhitespace(s);
  return s;
}
