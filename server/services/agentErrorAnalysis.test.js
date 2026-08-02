import { describe, expect, it, vi, beforeEach } from 'vitest';

// maybeCreateInvestigationTask → createInvestigationTask → addTask does real
// store I/O; stub it so the skip-vs-create gate can be asserted in isolation.
// getAllTasks feeds the fingerprint dedup scan (#2615).
vi.mock('./cos.js', () => ({ addTask: vi.fn(), updateTask: vi.fn(), getAllTasks: vi.fn() }));

import {
  analyzeAgentFailure,
  COMPLETION_REASON_ANALYSES,
  ERROR_PATTERNS,
  SNIPPET_RAW_MAX_CHARS,
  resolveFailedTaskDecision,
  resolveTypeFailureSignal,
  maybeCreateInvestigationTask,
  createInvestigationTask,
  buildInvestigationFingerprint,
  redactFailureSnippet,
  endsAwaitingUserInput,
  AWAITING_INPUT_TAIL_CHARS,
  MAX_TASK_RETRIES,
  INVESTIGATION_CIRCUIT_WINDOW_MS,
  INVESTIGATION_CIRCUIT_MAX_CREATIONS,
  __resetInvestigationCircuit
} from './agentErrorAnalysis.js';
import { API_ACCESS_ERROR_CATEGORIES } from './agentErrorAnalysis.js';
import { ENVIRONMENTAL_ERROR_CATEGORIES } from './taskLearning/metrics.js';
import { addTask, updateTask, getAllTasks } from './cos.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { groupTasksByStatus, getAutoApprovedTasks, getAwaitingApprovalTasks } from '../lib/taskParser.js';

// Fixed clock for the retry-hold stamp, so the assertion is exact.
const HOLD_NOW = Date.parse('2026-08-02T12:00:00.000Z');

// Default store shape for suites that exercise the create path: no existing
// tasks, so the fingerprint dedup never fires unless a test arranges it.
const mockEmptyStore = () => {
  getAllTasks.mockReset();
  getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } });
};

// analyzeAgentFailure ignores output shorter than 50 chars (treats it as a
// startup failure), so wrap each error line with a benign, pattern-free lead
// line that pushes the total past the threshold without matching any category.
const withLead = (errorLine) =>
  ['Initializing agent session and preparing the working directory.', errorLine].join('\n');

describe('analyzeAgentFailure', () => {
  it('classifies unsupported Codex model errors instead of matching prompt text', () => {
    const output = [
      'Global instructions:',
      'PortOS intentionally omits authentication in this deployment.',
      ...Array.from({ length: 220 }, (_, i) => `prompt line ${i}`),
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."}}'
    ].join('\n');

    const analysis = analyzeAgentFailure(output, { id: 'task-1' }, 'gpt-5');

    expect(analysis.category).toBe('model-not-supported');
    expect(analysis.message).toContain('gpt-5');
    expect(analysis.suggestedFix).toContain('provider model configuration');
  });

  it('classifies Claude extra-usage status as a usage-limit fallback condition', () => {
    const output = [
      'Claude Code starting...',
      ...Array.from({ length: 60 }, (_, i) => `setup line ${i}`),
      'Now using extra usage'
    ].join('\n');

    const analysis = analyzeAgentFailure(output, { id: 'task-2' }, 'claude-opus');

    expect(analysis.category).toBe('usage-limit');
    expect(analysis.requiresFallback).toBe(true);
    expect(analysis.suggestedFix).toContain('fallback provider');
  });

  it('does not classify ordinary prose about extra usage as a usage-limit fallback condition', () => {
    const output = [
      'The task failed while editing docs.',
      'The draft mentions extra usage examples in a billing section.',
      'Error: markdown validation failed'
    ].join('\n');

    const analysis = analyzeAgentFailure(output, { id: 'task-3' }, 'claude-opus');

    expect(analysis.category).not.toBe('usage-limit');
    expect(analysis.requiresFallback).toBeUndefined();
  });

  it('does not classify status-line prefixes as usage-limit fallback conditions', () => {
    const output = [
      'The task failed while editing docs.',
      'Now using extra usage examples in release notes',
      'Error: markdown validation failed'
    ].join('\n');

    const analysis = analyzeAgentFailure(output, { id: 'task-4' }, 'claude-opus');

    expect(analysis.category).not.toBe('usage-limit');
    expect(analysis.requiresFallback).toBeUndefined();
  });
});

