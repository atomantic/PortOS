import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { readFile, writeFile, rm, mkdir } from 'fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { createHash } from 'crypto';
import * as fsPromises from 'fs/promises';
// Mock fs/promises so the `ensureDir` regression test can force `mkdir` to
// throw a spurious Windows error, and the readJSONFileStrict tests can force a
// specific `readFile` errno (EACCES can't be provoked portably — chmod 000 is a
// no-op for root, which is how the container CI runs). Both default to delegating
// to the real implementation (so every other test in this file is unaffected);
// individual tests override with `mockRejectedValueOnce`.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdir: vi.fn((...args) => actual.mkdir(...args)),
    readFile: vi.fn((...args) => actual.readFile(...args)),
  };
});
import {
  assertSafeFilename,
  atomicWrite,
  ensureDir,
  pathExists,
  expandHome,
  isValidJSON,
  listDirectoryByExtension,
  safeJSONParse,
  safeJSONLParse,
  createCachedStore,
  readJSONFile,
  readJSONFileStrict,
  readJSONLFile,
  appendJSONLine,
  readJSONLines,
  writeJSONLines,
  formatDuration,
  sha256File,
  resolveImageInputPath,
  resolveScreenshot,
  isPathInsideDir,
  PATHS,
  sanitizeFilename,
  getFileExtension,
  getMimeType,
  detectImageFormat,
  EXTENSION_MIME_MAP,
  ATTACHMENT_ALLOWED_EXTENSIONS,
  SONGBOOK_ATTACHMENT_EXTENSIONS,
  saveBase64Upload,
  serveLocalFile,
  loadSlashdoLib,
  loadSlashdoFile,
} from './fileUtils.js';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname_test = dirname(fileURLToPath(import.meta.url));

