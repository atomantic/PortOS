import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
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
