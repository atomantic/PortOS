import { describe, expect, it, vi, beforeEach } from 'vitest';

// maybeCreateInvestigationTask → createInvestigationTask → addTask does real
// store I/O; stub it so the skip-vs-create gate can be asserted in isolation.
vi.mock('./cos.js', () => ({ addTask: vi.fn(), updateTask: vi.fn() }));

import {
  analyzeAgentFailure,
  resolveFailedTaskDecision,
  maybeCreateInvestigationTask,
  MAX_TASK_RETRIES
} from './agentErrorAnalysis.js';
import { addTask } from './cos.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';

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
    it('retries on the first failure (failureCount → 1) with no investigation', () => {
      const decision = resolveFailedTaskDecision(task(), { actionable: false, category: 'rate-limit', message: 'Rate limited' });
      expect(decision.status).toBe('pending');
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
      expect(decision.status).toBe('pending');
      expect(decision.metadataUpdates.compaction).toEqual(compaction);
    });
  });

  describe('missing errorAnalysis', () => {
    it('treats null as a non-actionable unknown error', () => {
      const decision = resolveFailedTaskDecision(task(), null);
      expect(decision.status).toBe('pending');
      expect(decision.metadataUpdates.failureCount).toBe(1);
      expect(decision.metadataUpdates.lastErrorCategory).toBe('unknown');
    });

    it('still blocks after max retries with null errorAnalysis', () => {
      const decision = resolveFailedTaskDecision(task({ failureCount: MAX_TASK_RETRIES - 1 }), null);
      expect(decision.status).toBe('blocked');
      expect(decision.metadataUpdates.failureCount).toBe(MAX_TASK_RETRIES);
    });
  });
});

// The actual "create an investigation task or skip it" decision lives in
// maybeCreateInvestigationTask (the sole owner of the API_ACCESS gate). Assert
// the real branch by spying on the store write it ultimately performs.
describe('maybeCreateInvestigationTask', () => {
  beforeEach(() => {
    addTask.mockReset();
    addTask.mockResolvedValue({ id: 'investigation-1' });
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
});
