import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { getNativeTranscriptCoverage } from './nativeTranscriptCoverage.js';

let home;
beforeEach(async () => { vi.stubEnv('CLAUDE_CONFIG_DIR', ''); home = await mkdtemp(join(tmpdir(), 'native-coverage-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });
const claude = (id, output = 5) => ({ type: 'assistant', timestamp: '2026-03-01T00:00:00Z', message: { id, usage: {
  input_tokens: 10, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 2,
} } });
const save = async (path, records) => {
  const file = join(home, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n');
  return file;
};

describe('read-only native retained history', () => {
  it('deduplicates Claude parent/copied/subagent emissions, excludes conflicts and never changes native files', async () => {
    const file = await save('.claude/projects/project/session.jsonl', [claude('a'), claude('conflict'), claude('missing'), '{invalid']);
    const missing = claude('missing'); delete missing.message.usage.output_tokens;
    await save('.claude/projects/project/session/subagents/agent.jsonl', [{ ...claude('a'), timestamp: '2026-03-02T00:00:00Z' }, claude('b'), claude('conflict', 9), missing, { type: 'assistant', message: { usage: claude('a').message.usage } }]);
    const before = await readFile(file, 'utf8');
    const result = await getNativeTranscriptCoverage('claude', { home });
    expect(result).toMatchObject({ status: 'partial', scope: 'local-retained-transcripts', completeness: 'unknown',
      summary: { totalTokens: 40, tokensIn: 20, tokensOut: 10, cacheReadTokens: 6, cacheWriteTokens: 4 },
      coverage: { files: 2, measuredRecords: 2, duplicateRecords: 3, conflictingRecords: 2, missingUsageRecords: 1,
        missingIdentityRecords: 1, invalidLines: 1, undatedRecords: 1, firstObservedAt: '2026-03-01T00:00:00.000Z' }, cost: { usd: null, kind: 'unknown' } });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(JSON.stringify(result)).not.toContain(home);
    expect(JSON.stringify(result)).not.toContain('conflict"');
  });

  it('honors the configured Claude directory without mixing in the default source', async () => {
    await save('.claude/projects/default/session.jsonl', [claude('default')]);
    await save('configured/projects/project/session.jsonl', [claude('configured', 8)]);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'configured'));
    const result = await getNativeTranscriptCoverage('claude', { home });
    expect(result).toMatchObject({ summary: { tokensOut: 8 }, coverage: { measuredRecords: 1 } });
    expect(JSON.stringify(result)).not.toContain(home);
  });

  it('distinguishes absent, unreadable, capped and empty retained sources without exposing paths', async () => {
    const missing = await getNativeTranscriptCoverage('claude', { home });
    expect(missing).toMatchObject({ status: 'unavailable', summary: null, coverage: { missingSource: true } });
    expect(missing.reason).toContain('directory was found');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/projects'), 'not a directory');
    const unreadable = await getNativeTranscriptCoverage('claude', { home });
    expect(unreadable.reason).toContain('could not be fully read');
    await rm(join(home, '.claude/projects'));
    await save('.claude/projects/project/session.jsonl', [{ type: 'user' }]);
    expect((await getNativeTranscriptCoverage('claude', { home })).reason).toContain('does not establish zero');
    expect((await getNativeTranscriptCoverage('claude', { home, limits: { bytes: 1 } })).reason).toContain('safety limit');
  });

  it('reports only the measured Antigravity planner subset without inventing input/cache or cost semantics', async () => {
    const step = { type: 'PLANNER_RESPONSE', step_index: 1, created_at: '2026-03-02T12:00:00Z', input_tokens: 20, output_tokens: 4, cache_read_tokens: 10 };
    await save('.gemini/antigravity-cli/brain/session/.system_generated/logs/transcript.jsonl', [step, step,
      { type: 'VIEW_FILE', step_index: 2 }, { type: 'PLANNER_RESPONSE', step_index: 3 }]);
    const result = await getNativeTranscriptCoverage('agy', { home });
    expect(result).toMatchObject({ status: 'partial', semantics: 'measured-record-subset', summary: {
      totalTokens: null, tokensIn: 20, tokensOut: 4, cacheReadTokens: 10, cacheWriteTokens: null,
    }, coverage: { records: 3, measuredRecords: 1, missingUsageRecords: 1, duplicateRecords: 1 } });
  });

  it('never sums Grok counters even when their sequence looks per-turn or monotonic', async () => {
    const turn = (id, inputTokens) => ({ timestamp: 1772323200, params: { sessionId: 'synthetic', update: {
      sessionUpdate: 'turn_completed', prompt_id: id, usage: { inputTokens, outputTokens: 7, modelUsage: { example: { inputTokens, outputTokens: 7 } } },
    } } });
    await save('.grok/sessions/project/session/updates.jsonl', [turn('a', 10), turn('b', 20), turn('c', 30), turn('a', 10), turn(null, 4)]);
    const result = await getNativeTranscriptCoverage('grok', { home });
    expect(result).toMatchObject({ status: 'partial', summary: null, semantics: 'unvalidated-turn-counters',
      coverage: { measuredRecords: 3, duplicateRecords: 1, missingIdentityRecords: 1 } });
  });

  it('keeps missing sources, missing fields, bad values and interrupted lines unknown rather than zero-complete', async () => {
    expect(await getNativeTranscriptCoverage('agy', { home })).toMatchObject({ status: 'unavailable', summary: null });
    const bad = claude('bad', -1);
    const file = await save('.claude/projects/p/s.jsonl', [bad, claude('unsafe', Number.MAX_SAFE_INTEGER + 1)]);
    await writeFile(file, JSON.stringify(claude('inflight')) , { flag: 'a' });
    expect(await getNativeTranscriptCoverage('claude', { home })).toMatchObject({ status: 'partial', summary: null,
      coverage: { measuredRecords: 0, missingUsageRecords: 2, invalidLines: 1 } });
  });

  it('resolves streamed Claude emissions to the final one whatever order the copies are read in', async () => {
    const emission = (output, final) => { const row = claude('m', output); row.requestId = 'r'; row.message.stop_reason = final ? 'end_turn' : null; return row; };
    const orders = [[[3, false], [7, false], [9, true]], [[9, true], [3, false], [7, false]], [[7, false], [9, true], [3, false]]];
    for (const [index, order] of orders.entries()) {
      await rm(join(home, '.claude'), { recursive: true, force: true });
      await save(`.claude/projects/p/${index}.jsonl`, order.map(([output, final]) => emission(output, final)));
      expect(await getNativeTranscriptCoverage('claude', { home })).toMatchObject({ status: 'available',
        summary: { tokensOut: 9 }, coverage: { measuredRecords: 1, conflictingRecords: 0, streamingSupersededRecords: 2 } });
    }
    // A final emission smaller than a partial, in either order, cannot be a stream.
    for (const order of [[[12, false], [9, true]], [[9, true], [12, false]]]) {
      await rm(join(home, '.claude'), { recursive: true, force: true });
      await save('.claude/projects/p/s.jsonl', order.map(([output, final]) => emission(output, final)));
      expect(await getNativeTranscriptCoverage('claude', { home })).toMatchObject({ summary: null, coverage: { conflictingRecords: 1 } });
    }
  });

  it('projects private, sorted Claude identities and deterministic tombstones regardless of emission order', async () => {
    const first = claude('private-message', 9);
    first.requestId = 'private-request';
    first.message.stop_reason = 'end_turn';
    first.message.content = 'private prompt';
    const copy = { ...first, timestamp: '2026-03-03T00:00:00Z' };
    const bad = claude('invalid', -1);
    const inconsistent = claude('inconsistent');
    inconsistent.message.usage.cache_creation = { ephemeral_5m_input_tokens: 90 };
    const differentRequest = { ...claude('request-collision'), requestId: 'different-request' };
    const rows = [copy, first, bad, inconsistent, claude('request-collision'), differentRequest];
    let projection;
    for (const order of [rows, [...rows].reverse()]) {
      await save('.claude/projects/private-project/s.jsonl', order);
      const result = await getNativeTranscriptCoverage('claude', { home, includeRecords: true });
      expect(result).toMatchObject({ summary: { tokensOut: 9 }, coverage: { measuredRecords: 1, conflictingRecords: 1, fieldInconsistentRecords: 1 },
        recordProjection: { version: 1, identityScheme: 'sha256-native-record/1', truncated: false } });
      const records = result.recordProjection.records;
      expect(records).toHaveLength(4);
      expect(records.map(row => row.recordKey)).toEqual(records.map(row => row.recordKey).sort());
      expect(records.find(row => row.final)).toMatchObject({ requestKey: expect.stringMatching(/^[a-f0-9]{64}$/), at: '2026-03-01T00:00:00.000Z' });
      expect(records.find(row => row.conflict)).toMatchObject({ values: [null, null, null, null], requestKey: null, final: false });
      expect(records.some(row => row.values[1] === null && !row.conflict)).toBe(true);
      for (const row of records) expect(Object.keys(row).sort()).toEqual(['at', 'conflict', 'final', 'inconsistent', 'recordKey', 'requestKey', 'values']);
      expect(JSON.stringify(result)).not.toMatch(/private-message|private-request|private prompt|private-project|different-request/);
      if (projection) expect(result.recordProjection).toEqual(projection);
      projection = result.recordProjection;
    }
    expect(await getNativeTranscriptCoverage('claude', { home })).not.toHaveProperty('recordProjection');
    for (const family of ['agy', 'grok']) expect(await getNativeTranscriptCoverage(family, { home, includeRecords: true })).toHaveProperty('recordProjection', null);
  });

  it('counts superseded streaming copies consistently and excludes incompatible inputs and competing finals', async () => {
    const emission = (id, output, final = false) => {
      const row = claude(id, output); row.requestId = 'request'; row.message.stop_reason = final ? 'end_turn' : null; return row;
    };
    const inputConflict = emission('input-conflict', 9, true); inputConflict.message.usage.input_tokens = 11;
    const rows = [emission('stream', 3), emission('stream', 3), emission('stream', 7), emission('stream', 9, true),
      emission('input-conflict', 3), inputConflict, emission('final-conflict', 3, true), emission('final-conflict', 9, true),
      emission('unfinished', 3), emission('unfinished', 9)];
    let projection;
    for (const order of [rows, [...rows].reverse(), [...rows.slice(2), ...rows.slice(0, 2)]]) {
      await save('.claude/projects/p/s.jsonl', order);
      const result = await getNativeTranscriptCoverage('claude', { home, includeRecords: true });
      expect(result).toMatchObject({ summary: { tokensOut: 9 }, coverage: { measuredRecords: 1, conflictingRecords: 3, streamingSupersededRecords: 3 } });
      if (projection) expect(result.recordProjection).toEqual(projection);
      projection = result.recordProjection;
    }
  });

  it('fingerprints the full Grok usage shape canonically without summing unvalidated counters', async () => {
    const usage = { inputTokens: 10, outputTokens: 7, totalTokens: 17, reasoningTokens: 2, costUsdTicks: 12,
      modelUsage: { second: { outputTokens: 3, inputTokens: 4 }, first: { inputTokens: 6, outputTokens: 4 } } };
    const turn = (id, values) => ({ timestamp: 1772323200, params: { sessionId: 'synthetic', update: {
      sessionUpdate: 'turn_completed', prompt_id: id, usage: values,
    } } });
    await save('.grok/sessions/project/session/updates.jsonl', [turn('same', usage), turn('same', {
      ...usage, modelUsage: { first: { outputTokens: 4, inputTokens: 6 }, second: { inputTokens: 4, outputTokens: 3 } },
    }), ...['totalTokens', 'reasoningTokens', 'costUsdTicks'].flatMap(field => [turn(field, usage), turn(field, { ...usage, [field]: usage[field] + 1 })])]);
    expect(await getNativeTranscriptCoverage('grok', { home })).toMatchObject({ summary: null,
      coverage: { measuredRecords: 1, duplicateRecords: 4, conflictingRecords: 3, fieldInconsistentRecords: 1 } });
  });

  it('retains the same bounded runtime version evidence regardless of file order', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ ...claude(`version-${index}`), version: `1.0.${index}` }));
    const expected = rows.map(row => row.version).sort().slice(0, 32);
    for (const order of [rows, [...rows].reverse(), [...rows.slice(20), ...rows.slice(0, 20)]]) {
      await save('.claude/projects/p/s.jsonl', order);
      expect((await getNativeTranscriptCoverage('claude', { home })).coverage.runtimeVersions).toEqual(expected);
    }
  });

  it('keeps scanning past an oversized record and reports it instead of stopping', async () => {
    // One line wholly inside a read chunk, and one spanning several.
    const small = JSON.stringify({ type: 'user', content: 'x'.repeat(2 * 1024) });
    const big = JSON.stringify({ type: 'user', content: 'x'.repeat(200 * 1024) });
    await save('.claude/projects/p/s.jsonl', [claude('a'), small, big, claude('b')]);
    // An unterminated oversized tail that ends in a short final chunk is still that line, not an invalid one.
    const trailing = await save('.claude/projects/p/t.jsonl', [claude('c')]);
    const { size } = await stat(trailing);
    await writeFile(trailing, 'x'.repeat(3 * 64 * 1024 + 100 - size), { flag: 'a' });
    const result = await getNativeTranscriptCoverage('claude', { home, limits: { lineBytes: 1024 } });
    expect(result).toMatchObject({ status: 'partial', summary: { tokensIn: 30 },
      coverage: { measuredRecords: 3, capped: true, stoppedEarly: false, oversizedLines: 3, invalidLines: 0 } });
  });

  it('bounds bytes, line length, enumeration, record memory and time without following symlinks', async () => {
    const file = await save('.claude/projects/p/s.jsonl', [claude('a'), claude('b')]);
    for (const limits of [{ bytes: 1 }, { lineBytes: 1 }, { entries: 1 }, { records: 1 }, { milliseconds: 0 }]) {
      const result = await getNativeTranscriptCoverage('claude', { home, limits });
      expect(result.coverage.capped).toBe(true);
      expect(result.completeness).toBe('unknown');
    }
    await symlink(file, join(home, '.claude/projects/p/copy.jsonl'));
    expect(await getNativeTranscriptCoverage('claude', { home })).toMatchObject({ status: 'partial', coverage: { skippedLinks: 1, measuredRecords: 2 } });
  });
});
