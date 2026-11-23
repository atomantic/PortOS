/**
 * Test memo store — green entries and per-test dependency records on disk.
 *
 * Layout under the memo directory (`~/.portos/test-memo` unless
 * `PORTOS_TEST_MEMO_DIR` says otherwise):
 *
 *   entries/<key[0..2]>/<key>.json   { test, workspace, verifiedAt, source, commit }
 *   records/<workspace>/<sha256(test)>.json   { version: 2, test, modules: [repo-relative...], digests: [...], served?: { roots, files }, recordedAt }
 *
 * An entry says "a trusted run verified this key green". A record says which
 * modules the test loaded in its last green run, so the next key can be
 * computed over that exact set (`testMemo.js`, recorded key). A version 2
 * record also stores each module's truncated content digest, aligned with
 * `modules`; only such a record narrows related selection (`recordedReach`),
 * because the digests show which loaded modules changed since the run. A
 * record without them still feeds the recorded key. `served` (#17616) names
 * what a real-browser suite's fixture served from each root it handed to
 * Vite (`startBrowserFixture`); a record without it, or with one this reader
 * rejects, keys those roots whole. Older readers ignore the field.
 *
 * Several worktrees run pregate at once against the same directory: every
 * write is a temp file renamed into place, so a reader never sees a torn
 * file, and reads never throw — any failure is a miss. `PORTOS_TEST_MEMO=off`
 * disables reads and writes together. Inside a Vitest worker (a test that
 * spawns the runner) the memo is off unless the test points it at its own
 * directory, so fixtures cannot pollute the developer's store.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** An entry older than this is a miss, so the nightly re-verifies what it keeps skipping. */
export const MAX_ENTRY_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Where the store lives for `env`, or null when the memo is disabled. */
export function resolveMemoDir(env = process.env, home = homedir()) {
  if (env.PORTOS_TEST_MEMO === 'off') return null;
  if (env.PORTOS_TEST_MEMO_DIR) return env.PORTOS_TEST_MEMO_DIR;
  if (env.VITEST) return null;
  return join(home, '.portos', 'test-memo');
}

const entryPath = (dir, key) => join(dir, 'entries', key.slice(0, 2), `${key}.json`);
const recordPath = (dir, workspace, test) => join(dir, 'records', workspace, `${createHash('sha256').update(test).digest('hex')}.json`);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** The green entry for `key` when it names `test` in `workspace` and is young enough; null on any miss or corruption. */
export function readMemoEntry(dir, key, { test, workspace, now = Date.now() }) {
  if (!dir || !KEY_PATTERN.test(String(key))) return null;
  const entry = readJson(entryPath(dir, key));
  if (!entry || entry.test !== test || entry.workspace !== workspace || typeof entry.verifiedAt !== 'string') return null;
  const age = now - Date.parse(entry.verifiedAt);
  if (!Number.isFinite(age) || age < 0 || age > MAX_ENTRY_AGE_MS) return null;
  return entry;
}

export function writeMemoEntry(dir, key, { test, workspace, source, commit }) {
  if (!dir || !KEY_PATTERN.test(String(key))) return;
  writeJsonAtomic(entryPath(dir, key), { test, workspace, verifiedAt: new Date().toISOString(), source, commit: commit ?? null });
}

export const MEMO_RECORD_VERSION = 2;
const DIGEST_PATTERN = /^[0-9a-f]{8,64}$/;

/** A repository-relative posix path: no root, drive, backslash, or `.`/`..` segment. */
const repoRelative = (rel) => typeof rel === 'string' && rel !== '' && !rel.includes('\\') && !/^[A-Za-z]:/.test(rel)
  && rel.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

/** A record's `served` field when well formed (non-empty roots, repo-relative paths), else null. */
const validServed = (served) => (served && Array.isArray(served.roots) && served.roots.length > 0 && Array.isArray(served.files)
  && served.roots.every(repoRelative) && served.files.every(repoRelative)
  ? { roots: served.roots, files: served.files } : null);