// Exercises the real exported ERROR_PATTERNS via analyzeAgentFailure, replacing
// the inline copy that used to live (and drift) in subAgentSpawner.test.js.
describe('analyzeAgentFailure — ERROR_PATTERNS classification', () => {
  it('classifies a 404 model-not-found error as actionable', () => {
    const analysis = analyzeAgentFailure(withLead('API Error: 404 - model: claude-4-ultra not found'), { id: 't' }, 'claude-4-ultra');
    expect(analysis.category).toBe('model-not-found');
    expect(analysis.actionable).toBe(true);
  });

  it('classifies a not_found_error model response as model-not-found', () => {
    const analysis = analyzeAgentFailure(withLead('Response: not_found_error - the requested model does not exist'), { id: 't' }, 'x');
    expect(analysis.category).toBe('model-not-found');
    expect(analysis.actionable).toBe(true);
  });

  it('classifies a 401/authentication error as actionable auth-error', () => {
    const analysis = analyzeAgentFailure(withLead('API Error: 401 Unauthorized — authentication failed'), { id: 't' }, 'x');
    expect(analysis.category).toBe('auth-error');
    expect(analysis.actionable).toBe(true);
  });

  it('classifies a 429 rate-limit error as non-actionable (transient retry)', () => {
    const analysis = analyzeAgentFailure(withLead('API Error: 429 Too Many Requests, please slow down'), { id: 't' }, 'x');
    expect(analysis.category).toBe('rate-limit');
    expect(analysis.actionable).toBe(false);
  });

  it('classifies a 5xx server error as non-actionable (transient)', () => {
    const analysis = analyzeAgentFailure(withLead('API Error: 500 Internal Server Error from the provider'), { id: 't' }, 'x');
    expect(analysis.category).toBe('server-error');
    expect(analysis.actionable).toBe(false);
  });

  it('classifies a connection-refused error as network-error', () => {
    const analysis = analyzeAgentFailure(withLead('Error: connect ECONNREFUSED 127.0.0.1:443 while reaching the API'), { id: 't' }, 'x');
    expect(analysis.category).toBe('network-error');
    expect(analysis.actionable).toBe(false);
  });

  it('attaches compaction hints to context-length errors', () => {
    const analysis = analyzeAgentFailure(withLead('Error: maximum context length exceeded for this request'), { id: 't' }, 'x');
    expect(analysis.category).toBe('context-length');
    expect(analysis.compaction?.needed).toBe(true);
  });

  it('falls back to an unknown, non-actionable category for unrecognized output', () => {
    const analysis = analyzeAgentFailure(withLead('The agent halted after an unrecognized condition with no diagnostic.'), { id: 't' }, 'x');
    expect(analysis.category).toBe('unknown');
    expect(analysis.actionable).toBe(false);
  });

  it('treats near-empty output as a startup failure', () => {
    const analysis = analyzeAgentFailure('boom', { id: 't' }, 'x');
    expect(analysis.category).toBe('startup-failure');
    expect(analysis.actionable).toBe(false);
  });
});

// Classification provenance (#2642): the environmental-exclusion gate in
// task-learning trusts `origin` to tell a genuine provider/runner signal from a
// loose keyword sweep over agent output, so every classifier return stamps one.
describe('analyzeAgentFailure — provenance origin (#2642)', () => {
  it('stamps provider origin on a structured API-error rate-limit', () => {
    const analysis = analyzeAgentFailure(withLead('API Error: 429 Too Many Requests, please slow down'), { id: 't' }, 'x');
    expect(analysis.category).toBe('rate-limit');
    expect(analysis.origin).toBe('provider');
  });

  it('stamps output-scan origin on a bare "rate limit" phrase in agent output', () => {
    // A failing test whose tail prints "rate limit" trips /rate.?limit/ but is NOT
    // a provider signal — it must stay output-scan so learning counts it as real.
    const analysis = analyzeAgentFailure(withLead('FAIL src/foo.test.js — the rate limit guard rejected the request'), { id: 't' }, 'x');
    expect(analysis.category).toBe('rate-limit');
    expect(analysis.origin).toBe('output-scan');
  });

  it('stamps runner origin on a structured ECONNREFUSED but output-scan on a bare "network error"', () => {
    const refused = analyzeAgentFailure(withLead('Error: connect ECONNREFUSED 127.0.0.1:443 while reaching the API'), { id: 't' }, 'x');
    expect(refused.category).toBe('network-error');
    expect(refused.origin).toBe('runner');

    const bare = analyzeAgentFailure(withLead('The integration test asserted a network error banner is shown'), { id: 't' }, 'x');
    expect(bare.category).toBe('network-error');
    expect(bare.origin).toBe('output-scan');
  });

  it('stamps provider origin on a structured 401 but output-scan on a bare "unauthorized"', () => {
    const structured = analyzeAgentFailure(withLead('API Error: 401 Unauthorized — authentication failed'), { id: 't' }, 'x');
    expect(structured.origin).toBe('provider');

    const bare = analyzeAgentFailure(withLead('The e2e suite failed: expected a 403 when unauthorized users hit /admin'), { id: 't' }, 'x');
    expect(bare.category).toBe('auth-error');
    expect(bare.origin).toBe('output-scan');
  });

  it('stamps provider origin on structured model errors', () => {
    expect(analyzeAgentFailure(withLead('API Error: 404 - model: claude-4-ultra not found'), { id: 't' }, 'x').origin).toBe('provider');
    expect(analyzeAgentFailure(withLead('Response: not_found_error - the requested model does not exist'), { id: 't' }, 'x').origin).toBe('provider');
  });

  it('stamps provider origin on a distinctive usage-limit idiom but output-scan on a bare "quota exceeded"', () => {
    const idiom = analyzeAgentFailure(withLead('You have hit your usage limit for this account.'), { id: 't' }, 'x');
    expect(idiom.category).toBe('usage-limit');
    expect(idiom.origin).toBe('provider');

    const generic = analyzeAgentFailure(withLead('The integration test expected a quota exceeded response from the stub.'), { id: 't' }, 'x');
    expect(generic.category).toBe('usage-limit');
    expect(generic.origin).toBe('output-scan');
  });

  it('stamps output-scan on model-not-supported (indistinguishable from a test asserting the phrase)', () => {
    const analysis = analyzeAgentFailure(withLead("The 'gpt-5' model is not supported when using Codex with a ChatGPT account."), { id: 't' }, 'gpt-5');
    expect(analysis.category).toBe('model-not-supported');
    expect(analysis.origin).toBe('output-scan');
  });

  it('promotes to provider when a structured marker appears LATER than a loose match in the window', () => {
    // Regex returns the leftmost match ("rate limit"), but a genuine "API Error: 429"
    // later in the same output is still a real provider signal → provider, not output-scan.
    const output = [
      'Initializing agent session and preparing the working directory.',
      'Note: the rate limit guard is enabled for this run',
      'API Error: 429 Too Many Requests — backing off'
    ].join('\n');
    const analysis = analyzeAgentFailure(output, { id: 't' }, 'x');
    expect(analysis.category).toBe('rate-limit');
    expect(analysis.origin).toBe('provider');
  });

  it('stamps runner origin on a startup failure and output-scan on an unknown match', () => {
    expect(analyzeAgentFailure('boom', { id: 't' }, 'x').origin).toBe('runner');
    expect(analyzeAgentFailure(withLead('The agent halted after an unrecognized condition with no diagnostic.'), { id: 't' }, 'x').origin).toBe('output-scan');
  });

  it('stamps output-scan on a non-environmental keyword match (test-failure)', () => {
    const analysis = analyzeAgentFailure(withLead('A unit test failed while running the suite; review the assertions'), { id: 't' }, 'x');
    expect(analysis.category).toBe('test-failure');
    expect(analysis.origin).toBe('output-scan');
  });
});

