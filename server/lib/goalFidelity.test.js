import { describe, it, expect } from 'vitest';
import {
  GOAL_FIDELITY_VERDICTS,
  MAX_OBJECTIVE_CHARS,
  formatGoalFidelitySummary,
  goalFidelityHoldsRun,
  normalizeGoalFidelityVerdict,
  resolveGoalFidelityConfig,
  taskObjective,
} from './goalFidelity.js';

describe('taskObjective', () => {
  it('composes the description with the task prompt block', () => {
    expect(taskObjective({
      description: 'Add a retry to the uploader',
      metadata: { prompt: 'Retry three times\nwith backoff', context: 'queued by hand' },
    })).toBe('Add a retry to the uploader\n\nRetry three times\nwith backoff\n\nqueued by hand');
  });

  it('returns null when the task states no objective, so the gate skips rather than judging against ""', () => {
    expect(taskObjective({ description: '   ', metadata: {} })).toBeNull();
    expect(taskObjective(null)).toBeNull();
  });

  it('truncates an oversized objective to WITHIN the cap, marker included', () => {
    const objective = taskObjective({ description: 'x'.repeat(MAX_OBJECTIVE_CHARS + 500), metadata: {} });
    expect(objective.length).toBeLessThanOrEqual(MAX_OBJECTIVE_CHARS);
    expect(objective).toContain('[objective truncated]');
  });
});

describe('resolveGoalFidelityConfig', () => {
  it('inherits the chain\'s local reviewer and its pinned model/effort when nothing is configured', () => {
    expect(resolveGoalFidelityConfig({ ollamaModel: 'qwen3:8b', ollamaEffort: 'low' }, ['copilot', 'ollama']))
      .toEqual({ enabled: true, backend: 'ollama', model: 'qwen3:8b', effort: 'low' });
  });

  it('prefers the gate\'s own pins over the chain\'s', () => {
    expect(resolveGoalFidelityConfig(
      { ollamaModel: 'qwen3:8b', goalFidelity: { backend: 'lmstudio', model: 'gpt-oss-20b', effort: 'high' } },
      ['ollama'],
    )).toEqual({ enabled: true, backend: 'lmstudio', model: 'gpt-oss-20b', effort: 'high' });
  });

  it('declines when disabled, when no local reviewer is available, and when the named backend is not server-callable', () => {
    expect(resolveGoalFidelityConfig({ goalFidelity: { enabled: false } }, ['ollama'])).toBeNull();
    expect(resolveGoalFidelityConfig({}, ['copilot', 'codex'])).toBeNull();
    // A CLI reviewer has no server-side entry point; silently substituting the
    // chain's ollama would run a review on a model the user never picked.
    expect(resolveGoalFidelityConfig({ goalFidelity: { backend: 'codex' } }, ['ollama'])).toBeNull();
  });

  it('drops an unusable pin instead of persisting it into the request', () => {
    const config = resolveGoalFidelityConfig({ goalFidelity: { backend: 'ollama', model: '  ', effort: 'ultra' } }, []);
    expect(config).toEqual({ enabled: true, backend: 'ollama', model: null, effort: null });
  });
});

describe('normalizeGoalFidelityVerdict', () => {
  it('accepts every declared verdict and caps the named lists', () => {
    for (const verdict of GOAL_FIDELITY_VERDICTS) {
      expect(normalizeGoalFidelityVerdict({ verdict, missing: [], unrequested: [], evidence: '' })?.verdict).toBe(verdict);
    }
    const many = normalizeGoalFidelityVerdict({
      verdict: 'fix-first',
      missing: Array.from({ length: 40 }, (_, i) => `item ${i}`),
      unrequested: ['  ', 'a real one', 42],
      evidence: 'tests were run',
    });
    expect(many.missing).toHaveLength(10);
    expect(many.unrequested).toEqual(['a real one']);
    expect(many.evidence).toBe('tests were run');
  });

  it('renders a markdown link in model-authored text as prose, not a clickable destination', () => {
    // These strings come from an untrusted diff and land in a Review Hub alert
    // that goes through PortOS's markdown renderer.
    const result = normalizeGoalFidelityVerdict({
      verdict: 'rethink',
      missing: ['[click here](https://example.com/attacker)'],
      unrequested: ['![banner](https://example.com/pixel.png)'],
    });
    expect(result.missing[0]).toBe('[click here] (https://example.com/attacker)');
    expect(result.unrequested[0]).toBe('![banner] (https://example.com/pixel.png)');
  });

  it('returns null for an unusable answer so "nothing judged this run" never collapses into ship or rethink', () => {
    expect(normalizeGoalFidelityVerdict(null)).toBeNull();
    expect(normalizeGoalFidelityVerdict(['ship'])).toBeNull();
    expect(normalizeGoalFidelityVerdict({ verdict: 'looks good to me' })).toBeNull();
    expect(normalizeGoalFidelityVerdict({ missing: [] })).toBeNull();
  });
});

describe('goalFidelityHoldsRun', () => {
  it('holds only on rethink', () => {
    expect(goalFidelityHoldsRun({ verdict: 'rethink' })).toBe(true);
    expect(goalFidelityHoldsRun({ verdict: 'fix-first' })).toBe(false);
    expect(goalFidelityHoldsRun({ verdict: 'ship' })).toBe(false);
    expect(goalFidelityHoldsRun(null)).toBe(false);
  });
});

describe('formatGoalFidelitySummary', () => {
  it('reports counts rather than the untrusted item text', () => {
    expect(formatGoalFidelitySummary({ verdict: 'rethink', missing: ['a', 'b'], unrequested: ['c'] }))
      .toBe('Goal-fidelity verdict: rethink (2 missing, 1 unrequested)');
    expect(formatGoalFidelitySummary({ verdict: 'ship', missing: [], unrequested: [] }))
      .toBe('Goal-fidelity verdict: ship');
  });
});
