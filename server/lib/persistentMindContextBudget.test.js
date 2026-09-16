import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BUDGET_PAUSE_REASON_PREFIX,
  contextBudgetPauseReasonFrom,
  formatContextBudgetPauseReason,
  isContextBudgetFitnessError,
  isContextBudgetPauseReason,
  parseContextBudgetTokens,
  publicContextBudgetReason,
} from './persistentMindContextBudget.js';

describe('persistentMindContextBudget', () => {
  const sample = 'Ollama (qwen3:8b): known 12288-token context is below the 15104-token request budget';

  it('parses known/required token counts from the providerStatus budget message', () => {
    expect(parseContextBudgetTokens(sample)).toEqual({ known: 12288, required: 15104 });
    expect(parseContextBudgetTokens('unrelated failure')).toBeNull();
  });

  it('classifies the budget message and attached context-length category as fitness errors', () => {
    expect(isContextBudgetFitnessError(sample)).toBe(true);
    expect(isContextBudgetFitnessError(new Error(sample))).toBe(true);
    expect(isContextBudgetFitnessError(Object.assign(new Error('prompt too large'), {
      errorAnalysis: { category: 'context-length', message: 'prompt too large' },
    }))).toBe(true);
    expect(isContextBudgetFitnessError('provider stream ended without a response')).toBe(false);
    expect(isContextBudgetFitnessError(Object.assign(new Error('rate limited'), {
      category: 'rate-limit',
    }))).toBe(false);
  });

  it('formats an actionable pause reason with numbers and a numCtx recovery hint', () => {
    const reason = formatContextBudgetPauseReason({ known: 12288, required: 15104 });
    expect(reason.startsWith(CONTEXT_BUDGET_PAUSE_REASON_PREFIX)).toBe(true);
    expect(reason).toContain('12288');
    expect(reason).toContain('15104');
    expect(reason).toMatch(/numCtx/i);
    expect(isContextBudgetPauseReason(reason)).toBe(true);
    expect(isContextBudgetPauseReason(sample)).toBe(true);
    expect(isContextBudgetPauseReason('Paused from the Mind page')).toBe(false);
    expect(isContextBudgetPauseReason(null)).toBe(false);
  });

  it('builds the public reason from raw or already-formatted errors without leaking extras', () => {
    expect(publicContextBudgetReason(sample)).toBe(contextBudgetPauseReasonFrom(sample));
    expect(publicContextBudgetReason(contextBudgetPauseReasonFrom(sample))).toBe(
      contextBudgetPauseReasonFrom(sample),
    );
    expect(publicContextBudgetReason('provider stream ended')).toBeNull();
    expect(publicContextBudgetReason(null)).toBeNull();
  });
});
