// Plugin contract. Each hook is optional — implementers declare only the
// hooks they care about. Hooks are awaited; they may return mutations.
//
// Decision: plugin errors do not crash the pipeline by default. A plugin
// that throws gets logged with its name + offending payload, and the
// pipeline continues. The PluginManager allows per-plugin override
// (`errorMode: 'halt'`) for users who want strict behavior.

import type {
  Chunk,
  ExtractionResult,
  FileJob,
  ParsedDocument,
  ProcessingStats,
} from '../shared/types.js';

export interface OnFileDiscoveredCtx {
  job: FileJob;
}

export interface OnDocumentParsedCtx {
  job: FileJob;
  parsed: ParsedDocument;
}

export interface OnEntitiesExtractedCtx {
  job: FileJob;
  chunks: Chunk[];
  extractions: Map<string, ExtractionResult>;
}

export interface OnDocumentCompletedCtx {
  job: FileJob;
  stats: ProcessingStats;
}

export interface OnDocumentRemovedCtx {
  documentId: string;
  filePath: string;
}

export interface OnRunCompletedCtx {
  documentsProcessed: number;
  totalDurationMs: number;
  // Free-form so the cost reporter and other plugins can surface their own data.
  metadata: Record<string, unknown>;
}

// Each lifecycle hook may return a transformed copy of the input, or void
// to leave it unchanged. Returning `null` from onFileDiscovered specifically
// means "skip this file" — that's a deliberate signal, not an error.
export interface PipelinePlugin {
  readonly name: string;

  onFileDiscovered?(ctx: OnFileDiscoveredCtx): Promise<FileJob | null | void>;
  onDocumentParsed?(ctx: OnDocumentParsedCtx): Promise<ParsedDocument | void>;
  onEntitiesExtracted?(
    ctx: OnEntitiesExtractedCtx
  ): Promise<Map<string, ExtractionResult> | void>;
  onDocumentCompleted?(ctx: OnDocumentCompletedCtx): Promise<void>;
  onDocumentRemoved?(ctx: OnDocumentRemovedCtx): Promise<void>;
  onRunCompleted?(ctx: OnRunCompletedCtx): Promise<void>;
}

export interface PluginRegistration {
  plugin: PipelinePlugin;
  errorMode: 'continue' | 'halt';
}
