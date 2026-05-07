// Tags the parsed document with a `domain` based on path patterns. Because
// the domain landed on the parsed document, downstream extractions can use
// it to bias their behavior. (E.g., the resolver could read the doc-level
// domain to skip cross-domain merges in a future enhancement.)
//
// Pattern syntax: glob-like `**` (any depth) and `*` (path segment), matched
// against the file path. First match wins. Inserts the domain into
// parsed.metadata.customProperties.domain (a free-form bag).

import type { ParsedDocument } from '../shared/types.js';
import { createChildLogger } from '../shared/logger.js';
import type {
  OnDocumentParsedCtx,
  PipelinePlugin,
} from './interfaces.js';

const log = createChildLogger('plugins.domain-tagger');

export interface DomainTaggerOptions {
  // Map of glob pattern → domain name. First-match wins; order in the input
  // matters. JS objects preserve insertion order, so a record is fine.
  pathPatterns: Record<string, string>;
}

function globToRegex(glob: string): RegExp {
  // Tiny glob → regex: `**` matches any chars including slashes; `*` matches
  // a single path segment chunk; `?` matches one char; everything else is
  // literal. Anchored to whole string.
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '.';
    } else if (c && /[.+^$(){}|[\]\\]/.test(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

export class DomainTaggerPlugin implements PipelinePlugin {
  readonly name = 'domain-tagger';
  private readonly compiled: Array<{ pattern: string; regex: RegExp; domain: string }>;

  constructor(opts: DomainTaggerOptions) {
    this.compiled = Object.entries(opts.pathPatterns).map(([pattern, domain]) => ({
      pattern,
      regex: globToRegex(pattern),
      domain,
    }));
  }

  async onDocumentParsed(ctx: OnDocumentParsedCtx): Promise<ParsedDocument | void> {
    const path = ctx.job.relativePath ?? ctx.job.filePath;
    for (const { pattern, regex, domain } of this.compiled) {
      if (regex.test(path)) {
        log.debug(
          { filePath: path, pattern, domain },
          'domain_tagger.matched'
        );
        return {
          ...ctx.parsed,
          metadata: {
            ...ctx.parsed.metadata,
            customProperties: {
              ...ctx.parsed.metadata.customProperties,
              domain,
            },
          },
        };
      }
    }
    // No match — leave the parsed doc unchanged. Returning void is
    // semantically equivalent and saves an allocation.
    return undefined;
  }
}
