import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { encodeMessage } from '../lib/protobufWire.js';

const { makeProxy, cleanup, tempRoot } = mockPathsDataRoot({ prefix: 'portos-native-usage-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
afterAll(cleanup);

const NOW = Date.parse('2026-07-20T12:00:00.000Z');
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const speedZero = {
  fastInput: 0, fastOutput: 0, fastCacheRead: 0, fastCacheWrite: 0,
  ultrafastInput: 0, ultrafastOutput: 0, ultrafastCacheRead: 0, ultrafastCacheWrite: 0,
};
const withSpeed = (counts) => ({ ...counts, ...speedZero });
const codexTotal = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const codexRollout = (id) => jsonl([
  { type: 'session_meta', payload: { id, cwd: '/example/workspace', model: 'example-codex' } },
  { timestamp: '2026-07-18T23:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'SYNTHETIC' } },
  { timestamp: '2026-07-18T23:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: codexTotal(100, 40, 10) } } },
  { timestamp: '2026-07-19T01:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'SYNTHETIC' } },
  { timestamp: '2026-07-19T01:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: codexTotal(300, 140, 25) } } },
]);
const AGY_METADATA = {
  created: { no: 1, type: 'message', schema: { seconds: { no: 1, type: 'varint' } } },
  usage: { no: 9, type: 'message', schema: {
    input: { no: 2, type: 'varint' }, output: { no: 3, type: 'varint' }, cacheWrite: { no: 4, type: 'varint' }, cacheRead: { no: 5, type: 'varint' },
  } },
};
const agyDatabase = async (path, steps) => {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, metadata BLOB)');
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)');
  const insert = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
  steps.forEach(({ type, at, usage }, idx) => insert.run(idx, type, encodeMessage(AGY_METADATA, { created: { seconds: Date.parse(at) / 1000 }, usage })));
  db.close();
};
const grokTurn = (promptId, ms, usage, model = 'example-grok') => ({ params: { sessionId: 'grok-session', _meta: { agentTimestampMs: ms },
  update: { sessionUpdate: 'turn_completed', prompt_id: promptId, usage: { ...usage, modelUsage: { [model]: {} } } } } });

let home;
let history;
const write = async (path, text, mtime = NOW) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await utimes(path, mtime / 1000, mtime / 1000);
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'native-usage-home-'));
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
  vi.resetModules();
  history = await import('./nativeUsageHistory.js');
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

describe('native usage history', () => {
  it('splits a Codex rollout into UTC days by its cumulative counters and counts a copied rollout once', async () => {
    await write(join(home, '.codex', 'sessions', '2026', '07', '18', 'rollout-a.jsonl'), codexRollout('session-a'));
    await write(join(home, '.codex', 'archived_sessions', 'rollout-a.jsonl'), codexRollout('session-a'));
    const result = await history.NATIVE_USAGE_STORES.codex.refresh({ home, force: true, now: NOW });
    expect(result.refreshed).toBe(true);
    expect(result.days['2026-07-18']['example-codex']).toEqual(withSpeed({ messages: 1, input: 60, output: 10, cacheRead: 40, cacheWrite: 0 }));
    expect(result.days['2026-07-19']['example-codex']).toEqual(withSpeed({ messages: 1, input: 100, output: 15, cacheRead: 100, cacheWrite: 0 }));
    // First scan read everything: complete from the app's retention floor or its first day.
    expect(result.coverageStart).toBe('2026-07-18');
  });

  it('counts each Codex call once by its own counters: repeats, inherited fork bases and replayed parent events are not added', async () => {
    const call = (at, total, last) => ({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
    await write(join(home, '.codex', 'sessions', '2026', '07', '19', 'parent.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'parent', model: 'example-codex' } },
      call('2026-07-19T01:00:00.000Z', codexTotal(100, 0, 10), codexTotal(100, 0, 10)),
      // A rate-limit refresh repeats the total.
      call('2026-07-19T01:00:05.000Z', codexTotal(100, 0, 10), codexTotal(100, 0, 10)),
      call('2026-07-19T02:00:00.000Z', codexTotal(300, 0, 30), codexTotal(200, 0, 20)),
    ]));
    await write(join(home, '.codex', 'sessions', '2026', '07', '19', 'fork.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'fork', forked_from_id: 'parent', model: 'example-codex' } },
      { type: 'session_meta', payload: { id: 'parent', model: 'example-codex' } },
      // Replay of the parent's second call under a new timestamp.
      call('2026-07-19T03:00:00.000Z', codexTotal(300, 0, 30), codexTotal(200, 0, 20)),
      // The fork's own call: its total starts from the inherited base.
      { type: 'turn_context', payload: { model: 'example-codex-mini' } },
      call('2026-07-19T04:00:00.000Z', codexTotal(350, 0, 35), codexTotal(50, 0, 5)),
    ]));
    const result = await history.NATIVE_USAGE_STORES.codex.refresh({ home, force: true, now: NOW });
    expect(result.days['2026-07-19']).toEqual({
      'example-codex': withSpeed({ messages: 2, input: 300, output: 30, cacheRead: 0, cacheWrite: 0 }),
      'example-codex-mini': withSpeed({ messages: 1, input: 50, output: 5, cacheRead: 0, cacheWrite: 0 }),
    });
  });

  it('reads an unchanged fork parent during an incremental Codex pass, so a new fork never re-counts its replay', async () => {
    const call = (at, total, last) => ({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
    await write(join(home, '.codex', 'sessions', '2026', '07', '10', 'parent.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'parent', model: 'example-codex' } },
      call('2026-07-10T01:00:00.000Z', codexTotal(200, 0, 20), codexTotal(200, 0, 20)),
    ]), NOW - 10 * 86_400_000);
    await history.NATIVE_USAGE_STORES.codex.refresh({ home, force: true, now: NOW });
    await write(join(home, '.codex', 'sessions', '2026', '07', '20', 'fork.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'fork', forked_from_id: 'parent', model: 'example-codex' } },
      { type: 'session_meta', payload: { id: 'parent', model: 'example-codex' } },
      call('2026-07-20T01:00:00.000Z', codexTotal(200, 0, 20), codexTotal(200, 0, 20)),
      call('2026-07-20T02:00:00.000Z', codexTotal(250, 0, 25), codexTotal(50, 0, 5)),
    ]));
    const result = await history.NATIVE_USAGE_STORES.codex.refresh({ home, force: true, now: NOW + 60_000 });
    expect(result.days['2026-07-20']).toEqual({ 'example-codex': withSpeed({ messages: 1, input: 50, output: 5, cacheRead: 0, cacheWrite: 0 }) });
    expect(result.days['2026-07-10']['example-codex']).toMatchObject({ messages: 1, input: 200 });
  });

  it('counts a Codex cache write as its own tier, carved out of input apart from the cached read', async () => {
    const usage = { ...codexTotal(1000, 600, 50), cache_write_input_tokens: 300 };
    await write(join(home, '.codex', 'sessions', '2026', '07', '19', 'rollout-a.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'session-a', model: 'example-codex' } },
      { timestamp: '2026-07-19T01:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } },
    ]));
    const result = await history.NATIVE_USAGE_STORES.codex.refresh({ home, force: true, now: NOW });
    expect(result.days['2026-07-19']['example-codex']).toEqual(withSpeed({ messages: 1, input: 100, output: 50, cacheRead: 600, cacheWrite: 300 }));
  });

  it('attributes a Codex call after thread_settings priority to the fast subset', async () => {
    const total = (input, output) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
    const call = (at, totalUsage, last) => ({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: totalUsage, last_token_usage: last } } });
    const settings = (at, tier) => ({ timestamp: at, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: tier, cwd: '/example/not-stored' } } });
    await write(join(home, '.codex', 'sessions', '2026', '07', '19', 'rollout-fast.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'session-fast', model: 'example-codex' } },
      call('2026-07-19T01:00:00.000Z', total(100, 10), { ...total(100, 10), cached_input_tokens: 0 }),
      settings('2026-07-19T01:00:30.000Z', 'priority'),
      call('2026-07-19T02:00:00.000Z', total(150, 15), { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55 }),
    ]));
    const result = await history.NATIVE_USAGE_STORES.codex.refresh({ home, force: true, now: NOW });
    expect(result.days['2026-07-19']['example-codex']).toEqual({
      ...withSpeed({ messages: 2, input: 140, output: 15, cacheRead: 10, cacheWrite: 0 }),
      fastInput: 40, fastOutput: 5, fastCacheRead: 10,
    });
  });

  it('reads Antigravity usage from the dated conversation DB steps, and the transcript only for a conversation without one', async () => {
    const brain = (id) => join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    const step = (index, at, tokens) => ({ type: 'PLANNER_RESPONSE', step_index: index, created_at: at, content: 'SYNTHETIC', ...tokens });
    await agyDatabase(join(home, '.gemini', 'antigravity-cli', 'conversations', 'conversation-a.db'), [
      { type: 14, at: '2026-07-18T09:00:00Z' },
      { type: 15, at: '2026-07-18T09:00:01Z', usage: { input: 40, output: 12, cacheRead: 900 } },
      // A checkpoint step is billed too; its transcript reader never saw it.
      { type: 23, at: '2026-07-19T09:00:00Z', usage: { input: 7, output: 3 } },
    ]);
    // The same conversation's transcript repeats the planner step: not added.
    await write(brain('conversation-a'), jsonl([step(1, '2026-07-18T09:00:01Z', { input_tokens: 40, cache_read_tokens: 900, output_tokens: 12 })]));
    await write(brain('conversation-b'), jsonl([
      { type: 'USER_INPUT', step_index: 0, created_at: '2026-07-19T09:00:00Z', content: 'SYNTHETIC' },
      step(1, '2026-07-19T09:00:01Z', { input_tokens: 5, cache_read_tokens: 10, output_tokens: 2 }),
      step(1, '2026-07-19T09:00:01Z', { input_tokens: 5, cache_read_tokens: 10, output_tokens: 2 }),
      step(2, '2026-07-19T09:01:00Z', {}),
    ]));
    const result = await history.NATIVE_USAGE_STORES.agy.refresh({ home, force: true, now: NOW });
    expect(result.days['2026-07-18']['(unknown model)']).toEqual({ messages: 1, input: 40, output: 12, cacheRead: 900, cacheWrite: 0 });
    expect(result.days['2026-07-19']['(unknown model)']).toEqual({ messages: 2, input: 12, output: 5, cacheRead: 10, cacheWrite: 0 });
  });

  it('rescans every Antigravity conversation DB once over an older store, so earlier undated-transcript days fill in', async () => {
    const old = NOW - 20 * 86_400_000;
    const store = history.NATIVE_USAGE_STORES.agy;
    await write(store.file, JSON.stringify({ days: {}, updatedAt: new Date(NOW - 60_000).toISOString(), coverageStart: '2026-06-20' }));
    const path = join(home, '.gemini', 'antigravity-cli', 'conversations', 'conversation-a.db');
    await agyDatabase(path, [{ type: 15, at: '2026-06-30T09:00:00Z', usage: { input: 40, output: 12 } }]);
    await utimes(path, old / 1000, old / 1000);
    const result = await store.refresh({ home, force: true, now: NOW });
    expect(result.days['2026-06-30']['(unknown model)']).toMatchObject({ messages: 1, input: 40, output: 12 });
    expect(result.coverageStart).toBe('2026-06-20');
    // Current now: the next pass looks back only a few days and skips the old DB.
    const conversationB = join(home, '.gemini', 'antigravity-cli', 'conversations', 'conversation-b.db');
    await agyDatabase(conversationB, [{ type: 15, at: '2026-06-29T09:00:00Z', usage: { input: 5 } }]);
    await utimes(conversationB, old / 1000, old / 1000);
    expect((await store.refresh({ home, force: true, now: NOW + 60_000 })).days['2026-06-29']).toBeUndefined();
  });

  it('counts a Grok subagent as its own session, never through the parent\'s subagent link', async () => {
    const sessions = join(home, '.grok', 'sessions', encodeURIComponent('/example/workspace'));
    await write(join(sessions, 'parent-session', 'updates.jsonl'), jsonl([
      grokTurn('p1', Date.parse('2026-07-19T10:00:00Z'), { inputTokens: 500, cachedReadTokens: 200, outputTokens: 50 }),
    ]));
    // The parent only links the child; the link carries no usage of its own.
    await write(join(sessions, 'parent-session', 'subagents', 'child-session', 'meta.json'),
      JSON.stringify({ parent_session_id: 'parent-session', child_session_id: 'child-session' }));
    await write(join(sessions, 'child-session', 'updates.jsonl'), jsonl([
      grokTurn('c1', Date.parse('2026-07-19T10:01:00Z'), { inputTokens: 300, cachedReadTokens: 100, outputTokens: 30 }),
    ]));
    const result = await history.NATIVE_USAGE_STORES.grok.refresh({ home, force: true, now: NOW });
    expect(result.days['2026-07-19']['example-grok']).toMatchObject({ messages: 2, input: 500, output: 80, cacheRead: 300 });
  });

  it('sums per-prompt Grok turns per day and keeps the long-context subset', async () => {
    await write(join(home, '.grok', 'sessions', encodeURIComponent('/example/workspace'), 'grok-session', 'updates.jsonl'), jsonl([
      grokTurn('p1', Date.parse('2026-07-19T10:00:00Z'), { inputTokens: 500, cachedReadTokens: 200, outputTokens: 50 }),
      grokTurn('p2', Date.parse('2026-07-19T10:05:00Z'), { inputTokens: 250000, cachedReadTokens: 0, outputTokens: 5 }),
    ]));
    const result = await history.NATIVE_USAGE_STORES.grok.refresh({ home, force: true, now: NOW });
    expect(result.days['2026-07-19']['example-grok']).toEqual({
      messages: 2, input: 250300, output: 55, cacheRead: 200, cacheWrite: 0,
      longInput: 250000, longOutput: 5, longCacheRead: 0, longCacheWrite: 0,
      ...speedZero,
    });
  });

  it('keeps a Grok 4.7 fast turn on grok-4.7 with both the long and fast subsets', async () => {
    await write(join(home, '.grok', 'sessions', encodeURIComponent('/example/workspace'), 'grok-session', 'updates.jsonl'), jsonl([
      grokTurn('fast-long', Date.parse('2026-07-19T10:00:00Z'), { inputTokens: 250000, cachedReadTokens: 0, outputTokens: 5 }, 'grok-4.7[fast=true]'),
    ]));
    const result = await history.NATIVE_USAGE_STORES.grok.refresh({ home, force: true, now: NOW });
    expect(result.days['2026-07-19']['grok-4.7']).toEqual({
      messages: 1, input: 250000, output: 5, cacheRead: 0, cacheWrite: 0,
      longInput: 250000, longOutput: 5, longCacheRead: 0, longCacheWrite: 0,
      ...speedZero,
      fastInput: 250000, fastOutput: 5,
    });
    expect(result.days['2026-07-19']['grok-4.7[fast=true]']).toBeUndefined();
  });

  it('keeps history the app pruned and re-reads only recent days once coverage is known', async () => {
    const path = join(home, '.codex', 'sessions', '2026', '07', '18', 'rollout-a.jsonl');
    await write(path, codexRollout('session-a'));
    await history.NATIVE_USAGE_STORES.codex.refresh({ home, force: true, now: NOW });
    await rm(path);
    const again = await history.NATIVE_USAGE_STORES.codex.refresh({ home, force: true, now: NOW + 60_000 });
    expect(again.days['2026-07-18']['example-codex'].output).toBe(10);
    expect(again.coverageStart).toBe('2026-07-18');
  });

  it('feeds the standard usage report: native tokens replace measured ledger counts, estimates stay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await write(join(home, '.codex', 'sessions', '2026', '07', '18', 'rollout-a.jsonl'), codexRollout('session-a'));
    await history.refreshNativeUsageHistory({ home, force: true });
    const { buildUsageReport } = await import('./usage.js');
    const providers = [{ id: 'codex', name: 'Codex', type: 'cli', command: 'codex', defaultModel: 'example-codex' }];
    const bucket = (tokensIn, tokensOut, source, estimated) => ({ messages: 1, tokensIn, tokensOut, cacheReadTokens: 0, cacheWriteTokens: 0, source, ...(estimated ? { estimated } : {}) });
    const ledger = {
      lastUpdated: '2026-07-19T02:00:00.000Z',
      dailyActivity: { '2026-07-19': { sessions: 2, byProvider: { codex: {
        name: 'Codex', sessions: 2, ...bucket(150, 20, 'mixed', { messages: 1, tokensIn: 50, tokensOut: 5 }),
        byModel: { 'example-codex': { sessions: 2, ...bucket(150, 20, 'mixed', { messages: 1, tokensIn: 50, tokensOut: 5 }) } },
      } } } },
    };
    const reported = history.withNativeUsage(ledger, providers);
    const report = buildUsageReport(reported.dailyActivity, { from: '2026-07-19', to: '2026-07-19', providers });
    const row = report.providers.find((provider) => provider.id === 'codex');
    // 100 fresh + 50 estimated input, 15 + 5 output, 100 cache reads from the rollout.
    expect(row).toMatchObject({ sessions: 2, tokensIn: 150, tokensOut: 20, cacheReadTokens: 100 });
    expect(history.describeNativeUsageSources().find((source) => source.family === 'codex')).toMatchObject({ coverageStart: '2026-07-18', hasHistory: true });
  });

  it('holds a fold back while a Codex source cannot be read, so coverage never starts on a partial scan', async () => {
    await write(join(home, '.codex', 'sessions', '2026', '07', '18', 'rollout-a.jsonl'), '{"type":"session_meta","payload":{"id":"x"}}\n{not json');
    const result = await history.NATIVE_USAGE_STORES.codex.refresh({ home, force: true, now: NOW });
    expect(result).toMatchObject({ refreshed: false, coverageStart: null });
    expect(result.incomplete).toBeTruthy();
  });
});
