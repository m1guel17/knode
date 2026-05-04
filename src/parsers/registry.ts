// First-match-wins parser registry. Domain-specific adapters register before
// fallbacks so they take precedence.

import { ParserError } from '../shared/errors.js';
import type { FileJob } from '../shared/types.js';
import type { DocumentParser } from './interfaces.js';

export class ParserRegistry {
  private readonly parsers: DocumentParser[] = [];

  register(parser: DocumentParser): void {
    this.parsers.push(parser);
  }

  getParserFor(job: FileJob): DocumentParser {
    for (const p of this.parsers) {
      if (p.canHandle(job)) return p;
    }
    throw new ParserError(`No parser registered for file type: ${job.fileType}`, {
      filePath: job.filePath,
      fileType: job.fileType,
    });
  }
}
