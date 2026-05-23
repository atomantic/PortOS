import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises before importing the module
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn()
}));

import { readFile, writeFile } from 'fs/promises';
import { getSettings, updateSettings } from './settings.js';

describe('settings.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('should return parsed settings from file', async () => {
      const mockSettings = { theme: 'dark', notifications: true };
      readFile.mockResolvedValue(JSON.stringify(mockSettings));

      const result = await getSettings();

      expect(result).toEqual(mockSettings);
      expect(readFile).toHaveBeenCalledTimes(1);
    });

    it('should return empty object when file does not exist', async () => {
      readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await getSettings();

      expect(result).toEqual({});
    });

    it('should return empty object for empty file content', async () => {
      // safeJSONParse returns the default {} for empty/invalid input
      readFile.mockResolvedValue('');

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
      readFile.mockResolvedValue(JSON.stringify(mockSettings));

      const result = await getSettings();

      expect(result).toEqual(mockSettings);
    });
  });

  describe('updateSettings', () => {
    it('should merge patch with existing settings', async () => {
      const existingSettings = { theme: 'light', notifications: true };
      readFile.mockResolvedValue(JSON.stringify(existingSettings));
      writeFile.mockResolvedValue();

      const result = await updateSettings({ theme: 'dark' });

      expect(result).toEqual({ theme: 'dark', notifications: true });
    });

    it('should add new keys when patching', async () => {
      const existingSettings = { theme: 'light' };
      readFile.mockResolvedValue(JSON.stringify(existingSettings));
      writeFile.mockResolvedValue();

      const result = await updateSettings({ newSetting: 'value' });

      expect(result).toEqual({ theme: 'light', newSetting: 'value' });
    });

    it('should write formatted JSON to file', async () => {
      readFile.mockResolvedValue('{}');
      writeFile.mockResolvedValue();

      await updateSettings({ test: true });

      expect(writeFile).toHaveBeenCalledTimes(1);
      const [, content] = writeFile.mock.calls[0];
      // Should be formatted with 2-space indent and trailing newline
      expect(content).toBe('{\n  "test": true\n}\n');
    });

    it('should create settings from empty when file does not exist', async () => {
      readFile.mockRejectedValue(new Error('ENOENT'));
      writeFile.mockResolvedValue();

      const result = await updateSettings({ firstSetting: 'value' });

      expect(result).toEqual({ firstSetting: 'value' });
    });

    it('should overwrite nested values with shallow merge', async () => {
      const existingSettings = {
        display: { theme: 'light', fontSize: 12 }
      };
      readFile.mockResolvedValue(JSON.stringify(existingSettings));
      writeFile.mockResolvedValue();

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
      readFile.mockResolvedValue(JSON.stringify(existingSettings));
      writeFile.mockResolvedValue();

      const result = await updateSettings({ b: 20 });

      expect(result).toEqual({ a: 1, b: 20, c: 3 });
    });

    it('should handle null values in patch', async () => {
      const existingSettings = { feature: true };
      readFile.mockResolvedValue(JSON.stringify(existingSettings));
      writeFile.mockResolvedValue();

      const result = await updateSettings({ feature: null });

      expect(result).toEqual({ feature: null });
    });

    it('should handle empty patch object', async () => {
      const existingSettings = { theme: 'dark' };
      readFile.mockResolvedValue(JSON.stringify(existingSettings));
      writeFile.mockResolvedValue();

      const result = await updateSettings({});

      expect(result).toEqual({ theme: 'dark' });
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
      readFile.mockResolvedValue(JSON.stringify(polluted));

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
      readFile.mockResolvedValue(JSON.stringify(existing));
      writeFile.mockResolvedValue();

      // Caller accidentally passes a payload with store keys.
      await updateSettings({ alcoholDrinks: [], goals: [], voice: { enabled: true } });

      const [, content] = writeFile.mock.calls[0];
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
      readFile.mockResolvedValue(JSON.stringify(polluted));
      writeFile.mockResolvedValue();

      // Any save (even unrelated) cleans up the file.
      await updateSettings({ timezone: 'UTC' });

      const [, content] = writeFile.mock.calls[0];
      const written = JSON.parse(content);
      expect(written).toEqual({ theme: 'dark', timezone: 'UTC' });
    });

    it('preserves legitimate mortalloom config key (not in store-key list)', async () => {
      readFile.mockResolvedValue('{}');
      writeFile.mockResolvedValue();

      await updateSettings({ mortalloom: { enabled: true, path: '/foo' } });

      const [, content] = writeFile.mock.calls[0];
      const written = JSON.parse(content);
      expect(written.mortalloom).toEqual({ enabled: true, path: '/foo' });
    });

    it('reads are silent but auto-heal write announces the strip', async () => {
      // Pollution sitting on disk.
      const polluted = {
        theme: 'dark',
        alcoholDrinks: [{ id: 'A' }]
      };
      readFile.mockResolvedValue(JSON.stringify(polluted));
      writeFile.mockResolvedValue();

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

    it('does not warn when writeFile throws (no misleading log for a write that did not happen)', async () => {
      readFile.mockResolvedValue(JSON.stringify({ theme: 'dark', alcoholDrinks: [{}] }));
      writeFile.mockRejectedValue(new Error('EROFS'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(updateSettings({ timezone: 'UTC' })).rejects.toThrow('EROFS');
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('emits exactly one warning per updateSettings even when both disk AND patch are polluted', async () => {
      // Disk pollution: alcoholDrinks. Patch pollution: goals. Spec: one log line.
      readFile.mockResolvedValue(JSON.stringify({ theme: 'dark', alcoholDrinks: [{}] }));
      writeFile.mockResolvedValue();

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
      readFile.mockResolvedValue(JSON.stringify(malicious));
      writeFile.mockResolvedValue();

      const result = await getSettings();

      expect(result).toEqual({ theme: 'dark' });
      // Confirm no prototype pollution — a fresh object must not see `polluted`.
      expect({}.polluted).toBeUndefined();
    });
  });
});