describe('fileUtils', () => {
  // Regression guard for the CoS review-loop bug: PortOS inlines slashdo lib
  // markdown into headless CoS-agent prompts WITHOUT going through slashdo's
  // own per-environment installer, so it must resolve the `<!-- if:teams -->`
  // conditionals itself. Leaving both branches in shipped a self-contradictory
  // reviewer spec (in-process Agent tool AND `claude -p`) to a codex agent,
  // which then improvised its own `claude` invocation via a dozen probe calls.
  describe('loadSlashdoLib', () => {
    it('resolves if:teams conditionals to the non-teams (subprocess) branch by default', async () => {
      const body = await loadSlashdoLib('local-agent-review-loop');
      expect(body).toBeTruthy();
      // No conditional markers survive — both branches must be resolved, not inlined.
      expect(body).not.toMatch(/<!--\s*(if:|else|\/if:)/);
      // The subprocess reviewer invocation (else branch) is present…
      expect(body).toContain('claude -p "$LOCAL_PROMPT"');
      // …and the Claude-Code-only in-process Agent-tool branch is stripped.
      expect(body).not.toMatch(/in-process sub-agent via the .?Agent.? tool/i);
    });

    it('keeps the teams (in-process Agent-tool) branch when teams=true', async () => {
      const body = await loadSlashdoLib('local-agent-review-loop', { teams: true });
      expect(body).toBeTruthy();
      expect(body).not.toMatch(/<!--\s*(if:|else|\/if:)/);
      expect(body).toMatch(/in-process sub-agent via the .?Agent.? tool/i);
    });

    it('returns null for a lib file that does not exist', async () => {
      expect(await loadSlashdoLib('no-such-lib-file-xyz')).toBeNull();
    });
  });

  describe('loadSlashdoFile', () => {
    // `better.md` ships both `if:teams` conditional blocks and `!`cat`` includes
    // of shell-heavy lib files, and is reachable as a user-dispatched CoS command
    // — so it exercises both fixes below.
    it('resolves if:teams conditionals in a command body (not just libs)', async () => {
      const body = await loadSlashdoFile('better');
      expect(body).toBeTruthy();
      expect(body).not.toMatch(/<!--\s*(if:|else|\/if:)/);
    });

    it('inlines lib includes literally — no $-token blowup or corruption', async () => {
      const body = await loadSlashdoFile('better');
      // A bare-string String.replace would interpret `$\``/`$'` tokens in the
      // shell-heavy libs and splice the pre-match content in, ballooning a ~66KB
      // command past 2MB. The function-form replacer keeps it near the sum of the
      // raw sizes (~240KB) and preserves `$`-tokens verbatim.
      expect(body.length).toBeLessThan(600_000);
      expect(body).toContain('$LOCAL_PROMPT');
    });
  });

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
      fsPromises.readFile.mockRejectedValueOnce(eacces());

      const result = await readJSONFileStrict(filePath, { sessions: [] });
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
      fsPromises.readFile.mockRejectedValueOnce(eacces());
      expect(await readJSONFileStrict(filePath, { sessions: [] })).toEqual({ ok: false, value: { sessions: [] } });
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
      fsPromises.readFile.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

      await expect(readJSONFile(filePath, { sessions: [] }, { strict: true }))
        .rejects.toThrow(/Unreadable JSON file/);
    });

    it('throws for corrupt JSON', async () => {
      const filePath = join(testDir, 'corrupt.json');
      await writeFile(filePath, 'not json at all');

      await expect(readJSONFile(filePath, [], { strict: true })).rejects.toThrow(/Unreadable JSON file/);
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

  describe('pathExists', () => {
    const tmpRoot = join(tmpdir(), `fileutils-pathexists-${process.pid}-${Date.now()}`);

    beforeEach(() => mkdir(tmpRoot, { recursive: true }));
    afterEach(() => rm(tmpRoot, { recursive: true, force: true }));

    it('resolves true for an existing file', async () => {
      const f = join(tmpRoot, 'present.txt');
      await writeFile(f, 'hi');
      expect(await pathExists(f)).toBe(true);
    });

    it('resolves true for an existing directory', async () => {
      expect(await pathExists(tmpRoot)).toBe(true);
    });

    it('resolves false for a missing path without throwing', async () => {
      expect(await pathExists(join(tmpRoot, 'nope.txt'))).toBe(false);
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

  describe('isPathInsideDir', () => {
    it('accepts a file directly inside the directory', () => {
      expect(isPathInsideDir('/data/uploads', '/data/uploads/foo.png')).toBe(true);
      expect(isPathInsideDir('/data/uploads', '/data/uploads/sub/foo.png')).toBe(true);
    });

    it('rejects a traversal that escapes the directory', () => {
      expect(isPathInsideDir('/data/uploads', '/data/uploads/../etc/passwd')).toBe(false);
      expect(isPathInsideDir('/data/uploads', '/etc/passwd')).toBe(false);
    });

    it('rejects a sibling dir whose name merely starts with the root (the trailing-sep bug)', () => {
      // The old `startsWith(DIR)` check without a trailing separator let
      // `/data/uploads-evil/x` slip through because the string prefix matched.
      expect(isPathInsideDir('/data/uploads', '/data/uploads-evil/x.png')).toBe(false);
    });

    it('rejects the root itself (no trailing separator on the bare root)', () => {
      expect(isPathInsideDir('/data/uploads', '/data/uploads')).toBe(false);
    });

    it('returns false for non-string / empty inputs', () => {
      expect(isPathInsideDir('/data/uploads', '')).toBe(false);
      expect(isPathInsideDir('', '/data/uploads/foo.png')).toBe(false);
      expect(isPathInsideDir(null, undefined)).toBe(false);
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

  // CONVENTION: this block writes fixtures into the REAL `data/images`,
  // `data/image-refs`, and `data/templates` roots because `PATHS` is module-
  // evaluated and not easily overridable. Two rules to keep dev/CI worktrees
  // clean and avoid clobbering shipped assets:
  //   1. Every fixture name MUST start with the `fileutils-test-` prefix so
  //      the cleanup below can target it unambiguously (and so the basenames
  //      don't shadow any real asset the resolver would otherwise find).
  //   2. Cleanup goes in `afterAll`, NOT a recursive remove of the root —
  //      the data/ roots hold the user's universe content and shipped templates.
  describe('resolveImageInputPath', () => {
    const sampleTemplate = join(__dirname_test, '..', '..', 'data.reference', 'templates', 'character-reference-sheet.png');
    const galleryName = 'fileutils-test-gallery.png';
    const refsName = 'fileutils-test-refs.png';
    const templateName = 'fileutils-test-template.png';
    const galleryPath = join(PATHS.images, galleryName);
    const refsPath = join(PATHS.imageRefs, refsName);
    const templatePath = join(PATHS.visualTemplates, templateName);

    beforeEach(() => {
      // Provision fixtures in each approved root so the resolver can find
      // them. Reuses the shipped sample asset as a stand-in PNG body.
      for (const root of [PATHS.images, PATHS.imageRefs, PATHS.visualTemplates]) {
        if (!existsSync(root)) mkdirSync(root, { recursive: true });
      }
      if (existsSync(sampleTemplate)) {
        if (!existsSync(galleryPath)) copyFileSync(sampleTemplate, galleryPath);
        if (!existsSync(refsPath)) copyFileSync(sampleTemplate, refsPath);
        if (!existsSync(templatePath)) copyFileSync(sampleTemplate, templatePath);
      }
    });

    afterAll(() => {
      // Remove ONLY the per-test fixture files (uniquely-named so dev/CI
      // worktrees aren't polluted and later basename lookups don't keep
      // finding stale resolver hits). Never recursively remove the real
      // `data/images` / `data/image-refs` / `data/templates` roots.
      for (const p of [galleryPath, refsPath, templatePath]) {
        if (existsSync(p)) rmSync(p, { force: true });
      }
    });

    it('returns null for non-string / empty input', () => {
      expect(resolveImageInputPath(null)).toBeNull();
      expect(resolveImageInputPath('')).toBeNull();
      expect(resolveImageInputPath(undefined)).toBeNull();
      expect(resolveImageInputPath(123)).toBeNull();
    });

    it('resolves a basename present in the gallery (first root)', () => {
      const out = resolveImageInputPath(galleryName);
      expect(out).toBeTruthy();
      expect(out).toContain('data/images/');
      expect(out).toContain(galleryName);
    });

    it('resolves a basename present only in image-refs', () => {
      const out = resolveImageInputPath(refsName);
      expect(out).toBeTruthy();
      expect(out).toContain('data/image-refs/');
    });

    it('resolves a basename present only in visualTemplates', () => {
      const out = resolveImageInputPath(templateName);
      // `templateName` is unique to the visualTemplates root (it is NOT copied
      // into gallery or image-refs), so the resolver must land on the third
      // root and the returned path must carry that root's segment + basename —
      // a plain truthiness check would pass even on a wrong-root resolution.
      expect(out).toContain('data/templates/');
      expect(out).toContain(templateName);
    });

    it('REGRESSION: absolute path under a specific root stays in that root', () => {
      // Bug it guards: previously the resolver basenamed any input and tried
      // each root in order — so `/data/templates/<name>.png` for a file that
      // also exists in `/data/images/<name>.png` would silently redirect to
      // the gallery copy. Reference-sheet renders would have used the wrong
      // init image. Verify each absolute path resolves to its own root.
      const galleryAbs = join(PATHS.images, galleryName);
      const refsAbs = join(PATHS.imageRefs, refsName);
      const templateAbs = join(PATHS.visualTemplates, templateName);

      expect(resolveImageInputPath(galleryAbs)).toContain('data/images/');
      expect(resolveImageInputPath(refsAbs)).toContain('data/image-refs/');
      expect(resolveImageInputPath(templateAbs)).toContain('data/templates/');
    });

    it('REGRESSION: same basename in multiple roots — absolute path picks the matching root', () => {
      // All three fixtures share the same body (copied from sampleTemplate),
      // but the absolute path should pin to its own root, NOT collapse to
      // the gallery via basename fallback.
      const refsAbs = join(PATHS.imageRefs, refsName);
      const out = resolveImageInputPath(refsAbs);
      expect(out).toContain('data/image-refs/');
      expect(out).not.toContain('data/images/');
    });
  });

  describe('resolveScreenshot', () => {
    const sampleTemplate = join(__dirname_test, '..', '..', 'data.reference', 'templates', 'character-reference-sheet.png');
    const shotName = 'fileutils-test-screenshot.png';
    const shotPath = join(PATHS.screenshots, shotName);

    beforeEach(() => {
      if (!existsSync(PATHS.screenshots)) mkdirSync(PATHS.screenshots, { recursive: true });
      if (existsSync(sampleTemplate) && !existsSync(shotPath)) copyFileSync(sampleTemplate, shotPath);
    });

    afterAll(() => {
      // Remove ONLY the uniquely-named fixture — never the real screenshots root.
      if (existsSync(shotPath)) rmSync(shotPath, { force: true });
    });

    it('resolves a basename present under the screenshots root', () => {
      const out = resolveScreenshot(shotName);
      expect(out).toBeTruthy();
      expect(out).toContain('data/screenshots/');
      expect(out).toContain(shotName);
    });

    it('SECURITY: rejects parent-directory traversal that escapes the screenshots root', () => {
      // `loadImageAsBase64` (issue #1820) fed `imagePath` straight from req.body;
      // a `../` payload must NOT resolve to a file outside data/screenshots.
      expect(resolveScreenshot('../../etc/passwd')).toBeNull();
      expect(resolveScreenshot('../package.json')).toBeNull();
    });

    it('SECURITY: rejects an absolute path outside the screenshots root', () => {
      expect(resolveScreenshot('/etc/passwd')).toBeNull();
      expect(resolveScreenshot('/etc/hosts')).toBeNull();
    });

    it('rejects non-image extensions and missing files', () => {
      expect(resolveScreenshot('notes.txt')).toBeNull();
      expect(resolveScreenshot('does-not-exist.png')).toBeNull();
    });

    it('returns null for non-string / empty input', () => {
      expect(resolveScreenshot(null)).toBeNull();
      expect(resolveScreenshot('')).toBeNull();
      expect(resolveScreenshot(undefined)).toBeNull();
    });
  });

  describe('sha256File', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'portos-sha256-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('hashes a small file in one shot and matches createHash digest', async () => {
      const p = join(dir, 'small.bin');
      writeFileSync(p, 'hello world');
      const expected = createHash('sha256').update('hello world').digest('hex');
      expect(await sha256File(p)).toBe(expected);
    });

    it('hashes a large file via streaming (>= 512KB)', async () => {
      const p = join(dir, 'big.bin');
      const buf = Buffer.alloc(600 * 1024, 0x42);
      writeFileSync(p, buf);
      const expected = createHash('sha256').update(buf).digest('hex');
      expect(await sha256File(p)).toBe(expected);
    });

    it('returns identical digests for identical content under different paths', async () => {
      const a = join(dir, 'a.bin'); const b = join(dir, 'b.bin');
      writeFileSync(a, 'same-content');
      writeFileSync(b, 'same-content');
      expect(await sha256File(a)).toBe(await sha256File(b));
    });

    it('returns different digests for different content', async () => {
      const a = join(dir, 'a.bin'); const b = join(dir, 'b.bin');
      writeFileSync(a, 'one');
      writeFileSync(b, 'two');
      expect(await sha256File(a)).not.toBe(await sha256File(b));
    });
  });

  describe('expandHome', () => {
    it('expands a bare `~` to the homedir', () => {
      expect(expandHome('~')).toBe(homedir());
    });

    it('expands `~/foo` to homedir + foo', () => {
      const out = expandHome('~/foo');
      expect(out.startsWith(homedir())).toBe(true);
      expect(out.endsWith('foo')).toBe(true);
    });

    it('expands the Windows form `~\\foo` so `lib/fileUtils.js` stays cross-platform', () => {
      const out = expandHome('~\\foo');
      expect(out.startsWith(homedir())).toBe(true);
      expect(out.endsWith('foo')).toBe(true);
    });

    it('preserves absolute, relative, and empty inputs', () => {
      expect(expandHome('/abs/path')).toBe('/abs/path');
      expect(expandHome('relative/path')).toBe('relative/path');
      expect(expandHome('')).toBe('');
    });

    it('preserves non-string inputs (null / undefined / number) without throwing', () => {
      expect(expandHome(null)).toBe(null);
      expect(expandHome(undefined)).toBe(undefined);
      expect(expandHome(42)).toBe(42);
    });

    it('only expands a leading `~` — embedded `~` chars are preserved (iCloud~md~obsidian)', () => {
      expect(expandHome('iCloud~md~obsidian')).toBe('iCloud~md~obsidian');
      expect(expandHome('foo/~bar')).toBe('foo/~bar');
    });
  });

  describe('ensureDir', () => {
    let tmpRoot;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'fileutils-ensuredir-'));
    });

    afterEach(() => {
      fsPromises.mkdir.mockClear();
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('creates a missing nested directory', async () => {
      const target = join(tmpRoot, 'a', 'b', 'c');
      await ensureDir(target);
      expect(existsSync(target)).toBe(true);
    });

    it('is idempotent — succeeds when the directory already exists', async () => {
      const target = join(tmpRoot, 'exists');
      await ensureDir(target);
      await expect(ensureDir(target)).resolves.toBeUndefined();
    });

    it('swallows a spurious Windows mkdir error when the dir already exists (regression)', async () => {
      const target = join(tmpRoot, 'preexisting');
      mkdirSync(target);
      // Simulate the Windows UNKNOWN/EPERM that fs.mkdir can throw even on an
      // existing directory (antivirus locks, OneDrive sync, mapped drives).
      const spurious = Object.assign(new Error('UNKNOWN: unknown error, mkdir'), { code: 'UNKNOWN' });
      fsPromises.mkdir.mockRejectedValueOnce(spurious);
      await expect(ensureDir(target)).resolves.toBeUndefined();
    });

    it('still rejects when mkdir fails and the path is not a directory afterward', async () => {
      const target = join(tmpRoot, 'never-created');
      const realFailure = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      fsPromises.mkdir.mockRejectedValueOnce(realFailure);
      await expect(ensureDir(target)).rejects.toThrow(/EACCES/);
    });
  });

  describe('atomicWrite', () => {
    let tmpRoot;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'fileutils-atomicwrite-'));
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('serializes a plain object with 2-space indentation', async () => {
      const target = join(tmpRoot, 'obj.json');
      await atomicWrite(target, { b: 2, a: 1 });
      expect(await readFile(target, 'utf8')).toBe('{\n  "b": 2,\n  "a": 1\n}');
    });

    it('writes a string payload verbatim (preserving a trailing newline)', async () => {
      const target = join(tmpRoot, 'raw.json');
      await atomicWrite(target, '{"x":1}\n');
      expect(await readFile(target, 'utf8')).toBe('{"x":1}\n');
    });

    it.skipIf(process.platform === 'win32')(
      'preserves the destination file\'s restrictive mode on rewrite (regression: #1837)',
      async () => {
        const target = join(tmpRoot, 'secret.json');
        // Seed a hand-restricted secret file (e.g. an OAuth tokens.json the user
        // chmod 600'd). The temp-write + rename must NOT widen it to the umask
        // default — a plain writeFile(existing) kept the inode's mode, and
        // atomicWrite mirrors that.
        writeFileSync(target, '{"token":"old"}', { mode: 0o600 });
        const { chmodSync } = await import('fs');
        chmodSync(target, 0o600); // ensure 600 regardless of umask at creation
        await atomicWrite(target, { token: 'new' });
        const { statSync } = await import('fs');
        expect(statSync(target).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ token: 'new' });
      }
    );

    it('creates a new file at the default mode when the destination does not exist', async () => {
      const target = join(tmpRoot, 'fresh.json');
      await atomicWrite(target, { created: true });
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ created: true });
    });

    it.skipIf(process.platform === 'win32')(
      'replaces a symlink target with a regular file rather than following it (design decision: #1893)',
      async () => {
        // Decision pinned by this test: temp+rename REPLACES the link, standard
        // atomic-write semantics — it does NOT follow the symlink to update the
        // backing file. Following would reintroduce the non-atomic in-place
        // truncate atomicWrite exists to avoid. See the JSDoc + issue #1893.
        const { symlinkSync, lstatSync } = await import('fs');
        const backing = join(tmpRoot, 'backing.json');
        const link = join(tmpRoot, 'link.json');
        writeFileSync(backing, '{"orig":true}');
        symlinkSync(backing, link);

        await atomicWrite(link, { replaced: true });

        // The link path is now a regular file holding the new content...
        expect(lstatSync(link).isSymbolicLink()).toBe(false);
        expect(JSON.parse(await readFile(link, 'utf8'))).toEqual({ replaced: true });
        // ...and the original backing file is untouched (link was not followed).
        expect(JSON.parse(await readFile(backing, 'utf8'))).toEqual({ orig: true });
      }
    );
  });
});

