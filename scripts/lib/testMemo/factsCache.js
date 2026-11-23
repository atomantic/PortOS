/**
 * A persistent cache of `extractFileFacts` results, so a warm plan does not
 * re-parse every file of the repository on every run (#17617: ~9k files and
 * most of the planner's time once recorded hits stopped walking closures).
 *
 * Extraction is a function of the file's bytes, its path, the workspace it
 * is analyzed from, the three sources the workspace setup replaces, the code
 * that extracts (`FACTS_CODE` plus the Node version and platform, which
 * `node:module`'s builtin list and path handling depend on) and one kind of
 * cross-file input: what another module exports as a constant
 * (`exportedConstant`). The first five form the entry's key. The lookups are
 * recorded with the entry and asked again on reuse; any answer that is not
 * deep-equal to the recorded one is a miss and the file is extracted afresh.
 *
 * Entries are stored encoded (Sets, Maps and RegExps tagged) and decoded per
 * use, so no two analyzers share mutable facts. An extraction whose facts or
 * lookups do not survive the encoding exactly (`isDeepStrictEqual`) is not
 * stored: the cache never answers with anything but what extraction returned.
 *
 * On disk: `<memo dir>/facts/<workspace>.json`, `{ version, entries: { key:
 * { facts, lookups, usedAt } } }`, written by temp file and rename. Reads take
 * the first store directory holding the current version; writes go to the
 * first directory and keep what this run used plus what another branch or
 * worktree used within `MAX_ENTRY_AGE_MS`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { MAX_ENTRY_AGE_MS, memoDirs } from '../testMemoStore.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Every module `extractFileFacts` runs, repo-relative: its static import
 * closure (`scripts/lib/testMemo.test.js` pins the list against the imports).
 * A change to any of them changes `factsCodeVersion`, so no entry survives
 * a change to the extraction itself.
 */
export const FACTS_CODE = Object.freeze([
  'scripts/lib/sourceTokens.js',
  'scripts/lib/testMemo/constants.js',
  'scripts/lib/testMemo/evaluator.js',
  'scripts/lib/testMemo/fileFacts.js',
  'scripts/lib/testMemo/pathValues.js',
  'scripts/lib/testMemo/scopes.js',
  'scripts/lib/testMemo/specifiers.js',
  'scripts/lib/testMemo/tokens.js',
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

let codeVersion;
/** The extraction code's identity: `FACTS_CODE` bytes, the Node version and the platform. Null when a file cannot be read. */
export function factsCodeVersion(read = (rel) => readFileSync(join(REPO_ROOT, ...rel.split('/')))) {
  const parts = [`node ${process.version} ${process.platform}`];
  for (const rel of FACTS_CODE) {
    let bytes;
    try { bytes = read(rel); } catch { return null; }
    parts.push(`${rel} ${sha256(bytes)}`);
  }
  return sha256(parts.join('\n'));
}
const currentCodeVersion = () => {
  if (codeVersion === undefined) codeVersion = factsCodeVersion();
  return codeVersion;
};

const encodeValue = (value) => {
  if (value instanceof Set) return { $set: [...value].map(encodeValue) };
  if (value instanceof Map) return { $map: [...value].map(([k, v]) => [encodeValue(k), encodeValue(v)]) };
  if (value instanceof RegExp) return { $re: [value.source, value.flags] };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object') {
    // Only plain data: an instance of anything else would decode as a plain object.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('not plain data');
    if (Object.hasOwn(value, '$set') || Object.hasOwn(value, '$map') || Object.hasOwn(value, '$re')) return { $obj: Object.entries(value).map(([k, v]) => [k, encodeValue(v)]) };
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)]));
  }
  return value;
};

const decodeValue = (value) => {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$set')) return new Set(value.$set.map(decodeValue));
    if (Object.hasOwn(value, '$map')) return new Map(value.$map.map(([k, v]) => [decodeValue(k), decodeValue(v)]));
    if (Object.hasOwn(value, '$re')) return new RegExp(value.$re[0], value.$re[1]);
    if (Object.hasOwn(value, '$obj')) return Object.fromEntries(value.$obj.map(([k, v]) => [k, decodeValue(v)]));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeValue(v)]));
  }
  return value;
};

