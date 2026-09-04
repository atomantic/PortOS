import { describe, expect, it } from 'vitest';
import {
  LOCAL_PREFILL_TOKENS_PER_SECOND,
  describeLocalPromptBudget,
  estimateLocalPrefillMs,
  planLocalPromptBudget,
} from './localPromptBudget.js';

// chars/4 (contextBudget's estimator), so 400K chars ≈ 100K tokens — the size
// the observed Stage 3 envelope actually reached.
const HUGE_PROMPT = 'x'.repeat(400_000);

describe('planLocalPromptBudget', () => {
  it('raises the run duration estimate by the prefill a ~100K-token prompt costs locally', () => {
    // The regression: a 412 KB envelope was dispatched to a local 27B model
    // against a ~13-minute run estimate, and spent ~9 of those minutes in a
    // silent prefill nothing had budgeted for.
    const plan = planLocalPromptBudget({
      prompt: HUGE_PROMPT,
      endpoint: 'localhost:18020',
      baseDurationMs: 13 * 60_000,
    });
    expect(plan.promptTokens).toBe(100_000);
    // Conservative by construction: at least the ~9 minutes the real run took.
    expect(plan.prefillMs).toBeGreaterThanOrEqual(9 * 60_000);
    expect(plan.longPrefill).toBe(true);
    expect(plan.expectedDurationMs).toBe(13 * 60_000 + plan.prefillMs);
  });

  it('keeps an unlearned run estimate absent instead of collapsing it to the bare prefill', () => {
    // Sentinel contract: `baseDurationMs: null` means "nothing learned yet".
    // Reporting the prefill alone as the whole run's estimate would understate
    // the run exactly as badly as having no prefill in it at all.
    const plan = planLocalPromptBudget({ prompt: HUGE_PROMPT, endpoint: 'localhost:18020' });
    expect(plan.prefillMs).toBeGreaterThan(0);
    expect(plan.baseDurationMs).toBeNull();
    expect(plan.expectedDurationMs).toBeNull();
  });

  it('answers null for a cloud endpoint and for a prompt there is nothing to measure', () => {
    // A null plan is what the card reads as "no estimate". A cloud dispatch and
    // a pre-assembly call must both land there rather than on a zero-cost plan.
    expect(planLocalPromptBudget({ prompt: HUGE_PROMPT, endpoint: null })).toBeNull();
    expect(planLocalPromptBudget({ prompt: HUGE_PROMPT, endpoint: '   ' })).toBeNull();
    expect(planLocalPromptBudget({ prompt: '', endpoint: 'localhost:18020' })).toBeNull();
    expect(planLocalPromptBudget()).toBeNull();
  });

  it('does not flag an ordinary agent prompt as a long prefill', () => {
    const plan = planLocalPromptBudget({ prompt: 'y'.repeat(8_000), endpoint: 'localhost:11434' });
    expect(plan.promptTokens).toBe(2_000);
    expect(plan.longPrefill).toBe(false);
  });
});

describe('estimateLocalPrefillMs', () => {
  it('reports no estimate — not an instant one — for a missing token count', () => {
    expect(estimateLocalPrefillMs(null)).toBeNull();
    expect(estimateLocalPrefillMs(0)).toBeNull();
    expect(estimateLocalPrefillMs(Number.NaN)).toBeNull();
    expect(estimateLocalPrefillMs(60_000)).toBe(Math.ceil((60_000 / LOCAL_PREFILL_TOKENS_PER_SECOND) * 1000));
  });

  it('falls back to the conservative default rather than dividing by a garbled rate', () => {
    expect(estimateLocalPrefillMs(1_200, 0)).toBe(estimateLocalPrefillMs(1_200));
    expect(estimateLocalPrefillMs(1_200, -5)).toBe(estimateLocalPrefillMs(1_200));
  });
});

describe('describeLocalPromptBudget', () => {
  it('names the endpoint, the prefill, and the raised estimate', () => {
    const line = describeLocalPromptBudget(planLocalPromptBudget({
      prompt: HUGE_PROMPT,
      endpoint: 'localhost:18020',
      baseDurationMs: 13 * 60_000,
    }));
    expect(line).toContain('localhost:18020');
    expect(line).toContain('100000 prompt tokens');
    expect(line).toContain('run estimate raised to');
    expect(describeLocalPromptBudget(null)).toBeNull();
  });
});
