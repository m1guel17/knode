// `POST /api/v1/cypher` — typed, authenticated, read-only-by-default Cypher.
//
// Safety stack (defense in depth):
//   1. Keyword denylist on the query text (regex; lossless).
//   2. Neo4j session mode = 'READ' when readOnly: true (server enforces).
//   3. Hard timeout on the session.
//   4. Result row cap; oversize → 413 with a hint to add LIMIT.
//   5. Hashed query text logged with execution time (constant logging shape).
//
// The endpoint is the single hatch by which trusted callers ad-hoc-query the
// graph; everything else (RAG, hybrid search) sits on top of canned cypher
// behind their own endpoints.

import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import neo4j, { type Driver } from 'neo4j-driver';
import { z } from 'zod';
import { QueryLimitError, StorageError, ValidationError } from '../shared/errors.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger('api.cypher');

const CypherRequestSchema = z.object({
  query: z.string().min(1).max(10_000),
  params: z.record(z.unknown()).default({}),
  readOnly: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  maxRows: z.number().int().positive().max(100_000).optional(),
});
export type CypherRequest = z.infer<typeof CypherRequestSchema>;

// Tokens that cause writes or run dangerous server-side procedures. The
// regex is word-boundary-anchored to avoid false positives on entity names
// like "Microsoft Corp." → matched by "MERGE" only as a whole word.
//
// We do not try to *parse* Cypher here — the server-enforced READ session
// mode is the authoritative defense. This denylist is a first-line filter
// to bounce obvious mistakes with a clear 400 instead of a session-error 500.
const DANGEROUS_KEYWORDS = [
  'CREATE',
  'MERGE',
  'DELETE',
  'DETACH',
  'SET',
  'REMOVE',
  'DROP',
  'LOAD\\s+CSV',
  'CALL\\s+\\{',
  'CALL\\s+apoc\\.',
  'CALL\\s+db\\.create\\.',
  'CALL\\s+db\\.index\\.',
  'CALL\\s+dbms\\.',
];

const DENY_REGEX = new RegExp(`\\b(?:${DANGEROUS_KEYWORDS.join('|')})\\b`, 'i');

// Strip block comments and line comments before scanning for keywords —
// otherwise a denied keyword inside a comment would incorrectly reject a
// safe query.
function stripComments(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

export function isReadOnlySafe(query: string): { ok: true } | { ok: false; reason: string } {
  const stripped = stripComments(query);
  const m = DENY_REGEX.exec(stripped);
  if (m) {
    return { ok: false, reason: `Forbidden keyword "${m[0]}" in read-only query` };
  }
  return { ok: true };
}

function hashQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 12);
}

export interface CypherDeps {
  driver: Driver;
  database: string;
  defaultTimeoutMs: number;
  defaultMaxRows: number;
  logQueryText: boolean;
}

// Convert Neo4j driver result rows (with Integer, Node, Relationship objects)
// into JSON-safe primitives. We don't try to be exhaustive — the typical
// caller is doing aggregation queries and small projections.
function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (neo4j.isInt(value)) {
    const i = value;
    // .toNumber() throws for values outside JS safe-integer range; fall back
    // to a string in that case so the response stays JSON-encodable.
    return i.inSafeRange() ? i.toNumber() : i.toString();
  }
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as { properties?: unknown; labels?: string[]; type?: string; identity?: unknown; start?: unknown; end?: unknown };
    // Node
    if (v.labels !== undefined && v.properties !== undefined) {
      return {
        _kind: 'node',
        labels: v.labels,
        properties: toJsonSafe(v.properties) as Record<string, unknown>,
      };
    }
    // Relationship
    if (v.type !== undefined && v.start !== undefined && v.end !== undefined) {
      return {
        _kind: 'relationship',
        type: v.type,
        start: toJsonSafe(v.start),
        end: toJsonSafe(v.end),
        properties: toJsonSafe(v.properties ?? {}) as Record<string, unknown>,
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafe(val);
    }
    return out;
  }
  return value;
}

export function registerCypherEndpoint(app: Hono, deps: CypherDeps): void {
  app.post('/api/v1/cypher', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as unknown;
    const parsed = CypherRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw parsed.error;
    }
    const req = parsed.data;
    const queryHash = hashQuery(req.query);

    if (req.readOnly) {
      const safe = isReadOnlySafe(req.query);
      if (!safe.ok) {
        throw new ValidationError(safe.reason, { queryHash });
      }
    }

    const timeoutMs = req.timeoutMs ?? deps.defaultTimeoutMs;
    const maxRows = req.maxRows ?? deps.defaultMaxRows;

    const session = deps.driver.session({
      database: deps.database,
      defaultAccessMode: req.readOnly ? neo4j.session.READ : neo4j.session.WRITE,
    });

    const startedAt = Date.now();
    try {
      // Server-side timeout via tx config; the session also holds the local
      // timeout in case the driver hangs before reaching the server.
      const timer = setTimeout(() => {
        // Best-effort cancellation — neo4j-driver's session.close() interrupts
        // the in-flight query.
        void session.close().catch(() => {});
      }, timeoutMs);

      const result = await session.run(req.query, req.params, { timeout: timeoutMs });
      clearTimeout(timer);

      if (result.records.length > maxRows) {
        throw new QueryLimitError(
          `Query produced ${result.records.length} rows; cap is ${maxRows}. Add a LIMIT clause to your Cypher.`,
          { queryHash, rowCount: result.records.length, maxRows }
        );
      }

      const rows = result.records.map((rec) => {
        const obj: Record<string, unknown> = {};
        for (const key of rec.keys) obj[String(key)] = toJsonSafe(rec.get(key));
        return obj;
      });

      const durationMs = Date.now() - startedAt;
      log.info(
        {
          queryHash,
          rowCount: rows.length,
          durationMs,
          readOnly: req.readOnly,
          ...(deps.logQueryText ? { query: req.query } : {}),
        },
        'cypher.executed'
      );

      return c.json({
        rows,
        rowCount: rows.length,
        durationMs,
        queryHash,
      });
    } catch (e) {
      if (e instanceof QueryLimitError || e instanceof ValidationError) throw e;
      // neo4j-driver throws errors with .code = "Neo.ClientError.*"; preserve the
      // shape via StorageError but never leak the raw text to the client.
      const code = (e as { code?: string } | null)?.code;
      const message = e instanceof Error ? e.message : String(e);
      log.error({ queryHash, code, message }, 'cypher.failed');
      throw new StorageError(`Cypher execution failed: ${message}`, { queryHash, code });
    } finally {
      try {
        await session.close();
      } catch {
        // Already closed in the timer cancellation path; harmless.
      }
    }
  });
}

// Test surface — exported so unit tests can drive the safety filter and the
// JSON conversion without spinning up a real driver.
export const __testables = { isReadOnlySafe, toJsonSafe, hashQuery };
