import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-cc-transcripts-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
afterAll(cleanup);

const line = (id, model, timestamp, usage) => JSON.stringify({
  type: 'assistant', timestamp, requestId: `req-${id}`, message: { id, model, usage }
});
const u = (o) => ({ input_tokens: 1, output_tokens: o, cache_read_input_tokens: 10, cache_creation_input_tokens: 100 });

describe('claude code transcript usage', () => {
  let root;
  let svc;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cc-usage-'));
    vi.resetModules();
    svc = await import('./claudeCodeTranscriptUsage.js');
    // The data root is shared by every case in this file; start each with no store.
    await rm(svc.TRANSCRIPT_USAGE_FILE, { force: true });
    await mkdir(join(root, 'proj-a', 'sess', 'subagents'), { recursive: true });
    await mkdir(join(root, 'proj-b'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('buckets by day and model, dedupes streamed/forked copies (last wins), reads subagent files', async () => {
    await writeFile(join(root, 'proj-a', 's1.jsonl'), [
      line('m1', 'model-x', '2026-09-10T01:00:00Z', u(5)),
      line('m1', 'model-x', '2026-09-10T01:00:01Z', u(50)), // streamed rewrite — last wins
      line('m2', 'model-y', '2026-09-11T01:00:00Z', u(7)),
      line('ms', '<synthetic>', '2026-09-10T02:00:00Z', u(1)),
      JSON.stringify({ type: 'user', message: { usage: u(1) } }),
      'not json "usage"'
    ].join('\n'));
    await writeFile(join(root, 'proj-b', 's2.jsonl'), line('m1', 'model-x', '2026-09-10T01:00:01Z', u(50)) + '\n'); // forked replay
    await writeFile(join(root, 'proj-a', 'sess', 'subagents', 'a.jsonl'), line('m3', 'model-x', '2026-09-12T00:00:00Z', u(3)) + '\n');

    const { days } = await svc.refreshLocalTranscriptUsage({ root, force: true });
    expect(days['2026-09-10']['model-x']).toEqual({ messages: 1, input: 1, output: 50, cacheRead: 10, cacheWrite: 100 });
    expect(Object.keys(days).sort()).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
    expect(days['2026-09-12']['model-x'].output).toBe(3);
  });

  it('keeps the final streamed output across copied transcripts in either file order', async () => {
    const final = JSON.stringify({
      type: 'assistant', timestamp: '2026-09-10T01:00:01Z', requestId: 'req-shared',
      message: { id: 'shared', model: 'model-x', stop_reason: 'end_turn', usage: u(50) }
    });
    const partial = line('shared', 'model-x', '2026-09-10T01:00:00Z', u(5));

    for (const finalFirst of [true, false]) {
      const orderedRoot = join(root, finalFirst ? 'final-first' : 'partial-first');
      const a = join(orderedRoot, 'a.jsonl');
      const b = join(orderedRoot, 'b.jsonl');
      await mkdir(orderedRoot, { recursive: true });
      await writeFile(a, `${finalFirst ? final : partial}\n`);
      await writeFile(b, `${finalFirst ? partial : final}\n`);
      await rm(svc.TRANSCRIPT_USAGE_FILE, { force: true });
      const { days } = await svc.refreshLocalTranscriptUsage({ root: orderedRoot, force: true });
      expect(days['2026-09-10']['model-x'].output).toBe(50);
    }
  });

  it('persists history past transcript pruning and never shrinks a stored day', async () => {
    const file = join(root, 'proj-b', 's.jsonl');
    await writeFile(file, [line('a', 'model-x', '2026-01-05T00:00:00Z', u(9)), line('b', 'model-x', '2026-01-05T00:00:01Z', u(9))].join('\n'));
    await svc.refreshLocalTranscriptUsage({ root, force: true });
    await rm(file); // the CLI prunes the transcript
    await svc.refreshLocalTranscriptUsage({ root, force: true });
    const { days, updatedAt } = await svc.readLocalTranscriptUsage();
    expect(days['2026-01-05']['model-x'].messages).toBe(2);
    expect(updatedAt).toBeTruthy();
  });

  it('refuses to overwrite a damaged store with a partial rescan', async () => {
    await writeFile(svc.TRANSCRIPT_USAGE_FILE, '{ not json');
    await expect(svc.refreshLocalTranscriptUsage({ root, force: true })).rejects.toThrow();
    expect(await readFile(svc.TRANSCRIPT_USAGE_FILE, 'utf8')).toBe('{ not json');
  });

  it('rebuilds peer-supplied days to the fixed shape', () => {
    const out = svc.sanitizeTranscriptDays({ '2026-09-10': { m: { messages: 1, input: -5, evil: 9, output: 'x' } }, bad: { m: {} }, '2026-09-11': 'nope' });
    expect(out).toEqual({ '2026-09-10': { m: { messages: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  });

  it('discards prototype-polluting model keys during scan and merge without polluting Object.prototype', async () => {
    await writeFile(join(root, 'proj-a', 's1.jsonl'), [
      line('p1', '__proto__', '2026-09-10T01:00:00Z', u(50)),
      line('p2', 'constructor', '2026-09-10T01:00:00Z', u(50)),
      line('p3', 'prototype', '2026-09-10T01:00:00Z', u(50)),
      line('m1', 'model-valid', '2026-09-10T01:00:00Z', u(10)),
    ].join('\n'));

    const { days } = await svc.refreshLocalTranscriptUsage({ root, force: true });
    expect(days['2026-09-10']['model-valid']).toBeDefined();
    expect(Object.prototype.messages).toBeUndefined();
    expect(Object.prototype.output).toBeUndefined();
    expect(Object.prototype.input).toBeUndefined();
    expect(Object.hasOwn(days['2026-09-10'], '__proto__')).toBe(false);
    expect(Object.hasOwn(days['2026-09-10'], 'constructor')).toBe(false);
    expect(Object.hasOwn(days['2026-09-10'], 'prototype')).toBe(false);
  });

  it('filters prototype polluting and inherited keys in sanitizeTranscriptDays', () => {
    const raw = JSON.parse('{"2026-09-10":{"__proto__":{"messages":10,"output":50},"constructor":{"messages":1},"prototype":{"messages":1},"m":{"messages":2}},"__proto__":{"2026-09-10":{"m":{"messages":5}}}}');
    const out = svc.sanitizeTranscriptDays(raw);
    expect(Object.prototype.messages).toBeUndefined();
    expect(Object.prototype.output).toBeUndefined();
    expect(Object.keys(out['2026-09-10'])).toEqual(['m']);
    expect(out['2026-09-10'].m.messages).toBe(2);
  });

  it('safely handles inherited Object.prototype property names in merge without producing NaN', async () => {
    await writeFile(join(root, 'proj-a', 's1.jsonl'), [
      line('t1', 'toString', '2026-09-10T01:00:00Z', u(10)),
    ].join('\n'));

    const { days } = await svc.refreshLocalTranscriptUsage({ root, force: true });
    expect(days['2026-09-10'].toString).toEqual({ messages: 1, input: 1, output: 10, cacheRead: 10, cacheWrite: 100 });
    expect(typeof Object.prototype.toString).toBe('function');
  });
});
