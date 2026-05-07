// HTTP server factory for the query API. Returns a Hono instance — the
// caller is responsible for binding it (see src/index.ts --mode api).
//
// Wiring lives here; endpoint handlers live in dedicated files. Dependencies
// are passed in explicitly (no globals): graph backend driver, RAG pipeline,
// hybrid search, logger, config.

import { Hono } from 'hono';
import type { ApiConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import type { Neo4jBackend } from '../storage/backends/neo4j-backend.js';
import { registerCypherEndpoint } from './cypher-api.js';
import { registerHybridSearchEndpoint, type HybridSearchService } from './hybrid-search.js';
import { bearerAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { registerRagEndpoint, type RagService } from './rag-api.js';

const log = createChildLogger('api.server');

export interface ApiDeps {
  backend: Neo4jBackend;
  apiConfig: ApiConfig;
  apiToken: string;
  rag?: RagService | null;
  hybridSearch?: HybridSearchService | null;
}

export function createApiServer(deps: ApiDeps): Hono {
  const app = new Hono();

  app.onError(errorHandler);

  // Health check is unauthenticated — it's the liveness probe target.
  app.get('/api/v1/health', (c) =>
    c.json({
      status: 'ok',
      version: '3.0.0',
      now: new Date().toISOString(),
    })
  );

  // Everything below this line requires bearer auth.
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path === '/api/v1/health') return next();
    return bearerAuth({ token: deps.apiToken })(c, next);
  });

  registerCypherEndpoint(app, {
    driver: deps.backend.getDriver(),
    database: deps.backend.getDatabase(),
    defaultTimeoutMs: deps.apiConfig.cypherTimeoutMs,
    defaultMaxRows: deps.apiConfig.cypherMaxRows,
    logQueryText: deps.apiConfig.logQueryText,
  });

  if (deps.rag) {
    registerRagEndpoint(app, deps.rag);
  } else {
    app.post('/api/v1/rag', (c) =>
      c.json(
        {
          error: {
            code: 'rag_disabled',
            message: 'RAG endpoint is disabled in this deployment',
          },
        },
        503
      )
    );
  }

  if (deps.hybridSearch) {
    registerHybridSearchEndpoint(app, deps.hybridSearch);
  } else {
    app.post('/api/v1/hybrid-search', (c) =>
      c.json(
        {
          error: {
            code: 'hybrid_search_disabled',
            message: 'Hybrid search endpoint is disabled in this deployment',
          },
        },
        503
      )
    );
  }

  log.info(
    {
      cypherTimeoutMs: deps.apiConfig.cypherTimeoutMs,
      cypherMaxRows: deps.apiConfig.cypherMaxRows,
      ragEnabled: !!deps.rag,
      hybridSearchEnabled: !!deps.hybridSearch,
    },
    'api.server_built'
  );

  return app;
}
