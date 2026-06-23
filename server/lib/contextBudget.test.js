import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  usableInputTokens,
  manuscriptContentBudgetChars,
  planManuscriptPass,
  capContextOverhead,
  trimContextToBudget,
  fitContextToManuscriptFloor,
  CHARS_PER_TOKEN,
  FALLBACK_CONTEXT_WINDOW,
  MANUSCRIPT_FLOOR_TOKENS,
} from './contextBudget.js';

const section = (n, chars) => ({ number: n, text: 'x'.repeat(chars) });

// A realistic section following the `${header}\n\n${content}` convention every
// consumer builds before calling planManuscriptPass — so it can be split when
// it alone overflows the window.
const header = (n, title) => `# Issue ${n}${title ? ` — ${title}` : ''} (script)`;
const realSection = (n, content, title = `T${n}`) => ({
  number: n,
  title,
  stageId: 'script',
  content,
  text: `${header(n, title)}\n\n${content}`,
});
// A body of `paras` paragraphs, each `chars` long, joined by blank lines.
const paragraphs = (paras, chars) =>
  Array.from({ length: paras }, (_, i) => `${String.fromCharCode(97 + (i % 26))}`.repeat(chars)).join('\n\n');

describe('contextBudget', () => {
  describe('estimateTokens', () => {
    it('estimates chars/4, rounding up, and tolerates null', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcde')).toBe(2);
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });
  });

  describe('usableInputTokens', () => {
    it('subtracts margin, output reserve, and overhead', () => {
      // 100k window, 10% margin -> 90k; minus 8k reserve minus 2k overhead = 80k
      expect(usableInputTokens({ contextWindow: 100_000, overheadTokens: 2_000 })).toBe(80_000);
    });
    it('falls back to the conservative window when none is declared', () => {
      const u = usableInputTokens({ contextWindow: null, outputReserveTokens: 0, safetyMargin: 0 });
      expect(u).toBe(FALLBACK_CONTEXT_WINDOW);
    });
    it('never goes negative when reserves exceed the window', () => {
      expect(usableInputTokens({ contextWindow: 4_000, outputReserveTokens: 8_000 })).toBe(0);
    });
    it('clamps a nonsensical margin back to the default', () => {
      // margin 2 (>1) is invalid -> default 0.1; 100k -> 90k - 8k = 82k
      expect(usableInputTokens({ contextWindow: 100_000, safetyMargin: 2 })).toBe(82_000);
    });
  });

  describe('planManuscriptPass', () => {
    it('returns whole when the corpus fits the window', () => {
      const plan = planManuscriptPass({
        contextWindow: 1_000_000,
        sections: [section(1, 4_000), section(2, 4_000)],
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(plan.mode).toBe('whole');
      expect(plan.totalTokens).toBe(2_000);
      expect(plan.usableChars).toBe(plan.usableTokens * CHARS_PER_TOKEN);
    });

    it('returns whole for a single over-budget section that cannot be split (no string body)', () => {
      // `section()` has `text` but no `content`, so it can't be split on a body
      // — it stays one over-budget `whole` pass the caller truncates, as before.
      const plan = planManuscriptPass({
        contextWindow: 8_192,
        sections: [section(1, 1_000_000)],
      });
      expect(plan.mode).toBe('whole');
    });

    it('splits a single over-budget section into header-preserving sub-chunks instead of truncating', () => {
      // window 8192, margin 0, reserve 0 -> usable 8192 tokens = 32768 chars.
      // One section whose body is ~200k chars (~50k tokens) overflows alone.
      const body = paragraphs(40, 5_000); // 40 paras * 5000 chars + separators
      const plan = planManuscriptPass({
        contextWindow: 8_192,
        sections: [realSection(7, body, 'Long One')],
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(plan.mode).toBe('chunked');
      expect(plan.chunks.length).toBeGreaterThan(1);

      // Every sub-chunk fits the usable budget once rendered (header + piece).
      const rendered = (s) => `${header(s.number, s.title)}\n\n${s.content}`;
      for (const chunk of plan.chunks) {
        const corpus = chunk.sections.map(rendered).join('\n\n---\n\n');
        expect(corpus.length).toBeLessThanOrEqual(plan.usableChars);
      }

      // Header attribution is preserved on every piece (so downstream
      // first-wins finding-merge dedups by the same issue), and no body text
      // is dropped — concatenating the pieces reproduces the original body.
      const subs = plan.chunks.flatMap((c) => c.sections);
      for (const s of subs) {
        expect(s.number).toBe(7);
        expect(s.title).toBe('Long One');
        expect(s.stageId).toBe('script');
      }
      expect(subs.map((s) => s.content).join('')).toBe(body);
    });

    it('splits on paragraph boundaries when they fit the budget', () => {
      // usable 8192 tokens = 32768 chars; budget for the body is usableChars
      // minus the short header prefix. Paragraphs of 6000 chars -> ~5 per piece.
      const body = paragraphs(20, 6_000);
      const plan = planManuscriptPass({
        contextWindow: 8_192,
        sections: [realSection(3, body)],
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(plan.mode).toBe('chunked');
      const subs = plan.chunks.flatMap((c) => c.sections);
      // Each piece except the last ends on a paragraph boundary (blank line),
      // never mid-paragraph.
      for (const s of subs.slice(0, -1)) {
        expect(s.content.endsWith('\n\n')).toBe(true);
      }
      expect(subs.map((s) => s.content).join('')).toBe(body);
    });

    it('keeps a single over-budget section whole when the header alone exceeds the budget', () => {
      // A pathologically tiny window (4 tokens = 16 chars, smaller than the
      // ~25-char header prefix), so there is no room for any body piece ->
      // falls back to one whole pass.
      const plan = planManuscriptPass({
        contextWindow: 4,
        sections: [realSection(1, paragraphs(10, 2_000))],
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(plan.mode).toBe('whole');
    });

    it('budgets for the inter-section join separator when packing whole sections', () => {
      // 8 sections of exactly 1024 tokens (4096 chars) each sum to exactly the
      // 8192-token budget. Without accounting for the `\n\n---\n\n` join, all 8
      // would pack into one chunk whose rendered corpus (32831 chars) overflows
      // usableChars (32768) and the consumer's slice trims the last section's tail.
      const paddedSection = (n) => {
        const title = 'T';
        const h = header(n, title);
        return { number: n, title, stageId: 'script', content: 'x'.repeat(4_096 - (h.length + 2)), text: `${h}\n\n${'x'.repeat(4_096 - (h.length + 2))}` };
      };
      const sections = Array.from({ length: 8 }, (_, i) => paddedSection(i + 1));
      const plan = planManuscriptPass({ contextWindow: 8_192, sections, outputReserveTokens: 0, safetyMargin: 0 });
      expect(plan.mode).toBe('chunked');
      // Every chunk fits usableChars once rendered the way the consumers render it.
      for (const chunk of plan.chunks) {
        const corpus = chunk.sections.map((s) => `${header(s.number, s.title)}\n\n${s.content}`).join('\n\n---\n\n');
        expect(corpus.length).toBeLessThanOrEqual(plan.usableChars);
      }
      // ...and at least one chunk genuinely packs multiple whole sections.
      expect(plan.chunks.some((c) => c.sections.length > 1)).toBe(true);
    });

    it('splits an over-budget section while packing its small neighbors normally', () => {
      // One huge section between two small ones: the huge one splits, the small
      // ones still pack/standalone, and overall order is preserved.
      const sections = [
        realSection(1, paragraphs(2, 1_000)),
        realSection(2, paragraphs(40, 5_000)),
        realSection(3, paragraphs(2, 1_000)),
      ];
      const plan = planManuscriptPass({ contextWindow: 8_192, sections, outputReserveTokens: 0, safetyMargin: 0 });
      expect(plan.mode).toBe('chunked');
      const order = plan.chunks.flatMap((c) => c.sections.map((s) => s.number));
      // Section 2's pieces all carry number 2, appearing contiguously between 1 and 3.
      expect(order[0]).toBe(1);
      expect(order[order.length - 1]).toBe(3);
      expect(order.filter((n) => n === 2).length).toBeGreaterThan(1);
    });

    it('chunks an over-budget multi-section corpus, preserving order and dropping nothing', () => {
      // window 8192, margin 0, reserve 0 -> usable 8192 tokens = 32768 chars.
      // four 5000-tok sections (20000 chars each) -> packs 1 per chunk (2 would be 10000 > 8192).
      const sections = [section(1, 20_000), section(2, 20_000), section(3, 20_000), section(4, 20_000)];
      const plan = planManuscriptPass({ contextWindow: 8_192, sections, outputReserveTokens: 0, safetyMargin: 0 });
      expect(plan.mode).toBe('chunked');
      const order = plan.chunks.flatMap((c) => c.sections.map((s) => s.number));
      expect(order).toEqual([1, 2, 3, 4]);
      expect(plan.chunks.length).toBe(4);
    });

    it('packs multiple small sections into one chunk up to the budget', () => {
      // usable 8192 tokens; sections of 1000 tokens (4000 chars) each -> 8 fit per chunk
      const sections = Array.from({ length: 10 }, (_, i) => section(i + 1, 4_000));
      const plan = planManuscriptPass({ contextWindow: 8_192, sections, outputReserveTokens: 0, safetyMargin: 0 });
      expect(plan.mode).toBe('chunked');
      expect(plan.chunks[0].sections.length).toBe(8); // 8 * 1000 = 8000 <= 8192
      expect(plan.chunks[1].sections.length).toBe(2);
      const total = plan.chunks.reduce((n, c) => n + c.sections.length, 0);
      expect(total).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Manuscript budget floor (#1459): a large re-sent context block must not
  // starve the manuscript chunk to empty on a small/fallback context window.
  // ---------------------------------------------------------------------------

  describe('manuscriptContentBudgetChars', () => {
    it('scales up to the usable input budget on a large window', () => {
      // 200k window, 0 margin/reserve, 0 overhead -> 200k tokens usable -> 800k chars.
      const cap = manuscriptContentBudgetChars({
        contextWindow: 200_000,
        overheadTokens: 0,
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(cap).toBe(200_000 * CHARS_PER_TOKEN);
    });
    it('respects a medium window instead of forcing the historical 48–60K floor (#1488)', () => {
      // 16k window, 10% margin -> 14745; minus 6000 reserve minus 1500 overhead = 7245
      // tokens -> 28980 chars. The old Math.max(60_000, budgetChars) would have pinned
      // 60_000 chars (~15k tokens) and overflowed this window.
      const cap = manuscriptContentBudgetChars({
        contextWindow: 16_384,
        overheadTokens: 1_500,
        outputReserveTokens: 6_000,
      });
      const budgetTokens = usableInputTokens({ contextWindow: 16_384, overheadTokens: 1_500, outputReserveTokens: 6_000 });
      expect(cap).toBe(budgetTokens * CHARS_PER_TOKEN);
      expect(cap).toBeLessThan(60_000); // would have overflowed under the old fixed floor
    });
    it('floors at the manuscript minimum on a tiny window + large overhead so the content is never empty', () => {
      // 8k window with a heavy output reserve drives the usable input budget to ~0;
      // the floor (MANUSCRIPT_FLOOR_TOKENS) guarantees a non-empty, bounded chunk
      // (a few paragraphs) instead of the 48–60K overflow the old floor produced.
      const cap = manuscriptContentBudgetChars({
        contextWindow: 8_192,
        overheadTokens: 1_500,
        outputReserveTokens: 6_000,
      });
      expect(cap).toBe(MANUSCRIPT_FLOOR_TOKENS * CHARS_PER_TOKEN);
      expect(cap).toBeGreaterThan(0);
    });
    it('honors a custom floor', () => {
      const cap = manuscriptContentBudgetChars({
        contextWindow: 1_000,
        overheadTokens: 0,
        outputReserveTokens: 5_000, // exhausts the window
        floorTokens: 500,
      });
      expect(cap).toBe(500 * CHARS_PER_TOKEN);
    });
    it('caps the floor to the raw window when even the floor cannot fit (#1488 codex review)', () => {
      // 2000-token window, 1500 overhead, 0 reserve/margin -> only 500 tokens of raw
      // room after overhead, less than the 1500-token floor. The floor must NOT
      // overflow the window: trim to the 500 the window can actually hold.
      const cap = manuscriptContentBudgetChars({
        contextWindow: 2_000,
        overheadTokens: 1_500,
        outputReserveTokens: 0,
        safetyMargin: 0,
        floorTokens: 1_500,
      });
      expect(cap).toBe(500 * CHARS_PER_TOKEN);
      expect(cap).toBeLessThan(MANUSCRIPT_FLOOR_TOKENS * CHARS_PER_TOKEN);
    });
    it('yields zero when fixed overhead alone meets or exceeds the window', () => {
      // Overhead (1500) ≥ usable window (1000 * 0.9 = 900) -> nothing fits; send no
      // manuscript rather than overflow the context.
      const cap = manuscriptContentBudgetChars({
        contextWindow: 1_000,
        overheadTokens: 1_500,
        outputReserveTokens: 0,
        safetyMargin: 0.1,
      });
      expect(cap).toBe(0);
    });
  });

  describe('capContextOverhead', () => {
    it('passes context through unchanged when the window comfortably fits everything', () => {
      const r = capContextOverhead({ contextWindow: 100_000, contextTokens: 2_000, fixedOverheadTokens: 1_500 });
      expect(r.allowedContextTokens).toBe(2_000);
      expect(r.trimmed).toBe(false);
    });
    it('caps the context to preserve the manuscript floor on a small window', () => {
      // 8k window, 0 margin, 0 reserve -> 8000 input budget; 1000 fixed -> 7000 left.
      // A 10k-token context wants more than (7000 - floor), so it's capped at
      // 7000 - MANUSCRIPT_FLOOR_TOKENS, leaving the floor for the manuscript.
      const r = capContextOverhead({
        contextWindow: 8_000,
        contextTokens: 10_000,
        fixedOverheadTokens: 1_000,
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(r.allowedContextTokens).toBe(7_000 - MANUSCRIPT_FLOOR_TOKENS);
      expect(r.trimmed).toBe(true);
    });
    it('never returns negative context budget even when the fixed overhead alone exceeds the window', () => {
      const r = capContextOverhead({
        contextWindow: 2_000,
        contextTokens: 5_000,
        fixedOverheadTokens: 4_000,
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(r.allowedContextTokens).toBe(0);
      expect(r.trimmed).toBe(true);
    });
  });

  describe('trimContextToBudget', () => {
    it('passes a string within budget through unchanged', () => {
      expect(trimContextToBudget('short', 100)).toBe('short');
    });
    it('trims to a newline boundary and appends a marker', () => {
      const text = `${'a'.repeat(60)}\n${'b'.repeat(60)}`;
      const out = trimContextToBudget(text, 90);
      expect(out.length).toBeLessThanOrEqual(90);
      expect(out).toContain('context trimmed');
      // Cut at the newline, so the second line is dropped entirely.
      expect(out).not.toContain('b'.repeat(60));
    });
    it('yields empty string when the budget is at or below the marker length', () => {
      expect(trimContextToBudget('anything long enough', 5)).toBe('');
      expect(trimContextToBudget('x', 0)).toBe('');
    });
  });

  describe('fitContextToManuscriptFloor', () => {
    it('leaves context untouched and reports full overhead when it fits', () => {
      const ctx = { sceneMap: 'a'.repeat(400), arcs: 'b'.repeat(200) };
      const r = fitContextToManuscriptFloor(ctx, { contextWindow: 100_000, fixedOverheadTokens: 1_500 });
      expect(r.trimmed).toBe(false);
      expect(r.context).toEqual(ctx);
      // overhead = fixed + estimateTokens(both blocks)
      expect(r.overheadTokens).toBe(1_500 + estimateTokens(ctx.sceneMap) + estimateTokens(ctx.arcs));
    });

    it('trims the LARGEST block first, preserving the bounded ones', () => {
      // Tiny window, huge sceneMap, small arcs. The cut must land on sceneMap.
      const ctx = { sceneMap: 'S'.repeat(40_000), arcs: 'tiny arcs block' };
      const r = fitContextToManuscriptFloor(ctx, {
        contextWindow: 8_000,
        fixedOverheadTokens: 500,
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(r.trimmed).toBe(true);
      // The bounded block survives intact; the unbounded one absorbs the cut.
      expect(r.context.arcs).toBe('tiny arcs block');
      expect(r.context.sceneMap.length).toBeLessThan(ctx.sceneMap.length);
    });

    it('GUARANTEES a non-empty manuscript budget — a huge outline on a small window still leaves the floor', () => {
      // This is the #1459 regression: overhead alone used to meet/exceed the usable
      // budget, slicing the manuscript chunk to ''. After the fit, usableInputTokens
      // with the (trimmed) overhead must leave at least the manuscript floor.
      const ctx = { sceneMap: 'S'.repeat(200_000) };
      const window = 8_000;
      const r = fitContextToManuscriptFloor(ctx, {
        contextWindow: window,
        fixedOverheadTokens: 1_000,
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      const usable = usableInputTokens({
        contextWindow: window,
        overheadTokens: r.overheadTokens,
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      // The manuscript keeps at least the floor — never sliced to empty.
      expect(usable).toBeGreaterThanOrEqual(MANUSCRIPT_FLOOR_TOKENS);
      // And the rendered context now fits the budget it was trimmed for.
      expect(estimateTokens(r.context.sceneMap)).toBeLessThan(estimateTokens(ctx.sceneMap));
    });

    it('keeps the TOTAL token cost within the allowed budget across many small blocks (per-block ceiling)', () => {
      // estimateTokens ceilings per block, so several small blocks could each fit a
      // char budget yet sum to more tokens than allowed. The trim must drive on the
      // token sum, not aggregate chars, or the manuscript undershoots its floor.
      // Odd-length blocks (1001 chars → ceil(1001/4)=251 tokens each) so per-block
      // ceiling rounding accumulates; 30 of them (≈7530 tokens) overflows a 4K window.
      const ctx = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`b${i}`, 'x'.repeat(1_001)]));
      const window = 4_000;
      const fixed = 500;
      const r = fitContextToManuscriptFloor(ctx, {
        contextWindow: window,
        fixedOverheadTokens: fixed,
        outputReserveTokens: 0,
        safetyMargin: 0,
      });
      expect(r.trimmed).toBe(true);
      const usable = usableInputTokens({ contextWindow: window, overheadTokens: r.overheadTokens, outputReserveTokens: 0, safetyMargin: 0 });
      // The floor holds EXACTLY now — the manuscript keeps at least the full floor,
      // even though per-block ceiling rounding would have undershot a char-only trim.
      expect(usable).toBeGreaterThanOrEqual(MANUSCRIPT_FLOOR_TOKENS);
    });

    it('respects a caller-supplied smaller floor (so a short manuscript is not trimmed needlessly)', () => {
      // A modest context + a low floor that the window comfortably fits → no trim.
      const ctx = { sceneMap: 'S'.repeat(4_000) };
      const r = fitContextToManuscriptFloor(ctx, {
        contextWindow: 8_000,
        fixedOverheadTokens: 500,
        outputReserveTokens: 0,
        safetyMargin: 0,
        floorTokens: 100, // a tiny manuscript only needs a little room
      });
      expect(r.trimmed).toBe(false);
      expect(r.context.sceneMap).toBe(ctx.sceneMap);
    });

    it('handles an empty / non-object context as a no-op', () => {
      expect(fitContextToManuscriptFloor(null, { contextWindow: 8_000 })).toEqual({ context: {}, overheadTokens: 0, trimmed: false });
      expect(fitContextToManuscriptFloor({}, { contextWindow: 8_000, fixedOverheadTokens: 500 })).toEqual({ context: {}, overheadTokens: 500, trimmed: false });
    });
  });
});
