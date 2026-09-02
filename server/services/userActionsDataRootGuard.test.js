/**
 * Regression coverage for the #5605 structural guard: a suite that exercises
 * a route wired to `recordUserAction` without redirecting PATHS.data to a
 * temp root must fail loudly instead of writing user-action-events.json into
 * the repo's real data/ tree (the bug class #5594 patched per-suite for
 * cos.test.js / cosTaskRoutes.test.js / cosAgentFeedback.test.js).
 *
 * Deliberately does NOT mock `../lib/fileUtils.js` — this is the one test in
 * the suite that is SUPPOSED to run with PATHS.data unredirected, so it can
 * prove the guard rejects that exact condition. If the guard regresses, this
 * would otherwise be the test that writes a real file into the repo's data/
 * tree, so it also asserts that never happens.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { listUserActions, recordUserAction } from './userActions.js';

const REAL_EVENTS_FILE = join(PATHS.data, 'user-action-events.json');

// Snapshot ONCE, before any case runs. An install using the documented
// MEMORY_BACKEND=file escape hatch may legitimately already have this file as
// its real ledger, so every case must prove the guard leaves it untouched
// rather than assert it is absent — and `afterEach` must put back exactly what
// it found, including when a regression mutated the bytes.
const EXISTED_BEFORE = existsSync(REAL_EVENTS_FILE);
const CONTENT_BEFORE = EXISTED_BEFORE ? readFileSync(REAL_EVENTS_FILE, 'utf8') : null;

/** The real tree must come back exactly as this file found it — present and byte-identical, or still absent. */
function expectRealTreeUntouched() {
  expect(existsSync(REAL_EVENTS_FILE)).toBe(EXISTED_BEFORE);
  if (EXISTED_BEFORE) expect(readFileSync(REAL_EVENTS_FILE, 'utf8')).toBe(CONTENT_BEFORE);
}

afterEach(() => {
  // Repair anything a GUARD REGRESSION did, never anything the developer had:
  // delete only a file this run leaked, and restore only bytes this run changed.
  if (!EXISTED_BEFORE) {
    if (existsSync(REAL_EVENTS_FILE)) rmSync(REAL_EVENTS_FILE, { force: true });
    return;
  }
  if (readFileSync(REAL_EVENTS_FILE, 'utf8') !== CONTENT_BEFORE) {
    writeFileSync(REAL_EVENTS_FILE, CONTENT_BEFORE);
  }
});

describe('user-action ledger — data-root guard (#5605)', () => {
  it('recordUserAction throws instead of writing into the real data/ tree', async () => {
    await expect(recordUserAction({
      type: 'cos.task.create',
      summary: 'Guard regression probe',
      dedupeKey: `guard-probe-${Math.random().toString(36).slice(2)}`,
    })).rejects.toThrow(/real data\/ tree/);
    expectRealTreeUntouched();
  });

  it('listUserActions throws instead of reading the real ledger', async () => {
    // The read path matters too: those rows are machine-local operator records
    // (privacy ADR), so an untethered suite must not pull them into the process.
    await expect(listUserActions()).rejects.toThrow(/real data\/ tree/);
    expectRealTreeUntouched();
  });
});
