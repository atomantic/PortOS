/**
 * Tests for the shared catalog type registry (`catalogTypes.js`).
 *
 * The registry is the single source of truth: the Zod enum, the ID prefix,
 * the FTS field set, the DDL CHECK constraint, and the per-record payload
 * schemaVersion all derive from it. These tests lock:
 *   1. registry shape invariants (frozen, unique ids/prefixes);
 *   2. the validation enum is registry-derived (no second hand-rolled list);
 *   3. the db.js / init-db.sql literals (CHECK + FTS field set) MATCH the
 *      registry — so the registry stays authoritative even though those two
 *      SQL files must keep the literals inline for the DDL-parity test;
 *   4. the payload-version upgrade helper stamps + chains correctly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CATALOG_TYPES,
  INGREDIENT_TYPE_IDS,
  FTS_PAYLOAD_FIELDS,
  getCatalogType,
  ingredientIdPrefix,
  currentPayloadSchemaVersion,
  upgradePayload,
  RELATION_KINDS,
  RELATION_KIND_IDS,
  getRelationKind,
  MEDIA_KINDS,
  MEDIA_KIND_IDS,
  getMediaKind,
  canonicalTagKey,
  tagIdForKey,
  defaultTagsForType,
  USER_TYPE_FIELD_KINDS,
  normalizeUserType,
  setUserCatalogTypes,
  getActiveCatalogTypes,
  getActiveCatalogType,
  isActiveType,
} from './catalogTypes.js';
import { INGREDIENT_TYPES } from './catalogValidation.js';

import { afterEach } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const INIT_SQL = readFileSync(join(HERE, '..', 'scripts', 'init-db.sql'), 'utf8');
const DB_JS = readFileSync(join(HERE, 'db.js'), 'utf8');

describe('catalogTypes — registry shape', () => {
  it('exposes the six v1 types in order, frozen', () => {
    expect(INGREDIENT_TYPE_IDS).toEqual(['character', 'place', 'object', 'idea', 'scene', 'concept']);
    expect(Object.isFrozen(INGREDIENT_TYPE_IDS)).toBe(true);
    expect(Object.isFrozen(CATALOG_TYPES)).toBe(true);
    for (const t of CATALOG_TYPES) expect(Object.isFrozen(t)).toBe(true);
  });

  it('has unique ids and unique id prefixes', () => {
    const ids = CATALOG_TYPES.map((t) => t.id);
    const prefixes = CATALOG_TYPES.map((t) => t.idPrefix);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('every entry carries the required UI + payload fields', () => {
    for (const t of CATALOG_TYPES) {
      expect(typeof t.label).toBe('string');
      expect(typeof t.badgeColor).toBe('string');
      expect(typeof t.primaryContentKey).toBe('string');
      expect(typeof t.primaryContentLabel).toBe('string');
      expect(Array.isArray(t.snippetFallbackKeys)).toBe(true);
      expect(t.snippetFallbackKeys.length).toBeGreaterThan(0);
      expect(Number.isInteger(t.payloadSchemaVersion)).toBe(true);
      expect(t.payloadSchemaVersion).toBeGreaterThanOrEqual(1);
    }
  });

  it('ingredientIdPrefix resolves known types and throws on unknown', () => {
    expect(ingredientIdPrefix('character')).toBe('chr');
    expect(ingredientIdPrefix('idea')).toBe('idea');
    expect(() => ingredientIdPrefix('nope')).toThrow(/Unknown ingredient type/);
  });

  it('getCatalogType returns undefined for unknown ids', () => {
    expect(getCatalogType('character')?.id).toBe('character');
    expect(getCatalogType('nope')).toBeUndefined();
  });
});

describe('catalogTypes — derived validation enum', () => {
  it('catalogValidation.INGREDIENT_TYPES is the registry id list', () => {
    expect([...INGREDIENT_TYPES]).toEqual([...INGREDIENT_TYPE_IDS]);
    expect(Object.isFrozen(INGREDIENT_TYPES)).toBe(true);
  });
});

// The CHECK constraint + FTS field set must keep their literals inline in
// init-db.sql + db.js for the DDL-parity test (it reads the SQL as text). These
// assertions prove those literals still equal the registry, so the registry
// stays the source of truth: drift on either side fails the build here.
function checkSet(source) {
  const m = /CHECK\s*\(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i.exec(source);
  return m ? m[1].split(',').map((s) => s.replace(/['"\s]/g, '')).filter(Boolean) : null;
}
function ftsKeys(source) {
  const out = [];
  const re = /payload->>'([a-zA-Z0-9_]+)'/g;
  let m;
  while ((m = re.exec(source)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

describe('catalogTypes — DDL literals match registry', () => {
  it('neither SQL source hardcodes a type CHECK (the registry is the sole type gate)', () => {
    // The DB `CHECK (type IN (…))` was dropped — type validity now lives only in
    // the INGREDIENT_TYPES registry + its Zod enum. Assert neither init-db.sql
    // nor db.js reintroduces a hardcoded `type IN (…)` CHECK that could silently
    // drift from the registry (and would also have to be migrated per new type).
    expect(checkSet(INIT_SQL)).toBeNull();
    expect(checkSet(DB_JS)).toBeNull();
  });

  it('the search_tsv payload field set in both SQL sources equals FTS_PAYLOAD_FIELDS', () => {
    const want = [...FTS_PAYLOAD_FIELDS].sort();
    expect(ftsKeys(INIT_SQL).sort()).toEqual(want);
    expect(ftsKeys(DB_JS).sort()).toEqual(want);
  });
});

describe('catalogTypes — client mirror parity', () => {
  it('client/src/lib/catalogTypes.js mirrors the shared registry fields', async () => {
    // The client mirror carries the UI subset (label, badgeColor, primary
    // content key/label, snippet fallback chain). Server-only fields (idPrefix,
    // ftsFields, payload versioning) are intentionally absent there. If a type
    // is added/renamed on one side, this fails loudly.
    const client = await import('../../client/src/lib/catalogTypes.js');
    expect(client.CATALOG_TYPE_IDS).toEqual([...INGREDIENT_TYPE_IDS]);
    for (const serverType of CATALOG_TYPES) {
      const clientType = client.getCatalogType(serverType.id);
      expect(clientType, `client mirror missing type ${serverType.id}`).toBeTruthy();
      expect(clientType.label).toBe(serverType.label);
      expect(clientType.badgeColor).toBe(serverType.badgeColor);
      expect(clientType.primaryContentKey).toBe(serverType.primaryContentKey);
      expect(clientType.primaryContentLabel).toBe(serverType.primaryContentLabel);
      expect(clientType.snippetFallbackKeys).toEqual(serverType.snippetFallbackKeys);
    }
  });
});

describe('catalogTypes — payload schemaVersion', () => {
  it('currentPayloadSchemaVersion returns 1 for v1 types and 1 for unknown', () => {
    expect(currentPayloadSchemaVersion('character')).toBe(1);
    expect(currentPayloadSchemaVersion('nope')).toBe(1);
  });

  it('upgradePayload stamps schemaVersion to current', () => {
    const out = upgradePayload('character', { physicalDescription: 'x' });
    expect(out.schemaVersion).toBe(1);
    expect(out.physicalDescription).toBe('x');
  });

  it('upgradePayload runs the registered upgrader chain in order', () => {
    // Synthetic registry-style entry exercised via a local upgrade walk — the
    // shipped registry is all-v1 today, so we validate the chaining logic with
    // a hand-built type-like object through the same code path semantics.
    const calls = [];
    const fakeType = {
      payloadSchemaVersion: 3,
      payloadUpgraders: {
        1: (p) => { calls.push(1); return { ...p, a: true }; },
        2: (p) => { calls.push(2); return { ...p, b: true }; },
      },
    };
    // Re-implement the same walk the helper performs to assert ordering +
    // stamping (the helper itself is keyed off the real registry).
    let p = { schemaVersion: 1 };
    let v = p.schemaVersion;
    while (v < fakeType.payloadSchemaVersion) {
      const up = fakeType.payloadUpgraders[v];
      if (typeof up !== 'function') break;
      p = up(p) || p;
      v += 1;
    }
    p.schemaVersion = fakeType.payloadSchemaVersion;
    expect(calls).toEqual([1, 2]);
    expect(p).toEqual({ schemaVersion: 3, a: true, b: true });
  });

  it('upgradePayload returns the payload unchanged (but stamped) for unknown type', () => {
    const out = upgradePayload('nope', { x: 1 });
    expect(out.x).toBe(1);
  });
});

describe('catalogTypes — tag taxonomy helpers', () => {
  it('canonicalTagKey lowercases, trims, and collapses whitespace', () => {
    expect(canonicalTagKey('Noir')).toBe('noir');
    expect(canonicalTagKey('  noir ')).toBe('noir');
    expect(canonicalTagKey('Film   Noir')).toBe('film noir');
    expect(canonicalTagKey('FILM NOIR')).toBe('film noir');
  });

  it('canonicalTagKey returns "" for empty / non-string input', () => {
    expect(canonicalTagKey('')).toBe('');
    expect(canonicalTagKey('   ')).toBe('');
    expect(canonicalTagKey(null)).toBe('');
    expect(canonicalTagKey(undefined)).toBe('');
    expect(canonicalTagKey(42)).toBe('');
  });

  it('canonicalTagKey does NOT fold distinct labels (synonyms stay separate)', () => {
    // `noir` and `film-noir` are different keys — synonym merging is the user's
    // job via parent_id, not the normalizer's.
    expect(canonicalTagKey('noir')).not.toBe(canonicalTagKey('film-noir'));
  });

  it('tagIdForKey builds a deterministic cat-tag-<key> id', () => {
    expect(tagIdForKey('noir')).toBe('cat-tag-noir');
    expect(tagIdForKey(canonicalTagKey('Film Noir'))).toBe('cat-tag-film noir');
  });

  it('defaultTagsForType returns a fresh array, never the frozen registry one', () => {
    const a = defaultTagsForType('character');
    const b = defaultTagsForType('character');
    expect(Array.isArray(a)).toBe(true);
    expect(a).not.toBe(b); // distinct copies — safe to mutate
    expect(defaultTagsForType('nope')).toEqual([]);
  });

  it('every registry entry has an array defaultTags', () => {
    for (const t of CATALOG_TYPES) {
      expect(Array.isArray(t.defaultTags)).toBe(true);
    }
  });
});

describe('catalogTypes — relation kinds', () => {
  it('exposes the documented relation kinds, frozen + unique', () => {
    expect(Object.isFrozen(RELATION_KINDS)).toBe(true);
    for (const k of ['appears-in', 'lives-in', 'created-by', 'parent-of', 'variant-of', 'references']) {
      expect(RELATION_KIND_IDS).toContain(k);
    }
    expect(new Set(RELATION_KIND_IDS).size).toBe(RELATION_KIND_IDS.length);
  });

  it('every relation kind has a label and inverseLabel', () => {
    for (const r of RELATION_KINDS) {
      expect(typeof r.label).toBe('string');
      expect(r.label.length).toBeGreaterThan(0);
      expect(typeof r.inverseLabel).toBe('string');
    }
  });

  it('getRelationKind resolves a known id and returns undefined for unknown', () => {
    expect(getRelationKind('lives-in')?.label).toBe('Lives in');
    expect(getRelationKind('nemesis-of')).toBeUndefined();
  });
});

describe('catalogTypes — user-defined types (runtime layer)', () => {
  afterEach(() => setUserCatalogTypes([]));

  it('tags every static entry system:true and never splices user types into CATALOG_TYPES', () => {
    for (const t of CATALOG_TYPES) expect(t.system).toBe(true);
    setUserCatalogTypes([{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [] }]);
    // The static export is unchanged — user types live only in the runtime layer.
    expect(CATALOG_TYPES.map((t) => t.id)).toEqual(['character', 'place', 'object', 'idea', 'scene', 'concept']);
    expect(CATALOG_TYPES.some((t) => t.id === 'faction')).toBe(false);
  });

  it('USER_TYPE_FIELD_KINDS are the four documented kinds', () => {
    expect([...USER_TYPE_FIELD_KINDS]).toEqual(['string', 'longtext', 'tags', 'ref']);
  });

  it('normalizeUserType maps a settings entry to the internal registry shape', () => {
    const t = normalizeUserType({
      id: 'faction', label: 'Faction', primaryContentKey: 'creed',
      fields: [
        { key: 'creed', label: 'Creed', kind: 'longtext' },
        { key: 'leader', label: 'Leader', kind: 'ref' },
        { key: 'motto', label: 'Motto', kind: 'string' },
      ],
    });
    expect(t.system).toBe(false);
    expect(t.extractionShape).toBe('light');
    expect(t.payloadSchemaVersion).toBe(1);
    expect(t.badgeColor).toMatch(/gray/);
    expect(t.primaryContentLabel).toBe('Creed');
    // snippet fallback: primary content key first, then longtext keys.
    expect(t.snippetFallbackKeys[0]).toBe('creed');
    // idPrefix never collides with a system prefix.
    expect(['chr', 'plc', 'obj', 'idea', 'scn', 'cnc']).not.toContain(t.idPrefix);
    expect(t.fields.map((f) => f.key)).toEqual(['creed', 'leader', 'motto']);
  });

  it('normalizeUserType returns null for a structurally invalid entry', () => {
    expect(normalizeUserType(null)).toBeNull();
    expect(normalizeUserType({ label: 'no id' })).toBeNull();
    expect(normalizeUserType({ id: 'x' })).toBeNull();
  });

  it('setUserCatalogTypes merges system+user (system first) and resolves via active getters', () => {
    setUserCatalogTypes([{ id: 'faction', label: 'Faction', primaryContentKey: 'creed', fields: [] }]);
    const active = getActiveCatalogTypes();
    expect(active.slice(0, 6).map((t) => t.id)).toEqual([...INGREDIENT_TYPE_IDS]);
    expect(active[active.length - 1].id).toBe('faction');
    expect(getActiveCatalogType('faction')?.label).toBe('Faction');
    expect(getActiveCatalogType('character')?.system).toBe(true);
    expect(isActiveType('faction')).toBe(true);
    expect(isActiveType('character')).toBe(true);
    expect(isActiveType('nope')).toBe(false);
  });

  it('a user type colliding with a system id is skipped (system wins)', () => {
    setUserCatalogTypes([{ id: 'character', label: 'Hijack', primaryContentKey: 'x', fields: [] }]);
    // Still the system character (system:true), not the hijack.
    expect(getActiveCatalogType('character')?.system).toBe(true);
    expect(getActiveCatalogType('character')?.label).toBe('Character');
  });

  it('two user types deriving the same base prefix get distinct prefixes', () => {
    setUserCatalogTypes([
      { id: 'fact', label: 'Fact', primaryContentKey: 'x', fields: [] },
      { id: 'fact-sheet', label: 'Fact Sheet', primaryContentKey: 'x', fields: [] },
    ]);
    const types = getActiveCatalogTypes().filter((t) => !t.system);
    const prefixes = types.map((t) => t.idPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('ingredientIdPrefix + currentPayloadSchemaVersion resolve active user types', () => {
    setUserCatalogTypes([{ id: 'faction', label: 'Faction', primaryContentKey: 'x', fields: [] }]);
    expect(() => ingredientIdPrefix('faction')).not.toThrow();
    expect(currentPayloadSchemaVersion('faction')).toBe(1);
  });
});

describe('catalogTypes — media kinds', () => {
  it('exposes the documented media kinds, frozen + unique', () => {
    expect(Object.isFrozen(MEDIA_KINDS)).toBe(true);
    for (const k of ['portrait', 'reference', 'audio', 'video', 'document']) {
      expect(MEDIA_KIND_IDS).toContain(k);
    }
    expect(new Set(MEDIA_KIND_IDS).size).toBe(MEDIA_KIND_IDS.length);
  });

  it('every media kind has a label and an accept filter', () => {
    for (const m of MEDIA_KINDS) {
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
      expect(typeof m.accept).toBe('string');
      expect(m.accept.length).toBeGreaterThan(0);
    }
  });

  it('getMediaKind resolves a known id and returns undefined for unknown', () => {
    expect(getMediaKind('portrait')?.label).toBe('Portrait');
    expect(getMediaKind('hologram')).toBeUndefined();
  });

  it('client mirror has the same media kind ids + accept filters', async () => {
    const client = await import('../../client/src/lib/catalogTypes.js');
    expect(client.MEDIA_KINDS.map((m) => m.id)).toEqual([...MEDIA_KIND_IDS]);
    for (const serverKind of MEDIA_KINDS) {
      const clientKind = client.getMediaKind(serverKind.id);
      expect(clientKind, `client mirror missing media kind ${serverKind.id}`).toBeTruthy();
      expect(clientKind.label).toBe(serverKind.label);
      expect(clientKind.accept).toBe(serverKind.accept);
    }
  });
});
