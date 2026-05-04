import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/shared/config.js';
import { ConfigError } from '../../../src/shared/errors.js';

const VALID_TOML = `
[chunker]
targetTokens = 500
overlapTokens = 50
ocrThresholdCharsPerPage = 50

[extraction]
provider = "anthropic"
model = "claude-haiku-4-5"
temperature = 0.0
maxRetries = 2
ontologyPath = "config/ontology/default-ontology.json"

[extraction.resolution]
enabled = true
model = "claude-sonnet-4-6"

[embedding]
provider = "openai"
model = "text-embedding-3-small"
dimensions = 1536

[storage.neo4j]
uri = "bolt://localhost:7687"
user = "neo4j"
password = "test"
database = "neo4j"

[processingLog]
path = "./data/processing-log.db"
`;

function writeConfigDir(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'knode-config-'));
  writeFileSync(join(dir, 'default.toml'), content);
  return dir;
}

describe('loadConfig', () => {
  it('loads a valid configuration', () => {
    const dir = writeConfigDir(VALID_TOML);
    const cfg = loadConfig({ configDir: dir, env: { NODE_ENV: 'test' } });
    expect(cfg.chunker.targetTokens).toBe(500);
    expect(cfg.extraction.provider).toBe('anthropic');
    expect(cfg.storage.neo4j.uri).toBe('bolt://localhost:7687');
  });

  it('applies env overrides', () => {
    const dir = writeConfigDir(VALID_TOML);
    const cfg = loadConfig({
      configDir: dir,
      env: {
        NODE_ENV: 'test',
        NEO4J_URI: 'bolt://override:7687',
        NEO4J_USER: 'admin',
        NEO4J_PASSWORD: 'p',
        NEO4J_DATABASE: 'db',
      },
    });
    expect(cfg.storage.neo4j.uri).toBe('bolt://override:7687');
    expect(cfg.storage.neo4j.user).toBe('admin');
  });

  it('throws ConfigError on invalid configuration', () => {
    const broken = `
[chunker]
targetTokens = -1
overlapTokens = 50
ocrThresholdCharsPerPage = 50

[extraction]
provider = "anthropic"
model = "x"
temperature = 0.0
maxRetries = 0
ontologyPath = "x"

[extraction.resolution]
enabled = true
model = "x"

[embedding]
provider = "openai"
model = "x"
dimensions = 1536

[storage.neo4j]
uri = "bolt://x"
user = "u"
password = "p"
database = "n"

[processingLog]
path = "x"
`;
    const dir = writeConfigDir(broken);
    expect(() => loadConfig({ configDir: dir, env: { NODE_ENV: 'test' } })).toThrow(ConfigError);
  });
});
