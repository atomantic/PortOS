import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// settings.js persists via the shared atomicWrite helper and reads via
// tryReadFile (both from server/lib/fileUtils.js). Mock just those two and
// keep the rest of fileUtils real (PATHS, safeJSONParse). The createFileWriteQueue
// serializer is exercised for real — writes are sequential in these tests anyway.
vi.mock('../lib/fileUtils.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    atomicWrite: vi.fn(),
    tryReadFile: vi.fn()
  };
});

import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join as joinPath } from 'path';
import { tmpdir } from 'os';
import { atomicWrite, tryReadFile } from '../lib/fileUtils.js';
import { getSettings, updateSettings, updateSettingsWith, reloadSettings, settingsEvents, __resetSettingsCache, readSettingsStrict } from './settings.js';

describe('settings.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getSettings memoizes the parsed file; drop the cache so each test observes
    // its own per-test tryReadFile stub instead of a value cached by a prior test.
    __resetSettingsCache();
    // Sensible defaults: empty file on disk, writes succeed. Individual tests
    // override as needed.
    tryReadFile.mockResolvedValue('{}');
    atomicWrite.mockResolvedValue();
  });

  describe('getSettings', () => {
    it('should return parsed settings from file', async () => {
      const mockSettings = { theme: 'dark', notifications: true };
      tryReadFile.mockResolvedValue(JSON.stringify(mockSettings));

      const result = await getSettings();

      expect(result).toEqual(mockSettings);
      expect(tryReadFile).toHaveBeenCalledTimes(1);
    });

    it('should return empty object when file does not exist', async () => {
      // tryReadFile returns null when the file is missing/unreadable.
      tryReadFile.mockResolvedValue(null);

      const result = await getSettings();

      expect(result).toEqual({});
    });

    it('should return empty object for empty file content', async () => {
      // safeJSONParse returns the default {} for empty/invalid input
      tryReadFile.mockResolvedValue('');

      const result = await getSettings();
      expect(result).toEqual({});
    });

    it('does not cache a corrupt read, so a repaired file is picked up next call (#2684)', async () => {
      // A malformed settings.json must NOT poison the cache with {} — otherwise
      // verifyPassword() and every other consumer stay stranded on empty settings
      // (rejecting the correct password) until a save or restart.
      tryReadFile.mockResolvedValueOnce('{ truncated');
      const first = await getSettings();
      expect(first).toEqual({});

      // File repaired: the next read must reflect it, proving {} was not cached.
      tryReadFile.mockResolvedValue(JSON.stringify({ secrets: { auth: { enabled: true, passwordHash: 'h', salt: 's' } } }));
      const second = await getSettings();
      expect(second.secrets.auth.enabled).toBe(true);
    });

    it('should handle complex nested settings', async () => {
      const mockSettings = {
        display: {
          theme: 'dark',
          fontSize: 14
        },
        features: ['notifications', 'autoSave'],
        version: 2
      };
      tryReadFile.mockResolvedValue(JSON.stringify(mockSettings));

      const result = await getSettings();

      expect(result).toEqual(mockSettings);
    });

    it('memoizes the parsed file — a second call does not re-read disk', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ theme: 'dark' }));

      await getSettings();
      await getSettings();

      // The read cache means only the first call hits disk.
      expect(tryReadFile).toHaveBeenCalledTimes(1);
    });

    it('a settings:updated landing during a cold read does not clobber the fresher value', async () => {
      // Hold the cold read's disk load open until we release it, so we can slip a
      // save() in while getSettings() is awaiting loadRaw().
      let releaseRead;
      tryReadFile.mockReturnValue(new Promise((resolve) => { releaseRead = resolve; }));

      const inflight = getSettings(); // cold — now awaiting the disk read
      // A save completes mid-flight and populates the cache with fresh settings.
      settingsEvents.emit('settings:updated', { theme: 'fresh' });
      // Only now does the older on-disk snapshot resolve.
      releaseRead(JSON.stringify({ theme: 'stale' }));
      await inflight;

      // The fresher save value must win — the resumed cold read must not overwrite it.
      expect(await getSettings()).toEqual({ theme: 'fresh' });
    });

    it('hands out a deep copy — mutating a nested field does not corrupt the cache', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ display: { theme: 'dark' } }));

      const first = await getSettings();
      first.display.theme = 'light'; // mutate the returned nested object

      const second = await getSettings();
      // The cache is isolated from the mutation — second read is untouched.
      expect(second.display.theme).toBe('dark');
    });
  });

  describe('reloadSettings', () => {
    it('re-syncs the cache with the current on-disk file (for out-of-band writes like restore)', async () => {
      // Warm the cache with the original file.
      tryReadFile.mockResolvedValue(JSON.stringify({ theme: 'dark' }));
      expect(await getSettings()).toEqual({ theme: 'dark' });

      // A restore rsyncs a new settings.json into place, bypassing save().
      tryReadFile.mockResolvedValue(JSON.stringify({ theme: 'light', added: true }));
      // Without reloadSettings the cache would still serve the stale value...
      expect(await getSettings()).toEqual({ theme: 'dark' });

      // ...reloadSettings re-reads disk and refreshes every settings consumer.
      const reloaded = await reloadSettings();
      expect(reloaded).toEqual({ theme: 'light', added: true });
      expect(await getSettings()).toEqual({ theme: 'light', added: true });
    });
  });

  describe('updateSettings', () => {
    it('should merge patch with existing settings', async () => {
      const existingSettings = { theme: 'light', notifications: true };
      tryReadFile.mockResolvedValue(JSON.stringify(existingSettings));

      const result = await updateSettings({ theme: 'dark' });

      expect(result).toEqual({ theme: 'dark', notifications: true });
    });

    it('should add new keys when patching', async () => {
      const existingSettings = { theme: 'light' };
      tryReadFile.mockResolvedValue(JSON.stringify(existingSettings));

      const result = await updateSettings({ newSetting: 'value' });

      expect(result).toEqual({ theme: 'light', newSetting: 'value' });
    });

    it('should write formatted JSON to file', async () => {
      tryReadFile.mockResolvedValue('{}');

      await updateSettings({ test: true });

      expect(atomicWrite).toHaveBeenCalledTimes(1);
      const [, content] = atomicWrite.mock.calls[0];
      // Should be formatted with 2-space indent and trailing newline
      expect(content).toBe('{\n  "test": true\n}\n');
    });

    it('should create settings from empty when file does not exist', async () => {
      tryReadFile.mockResolvedValue(null);

      const result = await updateSettings({ firstSetting: 'value' });

      expect(result).toEqual({ firstSetting: 'value' });
    });

    it('should overwrite nested values with shallow merge', async () => {
      const existingSettings = {
        display: { theme: 'light', fontSize: 12 }
      };
      tryReadFile.mockResolvedValue(JSON.stringify(existingSettings));

      // Shallow merge replaces the entire display object
      const result = await updateSettings({ display: { theme: 'dark' } });

      expect(result).toEqual({ display: { theme: 'dark' } });
      // Note: fontSize is lost because it's a shallow merge
    });

    it('should preserve unmodified settings', async () => {
      const existingSettings = {
        a: 1,
        b: 2,
        c: 3
      };
      tryReadFile.mockResolvedValue(JSON.stringify(existingSettings));

      const result = await updateSettings({ b: 20 });

      expect(result).toEqual({ a: 1, b: 20, c: 3 });
    });

    it('should handle null values in patch', async () => {
      const existingSettings = { feature: true };
      tryReadFile.mockResolvedValue(JSON.stringify(existingSettings));

      const result = await updateSettings({ feature: null });

      expect(result).toEqual({ feature: null });
    });

    it('should handle empty patch object', async () => {
      const existingSettings = { theme: 'dark' };
      tryReadFile.mockResolvedValue(JSON.stringify(existingSettings));

      const result = await updateSettings({});

      expect(result).toEqual({ theme: 'dark' });
    });
  });

  describe('write serialization', () => {
    it('serializes concurrent updateSettings so neither patch is clobbered', async () => {
      // Simulate a slow disk: each write reflects onto the next read so the
      // queued read-merge-write can observe the prior write's result.
      let current = { base: true };
      tryReadFile.mockImplementation(async () => JSON.stringify(current));
      atomicWrite.mockImplementation(async (_path, content) => {
        current = JSON.parse(content);
      });

      // Fire both without awaiting the first — the queue must serialize them.
      const [a, b] = await Promise.all([
        updateSettings({ first: 1 }),
        updateSettings({ second: 2 })
      ]);

      // Both writes happened, in order, and the final state carries both patches.
      expect(atomicWrite).toHaveBeenCalledTimes(2);
      expect(current).toEqual({ base: true, first: 1, second: 2 });
      // The last resolved value is the fully-merged record; the first sees only
      // its own patch applied to the base.
      expect(b).toEqual({ base: true, first: 1, second: 2 });
      expect(a).toEqual({ base: true, first: 1 });
    });
  });

  describe('updateSettingsWith', () => {
    it('hands the mutator the current stripped settings and persists its return', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ civitai: { apiKey: 'old', other: 'keep' } }));
      let seen;
      const result = await updateSettingsWith((current) => {
        seen = current;
        return { ...current, civitai: { ...current.civitai, apiKey: 'new' } };
      });
      expect(seen).toEqual({ civitai: { apiKey: 'old', other: 'keep' } });
      expect(result).toEqual({ civitai: { apiKey: 'new', other: 'keep' } });
      expect(JSON.parse(atomicWrite.mock.calls[0][1])).toEqual({ civitai: { apiKey: 'new', other: 'keep' } });
    });

    it('supports building the next object by deleting a sub-key (no stale spread)', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ imageGen: { hfToken: 'tok', model: 'flux' }, theme: 'dark' }));
      const result = await updateSettingsWith((current) => {
        const { hfToken: _drop, ...rest } = current.imageGen || {};
        return { ...current, imageGen: rest };
      });
      expect(result).toEqual({ imageGen: { model: 'flux' }, theme: 'dark' });
    });

    it('runs the read-modify-write in one queued turn — a racing updateSettings is not clobbered', async () => {
      // Slow disk: each write reflects onto the next read. If updateSettingsWith
      // read OUTSIDE the queue (the old getSettings→saveSettings bug), it would
      // overwrite the interleaved updateSettings patch with its stale base.
      let current = { base: true };
      tryReadFile.mockImplementation(async () => JSON.stringify(current));
      atomicWrite.mockImplementation(async (_path, content) => { current = JSON.parse(content); });

      const [withResult, plainResult] = await Promise.all([
        updateSettingsWith((c) => ({ ...c, deep: { a: 1 } })),
        updateSettings({ second: 2 }),
      ]);

      // Both landed; neither clobbered the other.
      expect(atomicWrite).toHaveBeenCalledTimes(2);
      expect(current).toEqual({ base: true, deep: { a: 1 }, second: 2 });
      // First-queued sees only the base; second-queued sees the first's result.
      expect(withResult).toEqual({ base: true, deep: { a: 1 } });
      expect(plainResult).toEqual({ base: true, deep: { a: 1 }, second: 2 });
    });

    it('strips MortalLoom store keys from the snapshot handed to the mutator', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ goals: [1, 2], theme: 'dark' }));
      let seen;
      await updateSettingsWith((current) => { seen = current; return current; });
      // `goals` is a MortalLoom store key — getSettings strips it, so the mutator
      // must not see it (matching the getSettings() the old callers read).
      expect(seen).toEqual({ theme: 'dark' });
    });

    it('awaits an async mutator', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ a: 1 }));
      const result = await updateSettingsWith(async (current) => {
        await Promise.resolve();
        return { ...current, b: 2 };
      });
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('throws and writes nothing when the mutator returns a non-object (missing return, array, primitive)', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ a: 1 }));
      for (const bad of [undefined, null, 'str', 42, [1, 2]]) {
        await expect(updateSettingsWith(() => bad)).rejects.toThrow(/must return a plain settings object/);
      }
      // No invalid content (e.g. "undefined") was ever persisted.
      expect(atomicWrite).not.toHaveBeenCalled();
    });
  });

  describe('timezoneUpdatedAt stamping (#2040)', () => {
    it('stamps timezoneUpdatedAt when the timezone value actually changes', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ timezone: 'UTC', theme: 'dark' }));

      const before = Date.now();
      const result = await updateSettings({ timezone: 'Asia/Tokyo' });

      expect(result.timezone).toBe('Asia/Tokyo');
      expect(typeof result.timezoneUpdatedAt).toBe('number');
      expect(result.timezoneUpdatedAt).toBeGreaterThanOrEqual(before);
    });

    it('stamps on first-ever set (unset → value)', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ theme: 'dark' }));

      const result = await updateSettings({ timezone: 'UTC' });

      expect(typeof result.timezoneUpdatedAt).toBe('number');
    });

    it('does NOT stamp when an unrelated setting is saved (timezone unchanged)', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ timezone: 'UTC', theme: 'dark' }));

      const result = await updateSettings({ theme: 'light' });

      expect(result.timezone).toBe('UTC');
      expect(result.timezoneUpdatedAt).toBeUndefined();
    });

    it('does NOT stamp when the timezone is re-saved with the same value', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ timezone: 'UTC' }));

      const result = await updateSettings({ timezone: 'UTC' });

      expect(result.timezoneUpdatedAt).toBeUndefined();
    });

    it('preserves an existing timezoneUpdatedAt across an unrelated save (does not clear it)', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ timezone: 'UTC', timezoneUpdatedAt: 1234567890 }));

      const result = await updateSettings({ theme: 'dark' });

      expect(result.timezoneUpdatedAt).toBe(1234567890);
    });

    it('re-stamps (overwrites the old timestamp) when the timezone changes again', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ timezone: 'UTC', timezoneUpdatedAt: 1 }));

      const result = await updateSettings({ timezone: 'Europe/Paris' });

      expect(result.timezoneUpdatedAt).toBeGreaterThan(1);
    });
  });

  describe('MortalLoom store key pollution guard', () => {
    it('strips MortalLoom-store top-level keys on read', async () => {
      // Simulates the historical corruption: settings.json contains both
      // legitimate settings and MortalLoom store arrays.
      const polluted = {
        theme: 'dark',
        timezone: 'UTC',
        alcoholDrinks: [{ id: 'A', name: 'beer' }],
        bloodTests: [{ id: 'B' }],
        goals: [{ id: 'G' }],
        profile: { name: 'X' },
        mortalloom: { enabled: true }
      };
      tryReadFile.mockResolvedValue(JSON.stringify(polluted));

      const result = await getSettings();

      expect(result).toEqual({
        theme: 'dark',
        timezone: 'UTC',
        mortalloom: { enabled: true }
      });
      expect(result.alcoholDrinks).toBeUndefined();
      expect(result.goals).toBeUndefined();
      expect(result.profile).toBeUndefined();
    });

    it('strips MortalLoom-store keys before writing', async () => {
      const existing = { theme: 'dark' };
      tryReadFile.mockResolvedValue(JSON.stringify(existing));

      // Caller accidentally passes a payload with store keys.
      await updateSettings({ alcoholDrinks: [], goals: [], voice: { enabled: true } });

      const [, content] = atomicWrite.mock.calls[0];
      const written = JSON.parse(content);
      expect(written).toEqual({ theme: 'dark', voice: { enabled: true } });
      expect(written.alcoholDrinks).toBeUndefined();
      expect(written.goals).toBeUndefined();
    });

    it('auto-heals corrupted settings.json on next save', async () => {
      // Polluted file on disk.
      const polluted = {
        theme: 'dark',
        alcoholDrinks: [{ id: 'A' }],
        bloodTests: [{ id: 'B' }],
        habits: [{ id: 'H' }]
      };
      tryReadFile.mockResolvedValue(JSON.stringify(polluted));

      // Any save (even unrelated) cleans up the file.
      await updateSettings({ timezone: 'UTC' });

      const [, content] = atomicWrite.mock.calls[0];
      const written = JSON.parse(content);
      // Setting the timezone (undefined → 'UTC' here) stamps timezoneUpdatedAt;
      // strip it before comparing the rest of the cleaned shape.
      expect(typeof written.timezoneUpdatedAt).toBe('number');
      delete written.timezoneUpdatedAt;
      expect(written).toEqual({ theme: 'dark', timezone: 'UTC' });
    });

    it('preserves legitimate mortalloom config key (not in store-key list)', async () => {
      tryReadFile.mockResolvedValue('{}');

      await updateSettings({ mortalloom: { enabled: true, path: '/foo' } });

      const [, content] = atomicWrite.mock.calls[0];
      const written = JSON.parse(content);
      expect(written.mortalloom).toEqual({ enabled: true, path: '/foo' });
    });

    it('reads are silent but auto-heal write announces the strip', async () => {
      // Pollution sitting on disk.
      const polluted = {
        theme: 'dark',
        alcoholDrinks: [{ id: 'A' }]
      };
      tryReadFile.mockResolvedValue(JSON.stringify(polluted));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Pure read — must NOT log (otherwise every GET /api/settings spams).
      await getSettings();
      expect(warnSpy).not.toHaveBeenCalled();

      // Write path — the auto-heal must surface a single warning so the
      // operator sees the file is being cleaned.
      await updateSettings({ timezone: 'UTC' });
      expect(warnSpy).toHaveBeenCalled();
      const firstCallArg = warnSpy.mock.calls[0][0];
      expect(firstCallArg).toContain('alcoholDrinks');

      warnSpy.mockRestore();
    });

    it('does not warn when the write throws (no misleading log for a write that did not happen)', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ theme: 'dark', alcoholDrinks: [{}] }));
      atomicWrite.mockRejectedValue(new Error('EROFS'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(updateSettings({ timezone: 'UTC' })).rejects.toThrow('EROFS');
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('emits exactly one warning per updateSettings even when both disk AND patch are polluted', async () => {
      // Disk pollution: alcoholDrinks. Patch pollution: goals. Spec: one log line.
      tryReadFile.mockResolvedValue(JSON.stringify({ theme: 'dark', alcoholDrinks: [{}] }));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await updateSettings({ goals: [], timezone: 'UTC' });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0][0];
      expect(msg).toContain('alcoholDrinks');
      expect(msg).toContain('goals');

      warnSpy.mockRestore();
    });

    it('drops __proto__ / constructor / prototype keys instead of mutating Object.prototype', async () => {
      // A `__proto__` own property arrives via JSON.parse of a payload like
      // `{"__proto__":{"polluted":true}}`. Without the guard, the cleaned-object
      // rebuild would invoke the __proto__ setter.
      const malicious = JSON.parse('{"theme":"dark","__proto__":{"polluted":true},"constructor":{"polluted":true}}');
      tryReadFile.mockResolvedValue(JSON.stringify(malicious));

      const result = await getSettings();

      expect(result).toEqual({ theme: 'dark' });
      // Confirm no prototype pollution — a fresh object must not see `polluted`.
      expect({}.polluted).toBeUndefined();
    });
  });

  // Strict read for the auth gate (#2684): distinguishes absent (auth off) from
  // present-but-corrupt (fail closed), which loadRaw()/getSettings() collapse to {}.
  // Content comes through the mocked tryReadFile; the absent-vs-unreadable split
  // uses a real access() probe, so those two cases drive a real temp file.
  describe('readSettingsStrict', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(joinPath(tmpdir(), 'portos-strict-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('reports absent (not corrupt) when the file does not exist', async () => {
      // tryReadFile null + a path that isn't there → access() throws → absent.
      tryReadFile.mockResolvedValue(null);
      const res = await readSettingsStrict(joinPath(dir, 'nope.json'));
      expect(res).toEqual({ present: false, corrupt: false, settings: {} });
    });

    it('flags a present-but-unreadable file as corrupt (fail-closed signal)', async () => {
      // tryReadFile null (read failed) but the file EXISTS → access() succeeds → corrupt.
      const p = joinPath(dir, 'settings.json');
      writeFileSync(p, '{}');
      tryReadFile.mockResolvedValue(null);
      const res = await readSettingsStrict(p);
      expect(res).toEqual({ present: true, corrupt: true, settings: {} });
    });

    it('parses a clean settings file', async () => {
      tryReadFile.mockResolvedValue(JSON.stringify({ secrets: { auth: { enabled: true, passwordHash: 'h', salt: 's' } } }));
      const res = await readSettingsStrict(joinPath(dir, 'settings.json'));
      expect(res.present).toBe(true);
      expect(res.corrupt).toBe(false);
      expect(res.settings.secrets.auth.enabled).toBe(true);
    });

    it('flags present-but-malformed content as corrupt', async () => {
      tryReadFile.mockResolvedValue('{ this is not valid json');
      const res = await readSettingsStrict(joinPath(dir, 'settings.json'));
      expect(res).toEqual({ present: true, corrupt: true, settings: {} });
    });

    it('flags empty content as corrupt', async () => {
      tryReadFile.mockResolvedValue('');
      const res = await readSettingsStrict(joinPath(dir, 'settings.json'));
      expect(res.corrupt).toBe(true);
    });

    it('flags a valid-JSON but non-object root as corrupt', async () => {
      tryReadFile.mockResolvedValue('[1,2,3]');
      const res = await readSettingsStrict(joinPath(dir, 'settings.json'));
      expect(res.corrupt).toBe(true);
    });
  });

  // reloadSettings must not broadcast a corrupt file as `{}` (#2684) — that path
  // (backup restore of a malformed snapshot) is what would prime the auth cache
  // to disabled and fail open.
  describe('reloadSettings corruption handling', () => {
    it('emits settings:invalidated (not settings:updated) and drops the cache on a corrupt file', async () => {
      const onUpdated = vi.fn();
      const onInvalidated = vi.fn();
      settingsEvents.on('settings:updated', onUpdated);
      settingsEvents.on('settings:invalidated', onInvalidated);

      tryReadFile.mockResolvedValue('{ truncated');
      const result = await reloadSettings();

      expect(result).toEqual({});
      expect(onInvalidated).toHaveBeenCalledTimes(1);
      expect(onUpdated).not.toHaveBeenCalled();

      // Cache was dropped: a subsequent clean read is picked up (not a stale {}).
      tryReadFile.mockResolvedValue(JSON.stringify({ theme: 'dark' }));
      expect(await getSettings()).toEqual({ theme: 'dark' });

      settingsEvents.off('settings:updated', onUpdated);
      settingsEvents.off('settings:invalidated', onInvalidated);
    });

    it('emits settings:updated with the parsed settings on a clean reload', async () => {
      const onUpdated = vi.fn();
      settingsEvents.on('settings:updated', onUpdated);

      tryReadFile.mockResolvedValue(JSON.stringify({ theme: 'light' }));
      const result = await reloadSettings();

      expect(result).toEqual({ theme: 'light' });
      expect(onUpdated).toHaveBeenCalledWith({ theme: 'light' });

      settingsEvents.off('settings:updated', onUpdated);
    });
  });
});