// =============================================================================
// createCachedStore — cached JSON store with serialized writes (#2539)
// =============================================================================

describe('createCachedStore', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cached-store-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the default when the file is absent, then round-trips a save', async () => {
    const store = createCachedStore(join(dir, 'x.json'), { n: 0 });
    expect(await store.load()).toEqual({ n: 0 });
    await store.save({ n: 5 });
    expect(await store.load()).toEqual({ n: 5 });
  });

  it('mutate persists the fn result and returns it', async () => {
    const store = createCachedStore(join(dir, 'x.json'), { n: 0 });
    const out = await store.mutate((data) => { data.n = 9; });
    expect(out).toEqual({ n: 9 });
    // Persisted to disk, not just cache
    expect(JSON.parse(await readFile(join(dir, 'x.json'), 'utf-8'))).toEqual({ n: 9 });
  });

  it('serializes concurrent read-modify-write so no update is lost', async () => {
    const file = join(dir, 'counter.json');
    const store = createCachedStore(file, { n: 0 }, { ttl: 0 });
    // ttl:0 forces every load to re-read from disk — the worst case for the
    // classic load→mutate→save clobber. Without serialization, N concurrent
    // increments race down to ~1; mutate() must land all N.
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, () => store.mutate(async (data) => {
        const current = data.n;
        await Promise.resolve(); // yield — invites interleaving
        data.n = current + 1;
      }))
    );
    expect((await store.load()).n).toBe(N);
    expect(JSON.parse(await readFile(file, 'utf-8')).n).toBe(N);
  });

  it('mutate that returns undefined persists the mutated input', async () => {
    const store = createCachedStore(join(dir, 'x.json'), { items: [] });
    await store.mutate((data) => { data.items.push('a'); });
    await store.mutate((data) => { data.items.push('b'); });
    expect((await store.load()).items).toEqual(['a', 'b']);
  });

  it('invalidateCache forces a re-read from disk', async () => {
    const file = join(dir, 'x.json');
    const store = createCachedStore(file, { n: 0 });
    await store.load();
    await writeFile(file, JSON.stringify({ n: 42 }));
    store.invalidateCache();
    expect((await store.load()).n).toBe(42);
  });
});

