/**
 * The optional output-parser verdict a runner attaches to `agent:completed`
 * (fallbackAnalysis, finalSummary, rawStreamTail) must reach `finalizeAgent`
 * through `handleAgentCompletion`, and an event without them must finalize as
 * it always did (an older runner).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../cos/cosState.js', () => ({ getConfig: vi.fn().mockResolvedValue({}) }));
vi.mock('../cos/cosTaskStore.js', () => ({
  updateTask: vi.fn().mockResolvedValue(true),
  getTaskById: vi.fn().mockResolvedValue(null),
}));
vi.mock('../cos/cosAgentLifecycle.js', () => ({
  registerAgent: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
  completeAgent: vi.fn().mockResolvedValue(undefined),
  getAgentRecord: vi.fn().mockResolvedValue(null),
  getAgent: vi.fn().mockResolvedValue(null),
}));
vi.mock('./agentFinalization.js', () => ({
  finalizeAgent: vi.fn().mockResolvedValue(undefined),
  stampLiExecutionVerdict: vi.fn(async (update) => update),
  retireDeadAgent: vi.fn(async ({ success }) => ({ success })),
}));
vi.mock('./agentManagement.js', () => ({ handleOrphanedTask: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn().mockResolvedValue(undefined),
  releaseRetryHold: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./agentCompletionCleanup.js', () => ({
  runAgentCompletionCleanup: vi.fn().mockResolvedValue(undefined),
  removeCompletionSentinel: vi.fn().mockResolvedValue(undefined),
  replayAgentCompletionCleanup: vi.fn().mockResolvedValue(undefined),
}));

const { analyzeAgentFailure } = vi.hoisted(() => ({ analyzeAgentFailure: vi.fn() }));
vi.mock('./agentErrorAnalysis.js', async (importOriginal) => {
  const actual = await importOriginal();
  analyzeAgentFailure.mockImplementation(actual.analyzeAgentFailure);
  return { ...actual, analyzeAgentFailure };
});
// The transcript the server reads for a runner agent is output.txt; stand in a stderr-only diagnostic for it.
const TRANSCRIPT = '[stderr] API Error: 401 invalid authentication credentials\n';
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: (p) => String(p).endsWith('output.txt') || actual.existsSync(p) };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readFile: (p, ...rest) => (String(p).endsWith('output.txt') ? Promise.resolve(TRANSCRIPT) : actual.readFile(p, ...rest)) };
});

import { handleAgentCompletion, normalizeRunnerCompletionExtras } from './agentLifecycle.js';
import { runnerAgents, completingAgents, pausedAgents } from './agentState.js';
import { getAgentRecord, getAgent } from '../cos/cosAgentLifecycle.js';
import { getTaskById } from '../cos/cosTaskStore.js';
import { finalizeAgent, retireDeadAgent } from './agentFinalization.js';
import { handleOrphanedTask } from './agentManagement.js';

const AGENT_ID = 'agent-parser-verdict';
const USAGE_LIMIT = { hasError: true, category: 'usage-limit', message: 'Usage limit reached', requiresFallback: true };

async function complete(exitCode, success, extras) {
  await handleAgentCompletion(AGENT_ID, exitCode, success, 1000, extras);
  return finalizeAgent.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  runnerAgents.clear();
  pausedAgents.clear();
  completingAgents.clear();
  runnerAgents.set(AGENT_ID, { task: { id: 'task-1', taskType: 'user', metadata: {} }, providerId: 'claude-code', startedAt: Date.now() });
  getAgentRecord.mockResolvedValue({ status: 'running', metadata: {} });
});

describe('handleAgentCompletion — runner output-parser verdict', () => {
  it('fails a run the runner stopped on a usage-limit banner even when the child exited 0', async () => {
    const input = await complete(0, true, { fallbackAnalysis: USAGE_LIMIT });
    expect(input.success).toBe(false);
    expect(input.errorAnalysis).toMatchObject({ category: 'usage-limit' });
  });

  it('hands the stream-json result text to finalizeAgent as the summary', async () => {
    const input = await complete(0, true, { finalSummary: 'Shipped the fix.' });
    expect(input).toMatchObject({ success: true, finalSummary: 'Shipped the fix.', errorAnalysis: null });
  });

  it('analyzes a failure from the raw stream tail instead of the parsed transcript', async () => {
    const tail = `${JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low' })}\n`;
    const input = await complete(1, false, { rawStreamTail: tail });
    expect(input.success).toBe(false);
    expect(input.errorAnalysis).toBeTruthy();
    expect(input.errorAnalysis.message).not.toBe('');
  });

  it('analyzes the raw stream tail together with the transcript so a stderr-only diagnostic still classifies', async () => {
    const tail = `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`;
    await complete(1, false, { rawStreamTail: tail });
    expect(analyzeAgentFailure).toHaveBeenCalledWith(`${tail}\n${TRANSCRIPT}`, expect.anything(), undefined);
  });

  it('finalizes an event without the new fields exactly as before', async () => {
    const input = await complete(1, false, undefined);
    expect(input).toMatchObject({ success: false, finalSummary: null });
    expect(input.errorAnalysis).toBeTruthy();
  });
});

describe('handleAgentCompletion — runner verdict after a server restart (no runnerAgents entry)', () => {
  beforeEach(() => {
    runnerAgents.clear();
    getAgent.mockResolvedValue({ agentId: AGENT_ID, status: 'running', taskId: 'task-1', metadata: {} });
    getTaskById.mockResolvedValue({ id: 'task-1', status: 'in_progress', taskType: 'user', metadata: {} });
  });

  it('retires a usage-limit stop as a failure and never lets an existing commit promote the task', async () => {
    await handleAgentCompletion(AGENT_ID, 0, true, 1000, { fallbackAnalysis: { ...USAGE_LIMIT, message: 'Usage limit reached' } });
    expect(retireDeadAgent).toHaveBeenCalledWith(expect.objectContaining({
      success: false, category: 'usage-limit', errorMessage: 'Usage limit reached',
    }));
    expect(handleOrphanedTask).toHaveBeenCalledWith('task-1', AGENT_ID, getTaskById, expect.objectContaining({ providerStopped: true }));
  });

  it('keeps today’s recovery for a completion without a parser verdict', async () => {
    await handleAgentCompletion(AGENT_ID, 1, false, 1000);
    expect(handleOrphanedTask).toHaveBeenCalledWith('task-1', AGENT_ID, getTaskById, expect.not.objectContaining({ providerStopped: true }));
  });
});

describe('normalizeRunnerCompletionExtras', () => {
  it('drops anything of the wrong shape', () => {
    expect(normalizeRunnerCompletionExtras({ fallbackAnalysis: 'x', finalSummary: 5, rawStreamTail: '' }))
      .toEqual({ fallbackAnalysis: null, finalSummary: null, rawStreamTail: null });
    expect(normalizeRunnerCompletionExtras(null)).toEqual({ fallbackAnalysis: null, finalSummary: null, rawStreamTail: null });
    expect(normalizeRunnerCompletionExtras({ fallbackAnalysis: { message: 'no category' } }).fallbackAnalysis).toBeNull();
  });
});
