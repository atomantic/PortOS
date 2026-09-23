import { describe, expect, it } from 'vitest';
import { collectBoardStyleContext } from './styleContext.js';

const boardWith = (items) => ({
  id: 'mb-1',
  name: 'Universe refs',
  description: 'Dusty painted sci-fi.',
  items,
});

const analyzedItem = {
  id: 'i1',
  type: 'image',
  mediaKey: 'image:ref.png',
  caption: 'palette anchor',
  analysis: {
    prompt: 'a weathered foundry in granular ink wash',
    negativePrompt: 'gloss, neon',
    rationale: 'muted, tactile look',
    analyzedAt: '2026-08-14T00:00:00.000Z',
  },
};

describe('collectBoardStyleContext', () => {
  it('gathers notes, captions, and persisted analyses; skips media items with neither', () => {
    const ctx = collectBoardStyleContext(boardWith([
      analyzedItem,
      { id: 'i2', type: 'text', text: 'lean grim and spiritual', caption: null },
      { id: 'i3', type: 'video', mediaKey: 'video:clip.mp4', caption: null, analysis: null },
    ]));
    expect(ctx.description).toBe('Dusty painted sci-fi.');
    expect(ctx.items).toHaveLength(2);
    expect(ctx.items[0]).toMatchObject({
      kind: 'image',
      caption: 'palette anchor',
      analyzedPrompt: expect.stringContaining('granular ink wash'),
      analyzedNegative: 'gloss, neon',
    });
    expect(ctx.items[1]).toMatchObject({ kind: 'text', note: 'lean grim and spiritual' });
    expect(ctx.droppedItems).toBe(0);
  });

  it('caps the fragment list and reports the overflow', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ id: `t${i}`, type: 'text', text: `note ${i}` }));
    const ctx = collectBoardStyleContext(boardWith(many));
    expect(ctx.items).toHaveLength(60);
    expect(ctx.droppedItems).toBe(10);
  });

  it('bounds the AGGREGATE character budget, not just the fragment count', () => {
    // 50 items × ~600 chars each ≈ 30k chars — under the 60-item cap but past
    // the 24k aggregate budget, so the tail must be dropped.
    const big = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, type: 'text', text: 'x'.repeat(600) }));
    const ctx = collectBoardStyleContext(boardWith(big));
    expect(ctx.items.length).toBeLessThan(50);
    expect(ctx.items.length).toBeGreaterThan(0);
    expect(ctx.droppedItems).toBe(50 - ctx.items.length);
    const total = ctx.items.reduce((sum, it) => sum + it.note.length, 0);
    expect(total).toBeLessThanOrEqual(24000);
  });
});