/** `value` as a JSON-safe tree, or undefined when decoding it would not give back exactly `value`. */
export function encodeExact(value) {
  let encoded;
  try { encoded = JSON.parse(JSON.stringify(encodeValue(value))); } catch { return undefined; }
  return isDeepStrictEqual(decodeValue(encoded), value) ? encoded : undefined;
}


/**
 * The in-memory cache one plan shares between its analyzers. `entries` are
 * what a store held (`loadFactsCache`); `version` is the extraction code's
 * (null disables the cache: every call extracts).
 */
export function createFactsCache({ entries = {}, version = currentCodeVersion(), now = Date.now() } = {}) {
  const stored = new Map(Object.entries(entries));
  const used = new Map();
  let hits = 0;
  let misses = 0;
  return {
    version,
    /**
     * The raw facts for `parts` (the key's inputs), from the cache when every
     * recorded lookup still answers the same through `lookup(spec, name)`,
     * else from `extract(lookup)`, which is then remembered.
     */
    facts(parts, lookup, extract) {
      if (version === null) return extract(lookup);
      const key = sha256([version, ...parts].join('\0'));
      const entry = used.get(key) ?? stored.get(key);
      if (entry && entry.lookups.every(([spec, name, answer]) => isDeepStrictEqual(lookup(spec, name), decodeValue(answer)))) {
        used.set(key, { ...entry, usedAt: now });
        hits += 1;
        return decodeValue(entry.facts);
      }
      misses += 1;
      const lookups = [];
      let exact = true;
      const raw = extract((spec, name) => {
        const answer = lookup(spec, name);
        const encoded = encodeExact(answer);
        if (encoded === undefined) exact = false;
        else lookups.push([spec, name, encoded]);
        return answer;
      });
      const facts = exact ? encodeExact(raw) : undefined;
      if (facts !== undefined) used.set(key, { facts, lookups, usedAt: now });
      else used.delete(key);
      return raw;
    },
    stats: () => ({ hits, misses, entries: used.size }),
    /** What a save keeps: this run's entries, and others used within `maxAgeMs`. */
    toJSON(maxAgeMs = MAX_ENTRY_AGE_MS) {
      const out = {};
      for (const [key, entry] of stored) if (!used.has(key) && now - Date.parse(entry.usedAt) <= maxAgeMs) out[key] = entry;
      for (const [key, entry] of used) out[key] = { ...entry, usedAt: new Date(entry.usedAt).toISOString() };
      return { version, entries: out };
    },
  };
}

const factsPath = (dir, workspace) => join(dir, 'facts', `${workspace}.json`);

/** A cache seeded from the first store directory whose facts file has the current version (an empty one otherwise). */
export function loadFactsCache(dir, workspace, { version = currentCodeVersion(), now = Date.now() } = {}) {
  if (version !== null) {
    for (const root of memoDirs(dir)) {
      let parsed = null;
      try { parsed = JSON.parse(readFileSync(factsPath(root, workspace), 'utf8')); } catch { continue; }
      if (parsed?.version === version && parsed.entries && typeof parsed.entries === 'object') {
        const entries = Object.fromEntries(Object.entries(parsed.entries).filter(([, entry]) => entry
          && Array.isArray(entry.lookups) && entry.facts && typeof entry.facts === 'object' && Number.isFinite(Date.parse(entry.usedAt))));
        return createFactsCache({ entries, version, now });
      }
    }
  }
  return createFactsCache({ version, now });
}

/** Write the cache to the store's first directory; a failure only costs the next run its warm start. */
export function saveFactsCache(dir, workspace, cache) {
  const [root] = memoDirs(dir);
  if (!root || !cache || cache.version === null) return false;
  const path = factsPath(root, workspace);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify(cache.toJSON()));
    renameSync(temp, path);
    return true;
  } catch {
    rmSync(temp, { force: true });
    return false;
  }
}
