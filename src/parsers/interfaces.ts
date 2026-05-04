// Parser-domain interfaces. Lives here, not in shared/types.ts, because only
// parser code consumes these.

import type { FileJob, ParsedDocument, ParserType } from '../shared/types.js';

export interface DocumentParser {
  readonly supportedTypes: ParserType[];
  canHandle(job: FileJob): boolean;
  parse(job: FileJob): Promise<ParsedDocument>;
}
