// Domain error classes. Every thrown error carries context for the operator.

export type ErrorContext = Record<string, unknown>;

export class KnodeError extends Error {
  readonly context: ErrorContext;
  override readonly cause?: unknown;

  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
    if (cause !== undefined) this.cause = cause;
  }
}

export class ConfigError extends KnodeError {}
export class ParserError extends KnodeError {}
export class UnsupportedFileTypeError extends ParserError {}
export class ExtractionError extends KnodeError {}
export class StorageError extends KnodeError {}