// Pure decision branch of resolveFailedTaskUpdate. Replaces the inline
// resolveFailedTaskStatus copy in subAgentSpawner.test.js, which omitted the
// MAX_TOTAL_SPAWNS short-circuit and the compaction metadata entirely.
describe('resolveFailedTaskDecision', () => {
  const task = (metadata = {}) => ({ id: 'task-1', description: 'test', metadata });

  describe('actionable errors', () => {
    it('blocks immediately and hands the original analysis to the investigation', () => {
      const errorAnalysis = { actionable: true, category: 'model-not-found', message: 'Model not found' };
      const decision = resolveFailedTaskDecision(task(), errorAnalysis);
      expect(decision.status).toBe('blocked');
      expect(decision.investigationAnalysis).toBe(errorAnalysis);
      expect(decision.metadataUpdates.blockedCategory).toBe('model-not-found');
      expect(decision.metadataUpdates.blockedReason).toBe('Model not found');
    });

    it('blocks regardless of prior failure count', () => {
      const decision = resolveFailedTaskDecision(task({ failureCount: 0 }), { actionable: true, category: 'bad-request', message: 'bad' });
      expect(decision.status).toBe('blocked');
    });
  });

  describe('non-actionable errors with retry tracking', () => {
    // NOT `pending` (#3373): the retry is HELD non-spawnable — `in_progress` plus
    // the hold marker — until `releaseRetryHold` writes its resume pointer.
    it('retries on the first failure (failureCount → 1) with no investigation', () => {
      const decision = resolveFailedTaskDecision(task(), { actionable: false, category: 'rate-limit', message: 'Rate limited' }, HOLD_NOW);
      expect(decision.status).toBe('in_progress');
      expect(decision.metadataUpdates.retryPendingCleanup).toBe(true);
      expect(decision.metadataUpdates.retryPendingSince).toBe(new Date(HOLD_NOW).toISOString());
      expect(decision.metadataUpdates.failureCount).toBe(1);
      expect(decision.metadataUpdates.lastErrorCategory).toBe('rate-limit');
      expect(decision.investigationAnalysis).toBeNull();
    });

    it('blocks once failureCount reaches MAX_TASK_RETRIES', () => {
      const decision = resolveFailedTaskDecision(task({ failureCount: MAX_TASK_RETRIES - 1 }), { actionable: false, category: 'network-error', message: 'Network failed' });
      expect(decision.status).toBe('blocked');
      expect(decision.metadataUpdates.failureCount).toBe(MAX_TASK_RETRIES);
      expect(decision.metadataUpdates.blockedReason).toContain('Max retries exceeded');
      expect(decision.metadataUpdates.blockedCategory).toBe('network-error');
      expect(decision.investigationAnalysis.message).toContain(`failed ${MAX_TASK_RETRIES} times`);
    });

    it('blocks on the total-spawn ceiling even when the retry count is low (the gap the inline copy missed)', () => {
      const decision = resolveFailedTaskDecision(
        task({ failureCount: 0, totalSpawnCount: MAX_TOTAL_SPAWNS }),
        { actionable: false, category: 'server-error', message: 'Server error' }
      );
      expect(decision.status).toBe('blocked');
      expect(decision.metadataUpdates.failureCount).toBe(1);
      expect(decision.investigationAnalysis).not.toBeNull();
    });

    it('propagates compaction hints into the retry metadata (also missed by the inline copy)', () => {
      const compaction = { needed: true, reason: 'context-limit' };
      const decision = resolveFailedTaskDecision(task(), { actionable: false, category: 'context-length', message: 'too big', compaction });
      expect(decision.status).toBe('in_progress');
      expect(decision.metadataUpdates.compaction).toEqual(compaction);
    });
  });

  describe('missing errorAnalysis', () => {
    it('treats null as a non-actionable unknown error', () => {
      const decision = resolveFailedTaskDecision(task(), null);
      expect(decision.status).toBe('in_progress');
      expect(decision.metadataUpdates.failureCount).toBe(1);
      expect(decision.metadataUpdates.lastErrorCategory).toBe('unknown');
    });

    it('still blocks after max retries with null errorAnalysis', () => {
      const decision = resolveFailedTaskDecision(task({ failureCount: MAX_TASK_RETRIES - 1 }), null);
      expect(decision.status).toBe('blocked');
      expect(decision.metadataUpdates.failureCount).toBe(MAX_TASK_RETRIES);
    });
  });

  // Acceptance criterion (#3373): a dequeue that runs during the cleanup window
  // must not claim the retry. Every dequeue tier selects candidates through these
  // two taskParser helpers (`grouped.pending` for user tasks, `autoApproved` for
  // system tasks), so asserting against the REAL helpers — rather than restating
  // "status !== pending" — is what proves no tier can see the held task.
  describe('a held retry is not a dequeue candidate', () => {
    const applyDecision = (base, decision) => ({ ...base, status: decision.status, metadata: { ...base.metadata, ...decision.metadataUpdates } });

    it('is excluded from the pending, auto-approved, and approval queues', () => {
      const base = { id: 'task-1', description: 'do a thing', priority: 'HIGH', priorityValue: 3, autoApproved: true, approvalRequired: false, metadata: {} };
      const held = applyDecision(base, resolveFailedTaskDecision(base, { actionable: false, category: 'rate-limit', message: 'Rate limited' }, HOLD_NOW));

      expect(groupTasksByStatus([held]).pending).toEqual([]);
      expect(groupTasksByStatus([held]).in_progress).toEqual([held]);
      expect(getAutoApprovedTasks([held])).toEqual([]);
      expect(getAwaitingApprovalTasks([{ ...held, approvalRequired: true, autoApproved: false }])).toEqual([]);
    });

    // ...and a blocked task gets no hold at all, so nothing has to release it.
    it('a blocked task carries no hold marker', () => {
      const decision = resolveFailedTaskDecision({ id: 'task-1', metadata: { failureCount: MAX_TASK_RETRIES - 1 } }, { actionable: false, category: 'network-error', message: 'Network failed' }, HOLD_NOW);
      expect(decision.status).toBe('blocked');
      expect(decision.metadataUpdates.retryPendingCleanup).toBeUndefined();
      expect(decision.metadataUpdates.retryPendingSince).toBeUndefined();
    });
  });
});

