import { describe, it, expect } from 'vitest';
import { mergeQuotaBurnPatch } from './quotaBurnPatch';

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
