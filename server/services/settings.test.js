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
});
