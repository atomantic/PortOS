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
 * A store may be several directories (`resolveMemoDir` with
 * `PORTOS_TEST_MEMO_READ_DIRS`): a pull-request job reads the parked shard
 * lineages in place instead of copying them into one (#17617). Reads consult
 * every directory — an entry is the first valid hit, a record the newest by
 * `recordedAt`, which is what `mergeMemoStore` would have kept — and writes
 * go to the first.
 *
 * Several worktrees run pregate at once against the same directory: every
 * write is a temp file renamed into place, so a reader never sees a torn
 * file, and reads never throw — any failure is a miss. `PORTOS_TEST_MEMO=off`
 * disables reads and writes together. Inside a Vitest worker (a test that
 * spawns the runner) the memo is off unless the test points it at its own
 * directory, so fixtures cannot pollute the developer's store.
 */

import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** An entry older than this is a miss, so the nightly re-verifies what it keeps skipping. */
export const MAX_ENTRY_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Where the store lives for `env`, or null when the memo is disabled. With
 * `PORTOS_TEST_MEMO_READ_DIRS` (a `path.delimiter` list) the store is an
 * array: the usual directory first (where writes go), then the read-only
 * ones.
 */
export function resolveMemoDir(env = process.env, home = homedir(), pathDelimiter = delimiter) {
  if (env.PORTOS_TEST_MEMO === 'off') return null;
  const primary = env.PORTOS_TEST_MEMO_DIR || (env.VITEST ? null : join(home, '.portos', 'test-memo'));
  if (!primary) return null;
  const readDirs = (env.PORTOS_TEST_MEMO_READ_DIRS ?? '').split(pathDelimiter).filter(Boolean);
  return readDirs.length ? [primary, ...readDirs.filter((dir) => dir !== primary)] : primary;
}

/** The directories a store reads, in precedence order; the first is where it writes. */
export const memoDirs = (dir) => (Array.isArray(dir) ? dir : [dir]).filter(Boolean);

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
  if (!KEY_PATTERN.test(String(key))) return null;
  for (const root of memoDirs(dir)) {
    const entry = readJson(entryPath(root, key));
    if (!entry || entry.test !== test || entry.workspace !== workspace || typeof entry.verifiedAt !== 'string') continue;
    const age = now - Date.parse(entry.verifiedAt);
    if (!Number.isFinite(age) || age < 0 || age > MAX_ENTRY_AGE_MS) continue;
    return entry;
  }
  return null;
}

export function writeMemoEntry(dir, key, { test, workspace, source, commit }) {
  const [root] = memoDirs(dir);
  if (!root || !KEY_PATTERN.test(String(key))) return;
  writeJsonAtomic(entryPath(root, key), { test, workspace, verifiedAt: new Date().toISOString(), source, commit: commit ?? null });
}

export const MEMO_RECORD_VERSION = 2;
const DIGEST_PATTERN = /^[0-9a-f]{8,64}$/;

const stamp = (value, field) => {
  const time = Date.parse(value?.[field]);
  return Number.isFinite(time) ? time : null;
};

const validRecord = (record, test) => Boolean(record) && record.test === test
  && Array.isArray(record.modules) && record.modules.every((m) => typeof m === 'string');

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
 * the record carries a well-formed one. Across several directories the
 * record with the newest `recordedAt` wins; a tie goes to the earlier
 * directory.
 */
export function readMemoRecord(dir, workspace, test) {
  let record = null;
  let newest = null;
  for (const root of memoDirs(dir)) {
    const candidate = readJson(recordPath(root, workspace, test));
    if (!validRecord(candidate, test)) continue;
    const recorded = stamp(candidate, 'recordedAt') ?? -Infinity;
    if (record && recorded <= newest) continue;
    record = candidate;
    newest = recorded;
  }
  if (!record) return null;
  const digests = record.version === MEMO_RECORD_VERSION && Array.isArray(record.digests) && record.digests.length === record.modules.length
    && record.digests.every((digest) => typeof digest === 'string' && DIGEST_PATTERN.test(digest)) ? record.digests : null;
  return { modules: record.modules, digests, served: validServed(record.served) };
}

/**
 * `digestOf(rel)` gives each module's digest; a module without one leaves the
 * record digest-free (no narrowing). `served` (`{ roots, files }`) is stored
 * sorted when given. Writes go to the store's first directory.
 */
export function writeMemoRecord(dir, workspace, test, modules, digestOf = () => null, served = null) {
  const [root] = memoDirs(dir);
  if (!root) return;
  const sorted = [...modules].sort();
  const digests = sorted.map((rel) => digestOf(rel));
  const complete = digests.every((digest) => typeof digest === 'string');
  const servedField = served ? { served: { roots: [...new Set(served.roots)].sort(), files: [...new Set(served.files)].sort() } } : {};
  writeJsonAtomic(recordPath(root, workspace, test), complete
    ? { version: MEMO_RECORD_VERSION, test, modules: sorted, digests, ...servedField, recordedAt: new Date().toISOString() }
    : { test, modules: sorted, ...servedField, recordedAt: new Date().toISOString() });
}

const listDir = (path) => {
  try { return readdirSync(path); } catch { return []; }
};

