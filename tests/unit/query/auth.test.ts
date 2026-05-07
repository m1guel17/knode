import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bearerAuth } from '../../../src/query/middleware/auth.js';

function buildApp(token: string) {
  const app = new Hono();
  app.use('/api/v1/*', bearerAuth({ token }));
  app.get('/api/v1/secret', (c) => c.json({ ok: true }));
  app.get('/public', (c) => c.json({ ok: true }));
  return app;
}

describe('bearerAuth', () => {
  it('throws at construction time when the token is too short', () => {
    expect(() => bearerAuth({ token: 'short' })).toThrow(/at least 8/);
  });

  it('passes through requests with a valid bearer token', async () => {
    const app = buildApp('superSecret123');
    const res = await app.request('/api/v1/secret', {
      headers: { Authorization: 'Bearer superSecret123' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const app = buildApp('superSecret123');
    const res = await app.request('/api/v1/secret');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 401 when the token is wrong (same length)', async () => {
    const app = buildApp('superSecret123');
    const res = await app.request('/api/v1/secret', {
      headers: { Authorization: 'Bearer XXXXXXXXXX1234' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the token is wrong (different length)', async () => {
    const app = buildApp('superSecret123');
    const res = await app.request('/api/v1/secret', {
      headers: { Authorization: 'Bearer short-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a malformed Authorization header', async () => {
    const app = buildApp('superSecret123');
    const res = await app.request('/api/v1/secret', {
      headers: { Authorization: 'Basic abc:def' },
    });
    expect(res.status).toBe(401);
  });

  it('does not run on routes outside the protected path', async () => {
    const app = buildApp('superSecret123');
    const res = await app.request('/public');
    expect(res.status).toBe(200);
  });
});