describe('resolveTypeFailureSignal (#2616)', () => {
  it('a user-terminated run is skipped (never touches the ledger)', () => {
    expect(resolveTypeFailureSignal({ success: false, terminatedByUser: true }))
      .toEqual({ record: 'skip', category: null });
    // ...even when the exit code says success.
    expect(resolveTypeFailureSignal({ success: true, terminatedByUser: true }).record).toBe('skip');
  });

  it('a clean exit with no hook is a success signal', () => {
    expect(resolveTypeFailureSignal({ success: true })).toEqual({ record: 'success', category: null });
  });

  it('a failed exit with no hook is a failure signal carrying the error category', () => {
    expect(resolveTypeFailureSignal({ success: false, errorCategory: 'rate-limit' }))
      .toEqual({ record: 'failure', category: 'rate-limit' });
    // No category → 'unknown'.
    expect(resolveTypeFailureSignal({ success: false }).category).toBe('unknown');
  });

  it('an exit-0 run whose hook reports unparseable-response counts as a failure', () => {
    const signal = resolveTypeFailureSignal({
      success: true,
      hookResult: { ran: true, outcome: { action: 'no-op', reason: 'unparseable-response' } }
    });
    expect(signal).toEqual({ record: 'failure', category: 'unparseable-response' });
  });

  it('a thrown hook counts as a failure (hook-error) even on a clean exit', () => {
    const signal = resolveTypeFailureSignal({ success: true, hookResult: { ran: true, threw: true } });
    expect(signal).toEqual({ record: 'failure', category: 'hook-error' });
  });

  it('a run that already failed keeps its real error category (hook throw does not relabel it)', () => {
    const signal = resolveTypeFailureSignal({
      success: false,
      errorCategory: 'rate-limit',
      hookResult: { ran: true, threw: true }
    });
    expect(signal).toEqual({ record: 'failure', category: 'rate-limit' });
  });

  it('benign hook reasons (no-proposal/duplicate) leave the exit-code verdict intact', () => {
    for (const reason of ['no-proposal', 'duplicate', 'scope-suppressed', null]) {
      expect(resolveTypeFailureSignal({ success: true, hookResult: { ran: true, outcome: { reason } } }).record)
        .toBe('success');
    }
    // A hook that didn't run at all (no-op path) also defers to the exit code.
    expect(resolveTypeFailureSignal({ success: true, hookResult: { ran: false } }).record).toBe('success');
  });
});

