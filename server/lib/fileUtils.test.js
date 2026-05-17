import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assertSafeFilename,
  isValidJSON,
  listDirectoryByExtension,
  safeJSONParse,
  safeJSONLParse,
  readJSONFile,
  readJSONLFile,
  formatDuration
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

    it('should log warning when logError is true', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      safeJSONParse('invalid', {}, { logError: true });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should include context in log message', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      safeJSONParse('invalid', {}, { logError: true, context: 'test-file.json' });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test-file.json'));
      consoleSpy.mockRestore();
    });

    it('should not log for empty input even with logError true', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      safeJSONParse('', {}, { logError: true });
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle syntax error in structurally valid JSON', () => {
      // Passes structural check but fails JSON.parse
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = safeJSONParse('{"key": undefined}', { fallback: true }, { logError: true });
      expect(result).toEqual({ fallback: true });
      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
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

    it('should handle CRLF line endings (Windows)', () => {
      const content = '{"a": 1}\r\n{"b": 2}\r\n{"c": 3}';
      const result = safeJSONLParse(content);
      expect(result).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it('should handle mixed LF and CRLF line endings', () => {
      const content = '{"a": 1}\n{"b": 2}\r\n{"c": 3}';
      const result = safeJSONLParse(content);
      expect(result).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
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

  describe('formatDuration', () => {
    it('should return "0m" for zero or falsy values', () => {
      expect(formatDuration(0)).toBe('0m');
      expect(formatDuration(null)).toBe('0m');
      expect(formatDuration(undefined)).toBe('0m');
    });

    it('should format minutes correctly', () => {
      expect(formatDuration(60000)).toBe('1m');
      expect(formatDuration(300000)).toBe('5m');
      expect(formatDuration(59 * 60000)).toBe('59m');
    });

    it('should format hours and minutes correctly', () => {
      expect(formatDuration(60 * 60000)).toBe('1h 0m');
      expect(formatDuration(90 * 60000)).toBe('1h 30m');
      expect(formatDuration(150 * 60000)).toBe('2h 30m');
    });

    it('should format days and hours correctly', () => {
      expect(formatDuration(24 * 60 * 60000)).toBe('1d 0h');
      expect(formatDuration(25 * 60 * 60000)).toBe('1d 1h');
      expect(formatDuration(48 * 60 * 60000)).toBe('2d 0h');
      expect(formatDuration(50 * 60 * 60000)).toBe('2d 2h');
    });
  });

  describe('assertSafeFilename', () => {
    it('accepts a safe basename with an allowlisted extension', () => {
      expect(() => assertSafeFilename('foo.png', { extensions: ['.png'] })).not.toThrow();
      expect(() => assertSafeFilename('lora-cool.safetensors', { extensions: ['.safetensors'] })).not.toThrow();
    });

    it('matches extensions case-insensitively', () => {
      expect(() => assertSafeFilename('FOO.PNG', { extensions: ['.png'] })).not.toThrow();
      expect(() => assertSafeFilename('cool.SafeTensors', { extensions: ['.safetensors'] })).not.toThrow();
    });

    it('allows substring `..` in the middle of a name', () => {
      expect(() => assertSafeFilename('my..render.png', { extensions: ['.png'] })).not.toThrow();
    });

    it('rejects path separators', () => {
      expect(() => assertSafeFilename('sub/foo.png', { extensions: ['.png'] })).toThrow(/Invalid filename/);
      expect(() => assertSafeFilename('sub\\foo.png', { extensions: ['.png'] })).toThrow(/Invalid filename/);
    });

    it('rejects exact-traversal `.` and `..`', () => {
      expect(() => assertSafeFilename('.', { extensions: ['.png'] })).toThrow(/Invalid filename/);
      expect(() => assertSafeFilename('..', { extensions: ['.png'] })).toThrow(/Invalid filename/);
    });

    it('rejects null bytes', () => {
      expect(() => assertSafeFilename('foo\0.png', { extensions: ['.png'] })).toThrow(/Invalid filename/);
    });

    it('rejects empty or non-string inputs', () => {
      expect(() => assertSafeFilename('', { extensions: ['.png'] })).toThrow(/Filename required/);
      expect(() => assertSafeFilename(undefined, { extensions: ['.png'] })).toThrow(/Filename required/);
      expect(() => assertSafeFilename(null, { extensions: ['.png'] })).toThrow(/Filename required/);
    });

    it('rejects unrecognized extensions', () => {
      expect(() => assertSafeFilename('foo.jpg', { extensions: ['.png'] })).toThrow(/Invalid filename/);
      expect(() => assertSafeFilename('foo.exe', { extensions: ['.png', '.gif'] })).toThrow(/Invalid filename/);
    });

    it('uses subject in error messages', () => {
      expect(() => assertSafeFilename('', { extensions: ['.safetensors'], subject: 'LoRA filename' }))
        .toThrow(/LoRA filename required/);
      expect(() => assertSafeFilename('foo.jpg', { extensions: ['.safetensors'], subject: 'LoRA filename' }))
        .toThrow(/Invalid LoRA filename/);
    });

    it('throws on missing extensions option (programmer error, not user)', () => {
      expect(() => assertSafeFilename('foo.png', {})).toThrow(/extensions allowlist is required/);
      expect(() => assertSafeFilename('foo.png', { extensions: [] })).toThrow(/extensions allowlist is required/);
    });

    it('throws on extensions that do not start with a dot (programmer error)', () => {
      // Bare suffix like 'png' would also match 'not-an-imagepng' if we didn't
      // enforce the leading-dot rule — that's a serious validation hole.
      expect(() => assertSafeFilename('foo.png', { extensions: ['png'] }))
        .toThrow(/each extension must be a non-empty string starting with/);
      expect(() => assertSafeFilename('foo.png', { extensions: ['.png', 'jpg'] }))
        .toThrow(/each extension must be a non-empty string starting with/);
      expect(() => assertSafeFilename('foo.png', { extensions: [''] }))
        .toThrow(/each extension must be a non-empty string starting with/);
      expect(() => assertSafeFilename('foo.png', { extensions: ['.'] }))
        .toThrow(/each extension must be a non-empty string starting with/);
      expect(() => assertSafeFilename('foo.png', { extensions: [123] }))
        .toThrow(/each extension must be a non-empty string starting with/);
    });

    it('honors requiredMessage override for the missing-input case only', () => {
      // Backward-compat path: wrappers that used to throw a fixed phrase
      // (e.g. "Filename required" / "Invalid filename") can preserve that
      // message without affecting the invalid-input message.
      expect(() => assertSafeFilename('', {
        extensions: ['.safetensors'],
        subject: 'LoRA filename',
        requiredMessage: 'Filename required',
      })).toThrow(/^Filename required$/);
      // Invalid path still uses the subject-derived message.
      expect(() => assertSafeFilename('foo.jpg', {
        extensions: ['.safetensors'],
        subject: 'LoRA filename',
        requiredMessage: 'Filename required',
      })).toThrow(/^Invalid LoRA filename$/);
    });

    it('attaches 400 status + VALIDATION_ERROR code on the thrown ServerError', () => {
      try {
        assertSafeFilename('bad/path.png', { extensions: ['.png'] });
        throw new Error('Expected assertion to throw');
      } catch (err) {
        expect(err.status).toBe(400);
        expect(err.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('listDirectoryByExtension', () => {
    const tmpRoot = join(tmpdir(), `portos-listdir-test-${process.pid}-${Date.now()}`);

    beforeEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      await mkdir(tmpRoot, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    });

    it('returns [] when the directory does not exist', async () => {
      const res = await listDirectoryByExtension(join(tmpRoot, 'missing'), {
        extensions: ['.png'],
        mapEntry: (n) => ({ filename: n }),
      });
      expect(res).toEqual([]);
    });

    it('filters by extension (case-insensitive) and maps survivors', async () => {
      await writeFile(join(tmpRoot, 'a.png'), 'a');
      await writeFile(join(tmpRoot, 'b.PNG'), 'b');
      await writeFile(join(tmpRoot, 'c.jpg'), 'c');
      const res = await listDirectoryByExtension(tmpRoot, {
        extensions: ['.png'],
        mapEntry: (name, _full, s) => ({ name, sizeBytes: s.size }),
      });
      const names = res.map((r) => r.name).sort();
      expect(names).toEqual(['a.png', 'b.PNG']);
    });

    it('drops directories when requireRegularFile is true (default)', async () => {
      await writeFile(join(tmpRoot, 'real.safetensors'), 'data');
      await mkdir(join(tmpRoot, 'fake.safetensors'));
      const res = await listDirectoryByExtension(tmpRoot, {
        extensions: ['.safetensors'],
        mapEntry: (name) => ({ name }),
      });
      expect(res).toEqual([{ name: 'real.safetensors' }]);
    });

    it('keeps directories when requireRegularFile is false (gallery legacy)', async () => {
      await writeFile(join(tmpRoot, 'real.png'), 'data');
      await mkdir(join(tmpRoot, 'fake.png'));
      const res = await listDirectoryByExtension(tmpRoot, {
        extensions: ['.png'],
        requireRegularFile: false,
        mapEntry: (name) => ({ name }),
      });
      const names = res.map((r) => r.name).sort();
      expect(names).toEqual(['fake.png', 'real.png']);
    });

    it('drops entries whose mapEntry returns null', async () => {
      await writeFile(join(tmpRoot, 'a.json'), 'a');
      await writeFile(join(tmpRoot, 'b.json'), 'b');
      const res = await listDirectoryByExtension(tmpRoot, {
        extensions: ['.json'],
        mapEntry: (name) => (name === 'a.json' ? null : { name }),
      });
      expect(res).toEqual([{ name: 'b.json' }]);
    });

    it('throws if extensions is missing or empty', async () => {
      await expect(
        listDirectoryByExtension(tmpRoot, { mapEntry: (n) => n }),
      ).rejects.toThrow(/extensions allowlist/);
      await expect(
        listDirectoryByExtension(tmpRoot, { extensions: [], mapEntry: (n) => n }),
      ).rejects.toThrow(/extensions allowlist/);
    });

    it('throws if mapEntry is not a function', async () => {
      await expect(
        listDirectoryByExtension(tmpRoot, { extensions: ['.png'] }),
      ).rejects.toThrow(/mapEntry must be a function/);
    });
  });
});
