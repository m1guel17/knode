// Maps thrown errors to HTTP status codes and a stable JSON body shape.
// Every error response looks like:
//   { error: { code: string, message: string, details?: unknown } }
// Internal errors never leak stack traces or raw DB error text — those go to
// the structured log instead.

import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import {
  ConfigError,
  ExtractionError,
  KnodeError,
  ParserError,
  QueryLimitError,
  StorageError,
  ValidationError,
} from '../../shared/errors.js';
import { createChildLogger } from '../../shared/logger.js';

const log = createChildLogger('api.error');

interface ErrorMapping {
  status: number;
  code: string;
}

function classify(err: unknown): ErrorMapping {
  if (err instanceof ZodError) return { status: 400, code: 'validation_error' };
  if (err instanceof ValidationError) return { status: 400, code: 'validation_error' };
  if (err instanceof QueryLimitError) return { status: 413, code: 'query_too_large' };
  if (err instanceof StorageError) return { status: 503, code: 'storage_unavailable' };
  if (err instanceof ParserError) return { status: 422, code: 'parser_error' };
  if (err instanceof ExtractionError) return { status: 502, code: 'extraction_error' };
  if (err instanceof ConfigError) return { status: 500, code: 'config_error' };
  if (err instanceof KnodeError) return { status: 500, code: 'internal_error' };
  return { status: 500, code: 'internal_error' };
}

export const errorHandler: ErrorHandler = (err, c) => {
  const { status, code } = classify(err);
  const message = err instanceof Error ? err.message : 'Internal error';
  // Log full context server-side; the client never sees the cause.
  log.error(
    {
      code,
      status,
      message,
      context: err instanceof KnodeError ? err.context : undefined,
      cause: err instanceof Error && err.cause ? String(err.cause) : undefined,
      stack: err instanceof Error ? err.stack : undefined,
    },
    'api.error'
  );

  // Validation errors include the field-level detail; everything else returns
  // only a generic message — internal details belong in the log, not the wire.
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code,
          message: 'Request validation failed',
          details: err.flatten(),
        },
      },
      status as never
    );
  }

  if (status >= 500) {
    return c.json(
      {
        error: { code, message: 'Internal server error' },
      },
      status as never
    );
  }

  return c.json(
    {
      error: { code, message },
    },
    status as never
  );
};
