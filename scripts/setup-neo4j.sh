#!/usr/bin/env bash
# Bring up the dev stack and wait for Neo4j to become healthy.
# Idempotent — re-running is safe.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker/docker-compose.dev.yml"

echo "[setup-neo4j] starting docker-compose stack..."
docker compose -f "${COMPOSE_FILE}" up -d

echo "[setup-neo4j] waiting for Neo4j to be healthy (timeout 90s)..."
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' knode-neo4j 2>/dev/null || echo 'starting')"
  if [ "${status}" = "healthy" ]; then
    echo "[setup-neo4j] Neo4j healthy."
    exit 0
  fi
  sleep 3
done

echo "[setup-neo4j] timed out waiting for Neo4j" >&2
docker compose -f "${COMPOSE_FILE}" logs neo4j | tail -50 >&2
exit 1
