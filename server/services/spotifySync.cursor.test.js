// Corrupt Spotify cursor file must abort the sync, not re-poll without `after`.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  root: '',
  fetchWithTimeout: vi.fn(),
  recordEvents: vi.fn(),
}));
mocks.root = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'spotify-cursor-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...await importOriginal(),
  dataPath: (...parts) => join(mocks.root, ...parts),
}));
vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: (...a) => mocks.fetchWithTimeout(...a) }));
vi.mock('./spotifyAuth.js', () => ({
  getAccessToken: async () => 'token',
  getAuthStatus: async () => ({ connected: true }),
}));
vi.mock('./settings.js', () => ({ getSettings: async () => ({}) }));
vi.mock('./humanActivity.js', () => ({ recordEvents: (...a) => mocks.recordEvents(...a) }));

import { runSync, getStatus } from './spotifySync.js';

const statePath = () => join(mocks.root, 'spotify', 'sync-state.json');

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(join(mocks.root, 'spotify'), { recursive: true, force: true });
  mkdirSync(join(mocks.root, 'spotify'), { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => rmSync(mocks.root, { recursive: true, force: true }));

describe('spotify sync-state corruption', () => {
  it('aborts runSync without polling or overwriting the corrupt state file', async () => {
    const corrupt = '{"cursorAfter": 1710000';
    writeFileSync(statePath(), corrupt);

    await expect(runSync()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });

    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
    expect(mocks.recordEvents).not.toHaveBeenCalled();
    expect(readFileSync(statePath(), 'utf8')).toBe(corrupt);
    // in-flight latch cleared: a later run is not wedged
    await expect(runSync()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
  });

  it('keeps getStatus usable and reports stateError', async () => {
    writeFileSync(statePath(), 'nope');
    const status = await getStatus();
    expect(status.stateError).toBe('UNREADABLE_STORE');
    expect(status.state.cursorAfter).toBeNull();
    expect(status.auth).toEqual({ connected: true });
  });
});
