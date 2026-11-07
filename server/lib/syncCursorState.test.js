import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSyncCursorState, readSyncCursorStateForStatus } from './syncCursorState.js';

let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-cursor-'));
  file = join(dir, 'state.json');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('readSyncCursorState', () => {
  it('starts at 0 only when the file is genuinely missing', async () => {
    expect(await readSyncCursorState(file, 'cursorRowid')).toEqual({ cursorRowid: 0, lastRunAt: null, lastResult: null });
  });

  it('returns the persisted cursor and tolerates junk in the non-cursor fields', async () => {
    writeFileSync(file, JSON.stringify({ cursorRowid: 42, lastRunAt: 7, lastResult: { ok: true } }));
    const state = await readSyncCursorState(file, 'cursorRowid');
    expect(state.cursorRowid).toBe(42);
    expect(state.lastResult).toEqual({ ok: true });
  });

  it('treats a legacy object without the cursor key as cursor 0', async () => {
    writeFileSync(file, JSON.stringify({ lastRunAt: 'x' }));
    expect((await readSyncCursorState(file, 'cursorAfter')).cursorAfter).toBe(0);
  });

  it.each([
    ['truncated JSON', '{"cursorRowid": 12'],
    ['array root', '[1,2]'],
    ['null root', 'null'],
    ['string cursor', '{"cursorRowid":"12"}'],
    ['negative cursor', '{"cursorRowid":-1}'],
    ['fractional cursor', '{"cursorRowid":1.5}'],
    ['null cursor', '{"cursorRowid":null}'],
  ])('refuses to rewind on %s', async (_label, body) => {
    writeFileSync(file, body);
    await expect(readSyncCursorState(file, 'cursorRowid')).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
  });

  it('refuses to rewind when the file exists but cannot be read', async () => {
    mkdirSync(file); // EISDIR on read: present but unreadable
    await expect(readSyncCursorState(file, 'cursorRowid')).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
  });
});

describe('readSyncCursorStateForStatus', () => {
  it.each(['{oops', 'null'])('surfaces stateError for invalid state %s instead of throwing', async (body) => {
    writeFileSync(file, body);
    const result = await readSyncCursorStateForStatus(file, 'cursorRowid');
    expect(result.stateError).toBe('UNREADABLE_STORE');
    expect(result.state.cursorRowid).toBeNull();
  });

  it('returns the state with no stateError when readable', async () => {
    writeFileSync(file, '{"cursorRowid":5}');
    expect(await readSyncCursorStateForStatus(file, 'cursorRowid')).toEqual({
      state: { cursorRowid: 5, lastRunAt: null, lastResult: null },
    });
  });
});
