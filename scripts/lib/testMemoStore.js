/**
 * Test memo store — green entries and per-test dependency records on disk.
 *
 * Layout under the memo directory (`~/.portos/test-memo` unless
 * `PORTOS_TEST_MEMO_DIR` says otherwise):
 *
 *   entries/<key[0..2]>/<key>.json   { test, workspace, verifiedAt, source, commit }
 *   records/<workspace>/<sha256(test)>.json   { test, modules: [repo-relative...], recordedAt }
 *
 * An entry says "a trusted run verified this key green". A record says which
 * modules the test loaded in its last green run, so the next key can be
 * computed over that exact set (`testMemo.js`, recorded key).
 *
 * Several worktrees run pregate at once against the same directory: every
 * write is a temp file renamed into place, so a reader never sees a torn
 * file, and reads never throw — any failure is a miss. `PORTOS_TEST_MEMO=off`
 * disables reads and writes together. Inside a Vitest worker (a test that
 * spawns the runner) the memo is off unless the test points it at its own
 * directory, so fixtures cannot pollute the developer's store.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** The module list `test` loaded in its last recorded green run, or null. */
export function readMemoRecord(dir, workspace, test) {
  if (!dir) return null;
  const record = readJson(recordPath(dir, workspace, test));
  if (!record || record.test !== test || !Array.isArray(record.modules) || !record.modules.every((m) => typeof m === 'string')) return null;
  return record.modules;
}

export function writeMemoRecord(dir, workspace, test, modules) {
  if (!dir) return;
  writeJsonAtomic(recordPath(dir, workspace, test), { test, modules: [...modules].sort(), recordedAt: new Date().toISOString() });
}
