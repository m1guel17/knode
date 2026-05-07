// Smoke tests for the API server wiring. The Cypher endpoint is exercised
// without a real Neo4j by stubbing the driver.

import { describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../../../src/query/index.js';

// Build a fake driver that the cypher endpoint can use without a real Neo4j.
function fakeDriver() {
  const close = vi.fn();
  const session = {
    run: vi.fn(async () => ({
      records: [
        {
          keys: ['n'],
          get: () => 42,
        },
      ],
    })),
    close,
  };
  const driver = {
    session: () => session,
  };
  return { driver, session };
}

function buildBackend() {
  const { driver, session } = fakeDriver();
  const backend = {
    getDriver: () => driver,
    getDatabase: () => 'neo4j',
  } as never;
  return { backend, session };
}

describe('createApiServer wiring', () => {
  it('GET /api/v1/health is unauthenticated and returns 200', async () => {
    const { backend } = buildBackend();
    const app = createApiServer({
      backend,
      apiConfig: {
        host: '127.0.0.1',
        port: 3030,
        cypherTimeoutMs: 1000,
        cypherMaxRows: 10,
        logQueryText: false,
      },
      apiToken: 'tokenabc12345',
    });
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 401 when /api/v1/cypher is hit without a token', async () => {
    const { backend } = buildBackend();
    const app = createApiServer({
      backend,
      apiConfig: {
        host: '127.0.0.1',
        port: 3030,
        cypherTimeoutMs: 1000,
        cypherMaxRows: 10,
        logQueryText: false,
      },
      apiToken: 'tokenabc12345',
    });
    const res = await app.request('/api/v1/cypher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'MATCH (n) RETURN n LIMIT 1' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for a write query in read-only mode', async () => {
    const { backend } = buildBackend();
    const app = createApiServer({
      backend,
      apiConfig: {
        host: '127.0.0.1',
        port: 3030,
        cypherTimeoutMs: 1000,
        cypherMaxRows: 10,
        logQueryText: false,
      },
      apiToken: 'tokenabc12345',
    });
    const res = await app.request('/api/v1/cypher', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tokenabc12345',
      },
      body: JSON.stringify({ query: 'MERGE (n:Entity { name: "x" }) RETURN n' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });

  it('rejects /api/v1/rag with 503 when no rag service is wired', async () => {
    const { backend } = buildBackend();
    const app = createApiServer({
      backend,
      apiConfig: {
        host: '127.0.0.1',
        port: 3030,
        cypherTimeoutMs: 1000,
        cypherMaxRows: 10,
        logQueryText: false,
      },
      apiToken: 'tokenabc12345',
    });
    const res = await app.request('/api/v1/rag', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tokenabc12345',
      },
      body: JSON.stringify({ question: 'q' }),
    });
    expect(res.status).toBe(503);
  });

  it('returns 503 for /api/v1/hybrid-search when not wired', async () => {
    const { backend } = buildBackend();
    const app = createApiServer({
      backend,
      apiConfig: {
        host: '127.0.0.1',
        port: 3030,
        cypherTimeoutMs: 1000,
        cypherMaxRows: 10,
        logQueryText: false,
      },
      apiToken: 'tokenabc12345',
    });
    const res = await app.request('/api/v1/hybrid-search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tokenabc12345',
      },
      body: JSON.stringify({ query: 'x' }),
    });
    expect(res.status).toBe(503);
  });
});
