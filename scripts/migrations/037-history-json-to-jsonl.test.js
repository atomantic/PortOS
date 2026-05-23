import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './037-history-json-to-jsonl.js';

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
});
