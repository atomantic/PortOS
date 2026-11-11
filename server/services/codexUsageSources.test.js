import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as zlib from 'node:zlib';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup, tempRoot } = mockPathsDataRoot({ prefix: 'portos-codex-inventory-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
afterAll(cleanup);

const STORE = join(tempRoot, 'cache', 'codex-usage-inventory');
const CWD = '/example/workspace';
const line = value => JSON.stringify(value);
const rollout = (id, output = 10) => [
  { type: 'session_meta', payload: { id, cwd: CWD, model: 'example-model' } },
  { timestamp: '2026-07-01T00:00:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'SYNTHETIC TRANSCRIPT TEXT' } },
  { timestamp: '2026-07-01T00:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: output } } } }
].map(line).join('\n');

let home;
let sources;
const source = async (name, text) => {
  const path = join(home, '.codex', name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, name.endsWith('.zst') ? zlib.zstdCompressSync(text) : text);
  return path;
};
// A restart: nothing in process memory survives, only the store does.
const restart = async () => {
  vi.resetModules();
  sources = await import('./codexUsageSources.js');
};
const read = options => sources.readCodexAccountingSources({ home, ...options });
const decoder = () => vi.fn(() => zlib.createZstdDecompress());
const incompleteError = inventory => {
  try { sources.assertCodexInventoryComplete(inventory); } catch (error) { return error; }
  return null;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codex-inventory-home-'));
  await rm(join(tempRoot, 'cache'), { recursive: true, force: true });
  await restart();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('Codex accounting inventory', () => {
  it('keeps verified projections across a restart without decoding unchanged history or storing transcript text', async () => {
    await source('archived_sessions/a.jsonl.zst', rollout('session-a'));
    await source('sessions/b.jsonl', rollout('session-b'));
    const decompress = decoder();
    const first = await read({ decompress });
    expect(first.coverage).toMatchObject({ complete: true, filesInspected: 2, filesCached: 0 });
    expect(decompress).toHaveBeenCalledTimes(1);

    await restart();
    const second = await read({ decompress });
    expect(decompress).toHaveBeenCalledTimes(1);
    expect(second.coverage).toMatchObject({ complete: true, filesInspected: 2, filesCached: 2, decodedBytes: 0 });
    expect(second.revision).toBe(first.revision);
    const [before, after] = await Promise.all([first, second].map(({ sessions }) => Promise.all(sessions.map(session => session.loadRecords()))));
    expect(after).toEqual(before);

    const stored = (await Promise.all((await readdir(STORE)).map(async name => zlib.gunzipSync(await readFile(join(STORE, name))).toString()))).join('\n');
    expect(stored).toContain('total_token_usage');
    for (const privateValue of ['SYNTHETIC TRANSCRIPT TEXT', 'session-a', home]) expect(stored).not.toContain(privateValue);

    // A runtime without the decoder reports that rather than coasting on the store.
    expect((await read({ decompress: null })).coverage.issues).toEqual({ unsupported_compression: 1, missing_identity: 1 });
  });

  it('keeps a Codex service tier and drops the rest of the thread settings', async () => {
    const secret = 'SECRET-CWD-NOT-FOR-STORE';
    await source('sessions/tier.jsonl', [
      line({ type: 'session_meta', payload: { id: 'tier-session', cwd: CWD, model: 'example-model' } }),
      line({ timestamp: '2026-07-01T00:00:00Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority', cwd: secret, approval_policy: 'never' } } }),
      line({ timestamp: '2026-07-01T00:00:01Z', type: 'event_msg', payload: { type: 'agent_message', message: secret } }),
      line({ timestamp: '2026-07-01T00:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } } }),
    ].join('\n'));
    const inventory = await read();
    const records = (await Promise.all(inventory.sessions.map((session) => session.loadRecords()))).flat();
    expect(records).toContainEqual({ timestamp: '2026-07-01T00:00:00Z', payload: { type: 'thread_settings_applied', service_tier: 'priority' } });
    const stored = (await Promise.all((await readdir(STORE)).map(async (name) => zlib.gunzipSync(await readFile(join(STORE, name))).toString()))).join('\n');
    expect(stored).toContain('priority');
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('approval_policy');
  });

  it('still invalidates a changed, deleted or conflicting source after a restart', async () => {
    const changed = await source('sessions/changed.jsonl', rollout('changed'));
    const moved = await source('sessions/moved.jsonl', rollout('moved'));
    await source('archived_sessions/moved.jsonl', rollout('moved'));
    await read();

    await appendFile(changed, `\n${line({ timestamp: '2026-07-01T00:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 50 } } } })}`);
    await rm(moved);
    await restart();
    const updated = await read();
    expect(updated.coverage).toMatchObject({ complete: true, filesInspected: 2, filesCached: 1, duplicateCopies: 0 });
    const records = await updated.sessions.find(session => session.paths[0] === changed).loadRecords();
    expect(records.filter(record => record.payload?.type === 'token_count')).toHaveLength(2);

    await source('archived_sessions/conflict.jsonl', rollout('moved', 999));
    await restart();
    const conflicted = await read();
    expect(conflicted.coverage).toMatchObject({ complete: false, issues: { conflicting_copies: 1 } });
    expect(conflicted.sessions.map(session => session.paths[0])).toEqual([changed]);
  });

  it('treats a damaged or other-version store as a cold rescan', async () => {
    await source('sessions/a.jsonl', rollout('session-a'));
    await source('sessions/b.jsonl', rollout('session-b'));
    await read();
    const [damaged, future] = await readdir(STORE);
    await writeFile(join(STORE, damaged), 'not gzip');
    const entry = JSON.parse(zlib.gunzipSync(await readFile(join(STORE, future))).toString());
    await writeFile(join(STORE, future), zlib.gzipSync(JSON.stringify({ ...entry, version: entry.version + 1 })));
    await restart();
    const rescan = await read();
    expect(rescan.coverage).toMatchObject({ complete: true, filesCached: 0, filesInspected: 2 });
    await restart();
    expect((await read()).coverage).toMatchObject({ complete: true, filesCached: 2 });
  });

  it('converges across passes when history exceeds the per-pass work, without cached sources spending it', async () => {
    const paths = await Promise.all(['a', 'b', 'c'].map(name => source(`sessions/${name}.jsonl`, rollout(`session-${name}`))));
    // Three records per source: the whole inventory is over this per-source ceiling.
    const limits = { coldFiles: 1, records: 3 };
    const first = await read({ limits });
    expect(first).toMatchObject({ stopped: 'indexing_pending', coverage: { complete: false, filesDiscovered: 3, filesInspected: 1, filesPending: 2, issues: { indexing_pending: 2 } } });
    const held = incompleteError(first);
    expect(held).toMatchObject({ code: 'CODEX_SOURCES_INCOMPLETE', issues: { indexing_pending: 2 }, progress: { indexed: 1, total: 3 } });
    for (const path of paths) expect(held.message).not.toContain(path);

    await restart();
    expect((await read({ limits })).coverage).toMatchObject({ filesCached: 1, filesInspected: 2, filesPending: 1 });
    const final = await read({ limits });
    expect(final).toMatchObject({ stopped: null, coverage: { complete: true, filesCached: 2, filesInspected: 3, filesPending: 0, issues: {} } });
    expect(final.sessions).toHaveLength(3);
    expect(incompleteError(final)).toBeNull();
  });

  it('stops admitting cold sources at the time budget, finishing the one in progress and leaving no deadline stop', async () => {
    await source('sessions/a.jsonl.zst', rollout('session-a'));
    await source('sessions/b.jsonl.zst', rollout('session-b'));
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const decompress = vi.fn(() => {
      clock = 25_000;
      return zlib.createZstdDecompress();
    });
    const pass = await read({ decompress });
    expect(decompress).toHaveBeenCalledTimes(1);
    expect(pass).toMatchObject({ stopped: 'indexing_pending', coverage: { filesInspected: 1, filesPending: 1, issues: { indexing_pending: 1 } } });

    await source('sessions/c.jsonl.zst', rollout('session-c'));
    clock = 0;
    const bytes = await read({ decompress: decoder(), limits: { coldBytes: 1 } });
    expect(bytes.coverage).toMatchObject({ filesCached: 1, filesInspected: 2, filesPending: 1 });
  });

  it('applies the record ceiling per source, so one pass can index more than it in total', async () => {
    for (const name of ['a', 'b', 'c']) await source(`sessions/${name}.jsonl`, rollout(`session-${name}`));
    expect((await read({ limits: { records: 3 } })).coverage).toMatchObject({ complete: true, filesInspected: 3, recordsRead: 9 });
  });

  it('holds only the source that exceeds a per-source ceiling, indexing the rest', async () => {
    await source('sessions/big.jsonl', rollout('session-big'));
    await source('sessions/small.jsonl', line({ type: 'session_meta', payload: { id: 'session-small', cwd: CWD } }));
    const pass = await read({ limits: { records: 2 } });
    expect(pass).toMatchObject({ stopped: null, coverage: { complete: false, filesInspected: 2, issues: { record_limit: 1 } } });
    expect(pass.problemSources).toEqual([expect.objectContaining({ issues: expect.arrayContaining(['record_limit']) })]);
    expect((await readdir(STORE))).toHaveLength(1);
  });

  it('shares a running decode between callers without narrowing or widening either window', async () => {
    const recent = Date.parse('2026-07-02T00:00:00Z');
    const older = await source('sessions/older.jsonl.zst', rollout('session-older'));
    await utimes(older, new Date(recent - 86_400_000), new Date(recent - 86_400_000));
    const newer = await source('sessions/newer.jsonl.zst', rollout('session-newer'));
    await utimes(newer, new Date(recent), new Date(recent));
    const decompress = decoder();
    const [wide, narrow, same] = await Promise.all([
      read({ decompress, modifiedSince: recent - 2 * 86_400_000 }),
      read({ decompress, modifiedSince: recent - 1000 }),
      read({ decompress, modifiedSince: recent - 1000 })
    ]);
    expect(decompress).toHaveBeenCalledTimes(2);
    expect(wide.sessions.flatMap(session => session.paths).sort()).toEqual([newer, older].sort());
    for (const reader of [narrow, same]) {
      expect(reader.coverage.complete).toBe(true);
      expect(reader.sessions.flatMap(session => session.paths)).toEqual([newer]);
    }
    expect(await narrow.sessions[0].loadRecords()).toEqual(await wide.sessions.find(session => session.paths[0] === newer).loadRecords());
  });

  it('does not let one caller cancelling a shared decode hold another caller', async () => {
    await source('sessions/a.jsonl.zst', rollout('session-a'));
    const controller = new AbortController();
    const decompress = vi.fn(() => {
      if (decompress.mock.calls.length === 1) controller.abort();
      return zlib.createZstdDecompress();
    });
    const [cancelled, other] = await Promise.all([read({ decompress, signal: controller.signal }), read({ decompress })]);
    expect(cancelled).toMatchObject({ stopped: 'cancelled', coverage: { complete: false } });
    expect(other.coverage).toMatchObject({ complete: true, issues: {} });
    expect(other.sessions).toHaveLength(1);
  });

  it('rejects a load whose stored projection has gone, then rebuilds it on the next pass', async () => {
    await source('sessions/a.jsonl', rollout('session-a'));
    const { sessions } = await read();
    await rm(STORE, { recursive: true });
    await expect(sessions[0].loadRecords()).rejects.toMatchObject({ code: 'CODEX_SOURCES_INCOMPLETE', issues: { source_changed: 1 } });
    const rebuilt = await read();
    expect(rebuilt.coverage).toMatchObject({ complete: true, filesCached: 0 });
    expect(await rebuilt.sessions[0].loadRecords()).toHaveLength(3);
  });

  it('keeps accounting complete in memory, within its record bound, when the store cannot be written', async () => {
    await writeFile(join(tempRoot, 'cache'), 'a file where the store directory belongs');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await source('sessions/a.jsonl', rollout('session-a'));
    await source('sessions/b.jsonl', rollout('session-b'));
    const pass = await read();
    expect(pass.coverage).toMatchObject({ complete: true, filesInspected: 2 });
    expect(await pass.sessions[0].loadRecords()).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain(tempRoot);
    expect((await read({ limits: { records: 4 } }))).toMatchObject({ stopped: 'record_limit', coverage: { complete: false } });
  });

  it('bounds the store, dropping the oldest sources first', async () => {
    const base = Date.now();
    for (const [index, name] of ['oldest', 'middle', 'newest'].entries()) {
      const path = await source(`sessions/${name}.jsonl`, rollout(`session-${name}`));
      await utimes(path, new Date(base - (3 - index) * 3_600_000), new Date(base - (3 - index) * 3_600_000));
    }
    // Two entries at their 4 KiB minimum.
    expect((await read({ limits: { cacheBytes: 8192 } })).coverage.complete).toBe(true);
    expect(await readdir(STORE)).toHaveLength(2);
    await restart();
    const kept = await read({ limits: { coldFiles: 1 }, modifiedSince: base - 2.5 * 3_600_000 });
    expect(kept.coverage).toMatchObject({ complete: true, filesCached: 2, filesInspected: 2 });
    expect((await read({ limits: { coldFiles: 1 } })).coverage).toMatchObject({ filesCached: 2, filesInspected: 3 });
  });

  it('leaves explicit preview independent of the store and of routine budgets', async () => {
    await source('sessions/a.jsonl', rollout('session-a'));
    const range = { from: '2026-01-01', to: '2026-12-31', home };
    await expect(sources.previewCodexUsage({ ...range, limits: { coldFiles: 1 } })).rejects.toThrow('INVALID_LIMIT');
    const preview = await sources.previewCodexUsage(range);
    expect(preview.coverage).toMatchObject({ complete: true, filesCached: 0 });
    await expect(readdir(STORE)).rejects.toMatchObject({ code: 'ENOENT' });
    await read();
    const fresh = await sources.previewCodexUsage(range);
    expect(fresh.coverage.filesCached).toBe(0);
    expect(fresh.coverage.decodedBytes).toBeGreaterThan(0);
  });
});
