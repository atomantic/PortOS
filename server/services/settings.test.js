import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { atomicWrite, tryReadFile } from '../lib/fileUtils.js';
import { getSettings, updateSettings } from './settings.js';

describe('settings.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