// =============================================================================
// sanitizeFilename / getFileExtension / getMimeType / allowlists (#1140)
// =============================================================================

describe('sanitizeFilename', () => {
  it('returns a safe basename for a normal filename', () => {
    expect(sanitizeFilename('hello.txt')).toBe('hello.txt');
  });

  it('strips directory components', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  });

  it('replaces special characters with underscores', () => {
    expect(sanitizeFilename('hello world!.txt')).toBe('hello_world_.txt');
    expect(sanitizeFilename('file with spaces.js')).toBe('file_with_spaces.js');
    expect(sanitizeFilename('résumé.pdf')).toBe('r_sum_.pdf');
  });

  it('prevents hidden files by replacing a leading dot', () => {
    expect(sanitizeFilename('.bashrc')).toBe('_bashrc');
    expect(sanitizeFilename('.hidden.txt')).toBe('_hidden.txt');
  });

  it('leaves dots in the middle alone (extension dots)', () => {
    expect(sanitizeFilename('my.file.name.txt')).toBe('my.file.name.txt');
  });

  it('handles an empty string gracefully', () => {
    expect(sanitizeFilename('')).toBe('');
  });
});

describe('getFileExtension', () => {
  it('returns the lowercased extension with leading dot', () => {
    expect(getFileExtension('photo.PNG')).toBe('.png');
    expect(getFileExtension('archive.tar.gz')).toBe('.gz');
  });

  it('returns null for a filename without an extension', () => {
    expect(getFileExtension('Makefile')).toBeNull();
    expect(getFileExtension('no-ext')).toBeNull();
  });

  it('normalises uppercase extensions', () => {
    expect(getFileExtension('IMAGE.JPEG')).toBe('.jpeg');
  });
});

