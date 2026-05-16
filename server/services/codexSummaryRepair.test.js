import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { repairCodexTaskSummary, isWonkyTaskSummary } from './codexSummaryRepair.js';

describe('isWonkyTaskSummary', () => {
  it('returns false for short summaries', () => {
    expect(isWonkyTaskSummary('A short summary.\n- bullet')).toBe(false);
  });

  it('returns false for empty/non-string input', () => {
    expect(isWonkyTaskSummary('')).toBe(false);
    expect(isWonkyTaskSummary(null)).toBe(false);
    expect(isWonkyTaskSummary(undefined)).toBe(false);
  });

  it('returns true for summaries above the 20KB threshold', () => {
    expect(isWonkyTaskSummary('x'.repeat(20_001))).toBe(true);
  });
});

describe('repairCodexTaskSummary', () => {
  let agentDir;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'codex-repair-'));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  async function seed(metadata, outputBuffer) {
    await writeFile(join(agentDir, 'metadata.json'), JSON.stringify({ id: 'agent-test', metadata }, null, 2));
    if (outputBuffer != null) await writeFile(join(agentDir, 'output.txt'), outputBuffer);
  }

  it('rewrites metadata.json when stored summary is wonky and tail is recoverable', async () => {
    const fakeTranscript = 'x'.repeat(25_000);
    const output = [
      fakeTranscript,
      'apply patch',
      'diff --git a/foo b/foo',
      '+something',
      'tokens used',
      '12,345',
      'Final assistant summary.',
      '- bullet one',
    ].join('\n');

    await seed({ taskSummary: fakeTranscript }, output);

    const repaired = await repairCodexTaskSummary(agentDir, { id: 'agent-test', metadata: { taskSummary: fakeTranscript } });
    expect(repaired).toBe('Final assistant summary.\n- bullet one');

    const persisted = JSON.parse(await readFile(join(agentDir, 'metadata.json'), 'utf-8'));
    expect(persisted.metadata.taskSummary).toBe('Final assistant summary.\n- bullet one');
  });

  it('returns null and leaves metadata untouched when summary is below threshold', async () => {
    await seed({ taskSummary: 'short' }, 'tokens used\n123\nA tail');
    const before = await readFile(join(agentDir, 'metadata.json'), 'utf-8');

    const result = await repairCodexTaskSummary(agentDir, { id: 'agent-test', metadata: { taskSummary: 'short' } });
    expect(result).toBeNull();

    const after = await readFile(join(agentDir, 'metadata.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('returns null when output.txt is missing', async () => {
    await seed({ taskSummary: 'x'.repeat(25_000) }, null);

    const result = await repairCodexTaskSummary(agentDir, { id: 'agent-test', metadata: { taskSummary: 'x'.repeat(25_000) } });
    expect(result).toBeNull();
  });

  it('returns null when output.txt has no Codex markers (cannot extract tail)', async () => {
    const wonky = 'x'.repeat(25_000);
    await seed({ taskSummary: wonky }, 'Just a Claude transcript with 🔧 Using Read\nNo codex markers.');

    const result = await repairCodexTaskSummary(agentDir, { id: 'agent-test', metadata: { taskSummary: wonky } });
    expect(result).toBeNull();
  });

  it('preserves other metadata fields when persisting the repair', async () => {
    const wonky = 'x'.repeat(25_000);
    const output = 'apply patch\ntokens used\n100\nThe real summary.';
    await seed({ taskSummary: wonky, providerId: 'codex', model: 'gpt-5' }, output);

    await repairCodexTaskSummary(agentDir, { id: 'agent-test', metadata: { taskSummary: wonky } });

    const persisted = JSON.parse(await readFile(join(agentDir, 'metadata.json'), 'utf-8'));
    expect(persisted.metadata.providerId).toBe('codex');
    expect(persisted.metadata.model).toBe('gpt-5');
    expect(persisted.metadata.taskSummary).toBe('The real summary.');
  });

  it('also clears wonky simplifySummary (Codex cannot run /simplify)', async () => {
    const wonkyTask = 'x'.repeat(25_000);
    const wonkySimplify = 'y'.repeat(25_000);
    const output = 'apply patch\ntokens used\n100\nThe real summary.';
    await seed({ taskSummary: wonkyTask, simplifySummary: wonkySimplify }, output);

    const repaired = await repairCodexTaskSummary(agentDir, { id: 'agent-test', metadata: { taskSummary: wonkyTask, simplifySummary: wonkySimplify } });
    expect(repaired).toBe('The real summary.');

    const persisted = JSON.parse(await readFile(join(agentDir, 'metadata.json'), 'utf-8'));
    expect(persisted.metadata.taskSummary).toBe('The real summary.');
    expect(persisted.metadata.simplifySummary).toBeNull();
  });

  it('repairs when only simplifySummary is wonky (taskSummary already small)', async () => {
    const wonkySimplify = 'y'.repeat(25_000);
    const output = 'apply patch\ntokens used\n100\nFinal summary.';
    await seed({ taskSummary: 'already small', simplifySummary: wonkySimplify }, output);

    const repaired = await repairCodexTaskSummary(agentDir, { id: 'agent-test', metadata: { taskSummary: 'already small', simplifySummary: wonkySimplify } });
    expect(repaired).toBe('Final summary.');

    const persisted = JSON.parse(await readFile(join(agentDir, 'metadata.json'), 'utf-8'));
    expect(persisted.metadata.simplifySummary).toBeNull();
  });
});
