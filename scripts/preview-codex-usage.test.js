import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { assertCodexInventoryComplete, previewCodexUsage, readCodexAccountingSources } from '../server/services/codexUsageSources.js';
import { parseCodexRollout } from '../server/lib/providerTranscriptUsage.js';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, 'preview-codex-usage.js');
const range = { from: '2026-07-01', to: '2026-07-02' };
const meta = (id = 'synthetic-session', model = 'gpt-test') => ({ type: 'session_meta', payload: { id, model, cwd: '/private/example-project' } });
const count = (timestamp, input, cached = 0, output = 10) => ({ timestamp, type: 'event_msg', payload: {
  type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } }
} });
const message = timestamp => ({ timestamp, type: 'event_msg', payload: { type: 'agent_message', message: 'SYNTHETIC PRIVATE TRANSCRIPT' } });
const serialize = records => `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
const records = (id = 'synthetic-session') => [meta(id),
  count('2026-06-20T12:00:00Z', 100, 20, 10),
  message('2026-07-01T00:00:00Z'),
  count('2026-07-01T00:00:00Z', 150, 40, 20),
  count('2026-07-01T00:00:00Z', 150, 40, 20),
  count('2026-07-02T23:59:59.999Z', 200, 60, 30),
  count('2026-07-03T00:00:00Z', 999, 200, 100)];
let home;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'codex-preview-synthetic-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });
const source = async (name, data) => {
  const path = join(home, '.codex', name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return path;
};
const preview = options => previewCodexUsage({ ...range, home, ...options });
const command = async args => {
  const result = await exec(process.execPath, [script, '--home', home, ...args]).catch(error => error);
  return { code: result.code ?? 0, result: JSON.parse(result.stdout), stderr: result.stderr };
};

describe('read-only Codex preview command and source boundary', () => {
  it('includes older-started, moved and compressed copies once with exact parser window semantics and no private output or writes', async () => {
    const text = serialize(records());
    const original = await source('sessions/2020/01/01/old.jsonl', text);
    await source('archived_sessions/moved.jsonl', text);
    await source('archived_sessions/copy.jsonl.zst', zlib.zstdCompressSync(text));
    const second = records('another-session');
    second[0] = meta('another-session', 'gpt-other');
    await source('archived_sessions/another.jsonl', serialize(second));
    const { result, code, stderr } = await command(['--from', range.from, '--to', range.to]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(result.coverage).toMatchObject({ complete: true, filesInspected: 4, logicalSessions: 2, duplicateCopies: 2 });
    const expected = parseCodexRollout(text, { from: Date.parse('2026-07-01T00:00:00Z'), to: Date.parse('2026-07-02T23:59:59.999Z') });
    expect(result.byModel['gpt-test']).toEqual(expected.byModel['gpt-test']);
    expect(result.totals).toEqual({ messages: 2, tokensIn: 120, tokensOut: 40, cacheReadTokens: 80, cacheWriteTokens: 0 });
    expect(result).toMatchObject({ ledgerOverlap: 'unknown', missingUsage: null });
    const output = JSON.stringify(result);
    for (const privateValue of [home, 'private/example', 'synthetic-session', 'PRIVATE TRANSCRIPT', 'old.jsonl']) expect(output).not.toContain(privateValue);
    expect(await readFile(original, 'utf8')).toBe(text);
  });

  it('excludes an entire identity for conflicting totals or a malformed copy, regardless of copy order', async () => {
    await source('sessions/a.jsonl', serialize(records('conflict')));
    const changed = records('conflict');
    changed[5] = count('2026-07-02T23:59:59.999Z', 300);
    await source('archived_sessions/b.jsonl', serialize(changed));
    await source('sessions/c.jsonl', `${serialize(records('malformed'))}{"truncated":`);
    await source('archived_sessions/d.jsonl', serialize(records('malformed')));
    await source('sessions/e.jsonl', serialize(records('healthy')));
    const { result, code } = await command(['--from', range.from, '--to', range.to]);
    expect(code).toBe(2);
    expect(result.coverage).toMatchObject({ complete: false, resolvedSessions: 1, unresolvedSessions: 2,
      issues: { conflicting_copies: 1, malformed: 1 } });
    expect(result.totals.tokensIn).toBe(60);
  });

  it('invalidates all identities in a multi-session source and excludes invalid accounting rather than coercing it to zero', async () => {
    await source('sessions/a.jsonl', serialize(records('first')));
    await source('archived_sessions/b.jsonl', serialize([meta('first'), meta('second'), count('2026-07-01', 100)]));
    const invalid = count('2026-07-01', '100');
    await source('sessions/c.jsonl', serialize([meta('invalid'), invalid]));
    await source('sessions/d.jsonl', serialize([meta('private-model', '/private/model/path'), count('2026-07-01', 100)]));
    const result = await preview();
    expect(result.coverage.unresolvedSessions).toBe(4);
    expect(result.totals.tokensIn).toBe(0);
    expect(result.coverage.issues).toMatchObject({ conflicting_identity: 1, malformed: 2 });
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('accepts oversized non-accounting lines but fails closed on oversized accounting', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const envelope = (type, payload) => JSON.stringify({ timestamp: '2026-07-01T00:00:00Z', ordinal: 7, type, payload });
    const [first, ...rest] = records();
    await source('sessions/a.jsonl', [
      JSON.stringify(first),
      envelope('response_item', { type: 'function_call_output', output: huge }),
      envelope('event_msg', { type: 'item_completed', item: huge }),
      envelope('compacted', { message: huge }),
      ...rest.map(record => JSON.stringify(record))
    ].join('\n'));
    const accepted = await preview();
    expect(accepted.coverage).toMatchObject({ complete: true, issues: {} });
    expect(accepted.totals.tokensIn).toBe(60);
    await source('sessions/b.jsonl', serialize([meta('oversized-count'), { ...count('2026-07-01', 100), padding: huge }]));
    const refused = await preview();
    expect(refused.coverage.issues.line_limit).toBe(1);
    expect(refused.coverage.unresolvedSessions).toBe(1);
  });

  it('treats a forked rollout\'s embedded parent meta as ancestry, keeping both sessions billable', async () => {
    const parent = 'parent-session';
    await source('sessions/parent.jsonl', serialize(records(parent)));
    const child = records('child-session');
    child[0].payload.forked_from_id = parent;
    child.splice(1, 0, meta(parent));
    await source('sessions/child.jsonl', serialize(child));
    const result = await preview();
    expect(result.coverage).toMatchObject({ complete: true, logicalSessions: 2, resolvedSessions: 2, duplicateCopies: 0, issues: {} });
    expect(result.totals.tokensIn).toBe(120);
  });

  it('skips only sources last written before the window, without spending budgets or losing baselines', async () => {
    const stale = await source('sessions/stale.jsonl', 'not json');
    const before = new Date('2026-06-30T00:00:00Z');
    await utimes(stale, before, before);
    await source('sessions/current.jsonl', serialize(records()));
    const result = await preview({ limits: { files: 1 } });
    expect(result.coverage).toMatchObject({ complete: true, filesInspected: 1 });
    expect(result.totals.tokensIn).toBe(60);
  });

  it('names the incomplete reasons and relative sources without exposing the home directory', async () => {
    await source('sessions/2026/bad.jsonl', '{"truncated":');
    const inventory = await readCodexAccountingSources({ home, cache: false });
    let error;
    try { assertCodexInventoryComplete(inventory); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'CODEX_SOURCES_INCOMPLETE', issues: { malformed: 1 } });
    expect(error.message).toContain('malformed=1');
    expect(error.message).toContain(join('sessions', '2026', 'bad.jsonl'));
    expect(error.message).not.toContain(home);
  });

  it('reports malformed and truncated compressed files and invalidates their identifiable raw copies', async () => {
    const text = serialize(records());
    await source('sessions/good.jsonl', text);
    const compressed = zlib.zstdCompressSync(`${text}${JSON.stringify({ type: 'response_item', payload: 'x'.repeat(200_000) })}\n`);
    await source('archived_sessions/truncated.jsonl.zst', compressed.subarray(0, compressed.length - 3));
    await source('archived_sessions/broken.jsonl.zst', 'not zstandard');
    const result = await preview();
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.issues.invalid_compression).toBe(2);
    expect(result.totals.tokensIn).toBe(0);
  });

  it('reports unsupported native compression without invoking an external decoder', async () => {
    await source('sessions/a.jsonl.zst', zlib.zstdCompressSync(serialize(records())));
    const result = await preview({ decompress: null });
    expect(result).toMatchObject({ compressionSupported: false, coverage: { complete: false, issues: { unsupported_compression: 1 } } });
    expect(result.totals.tokensIn).toBe(0);
  });

  it('rejects missing, impossible, reversed and oversized ranges and any apply mode before scanning', async () => {
    for (const args of [[], ['--from', '2026-02-30', '--to', range.to], ['--from', range.to, '--to', range.from],
      ['--from', '2025-01-01', '--to', '2026-01-02'], ['--from', range.from, '--to', range.to, '--apply', 'yes']]) {
      const result = await command(args);
      expect(result.code).toBe(1);
      expect(result.result.error).toMatch(/^INVALID_/);
    }
  });

  it('caps file discovery and decoded bytes and never includes partial source totals', async () => {
    await source('sessions/a.jsonl', serialize(records('first')));
    await source('sessions/b.jsonl', serialize(records('second')));
    const files = await preview({ limits: { files: 1 } });
    expect(files).toMatchObject({ stopped: 'file_limit', coverage: { complete: false, filesInspected: 1 } });
    const bytes = await preview({ limits: { decodedBytes: 50 } });
    expect(bytes.stopped).toBe('decoded_byte_limit');
    expect(bytes.coverage.decodedBytes).toBeGreaterThan(50);
    expect(bytes.coverage.decodedBytes).toBeLessThanOrEqual(50 + 64 * 1024);
    expect(bytes.totals.tokensIn).toBe(0);
    await expect(preview({ limits: { files: Infinity } })).rejects.toThrow('INVALID_LIMIT');
  });

  it('bounds non-source discovery, metadata records and lines, including highly compressed plaintext', async () => {
    await source('sessions/ignore.txt', 'irrelevant');
    await source('sessions/a.jsonl.zst', zlib.zstdCompressSync(serialize(records())));
    expect((await preview({ limits: { entries: 1 } })).stopped).toBe('entry_limit');
    expect((await preview({ limits: { records: 1 } })).stopped).toBe('record_limit');
    const result = await preview({ limits: { lineBytes: 50 } });
    expect(result.coverage.issues.line_limit).toBe(1);
    expect(result.totals.tokensIn).toBe(0);
  });

  it('reports cancellation and a deterministic deadline without returning partial counts', async () => {
    await source('sessions/a.jsonl.zst', zlib.zstdCompressSync(serialize(records())));
    const controller = new AbortController();
    const result = await preview({ signal: controller.signal, decompress: () => { controller.abort(); return zlib.createZstdDecompress(); } });
    expect(result).toMatchObject({ stopped: 'cancelled', coverage: { complete: false } });
    expect(result.totals.tokensIn).toBe(0);
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValueOnce(now).mockReturnValue(now + 100);
    expect((await preview({ limits: { milliseconds: 10 } })).stopped).toBe('time_limit');
  });

  it('detects a file growing during the read and excludes its captured prefix', async () => {
    const path = await source('sessions/growing.jsonl.zst', zlib.zstdCompressSync(serialize(records())));
    let growth;
    const result = await preview({ decompress: () => {
      growth = appendFile(path, zlib.zstdCompressSync(serialize([count('2026-07-02', 1000)])));
      const decoder = zlib.createZstdDecompress();
      const flush = decoder._flush.bind(decoder);
      decoder._flush = callback => { void growth.then(() => flush(callback), callback); };
      return decoder;
    } });
    await growth;
    expect(result.coverage.issues.source_changed).toBe(1);
    expect(result.totals.tokensIn).toBe(0);
  });

  it('does not follow symlinked history or treat an empty synthetic home as a read failure', async () => {
    expect((await preview()).coverage.complete).toBe(true);
    await source('outside.jsonl', serialize(records()));
    await symlink(join(home, '.codex'), join(home, '.codex', 'sessions'), 'dir');
    const result = await preview();
    expect(result.coverage).toMatchObject({ complete: false, filesInspected: 0, issues: { unsupported_entry: 1 } });
  });
});
