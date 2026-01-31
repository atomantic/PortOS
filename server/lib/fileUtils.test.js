import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isValidJSON,
  safeJSONParse,
  safeJSONLParse,
  readJSONFile,
  readJSONLFile
} from './fileUtils.js';

describe('fileUtils', () => {
  describe('isValidJSON', () => {
    it('should return true for valid JSON object', () => {
      expect(isValidJSON('{"key": "value"}')).toBe(true);
    });

    it('should return true for valid JSON array when allowed', () => {
      expect(isValidJSON('[1, 2, 3]')).toBe(true);
    });

    it('should return false for JSON array when not allowed', () => {
      expect(isValidJSON('[1, 2, 3]', { allowArray: false })).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidJSON('')).toBe(false);
    });

    it('should return false for whitespace-only string', () => {
      expect(isValidJSON('   ')).toBe(false);
    });

    it('should return false for null', () => {
      expect(isValidJSON(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isValidJSON(undefined)).toBe(false);
    });

    it('should return false for string not starting with { or [', () => {
      expect(isValidJSON('hello')).toBe(false);
    });

    it('should return false for incomplete object (missing end)', () => {
      expect(isValidJSON('{"key":')).toBe(false);
    });

    it('should return false for incomplete array (missing end)', () => {
      expect(isValidJSON('[1, 2')).toBe(false);
    });

    it('should handle whitespace around valid JSON', () => {
      expect(isValidJSON('  {"key": "value"}  ')).toBe(true);
    });

    it('should handle nested objects', () => {
      expect(isValidJSON('{"outer": {"inner": "value"}}')).toBe(true);
    });
  });

  describe('safeJSONParse', () => {
    it('should parse valid JSON object', () => {
      const result = safeJSONParse('{"key": "value"}', {});
      expect(result).toEqual({ key: 'value' });
    });

    it('should parse valid JSON array', () => {
      const result = safeJSONParse('[1, 2, 3]', []);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should return default value for empty string', () => {
      const result = safeJSONParse('', { default: true });
      expect(result).toEqual({ default: true });
    });

    it('should return default value for null input', () => {
      const result = safeJSONParse(null, []);
      expect(result).toEqual([]);
    });

    it('should return default value for invalid JSON', () => {
      const result = safeJSONParse('not json', { fallback: 'value' });
      expect(result).toEqual({ fallback: 'value' });
    });

    it('should return default value for JSON with trailing comma', () => {
      const result = safeJSONParse('{"a": 1,}', {});
      expect(result).toEqual({});
    });

    it('should return default value for truncated JSON', () => {
      const result = safeJSONParse('{"key": "value', {});
      expect(result).toEqual({});
    });

    it('should return null as default when no defaultValue provided', () => {
      const result = safeJSONParse('invalid');
      expect(result).toBe(null);
    });

    it('should reject arrays when allowArray is false', () => {
      const result = safeJSONParse('[1, 2, 3]', {}, { allowArray: false });
      expect(result).toEqual({});
    });

    it('should log error when logError is true', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      safeJSONParse('invalid', {}, { logError: true });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should include context in log message', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      safeJSONParse('invalid', {}, { logError: true, context: 'test-file.json' });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test-file.json'));
      consoleSpy.mockRestore();
    });

    it('should not log for empty input even with logError true', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      safeJSONParse('', {}, { logError: true });
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle syntax error in structurally valid JSON', () => {
      // Passes structural check but fails JSON.parse
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = safeJSONParse('{"key": undefined}', { fallback: true }, { logError: true });
      expect(result).toEqual({ fallback: true });
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('safeJSONLParse', () => {
    it('should parse valid JSONL content', () => {
      const content = '{"a": 1}\n{"b": 2}\n{"c": 3}';
      const result = safeJSONLParse(content);
      expect(result).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it('should skip empty lines', () => {
      const content = '{"a": 1}\n\n{"b": 2}\n';
      const result = safeJSONLParse(content);
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('should skip whitespace-only lines', () => {
      const content = '{"a": 1}\n   \n{"b": 2}';
      const result = safeJSONLParse(content);
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('should skip invalid lines and continue parsing', () => {
      const content = '{"a": 1}\ninvalid json\n{"b": 2}';
      const result = safeJSONLParse(content);
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('should return empty array for empty content', () => {
      expect(safeJSONLParse('')).toEqual([]);
    });

    it('should return empty array for null content', () => {
      expect(safeJSONLParse(null)).toEqual([]);
    });

    it('should return empty array for whitespace-only content', () => {
      expect(safeJSONLParse('   \n   ')).toEqual([]);
    });

    it('should handle single line without trailing newline', () => {
      const result = safeJSONLParse('{"single": "line"}');
      expect(result).toEqual([{ single: 'line' }]);
    });

    it('should reject array values in lines (JSONL expects objects)', () => {
      const content = '{"a": 1}\n[1, 2, 3]\n{"b": 2}';
      const result = safeJSONLParse(content);
      // Arrays are rejected because allowArray: false is passed internally
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('should handle lines with only truncated JSON', () => {
      const content = '{"complete": true}\n{"incomplete":';
      const result = safeJSONLParse(content);
      expect(result).toEqual([{ complete: true }]);
    });
  });

  describe('readJSONFile', () => {
    const testDir = join(tmpdir(), 'fileutils-test-' + Date.now());

    beforeEach(async () => {
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it('should read and parse valid JSON file', async () => {
      const filePath = join(testDir, 'valid.json');
      await writeFile(filePath, '{"key": "value"}');

      const result = await readJSONFile(filePath, {});
      expect(result).toEqual({ key: 'value' });
    });

    it('should return default value for non-existent file', async () => {
      const result = await readJSONFile('/nonexistent/path.json', { default: true });
      expect(result).toEqual({ default: true });
    });

    it('should return default value for empty file', async () => {
      const filePath = join(testDir, 'empty.json');
      await writeFile(filePath, '');

      const result = await readJSONFile(filePath, { empty: true });
      expect(result).toEqual({ empty: true });
    });

    it('should return default value for corrupted file', async () => {
      const filePath = join(testDir, 'corrupted.json');
      await writeFile(filePath, '{"incomplete":');

      const result = await readJSONFile(filePath, { fallback: true });
      expect(result).toEqual({ fallback: true });
    });

    it('should handle arrays when allowArray is true', async () => {
      const filePath = join(testDir, 'array.json');
      await writeFile(filePath, '[1, 2, 3]');

      const result = await readJSONFile(filePath, []);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should reject arrays when allowArray is false', async () => {
      const filePath = join(testDir, 'array.json');
      await writeFile(filePath, '[1, 2, 3]');

      const result = await readJSONFile(filePath, {}, { allowArray: false });
      expect(result).toEqual({});
    });
  });

  describe('readJSONLFile', () => {
    const testDir = join(tmpdir(), 'fileutils-jsonl-test-' + Date.now());

    beforeEach(async () => {
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it('should read and parse valid JSONL file', async () => {
      const filePath = join(testDir, 'valid.jsonl');
      await writeFile(filePath, '{"a": 1}\n{"b": 2}\n{"c": 3}');

      const result = await readJSONLFile(filePath);
      expect(result).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it('should return empty array for non-existent file', async () => {
      const result = await readJSONLFile('/nonexistent/path.jsonl');
      expect(result).toEqual([]);
    });

    it('should return empty array for empty file', async () => {
      const filePath = join(testDir, 'empty.jsonl');
      await writeFile(filePath, '');

      const result = await readJSONLFile(filePath);
      expect(result).toEqual([]);
    });

    it('should skip invalid lines in JSONL file', async () => {
      const filePath = join(testDir, 'mixed.jsonl');
      await writeFile(filePath, '{"valid": 1}\nnot json\n{"also": "valid"}');

      const result = await readJSONLFile(filePath);
      expect(result).toEqual([{ valid: 1 }, { also: 'valid' }]);
    });
  });
});