describe('getMimeType', () => {
  it('returns the correct MIME type for known extensions', () => {
    expect(getMimeType('.png')).toBe('image/png');
    expect(getMimeType('.pdf')).toBe('application/pdf');
    expect(getMimeType('.mp3')).toBe('audio/mpeg');
    expect(getMimeType('.zip')).toBe('application/zip');
    expect(getMimeType('.json')).toBe('application/json');
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(getMimeType('.xyz')).toBe('application/octet-stream');
    expect(getMimeType('.unknown')).toBe('application/octet-stream');
    expect(getMimeType(null)).toBe('application/octet-stream');
  });

  it('all entries in EXTENSION_MIME_MAP are reachable through getMimeType', () => {
    for (const [ext, mime] of Object.entries(EXTENSION_MIME_MAP)) {
      expect(getMimeType(ext)).toBe(mime);
    }
  });
});

describe('ATTACHMENT_ALLOWED_EXTENSIONS', () => {
  it('is a Set', () => {
    expect(ATTACHMENT_ALLOWED_EXTENSIONS).toBeInstanceOf(Set);
  });

  it('allows common document types', () => {
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.pdf')).toBe(true);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.md')).toBe(true);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.json')).toBe(true);
  });

  it('allows image types', () => {
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.png')).toBe(true);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.jpg')).toBe(true);
  });

  it('does NOT allow audio/video types (strict attachment subset)', () => {
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.mp3')).toBe(false);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.mp4')).toBe(false);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.ico')).toBe(false);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.bmp')).toBe(false);
  });

  it('all extensions in the set are also present in EXTENSION_MIME_MAP', () => {
    for (const ext of ATTACHMENT_ALLOWED_EXTENSIONS) {
      expect(EXTENSION_MIME_MAP).toHaveProperty(ext);
    }
  });
});

