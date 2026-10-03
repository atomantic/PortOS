import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './037-history-json-to-jsonl.js';

// Destination fault injection: when set, wraps the migration's write stream.
const faults = vi.hoisted(() => ({ wrap: null }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createWriteStream: (path, opts) => (faults.wrap
      ? faults.wrap(actual.createWriteStream, path, opts)
      : actual.createWriteStream(path, opts)),
  };
});

const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const readJsonl = (path) =>
  readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

describe('migration 037 — history.json to history.jsonl', () => {
  let rootDir;
  let dataDir;
  let legacyPath;
  let jsonlPath;
  let backupPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-037-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    legacyPath = join(dataDir, 'history.json');
    jsonlPath = join(dataDir, 'history.jsonl');
    backupPath = legacyPath + '.bak-037';
  });

  afterEach(() => {
    faults.wrap = null;
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('fresh install: no legacy file creates an empty JSONL file', async () => {
    const result = await migration.up({ rootDir });

    expect(result).toEqual({ ok: true, reason: 'fresh-install' });
    expect(existsSync(jsonlPath)).toBe(true);
    expect(readFileSync(jsonlPath, 'utf-8')).toBe('');
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('converts legacy entries in order and backs up history.json', async () => {
    writeJson(legacyPath, {
      entries: [
        { id: 'a', action: 'start', timestamp: '2026-05-23T00:00:00.000Z' },
        { id: 'b', action: 'stop', timestamp: '2026-05-23T00:01:00.000Z' },
      ],
    });

    const result = await migration.up({ rootDir });

    expect(result).toEqual({
      ok: true,
      reason: 'converted',
      converted: 2,
      skippedDuplicate: 0,
      skippedInvalid: 0,
    });
    expect(readJsonl(jsonlPath).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(existsSync(legacyPath)).toBe(false);
    expect(readJson(backupPath).entries).toHaveLength(2);
  });

  it('dedupes against existing JSONL during partial recovery', async () => {
    writeFileSync(jsonlPath, '{"id":"a","action":"start"}\n');
    writeJson(legacyPath, {
      entries: [
        { id: 'a', action: 'start' },
        { id: 'b', action: 'stop' },
        null,
      ],
    });

    const result = await migration.up({ rootDir });

    expect(result).toEqual({
      ok: true,
      reason: 'converted',
      converted: 1,
      skippedDuplicate: 1,
      skippedInvalid: 1,
    });
    expect(readJsonl(jsonlPath).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('is idempotent after conversion', async () => {
    writeJson(legacyPath, { entries: [{ id: 'a', action: 'start' }] });
    await migration.up({ rootDir });

    const result = await migration.up({ rootDir });

    expect(result).toEqual({ ok: true, reason: 'already-jsonl' });
    expect(readJsonl(jsonlPath).map((entry) => entry.id)).toEqual(['a']);
  });

  it('reports unreadable legacy content without renaming it', async () => {
    writeFileSync(legacyPath, 'not json');

    const result = await migration.up({ rootDir });

    expect(result).toEqual({ ok: false, reason: 'unreadable' });
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(jsonlPath)).toBe(false);
  });

  describe('destination I/O failure (#9784)', () => {
    const injections = {
      open: (create, path, opts) => create(join(dataDir, 'missing-dir', 'history.jsonl.tmp'), opts),
      write: (create, path, opts) => {
        const stream = create(path, opts);
        stream._write = (chunk, encoding, cb) => cb(enospc());
        stream._writev = (chunks, cb) => cb(enospc());
        return stream;
      },
      finish: (create, path, opts) => {
        const stream = create(path, opts);
        stream._final = (cb) => cb(enospc());
        return stream;
      },
    };

    it.each(Object.keys(injections))(
      '%s failure rejects, leaves both inputs byte-identical, and a retry after repair converts without duplicates',
      async (kind) => {
        writeFileSync(jsonlPath, '{"id":"a","action":"start"}\n');
        writeJson(legacyPath, { entries: [{ id: 'a', action: 'start' }, { id: 'b', action: 'stop' }] });
        const legacyBefore = readFileSync(legacyPath);
        const jsonlBefore = readFileSync(jsonlPath);
        const filesBefore = readdirSync(dataDir).sort();

        faults.wrap = injections[kind];
        await expect(migration.up({ rootDir })).rejects.toThrow(kind === 'open' ? /ENOENT/ : /ENOSPC/);

        expect(readFileSync(legacyPath)).toEqual(legacyBefore);
        expect(readFileSync(jsonlPath)).toEqual(jsonlBefore);
        expect(readdirSync(dataDir).sort()).toEqual(filesBefore);

        faults.wrap = null;
        const result = await migration.up({ rootDir });
        expect(result).toMatchObject({ ok: true, reason: 'converted', converted: 1, skippedDuplicate: 1 });
        expect(readJsonl(jsonlPath).map((entry) => entry.id)).toEqual(['a', 'b']);
        expect(existsSync(legacyPath)).toBe(false);
      },
    );
  });

  it('keeps an existing JSONL whose last line lacks a newline separate from converted entries', async () => {
    writeFileSync(jsonlPath, '{"id":"a","action":"start"}');
    writeJson(legacyPath, { entries: [{ id: 'b', action: 'stop' }] });

    await migration.up({ rootDir });

    expect(readJsonl(jsonlPath).map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
