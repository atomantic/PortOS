import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const readLines = (path) =>
  readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

describe('history service JSONL storage', () => {
  let dataDir;
  let historyFile;

  beforeEach(() => {
    vi.resetModules();
    dataDir = mkdtempSync(join(tmpdir(), 'portos-history-service-'));
    historyFile = join(dataDir, 'history.jsonl');
  });

  afterEach(() => {
    vi.doUnmock('../lib/fileUtils.js');
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function loadService(overrides = {}) {
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        PATHS: { ...actual.PATHS, data: dataDir },
        ...overrides,
      };
    });
    return import('./history.js');
  }

  it('appends log entries as JSONL records and returns newest entries first', async () => {
    const history = await loadService();

    const first = await history.logAction('start', 'app-1', 'App One');
    const second = await history.logAction('restart', 'app-1', 'App One', { via: 'test' });

    expect(existsSync(historyFile)).toBe(true);
    expect(readLines(historyFile).map((entry) => entry.id)).toEqual([first.id, second.id]);

    const result = await history.getHistory();
    expect(result.total).toBe(2);
    expect(result.entries.map((entry) => entry.id)).toEqual([second.id, first.id]);
  });

  it('filters entries and rewrites JSONL on delete', async () => {
    const history = await loadService();

    const success = await history.logAction('start', 'app-1', 'App One', {}, true);
    const failure = await history.logAction('stop', 'app-2', 'App Two', {}, false, 'boom');

    expect((await history.getHistory({ success: false })).entries).toMatchObject([{ id: failure.id }]);
    expect((await history.getActionTypes())).toEqual(['start', 'stop']);

    expect(await history.deleteEntry(success.id)).toEqual({ deleted: true });
    expect(readLines(historyFile).map((entry) => entry.id)).toEqual([failure.id]);
    expect(await history.deleteEntry('missing')).toEqual({ deleted: false, error: 'Entry not found' });
  });

  it('preserves the max-entry retention bound during appends', async () => {
    const history = await loadService();

    for (let i = 0; i < 501; i += 1) {
      await history.logAction('run', `target-${i}`, `Target ${i}`);
    }

    const lines = readLines(historyFile);
    expect(lines).toHaveLength(500);
    expect(lines[0].target).toBe('target-1');
    expect(lines[499].target).toBe('target-500');

    const result = await history.getHistory({ limit: 1 });
    expect(result.total).toBe(500);
    expect(result.entries[0].target).toBe('target-500');
  });

  it('serializes concurrent appends so no entry is lost', async () => {
    const history = await loadService();

    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      history.logAction('run', `target-${i}`, `Target ${i}`),
    ));

    const lines = readLines(historyFile);
    expect(lines).toHaveLength(20);
    expect(new Set(lines.map((entry) => entry.target)).size).toBe(20);
  });

  it('does not cache an entry when the append fails', async () => {
    const appendJSONLine = vi.fn().mockRejectedValue(new Error('disk full'));
    const history = await loadService({ appendJSONLine });

    await expect(history.logAction('start', 'app-1', 'App One')).rejects.toThrow(/disk full/);

    expect(await history.getHistory()).toEqual({ total: 0, entries: [] });
    expect(existsSync(historyFile)).toBe(false);
  });

  it('does not remove a cached entry when delete persistence fails', async () => {
    const writeJSONLines = vi.fn().mockRejectedValue(new Error('disk full'));
    const history = await loadService({ writeJSONLines });
    const entry = await history.logAction('start', 'app-1', 'App One');

    await expect(history.deleteEntry(entry.id)).rejects.toThrow(/disk full/);

    expect((await history.getHistory()).entries.map((item) => item.id)).toEqual([entry.id]);
    expect(readLines(historyFile).map((item) => item.id)).toEqual([entry.id]);
  });

  it('does not clear cached entries when clear persistence fails', async () => {
    const writeJSONLines = vi.fn().mockRejectedValue(new Error('disk full'));
    const history = await loadService({ writeJSONLines });
    const entry = await history.logAction('start', 'app-1', 'App One');

    await expect(history.clearHistory()).rejects.toThrow(/disk full/);

    expect((await history.getHistory()).entries.map((item) => item.id)).toEqual([entry.id]);
    expect(readLines(historyFile).map((item) => item.id)).toEqual([entry.id]);
  });

  it('clears all records by replacing the JSONL file with empty content', async () => {
    const history = await loadService();

    await history.logAction('start', 'app-1', 'App One');
    expect(readFileSync(historyFile, 'utf-8')).not.toBe('');

    expect(await history.clearHistory()).toEqual({ cleared: true });
    expect(readFileSync(historyFile, 'utf-8')).toBe('');
    expect(await history.getHistory()).toEqual({ total: 0, entries: [] });
  });
});
