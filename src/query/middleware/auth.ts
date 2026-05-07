// Static-token authentication for the query API. The token is read from
// `API_TOKEN` env at boot. Requests without `Authorization: Bearer <token>`
// or with the wrong token receive a 401 with a generic body — never leak
// whether the token was missing vs. wrong (timing-safe comparison).
//
// This is intentionally minimal. Production-grade auth (OAuth, multi-tenant,
// per-token rate limits) is Phase 4 territory.

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { ConfigError } from '../../shared/errors.js';

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

function constantTimeEq(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; pad both to the same
  // length first so a length-difference comparison still costs the full
  // compare.
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  const len = Math.max(ab.length, bb.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  ab.copy(aPadded);
  bb.copy(bPadded);
  // The length check itself is intentionally outside the timing-safe call —
  // an attacker who guesses a wrong-length token learns nothing useful (every
  // wrong guess fails identically).
  const eq = timingSafeEqual(aPadded, bPadded);
  return eq && ab.length === bb.length;
}

export interface AuthMiddlewareOptions {
  // The expected bearer token. Pass it in explicitly so tests don't depend on
  // process.env.
  token: string;
}

export function bearerAuth(opts: AuthMiddlewareOptions): MiddlewareHandler {
  if (!opts.token || opts.token.length < 8) {
    throw new ConfigError(
      'API_TOKEN must be at least 8 characters. Set the API_TOKEN env var before starting --mode api.',
      { tokenLength: opts.token?.length ?? 0 }
    );
  }
  const expected = opts.token;
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const match = BEARER_PATTERN.exec(header);
    if (!match || !match[1] || !constantTimeEq(match[1], expected)) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid or missing token' } }, 401);
    }
    await next();
  };
}