// The actual "create an investigation task or skip it" decision lives in
// maybeCreateInvestigationTask (the sole owner of the API_ACCESS gate). Assert
// the real branch by spying on the store write it ultimately performs.
describe('maybeCreateInvestigationTask', () => {
  beforeEach(() => {
    addTask.mockReset();
    addTask.mockResolvedValue({ id: 'investigation-1' });
    mockEmptyStore();
    __resetInvestigationCircuit();
  });

  const task = { id: 'task-1', description: 'do the thing', metadata: {} };

  it('skips investigation for API-access categories (auth/forbidden/usage-limit)', async () => {
    for (const category of ['auth-error', 'forbidden', 'usage-limit']) {
      addTask.mockClear();
      await maybeCreateInvestigationTask('agent-1', task, { category, message: `${category} error` });
      expect(addTask).not.toHaveBeenCalled();
    }
  });

  it('creates an investigation task for a non-API-access category', async () => {
    await maybeCreateInvestigationTask('agent-1', task, { category: 'model-not-found', message: 'Model not found' });
    expect(addTask).toHaveBeenCalledTimes(1);
  });

  it('never spawns an investigation for a failed investigation task (meta-cascade guard)', async () => {
    await maybeCreateInvestigationTask('agent-1', { id: 'inv-1', description: '[Auto] Investigate agent failure: x', metadata: { isInvestigation: true } }, { category: 'unknown', message: 'boom' });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('honors the string-true marker from the markdown metadata round-trip', async () => {
    await maybeCreateInvestigationTask('agent-1', { id: 'inv-2', description: 'x', metadata: { isInvestigation: 'true' } }, { category: 'unknown', message: 'boom' });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('recognizes pre-#2615 investigation tasks by their legacy headline (no metadata marker)', async () => {
    await maybeCreateInvestigationTask('agent-1', {
      id: 'inv-legacy',
      description: '[Auto] Investigate agent failure: some old failure message\n\n## What happened\n...',
      metadata: {}
    }, { category: 'unknown', message: 'boom' });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not mistake an ordinary task mentioning investigations for an investigation', async () => {
    await maybeCreateInvestigationTask('agent-1', {
      id: 'task-ordinary',
      description: 'Improve the [Auto] Investigate agent failure flow',
      metadata: {}
    }, { category: 'unknown', message: 'boom' });
    expect(addTask).toHaveBeenCalledTimes(1);
  });
});

describe('buildInvestigationFingerprint', () => {
  it('keys on category, analysisType/taskType, and app — never the free-text message', () => {
    const fp = buildInvestigationFingerprint(
      { id: 't', taskType: 'internal', metadata: { analysisType: 'app-improve', app: 'ExampleApp' } },
      { category: 'startup-failure', message: 'raw output line that varies per run' }
    );
    expect(fp).toBe('startup-failure:app-improve:ExampleApp');
  });

  it('falls back to taskType, then generic sentinels, when analysisType/app are absent', () => {
    expect(buildInvestigationFingerprint({ id: 't', taskType: 'user', metadata: {} }, { category: 'unknown' })).toBe('unknown:user:none');
    expect(buildInvestigationFingerprint({ id: 't' }, null)).toBe('unknown:task:none');
  });
});

describe('createInvestigationTask guards (#2615)', () => {
  const failedTask = { id: 'task-1', description: 'do the thing', taskType: 'user', metadata: {} };
  const analysis = { category: 'startup-failure', message: 'Agent exited during startup' };

  beforeEach(() => {
    addTask.mockReset();
    addTask.mockResolvedValue({ id: 'investigation-1' });
    updateTask.mockReset();
    updateTask.mockResolvedValue({});
    mockEmptyStore();
    __resetInvestigationCircuit();
  });

  it('stamps the fingerprint, isInvestigation marker, and affectedTasks onto the created task', async () => {
    await createInvestigationTask('agent-1', failedTask, analysis);
    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({
      priority: 'HIGH',
      approvalRequired: true,
      isInvestigation: true,
      investigationFingerprint: 'startup-failure:user:none',
      affectedTasks: ['task-1']
    }), 'internal');
  });

  it('unions a later same-fingerprint failure into the surviving investigation\'s affectedTasks and body', async () => {
    const existing = {
      id: 'inv-open', status: 'pending', description: '[Auto] Investigate agent failure [startup-failure:user:none]: x\n\nbody',
      metadata: { investigationFingerprint: 'startup-failure:user:none', affectedTasks: ['task-1'] }
    };
    getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [existing] } });
    await createInvestigationTask('agent-2', { ...failedTask, id: 'task-2' }, analysis);
    expect(addTask).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith('inv-open', {
      description: `${existing.description}\n- Also blocks task \`task-2\` (same cause; agent \`agent-2\`).`,
      metadata: { affectedTasks: ['task-1', 'task-2'] }
    }, 'internal');
  });

  it('does not re-write affectedTasks when the failed task is already recorded', async () => {
    const existing = {
      id: 'inv-open', status: 'pending',
      metadata: { investigationFingerprint: 'startup-failure:user:none', affectedTasks: ['task-1'] }
    };
    getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [existing] } });
    await createInvestigationTask('agent-2', failedTask, analysis); // task-1 again
    expect(updateTask).not.toHaveBeenCalled();
  });

  it.each(['pending', 'in_progress', 'challenged', 'blocked'])(
    'skips creation while a same-fingerprint investigation is %s',
    async (status) => {
      const existing = { id: 'inv-open', status, metadata: { investigationFingerprint: 'startup-failure:user:none' } };
      getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [existing] } });
      const result = await createInvestigationTask('agent-1', failedTask, analysis);
      expect(addTask).not.toHaveBeenCalled();
      expect(result).toBe(existing);
    }
  );

  it('creates a fresh task once the prior investigation reached a terminal status', async () => {
    const done = { id: 'inv-done', status: 'completed', metadata: { investigationFingerprint: 'startup-failure:user:none' } };
    getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [done] } });
    await createInvestigationTask('agent-1', failedTask, analysis);
    expect(addTask).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe against an open investigation with a DIFFERENT fingerprint', async () => {
    const other = { id: 'inv-other', status: 'pending', metadata: { investigationFingerprint: 'network-error:user:none' } };
    getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [other] } });
    await createInvestigationTask('agent-1', failedTask, analysis);
    expect(addTask).toHaveBeenCalledTimes(1);
  });

  it('caps creations per rolling hour across all fingerprints', async () => {
    for (let i = 0; i < INVESTIGATION_CIRCUIT_MAX_CREATIONS; i++) {
      await createInvestigationTask(`agent-${i}`, { ...failedTask, id: `task-${i}` }, { category: `cat-${i}`, message: 'x' });
    }
    expect(addTask).toHaveBeenCalledTimes(INVESTIGATION_CIRCUIT_MAX_CREATIONS);

    const suppressed = await createInvestigationTask('agent-over', failedTask, analysis);
    expect(suppressed).toBeNull();
    expect(addTask).toHaveBeenCalledTimes(INVESTIGATION_CIRCUIT_MAX_CREATIONS);
  });

  it('re-closes the circuit once creations age out of the rolling window', async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < INVESTIGATION_CIRCUIT_MAX_CREATIONS; i++) {
        await createInvestigationTask(`agent-${i}`, { ...failedTask, id: `task-${i}` }, { category: `cat-${i}`, message: 'x' });
      }
      expect(await createInvestigationTask('agent-over', failedTask, analysis)).toBeNull();

      vi.advanceTimersByTime(INVESTIGATION_CIRCUIT_WINDOW_MS + 1);
      await createInvestigationTask('agent-later', failedTask, analysis);
      expect(addTask).toHaveBeenCalledTimes(INVESTIGATION_CIRCUIT_MAX_CREATIONS + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count an addTask description-level duplicate against the circuit', async () => {
    addTask.mockResolvedValue({ id: 'inv-existing', duplicate: true });
    for (let i = 0; i < INVESTIGATION_CIRCUIT_MAX_CREATIONS + 1; i++) {
      await createInvestigationTask(`agent-${i}`, { ...failedTask, id: `task-${i}` }, { category: `cat-${i}`, message: 'x' });
    }
    // Every call reached addTask — none were suppressed by the circuit, because
    // duplicate returns never consumed creation budget.
    expect(addTask).toHaveBeenCalledTimes(INVESTIGATION_CIRCUIT_MAX_CREATIONS + 1);
  });

  it('embeds the fingerprint in the headline so first-line dedup tracks fingerprint identity exactly', async () => {
    await createInvestigationTask('agent-1', { ...failedTask, metadata: { app: 'ExampleApp' } }, analysis);
    expect(addTask.mock.calls[0][0].description.split('\n')[0])
      .toBe('[Auto] Investigate agent failure [startup-failure:user:ExampleApp]: Agent exited during startup');
    // Different kind, same message → different first line, so addTask's
    // description dedup can never falsely collapse two distinct causes.
    addTask.mockClear();
    mockEmptyStore();
    await createInvestigationTask('agent-2', { ...failedTask, metadata: { analysisType: 'app-improve' } }, analysis);
    expect(addTask.mock.calls[0][0].description.split('\n')[0])
      .toBe('[Auto] Investigate agent failure [startup-failure:app-improve:none]: Agent exited during startup');
  });

  it('serializes concurrent same-fingerprint creates so only one task lands (TOCTOU)', async () => {
    // Stateful store double: created tasks become visible to the NEXT scan,
    // proving the second create's fingerprint scan runs after the first's
    // addTask instead of interleaving ahead of it.
    const store = [];
    getAllTasks.mockReset();
    getAllTasks.mockImplementation(async () => ({ user: { tasks: [] }, cos: { tasks: [...store] } }));
    addTask.mockReset();
    addTask.mockImplementation(async (taskData) => {
      const created = {
        id: `inv-${store.length + 1}`,
        status: 'pending',
        metadata: { investigationFingerprint: taskData.investigationFingerprint, isInvestigation: true }
      };
      store.push(created);
      return created;
    });

    const [first, second] = await Promise.all([
      createInvestigationTask('agent-a', failedTask, analysis),
      createInvestigationTask('agent-b', { ...failedTask, id: 'task-2' }, analysis)
    ]);

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(store).toHaveLength(1);
    expect(first).toBe(store[0]);  // creator gets the created task
    expect(second).toBe(store[0]); // second create deduped to the same task
  });
});

