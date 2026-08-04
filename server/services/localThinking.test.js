import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./lmStudioManager.js', () => ({
  checkLMStudioAvailable: vi.fn(),
  quickCompletion: vi.fn()
}));

import { checkLMStudioAvailable, quickCompletion } from './lmStudioManager.js';
import { analyzeTask, classifyMemory, getStats, resetStats, COMPLEXITY_THRESHOLDS } from './localThinking.js';

// getStats()/resetStats() operate on module-level singleton state that
// analyzeTask()/classifyMemory() mutate as a side effect — reset between
// tests so counts from one case don't leak into the next.
beforeEach(() => {
  vi.clearAllMocks();
  resetStats();
});

// =============================================================================
// analyzeTask — LM Studio unavailable (keyword-only fallback)
// =============================================================================

describe('analyzeTask (LM Studio unavailable)', () => {
  beforeEach(() => {
    checkLMStudioAvailable.mockResolvedValue(false);
  });

  it('scores a high-complexity keyword description above the escalation threshold', async () => {
    const result = await analyzeTask({ description: 'refactor the entire codebase for security' });
    expect(result.complexity).toBeGreaterThanOrEqual(0.8);
    expect(result.escalateToCloud).toBe(true);
    expect(result.localAnalysis).toBe(false);
    expect(result.reason).toBe('LM Studio unavailable, using keyword analysis');
  });

  it('scores a low-complexity keyword description below the escalation threshold', async () => {
    const result = await analyzeTask({ description: 'fix a typo in the readme' });
    expect(result.complexity).toBe(0.3);
    expect(result.escalateToCloud).toBe(false);
  });

  it('scores a medium-complexity keyword description at the default midpoint', async () => {
    const result = await analyzeTask({ description: 'implement a new feature' });
    expect(result.complexity).toBe(0.5);
    expect(result.escalateToCloud).toBe(false);
  });

  it('defaults to medium complexity for an empty/missing description', async () => {
    const result = await analyzeTask({});
    expect(result.complexity).toBe(0.5);
    expect(result.escalateToCloud).toBe(false);
  });

  it('boosts complexity for a long description with no matching keywords', async () => {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(20); // > 1000 chars, no keyword hits
    expect(filler.length).toBeGreaterThan(1000);
    const result = await analyzeTask({ description: filler });
    // base 0.5 + 0.1 (>500 chars) + 0.1 (>1000 chars) = 0.7
    expect(result.complexity).toBeCloseTo(0.7, 5);
  });

  it('caps the length boost at 1.0 even when combined with a high-complexity keyword', async () => {
    const filler = 'refactor ' + 'x'.repeat(1200);
    const result = await analyzeTask({ description: filler });
    expect(result.complexity).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// analyzeTask — LM Studio available (local-model analysis)
// =============================================================================

describe('analyzeTask (LM Studio available)', () => {
  beforeEach(() => {
    checkLMStudioAvailable.mockResolvedValue(true);
  });

  it('escalates when the local model reports complexity above the complex threshold', async () => {
    quickCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({ complexity: COMPLEXITY_THRESHOLDS.complex + 0.05, requiresArchitecturalDecisions: false })
    });
    const result = await analyzeTask({ description: 'do something' });
    expect(result.escalateToCloud).toBe(true);
    expect(result.localAnalysis).toBe(true);
    expect(result.reason).toBe('Task requires advanced reasoning');
  });

  it('escalates when the local model flags an architectural decision, even at low complexity', async () => {
    quickCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({ complexity: 0.1, requiresArchitecturalDecisions: true })
    });
    const result = await analyzeTask({ description: 'do something' });
    expect(result.escalateToCloud).toBe(true);
  });

  it('escalates for multi-file changes only when complexity also exceeds the medium threshold', async () => {
    const belowMedium = await (async () => {
      quickCompletion.mockResolvedValue({
        success: true,
        content: JSON.stringify({ complexity: COMPLEXITY_THRESHOLDS.medium - 0.1, requiresMultiFileChanges: true })
      });
      return analyzeTask({ description: 'do something' });
    })();
    expect(belowMedium.escalateToCloud).toBe(false);

    const aboveMedium = await (async () => {
      quickCompletion.mockResolvedValue({
        success: true,
        content: JSON.stringify({ complexity: COMPLEXITY_THRESHOLDS.medium + 0.1, requiresMultiFileChanges: true })
      });
      return analyzeTask({ description: 'do something' });
    })();
    expect(aboveMedium.escalateToCloud).toBe(true);
  });

  it('does not escalate a low-complexity task with no risk flags', async () => {
    quickCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({ complexity: 0.2, requiresArchitecturalDecisions: false, requiresMultiFileChanges: false })
    });
    const result = await analyzeTask({ description: 'do something' });
    expect(result.escalateToCloud).toBe(false);
    expect(result.reason).toBe('Task suitable for local execution');
  });

  it('surfaces the suggested approach and risks from the local model', async () => {
    quickCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        complexity: 0.4,
        suggestedApproach: 'Write a helper function',
        potentialRisks: ['may break existing callers']
      })
    });
    const result = await analyzeTask({ description: 'do something' });
    expect(result.suggestedApproach).toBe('Write a helper function');
    expect(result.potentialRisks).toEqual(['may break existing callers']);
    expect(result.suggestions).toEqual(['may break existing callers']);
  });

  it('falls back to keyword complexity when the local completion call fails', async () => {
    quickCompletion.mockResolvedValue({ success: false, error: 'model not loaded' });
    const result = await analyzeTask({ description: 'refactor everything' });
    expect(result.localAnalysis).toBe(false);
    expect(result.reason).toBe('Local analysis failed: model not loaded');
    expect(result.complexity).toBeGreaterThanOrEqual(0.8); // keyword fallback still applies
  });

  it('falls back to keyword complexity when the local model response has no parseable JSON', async () => {
    quickCompletion.mockResolvedValue({ success: true, content: 'not json at all' });
    const result = await analyzeTask({ description: 'refactor everything' });
    expect(result.localAnalysis).toBe(true);
    expect(result.reason).toBe('Could not parse local analysis');
    expect(result.rawResponse).toBe('not json at all');
    expect(result.complexity).toBeGreaterThanOrEqual(0.8);
  });

  it('falls back to keyword complexity when the local model response is malformed JSON', async () => {
    quickCompletion.mockResolvedValue({ success: true, content: '{ complexity: 0.9,, }' });
    const result = await analyzeTask({ description: 'fix a typo' });
    expect(result.localAnalysis).toBe(true);
    expect(result.complexity).toBe(0.3); // keyword fallback for "typo"
  });
});

