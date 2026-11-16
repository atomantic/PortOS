import { describe, it, expect, vi } from 'vitest';
import {
  issueEmbedSeed,
} from './dedup.js';
import {
  checkSemanticDuplicate,
} from './semanticDedup.js';
import {
  SEMANTIC_DEDUP_THRESHOLD,
  SEMANTIC_DEDUP_MAX_CANDIDATES,
  CLOSED_SUPPRESSION_MS,
} from './constants.js';

describe('checkSemanticDuplicate — I/O wrapper', () => {
  const NOW = Date.parse('2026-07-07T00:00:00Z');
  const ok = (embedding) => ({ success: true, embedding });
  const proposal = { title: 'Introduce widget', body: 'add it' };

  it('is unavailable (never suppresses) when there are no embeddable candidates', async () => {
    const embed = vi.fn(async () => ok([1, 0, 0]));
    // plan-style slug-only issue has no title/body to embed
    const res = await checkSemanticDuplicate({ proposal, existingIssues: [{ slug: 's', state: 'open' }], now: NOW, embed });
    expect(res).toEqual({ available: false, duplicate: false, match: null });
    expect(embed).not.toHaveBeenCalled();
  });

  it('is unavailable when the embeddings provider is off (skipped proposal embed)', async () => {
    const embed = vi.fn(async () => ({ skipped: true, reason: 'provider-disabled' }));
    const existing = [{ number: 3, title: 'Add widget', body: 'x', state: 'open' }];
    const res = await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    expect(res.available).toBe(false);
    expect(res.duplicate).toBe(false);
  });

  it('degrades to unavailable (never rejects) on an async rejection OR a synchronous throw', async () => {
    const existing = [{ number: 3, title: 'Add widget', body: 'x', state: 'open' }];
    const asyncThrow = vi.fn(async () => { throw new Error('provider down'); });
    expect(await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed: asyncThrow }))
      .toEqual({ available: false, duplicate: false, match: null });
    // A non-async embedder that throws synchronously must also degrade, not reject.
    const syncThrow = vi.fn(() => { throw new Error('sync boom'); });
    expect(await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed: syncThrow }))
      .toEqual({ available: false, duplicate: false, match: null });
  });

  it('flags a near-duplicate when a candidate embedding is close enough', async () => {
    const embed = vi.fn(async () => ok([1, 0, 0])); // proposal + candidate both identical → score 1
    const existing = [{ number: 3, slug: 'add-widget', title: 'Add widget', body: 'x', state: 'open' }];
    const res = await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    expect(res.available).toBe(true);
    expect(res.duplicate).toBe(true);
    expect(res.match.number).toBe(3);
  });

  it('checks but finds no duplicate when candidates are dissimilar', async () => {
    const embed = vi.fn(async (text) => ok(text === issueEmbedSeed({ title: proposal.title, body: proposal.body }) ? [1, 0, 0] : [0, 1, 0]));
    const existing = [{ number: 3, title: 'Unrelated', body: 'y', state: 'open' }];
    const res = await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    expect(res.available).toBe(true);
    expect(res.duplicate).toBe(false);
    expect(res.match).toBe(null);
  });

  it('ignores long-closed candidates (out of the dedup window)', async () => {
    const embed = vi.fn(async () => ok([1, 0, 0]));
    const old = new Date(NOW - (CLOSED_SUPPRESSION_MS + 1000)).toISOString();
    const existing = [{ number: 3, title: 'Add widget', body: 'x', state: 'closed', closedAt: old }];
    const res = await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    expect(res.available).toBe(false);
    expect(embed).not.toHaveBeenCalled();
  });

  it('caps the number of candidates embedded per run', async () => {
    const embed = vi.fn(async () => ok([0, 1, 0])); // dissimilar so nothing matches
    const existing = Array.from({ length: SEMANTIC_DEDUP_MAX_CANDIDATES + 20 }, (_, i) => ({ number: i, title: `t${i}`, body: 'b', state: 'open' }));
    await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    // 1 proposal embed + at most SEMANTIC_DEDUP_MAX_CANDIDATES candidate embeds
    expect(embed.mock.calls.length).toBe(SEMANTIC_DEDUP_MAX_CANDIDATES + 1);
  });

  it('respects the threshold constant default', () => {
    expect(SEMANTIC_DEDUP_THRESHOLD).toBeGreaterThan(0);
    expect(SEMANTIC_DEDUP_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