describe('redactFailureSnippet', () => {
  it('strips OS usernames, emails, IPs, hostnames, and secrets, collapsing to one line', () => {
    const raw = [
      'error at /Users/alice/github.com/app/index.js:42',
      'and windows path C:\\Users\\bob\\app\\index.js',
      'contact ops@example.com or reach host node-alpha.tailnet.ts.net',
      'also short-host printer.local timed out',
      'connect ECONNREFUSED 192.0.2.10:5555',
      'Authorization: Bearer abcdef0123456789abcdef',
    ].join('\n');
    const out = redactFailureSnippet(raw);
    expect(out).not.toContain('alice');
    expect(out).not.toContain('ops@example.com');
    // Assert the leading node-name label is gone, not just the full hostname —
    // a single-label regex would leave `node-alpha.<host>` behind.
    expect(out).not.toContain('node-alpha');
    expect(out).not.toContain('printer'); // multi-label + short .local host label stripped
    expect(out).not.toContain('bob'); // windows username stripped
    expect(out).not.toContain('192.0.2.10');
    expect(out).not.toContain('abcdef0123456789abcdef');
    expect(out).toContain('/Users/<user>/github.com/app/index.js');
    expect(out).toContain('<email>');
    expect(out).toContain('<host>');
    expect(out).toContain('<ip>');
    expect(out).not.toContain('\n'); // collapsed to a single line
  });

  it('returns an empty string for non-string / blank input', () => {
    expect(redactFailureSnippet(null)).toBe('');
    expect(redactFailureSnippet('   ')).toBe('');
  });

  it('caps overly long snippets with an ellipsis', () => {
    const out = redactFailureSnippet('x'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(241);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('analyzeAgentFailure — snippet & escalation enrichment', () => {
  it('captures the matched failure line as a snippet and category-specific escalation prose', () => {
    const analysis = analyzeAgentFailure(withLead('API Error: 404 - model: claude-4-ultra not found'), { id: 't' }, 'claude-4-ultra');
    expect(analysis.snippet).toContain('claude-4-ultra');
    expect(analysis.escalation).toMatch(/approve the retry/i);
  });

  it('leaves escalation null for categories without custom prose', () => {
    const analysis = analyzeAgentFailure(withLead('API Error: 429 Too Many Requests, please slow down'), { id: 't' }, 'x');
    expect(analysis.escalation).toBeNull();
  });
});

// A TUI transcript is a SCREEN, not a log: ANSI cursor-addressing repaints mean a
// multi-hundred-KB PTY spool can carry almost no newlines. Regression cover for the
// incident where that collapsed the "last 200 lines" window onto a whole 17-minute
// session — a `grep max_tokens` the agent itself ran classified an idle-reaper kill
// as `context-length` (actionable → task blocked + investigation filed), and the
// "matched line" snippet persisted 816KB of escape codes into metadata.json.
describe('analyzeAgentFailure — PTY transcript windowing', () => {
  // Cursor-addressed repaint: no newline anywhere, escapes between every token.
  const repaint = (text) => `\x1B[H\x1B[2J\x1B[38;2;215;119;87m${text}\x1B[39m\x1B[24;1H`;

  it('bounds the analysis window by characters so a newline-free transcript cannot match its own head', () => {
    const stale = repaint('Bash(grep -rn "budget\\|maxTokens\\|max_tokens\\|cost" server/services/)');
    const filler = repaint('Synthesizing… ').repeat(3000); // ≫ FAILURE_WINDOW_MAX_CHARS of escapes+text
    const analysis = analyzeAgentFailure(stale + filler, { id: 't' }, 'x');
    expect(analysis.category).not.toBe('context-length');
  });

  it('caps the captured snippet instead of persisting the whole newline-free buffer', () => {
    // Match sits deep inside a single newline-free line — the snippet must be a
    // bounded window around it, not the line (i.e. the whole transcript).
    const analysis = analyzeAgentFailure(
      repaint(`${'noise '.repeat(1000)}API Error: 401 Unauthorized${' trailing'.repeat(1000)}`),
      { id: 't' }, 'x'
    );
    expect(analysis.category).toBe('auth-error');
    expect(analysis.snippet.length).toBeLessThanOrEqual(SNIPPET_RAW_MAX_CHARS);
    expect(analysis.snippet).toContain('API Error: 401');
  });

  it('strips escape sequences out of the snippet', () => {
    const analysis = analyzeAgentFailure(withLead(repaint('API Error: 401 Unauthorized')), { id: 't' }, 'x');
    expect(analysis.snippet).not.toMatch(/\x1B/);
  });

  it('treats an all-escape transcript as a startup failure rather than scanning garbage', () => {
    const analysis = analyzeAgentFailure('\x1B[H\x1B[2J\x1B[?25l\x1B[24;1H'.repeat(200), { id: 't' }, 'x');
    expect(analysis.category).toBe('startup-failure');
    expect(analysis.origin).toBe('runner');
  });
});

describe('analyzeAgentFailure — runner completion reason (COMPLETION_REASON_ANALYSES)', () => {
  // The transcript the real incident produced: a keyword the AGENT typed, with the
  // run actually ended by the idle reaper.
  const noisyTranscript = withLead('Bash(grep -rn "maxTokens\\|max_tokens\\|cost" server/services/)');

  it('prefers the runner verdict over a loose output-scan match', () => {
    const analysis = analyzeAgentFailure(noisyTranscript, { id: 't' }, 'x', {
      completionReason: 'idle-no-changes',
      completionError: 'TUI agent idled out with zero uncommitted file changes',
    });
    expect(analysis.category).toBe('no-changes');
    expect(analysis.actionable).toBe(false);
    expect(analysis.origin).toBe('runner');
    expect(analysis.completionReason).toBe('idle-no-changes');
    // The runner's own prose is the snippet — never the escape-laden transcript.
    expect(analysis.snippet).toContain('idled out');
  });

  it('still yields to a STRUCTURED provider signal in the transcript', () => {
    const analysis = analyzeAgentFailure(withLead('API Error: 429 Too Many Requests — backing off'), { id: 't' }, 'x', {
      completionReason: 'idle-no-changes',
    });
    expect(analysis.category).toBe('rate-limit');
    expect(analysis.origin).toBe('provider');
  });

  it('keeps scanning past a loose match so a later structured one still wins', () => {
    // `context-length` (output-scan) matches earlier in the text than the
    // structured 401; discarding the loose match must not abort the sweep.
    const output = [
      'Initializing agent session and preparing the working directory.',
      'Checked the max_tokens budget helper in server/lib/',
      'API Error: 401 Unauthorized',
    ].join('\n');
    const analysis = analyzeAgentFailure(output, { id: 't' }, 'x', { completionReason: 'idle-no-changes' });
    expect(analysis.category).toBe('auth-error');
    expect(analysis.origin).toBe('provider');
  });

  it('applies the runner verdict when nothing in the transcript matches at all', () => {
    const analysis = analyzeAgentFailure(withLead('Reviewed the reference commits and recorded proposals.'), { id: 't' }, 'x', {
      completionReason: 'max-runtime-timeout',
      completionError: 'TUI agent exceeded max runtime',
    });
    expect(analysis.category).toBe('timeout');
    expect(analysis.completionReason).toBe('max-runtime-timeout');
  });

  it('applies the runner verdict when the transcript is empty', () => {
    const analysis = analyzeAgentFailure('', { id: 't' }, 'x', { completionReason: 'idle-no-activity' });
    expect(analysis.category).toBe('startup-failure');
    expect(analysis.completionReason).toBe('idle-no-activity');
  });

  it('ignores an unrecognized reason and classifies from the output as before', () => {
    const analysis = analyzeAgentFailure(withLead('API Error: 429 Too Many Requests'), { id: 't' }, 'x', {
      completionReason: 'agent-signaled-done',
    });
    expect(analysis.category).toBe('rate-limit');
  });

  // Verbatim-shaped tail of the real incident: a `/do:plan-task` run parked on the
  // skill's scope question until the idle reaper killed it. The transcript is
  // repaint-mangled (the TUI spools a SCREEN, not a log), which is why the marker
  // set only leans on fragments that survive a repaint.
  const parkedOnSelector = [
    'Initializing agent session and preparing the working directory.',
    'Found the real gap. Let me confirm the reuse surface.',
    '☐ Scope The drum-kit Web Audio play-along already exists in play mode. Which gap should I file?',
    '❯1.Audible preview in edit + import (Recommended)  2. Edit-mode preview only',
    'Enter to select · ↑/↓ to navigate · Esc to ancel',
  ].join('\n');

  it('names the unanswered prompt as the cause of an idle-no-changes run', () => {
    const analysis = analyzeAgentFailure(parkedOnSelector, { id: 't' }, 'x', {
      completionReason: 'idle-no-changes',
      completionError: 'TUI agent idled out with zero uncommitted file changes',
    });
    expect(analysis.message).toMatch(/interactive prompt/i);
    expect(analysis.suggestedFix).toMatch(/non-interactive/i);
    // Category is deliberately unchanged so the auto-fix tier and the
    // layered-intelligence failure bucket keep classifying it identically.
    expect(analysis.category).toBe(COMPLETION_REASON_ANALYSES['idle-no-changes'].category);
    expect(analysis.completionReason).toBe('idle-no-changes');
    expect(analysis.origin).toBe('runner');
  });

  it('preserves the original category when refining an idle-no-activity stall', () => {
    const analysis = analyzeAgentFailure(parkedOnSelector, { id: 't' }, 'x', {
      completionReason: 'idle-no-activity',
    });
    expect(analysis.category).toBe('startup-failure');
    expect(analysis.message).toMatch(/interactive prompt/i);
  });

  it('leaves a plain idle-out alone when no prompt is on screen', () => {
    const analysis = analyzeAgentFailure(withLead('Ran 4 shell commands and read 2 files.'), { id: 't' }, 'x', {
      completionReason: 'idle-no-changes',
    });
    expect(analysis.message).toBe(COMPLETION_REASON_ANALYSES['idle-no-changes'].message);
  });

  it('does not re-word a non-idle reason that happens to show a prompt', () => {
    const analysis = analyzeAgentFailure(parkedOnSelector, { id: 't' }, 'x', {
      completionReason: 'max-runtime-timeout',
    });
    expect(analysis.message).toBe(COMPLETION_REASON_ANALYSES['max-runtime-timeout'].message);
  });

  it('ignores a prompt the agent got PAST — only the tail counts as parked', () => {
    const answeredEarly = [
      'Enter to select · ↑/↓ to navigate',
      // Enough subsequent work to push the selector out of the tail window.
      ...Array.from({ length: 60 }, (_, i) => `Edited server/services/file${i}.js and ran the suite.`),
    ].join('\n');
    expect(answeredEarly.length).toBeGreaterThan(AWAITING_INPUT_TAIL_CHARS);
    expect(endsAwaitingUserInput(answeredEarly)).toBe(false);
  });

  it('maps every reason to a category ERROR_PATTERNS already produces (no orphan taxonomy tokens)', () => {
    const known = new Set([...ERROR_PATTERNS.map(p => p.category), 'startup-failure']);
    for (const [reason, def] of Object.entries(COMPLETION_REASON_ANALYSES)) {
      expect(known.has(def.category), `${reason} → ${def.category}`).toBe(true);
    }
  });
});

describe('createInvestigationTask body', () => {
  beforeEach(() => {
    addTask.mockReset();
    addTask.mockResolvedValue({ id: 'investigation-1' });
    mockEmptyStore();
    __resetInvestigationCircuit();
  });

  const bodyOf = () => addTask.mock.calls[0][0].description;

  it('renders the What happened / What to approve / What unblocks template with category-specific prose', async () => {
    await createInvestigationTask('agent-1', { id: 'task-9', description: 'ship the thing' }, {
      category: 'model-not-found',
      message: 'Model "claude-4-ultra" not found',
      configuredModel: 'claude-4-ultra',
      snippet: 'API Error: 404 - model: claude-4-ultra not found',
      escalation: 'Set a valid model id for this task, then approve the retry.',
    });
    const body = bodyOf();
    expect(body).toContain('## What happened');
    expect(body).toContain('## What to approve');
    expect(body).toContain('## What unblocks');
    expect(body).toContain('model-not-found');
    expect(body).toContain('claude-4-ultra'); // provider/model attribution
    expect(body).toContain('Set a valid model id'); // category-specific escalation prose
    expect(body).toContain('task-9'); // which task unblocks
  });

  it('falls back to suggestedFix when a category supplies no escalation prose', async () => {
    await createInvestigationTask('agent-2', { id: 'task-10', description: 'do x' }, {
      category: 'unknown',
      message: 'boom',
      suggestedFix: 'Review the details or agent output logs.',
      escalation: null,
    });
    expect(bodyOf()).toContain('Review the details or agent output logs.');
  });

  it('never leaks host/path/PII data from the snippet or task description into the body', async () => {
    await createInvestigationTask('agent-3', {
      id: 'task-11',
      description: 'fix bug for user alice at /Users/alice/app',
    }, {
      category: 'file-not-found',
      message: 'File not found',
      snippet: 'ENOENT: /Users/alice/secret.json — see ops@example.com or node-alpha.ts.net at 192.0.2.10',
    });
    const body = bodyOf();
    expect(body).not.toContain('/Users/alice');
    expect(body).not.toContain('ops@example.com');
    expect(body).not.toContain('node-alpha.ts.net');
    expect(body).not.toContain('192.0.2.10');
  });

  it('redacts the message headline for unmatched output whose raw line carries host/path/IP data', async () => {
    // `unknown` category derives `message` from a raw agent output line, so the
    // headline + classification interpolations must be scrubbed too.
    const dirtyLine = 'Error syncing project to build-box.tailnet.ts.net at 192.0.2.10 under /Users/alice/project';
    const analysis = analyzeAgentFailure(withLead(dirtyLine), { id: 't' }, 'x');
    expect(analysis.category).toBe('unknown');
    expect(analysis.message).toContain('build-box'); // raw line survives into message pre-redaction
    await createInvestigationTask('agent-4', { id: 'task-12', description: 'do y' }, analysis);
    const body = bodyOf();
    expect(body).not.toContain('192.0.2.10');
    expect(body).not.toContain('build-box');
    expect(body).not.toContain('/Users/alice');
  });
});

describe('API_ACCESS_ERROR_CATEGORIES ⊆ ENVIRONMENTAL_ERROR_CATEGORIES (issue #2618)', () => {
  it('every investigation-skip category is also excluded from learning aggregates', () => {
    // The two sets stay separate on purpose: API_ACCESS_ERROR_CATEGORIES gates
    // investigation-task spawning here, while taskLearning's environmental set
    // (a leaf constant — importing this module there would drag the cos.js task
    // graph into every taskLearning consumer) gates the success-rate aggregates.
    // But the subset relation must hold: a category whose failures can't even be
    // investigated by an LLM is certainly not task/model signal.
    for (const category of API_ACCESS_ERROR_CATEGORIES) {
      expect(ENVIRONMENTAL_ERROR_CATEGORIES.has(category)).toBe(true);
    }
  });
});
