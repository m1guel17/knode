import { describe, expect, it } from 'vitest';
import { isReadOnlySafe } from '../../../src/query/cypher-api.js';

describe('isReadOnlySafe', () => {
  it('allows simple MATCH/RETURN', () => {
    const r = isReadOnlySafe('MATCH (d:Document) RETURN d.fileName LIMIT 10');
    expect(r.ok).toBe(true);
  });

  it('allows lowercase keywords', () => {
    const r = isReadOnlySafe('match (n:Entity) where n.type = $t return n');
    expect(r.ok).toBe(true);
  });

  it('rejects CREATE', () => {
    const r = isReadOnlySafe('CREATE (n:Entity { name: "x" })');
    expect(r.ok).toBe(false);
  });

  it('rejects MERGE', () => {
    const r = isReadOnlySafe('MERGE (n:Entity { name: "x" })');
    expect(r.ok).toBe(false);
  });

  it('rejects DELETE / DETACH DELETE', () => {
    expect(isReadOnlySafe('MATCH (n) DELETE n').ok).toBe(false);
    expect(isReadOnlySafe('MATCH (n) DETACH DELETE n').ok).toBe(false);
  });

  it('rejects SET / REMOVE / DROP', () => {
    expect(isReadOnlySafe('MATCH (n) SET n.x = 1').ok).toBe(false);
    expect(isReadOnlySafe('MATCH (n) REMOVE n.x').ok).toBe(false);
    expect(isReadOnlySafe('DROP CONSTRAINT entity_name_type_unique').ok).toBe(false);
  });

  it('rejects LOAD CSV (with whitespace variation)', () => {
    expect(isReadOnlySafe('LOAD CSV FROM "x" AS row RETURN row').ok).toBe(false);
    expect(isReadOnlySafe('LOAD  CSV FROM "x"').ok).toBe(false);
  });

  it('rejects CALL apoc.* and other dangerous procs', () => {
    expect(isReadOnlySafe('CALL apoc.cypher.runMany("CREATE ...")').ok).toBe(false);
    expect(isReadOnlySafe('CALL db.create.something').ok).toBe(false);
    expect(isReadOnlySafe('CALL db.index.create.something').ok).toBe(false);
    expect(isReadOnlySafe('CALL dbms.security.create()').ok).toBe(false);
  });

  it('does not false-positive on entity names that contain "DROP" as a substring of another word', () => {
    // "DROPLET" should not match the DROP keyword (word boundary).
    const r = isReadOnlySafe('MATCH (n:Entity { name: "DROPLET" }) RETURN n');
    expect(r.ok).toBe(true);
  });

  it('does not match keywords inside line comments', () => {
    const r = isReadOnlySafe(`
      // CREATE here would be unsafe
      MATCH (n:Entity) RETURN n
    `);
    expect(r.ok).toBe(true);
  });

  it('does not match keywords inside block comments', () => {
    const r = isReadOnlySafe(`
      /* MERGE this is a hint */
      MATCH (n:Entity) RETURN n
    `);
    expect(r.ok).toBe(true);
  });

  it('still catches keywords adjacent to comments', () => {
    const r = isReadOnlySafe(`
      MATCH (n) // safe so far
      DELETE n
    `);
    expect(r.ok).toBe(false);
  });
});