/** A cold store cannot have hits under any tool fingerprint. */
export function hasMemoEntries(dir) {
  return memoDirs(dir).some(root => listDir(join(root, 'entries')).length > 0);
}

/**
 * Fold `sourceDir`'s store into `targetDir`. A matrix shard only records the
 * tests in its slice, so a job that restores one shard's lineage would see
 * records for that slice alone and select everything else unnarrowed; the
 * CI restore merges every full-run shard lineage (`.github/actions/test-memo`).
 * An entry is copied when the target lacks one that is younger, a record when
 * the target's is missing or older; unreadable or foreign files are skipped,
 * and expired entries are left behind (they are misses anyway, and copying
 * them would only grow the cache). A workspace's parsed-facts file
 * (`testMemo/factsCache.js`) is copied when the target has none, so the
 * merged store's planner starts warm. Returns the counts copied.
 */
export function mergeMemoStore(targetDir, sourceDir, { now = Date.now() } = {}) {
  const copied = { entries: 0, records: 0 };
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
  for (const name of listDir(join(sourceDir, 'facts'))) {
    if (!/^[\w-]+\.json$/.test(name) || existsSync(join(targetDir, 'facts', name))) continue;
    mkdirSync(join(targetDir, 'facts'), { recursive: true });
    copyFileSync(join(sourceDir, 'facts', name), join(targetDir, 'facts', name));
  }
  return copied;
}

/** How many entries per `(workspace, test)` a pruned store keeps (`pruneMemoStore`). */
export const MAX_ENTRIES_PER_TEST = 3;

const removeFile = (path) => {
  try { rmSync(path, { force: true }); return true; } catch { return false; }
};

/**
 * Bound the store before a trusted CI run saves it (#17617). Without this
 * every saved lineage carried every entry it ever restored, merged or wrote:
 * a server cache reached 213,086 entry files, and restoring and merging them
 * cost each job more than its tests did.
 *
 * Removes entry files that are unreadable, malformed or older than
 * `maxAgeMs` (misses already), then keeps the newest `maxEntriesPerTest`
 * per `(workspace, test)`. A test gets new entries only when it ran, and it
 * runs only when its inputs no longer match any entry, so the older entries
 * describe trees the branch has moved past. With `testExists(workspace,
 * test)`, entries and records of a test file that no longer exists go too.
 * Records are otherwise kept (one per test, the newest). Files that are not
 * entries or records (an in-flight temp file) are left alone.
 *
 * `testExists` and the cap assume one checkout owns the store, as a CI job
 * does. The developer's shared store (several worktrees, several branches)
 * passes neither and only drops what has expired.
 *
 * @returns {{ entries: number, records: number, removedEntries: number, removedRecords: number }}
 */
export function pruneMemoStore(dir, { now = Date.now(), maxAgeMs = MAX_ENTRY_AGE_MS, maxEntriesPerTest = MAX_ENTRIES_PER_TEST, testExists = null } = {}) {
  const counts = { entries: 0, records: 0, removedEntries: 0, removedRecords: 0 };
  const [root] = memoDirs(dir);
  if (!root) return counts;
  const exists = new Map();
  const live = (workspace, test) => {
    if (!testExists) return true;
    const id = `${workspace}\0${test}`;
    if (!exists.has(id)) exists.set(id, testExists(workspace, test) === true);
    return exists.get(id);
  };
  const drop = (path, kind) => { if (removeFile(path)) counts[kind] += 1; };
  const perTest = new Map();
  for (const bucket of listDir(join(root, 'entries'))) {
    for (const name of listDir(join(root, 'entries', bucket))) {
      if (!name.endsWith('.json')) continue;
      const path = join(root, 'entries', bucket, name);
      const key = name.slice(0, -'.json'.length);
      const entry = KEY_PATTERN.test(key) && bucket === key.slice(0, 2) ? readJson(path) : null;
      const verified = stamp(entry, 'verifiedAt');
      if (verified === null || typeof entry.test !== 'string' || typeof entry.workspace !== 'string'
        || now - verified > maxAgeMs || !live(entry.workspace, entry.test)) {
        drop(path, 'removedEntries');
        continue;
      }
      const id = `${entry.workspace}\0${entry.test}`;
      if (!perTest.has(id)) perTest.set(id, []);
      perTest.get(id).push({ path, verified });
    }
  }
  for (const kept of perTest.values()) {
    kept.sort((x, y) => y.verified - x.verified);
    for (const [index, { path }] of kept.entries()) {
      if (index < maxEntriesPerTest) counts.entries += 1;
      else drop(path, 'removedEntries');
    }
  }
  for (const workspace of listDir(join(root, 'records'))) {
    for (const name of listDir(join(root, 'records', workspace))) {
      if (!name.endsWith('.json')) continue;
      const path = join(root, 'records', workspace, name);
      const record = readJson(path);
      if (typeof record?.test !== 'string' || recordPath(root, workspace, record.test) !== path
        || !validRecord(record, record.test) || !live(workspace, record.test)) {
        drop(path, 'removedRecords');
        continue;
      }
      counts.records += 1;
    }
  }
  return counts;
}