// =============================================================================
// classifyMemory
// =============================================================================

describe('classifyMemory', () => {
  it('reports unavailable when LM Studio cannot be reached', async () => {
    checkLMStudioAvailable.mockResolvedValue(false);
    const result = await classifyMemory('The user prefers dark mode.');
    expect(result).toEqual({ success: false, error: 'LM Studio unavailable' });
  });

  it('returns the parsed classification on success', async () => {
    checkLMStudioAvailable.mockResolvedValue(true);
    quickCompletion.mockResolvedValue({
      success: true,
      content: JSON.stringify({ type: 'preference', category: 'other', tags: ['ui'], importance: 0.4 })
    });
    const result = await classifyMemory('The user prefers dark mode.');
    expect(result).toEqual({
      success: true,
      type: 'preference',
      category: 'other',
      tags: ['ui'],
      importance: 0.4
    });
  });

  it('propagates the completion error when the local call fails', async () => {
    checkLMStudioAvailable.mockResolvedValue(true);
    quickCompletion.mockResolvedValue({ success: false, error: 'timeout' });
    const result = await classifyMemory('some memory');
    expect(result).toEqual({ success: false, error: 'timeout' });
  });

  it('returns a bare success with no fields when the response has no JSON braces at all', async () => {
    // No `{...}` substring means the regex match is null; spreading `null` into
    // the return object is a JS no-op (not an error), so this short-circuits to
    // `{ success: true }` WITHOUT hitting the catch/parse-failure branch below.
    checkLMStudioAvailable.mockResolvedValue(true);
    quickCompletion.mockResolvedValue({ success: true, content: 'nonsense response' });
    const result = await classifyMemory('some memory');
    expect(result).toEqual({ success: true });
  });

  it('reports a parse failure with the raw response when the matched braces are invalid JSON', async () => {
    checkLMStudioAvailable.mockResolvedValue(true);
    quickCompletion.mockResolvedValue({ success: true, content: '{ type: unquoted-key }' });
    const result = await classifyMemory('some memory');
    expect(result).toEqual({
      success: false,
      error: 'Could not parse classification',
      rawResponse: '{ type: unquoted-key }'
    });
  });
});

// =============================================================================
// getStats / resetStats
// =============================================================================

describe('getStats', () => {
  it('reports zero rates with no analyses recorded', () => {
    const stats = getStats();
    expect(stats).toEqual({
      localAnalyses: 0,
      cloudEscalations: 0,
      localSuccesses: 0,
      localFailures: 0,
      localSuccessRate: '0%',
      escalationRate: '0%'
    });
  });

  it('tracks success and escalation rates across multiple analyses', async () => {
    checkLMStudioAvailable.mockResolvedValue(true);

    // One successful, non-escalating analysis
    quickCompletion.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({ complexity: 0.1 })
    });
    await analyzeTask({ description: 'do something' });

    // One successful, escalating analysis
    quickCompletion.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({ complexity: 0.95 })
    });
    await analyzeTask({ description: 'do something else' });

    // One failed local completion
    quickCompletion.mockResolvedValueOnce({ success: false, error: 'down' });
    await analyzeTask({ description: 'a third task' });

    const stats = getStats();
    expect(stats.localAnalyses).toBe(3);
    expect(stats.localSuccesses).toBe(2);
    expect(stats.localFailures).toBe(1);
    expect(stats.cloudEscalations).toBe(1);
    expect(stats.localSuccessRate).toBe('66.7%');
    expect(stats.escalationRate).toBe('33.3%');
  });
});
