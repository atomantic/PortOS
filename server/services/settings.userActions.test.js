/**
 * settings.js → operator-action ledger (#5594), end to end.
 *
 * Separate from `settings.test.js` because that suite stubs `atomicWrite` and
 * asserts on it; here BOTH writes are real (settings.json and the ledger's file
 * backend), with `PATHS.data` re-rooted at a temp dir, so what is pinned is the
 * actual persisted row rather than a call to a mock.
 *
 * What matters here is the `actor` split — `PUT /api/settings` is the only
 * caller that says `user`; a scheduler or sync hook writing the same file must
 * not look like the human did it — plus the diff itself: which keys changed,
 * before/after for short scalars, secret values withheld, and nothing written at
 * all for a no-op save.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const tempRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return mkdtempSync(joinPath(tmpdir(), 'portos-settings-actions-'));
});
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const { makePathsProxy } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});

const { saveSettings, updateSettings, updateSettingsWith, reloadSettings, __resetSettingsCache } =
  await import('./settings.js');
const { listUserActions } = await import('./userActions.js');

const SETTINGS_FILE = join(tempRoot, 'settings.json');
const seed = (settings) => writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

beforeEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  seed({ timezone: 'UTC' });
  __resetSettingsCache();
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('settings save → user_action_events (#5594)', () => {
  it('records the changed keys with before/after and the caller-supplied actor', async () => {
    await updateSettingsWith((current) => ({ ...current, timezone: 'America/Los_Angeles' }), { actor: 'user' });

    const [event] = await listUserActions({ type: 'settings.update' });
    expect(event).toMatchObject({ type: 'settings.update', actor: 'user', success: true });
    expect(event.payload.keysChanged).toEqual(['timezone']);
    expect(event.payload.changes.timezone).toEqual({ from: 'UTC', to: 'America/Los_Angeles' });
    // The derived `timezoneUpdatedAt` stamp is not an operator edit.
    expect(event.payload.keysChanged).not.toContain('timezoneUpdatedAt');
    // ...but it still reached disk — the diff runs before the stamp, not instead of it.
    expect(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).timezoneUpdatedAt).toEqual(expect.any(Number));
  });

  it('defaults to actor "system" for every non-route caller', async () => {
    await updateSettings({ theme: 'dark' });
    const [event] = await listUserActions({ type: 'settings.update' });
    expect(event.actor).toBe('system');
    expect(event.payload.keysChanged).toEqual(['theme']);
  });

  it('threads the actor through saveSettings and updateSettings too', async () => {
    await saveSettings({ timezone: 'UTC', theme: 'dark' }, { actor: 'user' });
    await updateSettings({ theme: 'light' }, { actor: 'user' });
    const events = await listUserActions({ type: 'settings.update' });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.actor === 'user')).toBe(true);
  });

  it('lists a secret-shaped key as changed but withholds its value', async () => {
    await updateSettings({ civitaiApiKey: 'EXAMPLE-not-a-real-key' }, { actor: 'user' });

    const [event] = await listUserActions({ type: 'settings.update' });
    expect(event.payload.keysChanged).toEqual(['civitaiApiKey']);
    expect(event.payload.redactedKeys).toEqual(['changes.civitaiApiKey']);
    expect(event.payload.changes).not.toHaveProperty('civitaiApiKey');
    expect(JSON.stringify(event)).not.toContain('EXAMPLE-not-a-real-key');
  });

  it('records the fact of a change for a non-scalar slice without copying it in', async () => {
    await updateSettings({ backup: { enabled: true, destination: '/example/backups' } }, { actor: 'user' });

    const [event] = await listUserActions({ type: 'settings.update' });
    expect(event.payload.changes.backup).toEqual({ changed: true });
  });

  it('writes nothing for a no-op save', async () => {
    await updateSettings({ timezone: 'UTC' }, { actor: 'user' });
    expect(await listUserActions({ type: 'settings.update' })).toEqual([]);

    // Bypass probe: the same call with a real change DOES record, so the
    // assertion above is about the no-op, not about the hook being dead.
    await updateSettings({ timezone: 'Europe/Berlin' }, { actor: 'user' });
    expect(await listUserActions({ type: 'settings.update' })).toHaveLength(1);
  });

  it('keeps two same-millisecond saves apart in the dedupe key', async () => {
    // `toISOString()` resolves only to the millisecond, so the changed-key list
    // is part of the key — without it a second distinct save landing in the same
    // millisecond would be swallowed by ON CONFLICT DO NOTHING.
    await updateSettings({ theme: 'dark' }, { actor: 'user' });
    await updateSettings({ locale: 'en-GB' }, { actor: 'user' });

    const events = await listUserActions({ type: 'settings.update' });
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(2);
    expect(events.every((e) => e.dedupeKey.startsWith('settings.update:'))).toBe(true);
  });

  it('records nothing for reloadSettings — a restore is not an operator edit', async () => {
    seed({ timezone: 'Asia/Tokyo', theme: 'dark' });
    await reloadSettings();
    expect(await listUserActions({ type: 'settings.update' })).toEqual([]);
  });
});
