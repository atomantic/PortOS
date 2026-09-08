import { describe, it, expect } from 'vitest';
import {
  dispatchCapInput,
  isUnlimitedDispatchCap,
  mergeQuotaBurnPatch,
  quotaBurnJobIsSpent,
  UNLIMITED_DISPATCHES,
} from './quotaBurnPatch';

describe('quotaBurnJobIsSpent', () => {
  const ranAt = '2026-08-01T00:00:00.000Z';

  it('gates on the step\'s own run-once flag, not on the completion alone', () => {
    // A completion is kept even after the checkbox is cleared, so `ranAt` alone
    // would keep a step the user switched back to repeating looking retired.
    expect(quotaBurnJobIsSpent({ runOnce: true }, ranAt)).toBe(true);
    expect(quotaBurnJobIsSpent({ runOnce: false }, ranAt)).toBe(false);
    expect(quotaBurnJobIsSpent({ runOnce: true }, null)).toBe(false);
  });

  it('reads a missing job or flag as unspent', () => {
    expect(quotaBurnJobIsSpent(undefined, ranAt)).toBe(false);
    expect(quotaBurnJobIsSpent({}, ranAt)).toBe(false);
  });
});

describe('mergeQuotaBurnPatch', () => {
  it('merges top-level keys and leaves families untouched', () => {
    expect(mergeQuotaBurnPatch({ enabled: false, checkIntervalMinutes: 30 }, { enabled: true }))
      .toEqual({ enabled: true, checkIntervalMinutes: 30 });
  });

  it('merges per-family keys without dropping the rest of the plan', () => {
    const base = { families: { grok: { enabled: true, reservePercent: 10 }, codex: { enabled: false } } };
    expect(mergeQuotaBurnPatch(base, { families: { grok: { reservePercent: 40 } } })).toEqual({
      families: { grok: { enabled: true, reservePercent: 40 }, codex: { enabled: false } },
    });
  });

  it('REPLACES a family\'s jobs array', () => {
    // Ordered list: a positional merge would make reordering and deletion
    // inexpressible — the same rule the server's save applies.
    const base = { families: { grok: { jobs: [{ id: 'a' }, { id: 'b' }] } } };
    expect(mergeQuotaBurnPatch(base, { families: { grok: { jobs: [{ id: 'b' }] } } }))
      .toEqual({ families: { grok: { jobs: [{ id: 'b' }] } } });
  });

  it('accumulates successive edits into one patch body', () => {
    // The page folds debounced edits this way, so the trailing PUT carries every
    // change rather than only the last field touched.
    const first = mergeQuotaBurnPatch(null, { families: { grok: { reservePercent: 40 } } });
    const second = mergeQuotaBurnPatch(first, { enabled: true });
    const third = mergeQuotaBurnPatch(second, { families: { grok: { priority: 2 }, codex: { enabled: true } } });
    expect(third).toEqual({
      enabled: true,
      families: { grok: { reservePercent: 40, priority: 2 }, codex: { enabled: true } },
    });
  });

  it('omits families entirely for a top-level-only edit', () => {
    expect(mergeQuotaBurnPatch(null, { enabled: true })).toEqual({ enabled: true });
  });
});

describe('dispatch cap helpers', () => {
  it('reads any negative cap as unlimited and a real cap as bounded', () => {
    expect(isUnlimitedDispatchCap(UNLIMITED_DISPATCHES)).toBe(true);
    expect(isUnlimitedDispatchCap(1)).toBe(false);
    expect(isUnlimitedDispatchCap(50)).toBe(false);
  });

  it('collapses anything below the real minimum to the sentinel the PUT accepts', () => {
    // 0 is what a spinner step down from 1 produces, and the schema rejects it —
    // sending it would 400 and take every co-pending edit with it.
    expect(dispatchCapInput(0)).toBe(UNLIMITED_DISPATCHES);
    expect(dispatchCapInput(-4)).toBe(UNLIMITED_DISPATCHES);
    expect(dispatchCapInput(1)).toBe(1);
    expect(dispatchCapInput(50)).toBe(50);
  });
});

// @vitest-environment node