describe('detectImageFormat', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  const GIF87 = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00]);
  const GIF89 = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]);

  it('detects PNG', () => {
    expect(detectImageFormat(PNG)).toEqual({ format: 'png', ext: '.png', mime: 'image/png' });
  });

  it('detects JPEG', () => {
    expect(detectImageFormat(JPEG)).toEqual({ format: 'jpeg', ext: '.jpg', mime: 'image/jpeg' });
  });

  it('detects WebP', () => {
    expect(detectImageFormat(WEBP)).toEqual({ format: 'webp', ext: '.webp', mime: 'image/webp' });
  });

  it('detects both GIF variants', () => {
    expect(detectImageFormat(GIF87)?.format).toBe('gif');
    expect(detectImageFormat(GIF89)?.format).toBe('gif');
  });

  it('returns null for non-image bytes', () => {
    expect(detectImageFormat(Buffer.from('not an image'))).toBeNull();
  });

  it('returns null for a RIFF container that is not WebP', () => {
    // RIFF header but "AVI " instead of "WEBP" at offset 8.
    const avi = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]);
    expect(detectImageFormat(avi)).toBeNull();
  });

  it('returns null for a truncated/too-short buffer', () => {
    expect(detectImageFormat(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('returns null for a non-Buffer input', () => {
    expect(detectImageFormat('AAAA')).toBeNull();
    expect(detectImageFormat(null)).toBeNull();
  });
});

describe('saveBase64Upload (shared attachment upload pipeline)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'save-b64-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = { allowedExtensions: SONGBOOK_ATTACHMENT_EXTENSIONS, maxBytes: 10 };
  const b64 = (s) => Buffer.from(s).toString('base64');

  it('persists within the cap and returns the uuid-prefixed name, buffer, size, and mime', async () => {
    const saved = await saveBase64Upload(dir, { filename: 'sheet.txt', data: b64('ten bytes!') }, opts);
    expect(saved.filename).toMatch(/^[0-9a-f]{8}-sheet\.txt$/);
    expect(saved.size).toBe(10);
    expect(saved.mime).toBe('text/plain');
    expect(saved.buffer.toString('utf-8')).toBe('ten bytes!');
    expect(existsSync(saved.filePath)).toBe(true);
    expect(saved.filePath.startsWith(dir)).toBe(true);
  });

  it('rejects a payload over maxBytes with a 400 FILE_TOO_LARGE', async () => {
    await expect(saveBase64Upload(dir, { filename: 'big.txt', data: b64('eleven bytes') }, opts))
      .rejects.toMatchObject({ status: 400, code: 'FILE_TOO_LARGE' });
  });

  it('rejects an extension outside the allowlist with a 400 INVALID_FILE_TYPE', async () => {
    await expect(saveBase64Upload(dir, { filename: 'app.exe', data: b64('x') }, opts))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_FILE_TYPE' });
  });

  it('rejects a traversal-shaped filename ("../x") with a 400', async () => {
    await expect(saveBase64Upload(dir, { filename: '../x', data: b64('x') }, opts))
      .rejects.toMatchObject({ status: 400 });
  });

  it('sanitizes a traversal filename with an allowed extension to a basename inside the dir', async () => {
    const saved = await saveBase64Upload(dir, { filename: '../../evil.txt', data: b64('x') }, opts);
    expect(saved.filename).toMatch(/^[0-9a-f]{8}-evil\.txt$/); // directory parts stripped
    expect(saved.filePath.startsWith(dir)).toBe(true);
    expect(existsSync(saved.filePath)).toBe(true);
  });
});

describe('serveLocalFile (shared attachment serving pipeline)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'serve-local-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const mockRes = () => ({
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    type: vi.fn(function type() { return this; }),
    sendFile: vi.fn(),
  });

  it('serves a benign MIME inline with nosniff and no attachment disposition', async () => {
    writeFileSync(join(dir, 'safe.txt'), 'hello');
    const res = mockRes();
    await serveLocalFile(res, dir, 'safe.txt');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Disposition']).toBeUndefined();
    expect(res.sendFile).toHaveBeenCalledWith(join(dir, 'safe.txt'));
  });

  it('forces Content-Disposition: attachment for a risky MIME (svg)', async () => {
    writeFileSync(join(dir, 'sheet.svg'), '<svg/>');
    const res = mockRes();
    await serveLocalFile(res, dir, 'sheet.svg');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="sheet.svg"');
    expect(res.sendFile).toHaveBeenCalledWith(join(dir, 'sheet.svg'));
  });

  it('404s with the parametrized missingError for absent bytes', async () => {
    const res = mockRes();
    await expect(serveLocalFile(res, dir, 'nope.txt', {
      missingError: { message: 'Attachment file is not on this machine', code: 'NOT_ON_THIS_MACHINE' },
    })).rejects.toMatchObject({ status: 404, code: 'NOT_ON_THIS_MACHINE' });
    expect(res.sendFile).not.toHaveBeenCalled();
  });
});
