import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { readFile, writeFile, rm, mkdir } from 'fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as fsPromises from 'fs/promises';

// Every wrapped fs/promises function delegates to the real implementation by default;
// individual tests override with `mockRejectedValueOnce` etc. (see fileUtils.testFixtures.js).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdir: vi.fn((...args) => actual.mkdir(...args)),
    open: vi.fn((...args) => actual.open(...args)),
    readFile: vi.fn((...args) => actual.readFile(...args)),
    rename: vi.fn((...args) => actual.rename(...args)),
    writeFile: vi.fn((...args) => actual.writeFile(...args)),
    chmod: vi.fn((...args) => actual.chmod(...args)),
    readdir: vi.fn((...args) => actual.readdir(...args)),
    stat: vi.fn((...args) => actual.stat(...args)),
  };
});

import { safeJSONParse, tryReadFile, tryReadFileStrict, readFileTail, readJSONFileStrict, readJSONFile, safeJSONLParse, readJSONLFile, appendJSONLine, readJSONLines, writeJSONLines } from './jsonIo.js';
import { withUnreadableFile, loadRealFsPromises } from './fileUtils.testFixtures.js';

beforeAll(loadRealFsPromises);

describe('fileUtils', () => {
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

    it('should still reject a root array under allowArray: false when defaultValue is not an array', () => {
      const result = safeJSONParse('["a", "b"]', { fallback: true }, { allowArray: false });
      expect(result).toEqual({ fallback: true });
    });

    it('should parse a top-level scalar string', () => {
      expect(safeJSONParse('"hello"', null)).toBe('hello');
    });

    it('should parse a top-level scalar number', () => {
      expect(safeJSONParse('123', null)).toBe(123);
    });

    it('should parse a top-level scalar boolean', () => {
      expect(safeJSONParse('true', null)).toBe(true);
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

    it('returns the array default when an array-defaulted file holds an object root', async () => {
      // Regression guard: every array-defaulted caller in-tree goes straight to
      // .filter/.find on the result (services/review.js#getItems,
      // services/videoGen/local.js, routes/videoGen.js), so handing back a parsed
      // object root would TypeError a request that used to degrade to an empty list.
      const filePath = join(testDir, 'object-root.json');
      await writeFile(filePath, '{"a":1}');

      expect(await readJSONFile(filePath, [])).toEqual([]);
    });

    it('returns the caller’s array default for garbage, not a manufactured []', async () => {
      // The noisy-output extraction used to manufacture a literal '[]' from text
      // holding no array, so a non-empty array default was silently replaced by an
      // empty one. The documented contract is "default value if the file is
      // invalid" — every in-tree caller passes `[]`, where the two agree.
      const filePath = join(testDir, 'garbage.json');
      await writeFile(filePath, 'not json at all');

      expect(await readJSONFile(filePath, ['fallback'])).toEqual(['fallback']);
    });

    it('still extracts an array out of noisy output (pm2 jlist with ANSI codes)', async () => {
      // Real ANSI output leads with ESC, not '[' — the extraction is deliberately
      // skipped for text already starting with '[' (it would be self-defeating on a
      // genuine JSON array), so `\x1b` here is load-bearing, not decoration.
      const filePath = join(testDir, 'noisy.json');
      await writeFile(filePath, '\x1b[31mwarn\x1b[0m [{"pid":1}]');

      expect(await readJSONFile(filePath, [])).toEqual([{ pid: 1 }]);
    });
  });

  // #2726: `readJSONFile` collapses "absent", "unreadable", and "corrupt" into the
  // same default, so a caller counting records can't tell a real empty from a failed
  // read and reports a fake 0. These pin the distinction the strict variant restores.
  describe('readJSONFileStrict', () => {
    const testDir = join(tmpdir(), 'fileutils-strict-test-' + Date.now());
    let warnSpy;

    beforeEach(async () => {
      await mkdir(testDir, { recursive: true });
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(async () => {
      warnSpy.mockRestore();
      await rm(testDir, { recursive: true, force: true });
    });

    const eacces = () => Object.assign(new Error('permission denied'), { code: 'EACCES' });

    it('reports ENOENT as a TRUSTWORTHY empty — absent is not a failure', async () => {
      const result = await readJSONFileStrict(join(testDir, 'never-written.json'), { sessions: [] });
      expect(result).toEqual({ ok: true, value: { sessions: [] } });
    });

    it('does not log for a genuinely absent file', async () => {
      await readJSONFileStrict(join(testDir, 'never-written.json'), []);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('reports EACCES as NOT ok — an unreadable file is not an empty one', async () => {
      const filePath = join(testDir, 'locked.json');
      await writeFile(filePath, '{"sessions": [{"id": "s1"}]}');

      const result = await withUnreadableFile(eacces(), () => readJSONFileStrict(filePath, { sessions: [] }));
      // `value` still carries the default so an ok-indifferent caller behaves as
      // before; `ok: false` is what makes the failure legible.
      expect(result).toEqual({ ok: false, value: { sessions: [] } });
    });

    it('reports a real non-ENOENT errno as NOT ok (reading a directory → EISDIR)', async () => {
      // Unmocked, no synthetic errno: proves the classification keys off "not
      // ENOENT" rather than a hard-coded list the real world can step outside of.
      const result = await readJSONFileStrict(testDir, []);
      expect(result.ok).toBe(false);
    });

    it('reports malformed JSON as NOT ok — corrupt bytes are not an empty collection', async () => {
      const filePath = join(testDir, 'corrupt.json');
      await writeFile(filePath, '{"incomplete":');

      expect(await readJSONFileStrict(filePath, { fallback: true }))
        .toEqual({ ok: false, value: { fallback: true } });
    });

    it('reports a truncated (empty) file as NOT ok', async () => {
      const filePath = join(testDir, 'empty.json');
      await writeFile(filePath, '');

      expect((await readJSONFileStrict(filePath, [])).ok).toBe(false);
    });

    it('reports a parsed file as ok with its value', async () => {
      const filePath = join(testDir, 'valid.json');
      await writeFile(filePath, '{"sessions": [{"id": "s1"}]}');

      expect(await readJSONFileStrict(filePath, { sessions: [] }))
        .toEqual({ ok: true, value: { sessions: [{ id: 's1' }] } });
    });

    it('reports a legitimately empty collection as ok — the whole point', async () => {
      const filePath = join(testDir, 'empty-list.json');
      await writeFile(filePath, '[]');

      expect(await readJSONFileStrict(filePath, ['fallback'])).toEqual({ ok: true, value: [] });
    });

    it('distinguishes a file that legitimately CONTAINS the default from a failed read', async () => {
      const filePath = join(testDir, 'same-as-default.json');
      await writeFile(filePath, '{"sessions":[]}');

      // Both return the same `value`; only `ok` tells them apart — which is why the
      // parse sentinel can't be an in-band marker like null.
      expect(await readJSONFileStrict(filePath, { sessions: [] })).toEqual({ ok: true, value: { sessions: [] } });
      expect(await withUnreadableFile(eacces(), () => readJSONFileStrict(filePath, { sessions: [] })))
        .toEqual({ ok: false, value: { sessions: [] } });
    });

    it('keeps readJSONFile’s noisy-output extraction for array defaults', async () => {
      // safeJSONParse keys extraction off `Array.isArray(defaultValue)`, and the
      // strict path passes a non-array sentinel as its fallback — so this pins that
      // the extraction still runs against the caller's real default (pm2 jlist).
      const filePath = join(testDir, 'noisy.json');
      await writeFile(filePath, '\x1b[31mwarning\x1b[0m [{"id":1}]');

      expect(await readJSONFileStrict(filePath, [])).toEqual({ ok: true, value: [{ id: 1 }] });
    });

    it('reports an object root as NOT ok when the caller declared an array default', async () => {
      // The array default is a declared shape expectation — a strict caller counting
      // a list must refuse an object it cannot count, rather than trusting it.
      const filePath = join(testDir, 'object-root.json');
      await writeFile(filePath, '{"sessions":[1,2]}');

      expect(await readJSONFileStrict(filePath, [])).toEqual({ ok: false, value: [] });
    });

    it('does NOT manufacture a trustworthy empty from noise holding no array', async () => {
      // extractJSONArray returns a literal '[]' when it finds nothing, which parses
      // cleanly — an array-defaulted strict read would otherwise report corrupt bytes
      // as `ok: true, value: []`, silently un-stricting itself.
      const filePath = join(testDir, 'garbage.json');
      await writeFile(filePath, 'not json at all');

      expect(await readJSONFileStrict(filePath, [])).toEqual({ ok: false, value: [] });
    });

    it('honours allowArray: false', async () => {
      const filePath = join(testDir, 'array.json');
      await writeFile(filePath, '[1, 2, 3]');

      expect(await readJSONFileStrict(filePath, {}, { allowArray: false }))
        .toEqual({ ok: false, value: {} });
    });

    it('stays silent when logError is false', async () => {
      const filePath = join(testDir, 'corrupt.json');
      await writeFile(filePath, '{"incomplete":');
      await readJSONFileStrict(filePath, {}, { logError: false });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // #4115: `tryReadFile` had the same absent-vs-unreadable conflation as
  // `readJSONFile` (a bare `.catch(() => null)`) but no strict counterpart at all.
  // These pin the three-state contract for the raw-bytes variant.
  describe('tryReadFileStrict', () => {
    const testDir = join(tmpdir(), 'fileutils-tryreadstrict-test-' + Date.now());

    beforeEach(async () => {
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    const eacces = () => Object.assign(new Error('permission denied'), { code: 'EACCES' });

    it('reports ENOENT as a TRUSTWORTHY absence', async () => {
      expect(await tryReadFileStrict(join(testDir, 'never-written.txt')))
        .toEqual({ ok: true, value: null });
    });

    it('reports EACCES as NOT ok — an unreadable file is not an absent one', async () => {
      const filePath = join(testDir, 'locked.txt');
      await writeFile(filePath, 'real contents');

      expect(await withUnreadableFile(eacces(), () => tryReadFileStrict(filePath)))
        .toEqual({ ok: false, value: null });
    });

    it('reports a real non-ENOENT errno as NOT ok (reading a directory → EISDIR)', async () => {
      // Unmocked, no synthetic errno: proves the classification keys off "not
      // ENOENT" rather than a hard-coded list the real world can step outside of.
      expect((await tryReadFileStrict(testDir)).ok).toBe(false);
    });

    it('returns the contents with ok when the read succeeds', async () => {
      const filePath = join(testDir, 'present.txt');
      await writeFile(filePath, 'hello');

      expect(await tryReadFileStrict(filePath)).toEqual({ ok: true, value: 'hello' });
    });

    it('keeps an EMPTY file distinguishable from an absent one', async () => {
      const filePath = join(testDir, 'empty.txt');
      await writeFile(filePath, '');

      expect(await tryReadFileStrict(filePath)).toEqual({ ok: true, value: '' });
      expect(await tryReadFileStrict(join(testDir, 'gone.txt'))).toEqual({ ok: true, value: null });
    });

    it('honours a null encoding and returns a Buffer', async () => {
      const filePath = join(testDir, 'bytes.bin');
      await writeFile(filePath, Buffer.from([0x00, 0x01, 0xff]));

      const { ok, value } = await tryReadFileStrict(filePath, null);
      expect(ok).toBe(true);
      expect(Buffer.isBuffer(value)).toBe(true);
      expect([...value]).toEqual([0x00, 0x01, 0xff]);
    });

    it('matches tryReadFile on the value for every non-error case', async () => {
      const filePath = join(testDir, 'parity.txt');
      await writeFile(filePath, 'same bytes');

      expect((await tryReadFileStrict(filePath)).value).toBe(await tryReadFile(filePath));
      expect((await tryReadFileStrict(join(testDir, 'nope.txt'))).value).toBe(await tryReadFile(join(testDir, 'nope.txt')));
    });
  });

  // The `strict` option is the same classification, surfaced as a throw — the shape
  // the Character signal readers need, since a rejection is how every DB-backed
  // getter already reports failure (#2726).
  describe('readJSONFile with { strict: true }', () => {
    const testDir = join(tmpdir(), 'fileutils-strictopt-test-' + Date.now());
    let warnSpy;

    beforeEach(async () => {
      await mkdir(testDir, { recursive: true });
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(async () => {
      warnSpy.mockRestore();
      await rm(testDir, { recursive: true, force: true });
    });

    it('returns the default for an absent file — strict does not mean paranoid', async () => {
      const result = await readJSONFile(join(testDir, 'never-written.json'), { sessions: [] }, { strict: true });
      expect(result).toEqual({ sessions: [] });
    });

    it('throws for an unreadable file instead of returning a fake empty', async () => {
      const filePath = join(testDir, 'locked.json');
      await writeFile(filePath, '{"sessions": []}');
      const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });

      await withUnreadableFile(eacces, () => expect(readJSONFile(filePath, { sessions: [] }, { strict: true }))
        .rejects.toThrow(/Unreadable JSON file/));
    });

    it('throws for corrupt JSON', async () => {
      const filePath = join(testDir, 'corrupt.json');
      await writeFile(filePath, 'not json at all');

      await expect(readJSONFile(filePath, [], { strict: true })).rejects.toMatchObject({
        message: expect.stringMatching(/Unreadable JSON file/),
        status: 500,
        code: 'UNREADABLE_STORE',
        responseMessage: 'Durable data store is unreadable',
      });
    });

    it('returns the parsed value when the read succeeds', async () => {
      const filePath = join(testDir, 'valid.json');
      await writeFile(filePath, '{"sessions":[{"id":"s1"}]}');

      expect(await readJSONFile(filePath, { sessions: [] }, { strict: true }))
        .toEqual({ sessions: [{ id: 's1' }] });
    });

    it('leaves every existing (non-strict) caller swallowing exactly as before', async () => {
      const filePath = join(testDir, 'corrupt.json');
      await writeFile(filePath, '{"incomplete":');

      expect(await readJSONFile(filePath, { fallback: true })).toEqual({ fallback: true });
      fsPromises.readFile.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'EACCES' }));
      expect(await readJSONFile(filePath, { fallback: true })).toEqual({ fallback: true });
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

  describe('JSONL write helpers', () => {
    let testDir;

    beforeEach(async () => {
      testDir = mkdtempSync(join(tmpdir(), 'fileutils-jsonl-write-test-'));
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it('appendJSONLine creates parent dirs and appends one record per line', async () => {
      const filePath = join(testDir, 'nested', 'events.jsonl');
      await appendJSONLine(filePath, { id: 'a', n: 1 });
      await appendJSONLine(filePath, { id: 'b', n: 2 });

      expect(await readFile(filePath, 'utf-8')).toBe('{"id":"a","n":1}\n{"id":"b","n":2}\n');
      expect(await readJSONLines(filePath)).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
    });

    it('readJSONLines supports offset and limit', async () => {
      const filePath = join(testDir, 'events.jsonl');
      await writeFile(filePath, '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');

      expect(await readJSONLines(filePath, { from: 1, limit: 1 })).toEqual([{ id: 'b' }]);
      expect(await readJSONLines(filePath, { from: 2 })).toEqual([{ id: 'c' }]);
      expect(await readJSONLines(filePath, { limit: 0 })).toEqual([]);
    });

    it('writeJSONLines atomically replaces the file', async () => {
      const filePath = join(testDir, 'events.jsonl');
      await appendJSONLine(filePath, { id: 'old' });
      await writeJSONLines(filePath, [{ id: 'new-1' }, { id: 'new-2' }]);

      expect(await readFile(filePath, 'utf-8')).toBe('{"id":"new-1"}\n{"id":"new-2"}\n');
      expect(await readJSONLines(filePath)).toEqual([{ id: 'new-1' }, { id: 'new-2' }]);
    });

    it('rejects non-serializable values', async () => {
      await expect(appendJSONLine(join(testDir, 'bad.jsonl'), undefined))
        .rejects.toThrow(/JSON-serializable/);
      await expect(writeJSONLines(join(testDir, 'bad.jsonl'), [undefined]))
        .rejects.toThrow(/JSON-serializable/);
    });
  });

  describe('readFileTail', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'portos-tail-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('returns null for a missing file so it stays distinct from an empty one', async () => {
      expect(await readFileTail(join(dir, 'nope.txt'), 1024)).toBeNull();
    });

    it('returns an empty string for a zero-byte file', async () => {
      const p = join(dir, 'empty.txt');
      writeFileSync(p, '');
      expect(await readFileTail(p, 1024)).toBe('');
    });

    it('returns the whole file when it fits under maxBytes', async () => {
      const p = join(dir, 'small.txt');
      writeFileSync(p, 'hello');
      expect(await readFileTail(p, 1024)).toBe('hello');
    });

    it('returns only the trailing window when the file is larger than maxBytes', async () => {
      const p = join(dir, 'big.txt');
      writeFileSync(p, 'abcdefghij');
      expect(await readFileTail(p, 4)).toBe('ghij');
    });

    it('does not load the whole file for a multi-MB log', async () => {
      const p = join(dir, 'huge.log');
      writeFileSync(p, Buffer.alloc(4 * 1024 * 1024, 0x61));
      const tail = await readFileTail(p, 128);
      expect(tail).toHaveLength(128);
    });
  });
});
