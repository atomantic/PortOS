import { describe, expect, it } from 'vitest';
import { buildTypographyDocument, cueStateAt, normalizeComposition, overlayWindows, renderableCues, sectionCardCues } from './composition.js';

const cue = (over = {}) => ({ id: 'c', text: 'Hello world', startSec: 10, endSec: 12, template: 'fade', placement: 'lower', emphasis: 'subtitle', ...over });

describe('normalizeComposition (#8984)', () => {
  it('fills defaults for a legacy/peer manifest and drops malformed cues without losing text', () => {
    const out = normalizeComposition({
      mode: 'bogus',
      textCues: [
        { text: '  Line one  ', startSec: 1, endSec: 0.5, template: 'spin' },
        { id: 'dup', text: 'Two', startSec: 2, endSec: 3 },
        { id: 'dup', text: 'Three', startSec: -1, endSec: 4 },
        { text: '   ' },
        null,
      ],
      style: { color: '#ABCDEF', font: 'comic' },
      posterSec: 'soon',
    });
    expect(out).toMatchObject({ version: 1, mode: 'concat', style: { color: '#abcdef', font: 'sans' }, posterSec: null });
    expect(out.textCues.map(({ text, startSec, endSec, template }) => ({ text, startSec, endSec, template }))).toEqual([
      { text: 'Line one', startSec: 1, endSec: null, template: 'fade' },
      { text: 'Two', startSec: 2, endSec: 3, template: 'fade' },
      { text: 'Three', startSec: null, endSec: null, template: 'fade' },
    ]);
    // A duplicated id is re-minted so every cue stays addressable.
    expect(out.textCues[1].id).toBe('dup');
    expect(out.textCues[2].id).not.toBe('dup');
    expect(normalizeComposition(null)).toBeNull();
  });

  it('keeps a well-formed styleGrammarId a peer sent (even one this catalog lacks) and drops a malformed one (#10254)', () => {
    expect(normalizeComposition({ styleGrammarId: 'future-peer-medium' }).styleGrammarId).toBe('future-peer-medium');
    expect(normalizeComposition({ styleGrammarId: 'Not A Slug' })).not.toHaveProperty('styleGrammarId');
    expect(normalizeComposition({})).not.toHaveProperty('styleGrammarId');
  });

  it('draws only timed cues, and only in composed mode, clipped to the video', () => {
    const composition = normalizeComposition({ mode: 'composed', textCues: [
      cue({ id: 'late', startSec: 40, endSec: 50 }),
      cue({ id: 'tail', startSec: 25, endSec: 35 }),
      cue({ id: 'untimed', startSec: null, endSec: null }),
      cue({ id: 'early', startSec: 1, endSec: 2 }),
    ] });
    expect(renderableCues(composition, 30).map(({ id, endSec }) => [id, endSec])).toEqual([['early', 2], ['tail', 30]]);
    expect(renderableCues({ ...composition, mode: 'concat' }, 30)).toEqual([]);
  });
});

describe('cueStateAt (#8984)', () => {
  it('is invisible outside its span and fully shown mid-span for every template', () => {
    for (const template of ['fade', 'rise', 'typewriter', 'pop']) {
      const c = cue({ template });
      expect(cueStateAt(c, 9.99)).toBeNull();
      expect(cueStateAt(c, 12)).toBeNull();
      expect(cueStateAt(c, 11)).toEqual({ opacity: 1, offsetY: 0, scale: 1, visibleChars: c.text.length });
    }
  });

  it('animates each template in on its own terms', () => {
    expect(cueStateAt(cue(), 10).opacity).toBe(0);
    expect(cueStateAt(cue({ template: 'rise' }), 10)).toMatchObject({ offsetY: 0.04, opacity: 0 });
    expect(cueStateAt(cue({ template: 'pop' }), 10).scale).toBe(0.85);
    const typed = cue({ template: 'typewriter' });
    // 11 characters typed over 0.55s: 0.2s in reveals ceil(11 × 0.2 / 0.55) = 4.
    expect(cueStateAt(typed, 10.2)).toMatchObject({ opacity: 1, visibleChars: 4 });
  });

  it('never scales past full size or rises above its rest, so motion stays inside the safe area', () => {
    for (let t = 10; t < 12; t += 0.01) {
      const pop = cueStateAt(cue({ template: 'pop' }), t);
      const rise = cueStateAt(cue({ template: 'rise' }), t);
      expect(pop.scale).toBeLessThanOrEqual(1);
      expect(rise.offsetY).toBeGreaterThanOrEqual(0);
      expect(rise.offsetY).toBeLessThanOrEqual(0.04);
    }
  });
});

describe('overlayWindows (#8984)', () => {
  it('joins near-adjacent cues into one capture window and keeps distant ones apart', () => {
    expect(overlayWindows([
      { startSec: 20, endSec: 22 },
      { startSec: 1, endSec: 3 },
      { startSec: 3.5, endSec: 4 },
      { startSec: 2, endSec: 2.5 },
    ])).toEqual([{ startSec: 1, endSec: 4 }, { startSec: 20, endSec: 22 }]);
  });
});

describe('buildTypographyDocument (#8984)', () => {
  it('embeds cue text as inert data that cannot close the script element', () => {
    const html = buildTypographyDocument({ cues: [cue({ text: '</script><img src=x onerror=alert(1)>' })], width: 1920, height: 1080, durationSec: 30, fps: 24 });
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('\\u003c/script>');
    expect(html).not.toContain('innerHTML');
  });

  it('uses the treatment graphic note for counter card motion and type', () => {
    const cards = sectionCardCues(
      [{ sceneId: 'graphic-card-0', layer: 'card', cardText: '198' }],
      [{ sceneId: 'graphic-card-0', startSec: 2, endSec: 2.5 }], 10, 'HUD pictograms and counters');
    expect(cards).toMatchObject([{ text: '198', template: 'pop' }]);
    const html = buildTypographyDocument({ cues: cards, style: { font: 'serif', graphicLanguage: 'HUD counters' },
      width: 1280, height: 720, durationSec: 10, fps: 24 });
    expect(html).toContain('Menlo');
  });
});