/**
 * `{ modules, digests, served }` for the modules `test` loaded in its last
 * recorded green run, or null. `digests` is null unless the record is
 * version 2 with one well-formed digest per module; `served` is null unless
 * the record carries a well-formed one.
 */
export function readMemoRecord(dir, workspace, test) {
  if (!dir) return null;
  const record = readJson(recordPath(dir, workspace, test));
  if (!record || record.test !== test || !Array.isArray(record.modules) || !record.modules.every((m) => typeof m === 'string')) return null;
  const digests = record.version === MEMO_RECORD_VERSION && Array.isArray(record.digests) && record.digests.length === record.modules.length
    && record.digests.every((digest) => typeof digest === 'string' && DIGEST_PATTERN.test(digest)) ? record.digests : null;
  return { modules: record.modules, digests, served: validServed(record.served) };
}

/**
 * `digestOf(rel)` gives each module's digest; a module without one leaves the
 * record digest-free (no narrowing). `served` (`{ roots, files }`) is stored
 * sorted when given.
 */
export function writeMemoRecord(dir, workspace, test, modules, digestOf = () => null, served = null) {
  if (!dir) return;
  const sorted = [...modules].sort();
  const digests = sorted.map((rel) => digestOf(rel));
  const complete = digests.every((digest) => typeof digest === 'string');
  const servedField = served ? { served: { roots: [...new Set(served.roots)].sort(), files: [...new Set(served.files)].sort() } } : {};
  writeJsonAtomic(recordPath(dir, workspace, test), complete
    ? { version: MEMO_RECORD_VERSION, test, modules: sorted, digests, ...servedField, recordedAt: new Date().toISOString() }
    : { test, modules: sorted, ...servedField, recordedAt: new Date().toISOString() });
}

const listDir = (path) => {
  try { return readdirSync(path); } catch { return []; }
};

/**
 * Fold `sourceDir`'s store into `targetDir`. A matrix shard only records the
 * tests in its slice, so a job that restores one shard's lineage would see
 * records for that slice alone and select everything else unnarrowed; the
 * CI restore merges every full-run shard lineage (`.github/actions/test-memo`).
 * An entry is copied when the target lacks one that is younger, a record when
 * the target's is missing or older; unreadable or foreign files are skipped,
 * and expired entries are left behind (they are misses anyway, and copying
 * them would only grow the cache). Returns the counts copied.
 */
export function mergeMemoStore(targetDir, sourceDir, { now = Date.now() } = {}) {
  const copied = { entries: 0, records: 0 };
  const stamp = (value, field) => {
    const time = Date.parse(value?.[field]);
    return Number.isFinite(time) ? time : null;
  };
  for (const bucket of listDir(join(sourceDir, 'entries'))) {
    for (const name of listDir(join(sourceDir, 'entries', bucket))) {
      const key = name.replace(/\.json$/, '');
      if (!KEY_PATTERN.test(key) || bucket !== key.slice(0, 2)) continue;
      const entry = readJson(join(sourceDir, 'entries', bucket, name));
      const verified = stamp(entry, 'verifiedAt');
      if (verified === null || now - verified > MAX_ENTRY_AGE_MS) continue;
      const existing = stamp(readJson(entryPath(targetDir, key)), 'verifiedAt');
      if (existing !== null && existing >= verified) continue;
      writeJsonAtomic(entryPath(targetDir, key), entry);
      copied.entries += 1;
    }
  }
  for (const workspace of listDir(join(sourceDir, 'records'))) {
    for (const name of listDir(join(sourceDir, 'records', workspace))) {
      const record = readJson(join(sourceDir, 'records', workspace, name));
      if (typeof record?.test !== 'string' || recordPath(sourceDir, workspace, record.test) !== join(sourceDir, 'records', workspace, name)) continue;
      const recorded = stamp(record, 'recordedAt');
      if (recorded === null) continue;
      const existing = stamp(readJson(recordPath(targetDir, workspace, record.test)), 'recordedAt');
      if (existing !== null && existing >= recorded) continue;
      writeJsonAtomic(recordPath(targetDir, workspace, record.test), record);
      copied.records += 1;
    }
  }
  return copied;
}
