import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigError,
  QueryLimitError,
  StorageError,
  ValidationError,
} from '../../../src/shared/errors.js';
import { errorHandler } from '../../../src/query/middleware/error-handler.js';

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.get('/zod', () => {
    z.object({ x: z.number() }).parse({ x: 'not a number' });
    return new Response('unreachable');
  });
  app.get('/validation', () => {
    throw new ValidationError('bad shape');
  });
  app.get('/limit', () => {
    throw new QueryLimitError('too many rows');
  });
  app.get('/storage', () => {
    throw new StorageError('db down');
  });
  app.get('/config', () => {
    throw new ConfigError('boom');
  });
  app.get('/native', () => {
    throw new Error('raw');
  });
  return app;
}

describe('errorHandler', () => {
  it('maps ZodError to 400 with details', async () => {
    const res = await buildApp().request('/zod');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details).toBeTruthy();
  });

  it('maps ValidationError to 400', async () => {
    const res = await buildApp().request('/validation');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toBe('bad shape');
  });

  it('maps QueryLimitError to 413', async () => {
    const res = await buildApp().request('/limit');
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('query_too_large');
  });

  it('maps StorageError to 503 and hides the message', async () => {
    const res = await buildApp().request('/storage');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('storage_unavailable');
    // Internal — message must not leak the raw "db down".
    expect(body.error.message).toBe('Internal server error');
  });

  it('maps ConfigError to 500 and hides the message', async () => {
    const res = await buildApp().request('/config');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('config_error');
    expect(body.error.message).toBe('Internal server error');
  });

  it('maps a plain Error to 500 (no stack leak)', async () => {
    const res = await buildApp().request('/native');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('Internal server error');
  });
});
