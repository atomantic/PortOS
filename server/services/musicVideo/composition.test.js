import { describe, expect, it } from 'vitest';
import { productionReviewBasis } from './productionReview.js';
import { buildTypographyDocument, composedLyricWindows, cueStateAt, normalizeComposition, overlayWindows, withAutopilotCutting, projectTypographyPlan, renderableCues, sectionCardCues } from './composition.js';

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

describe('composedLyricWindows', () => {
  const lyricCues = [
    { text: 'found a shot', startSec: 1, endSec: 1.6, words: [{ w: 'found', startSec: 1, endSec: 1.2 }, { w: 'shot', startSec: 1.4, endSec: 1.9 }] },
    { text: 'then changed the scene', startSec: 10, endSec: 11 },
    { text: 'past the end', startSec: 30, endSec: 31 },
  ];
  const project = (composition) => ({ composition, lyricCues });

  it('draws the timed lyrics of a composed render with no subtitle cues, holding past each line', () => {
    expect(composedLyricWindows(project({ mode: 'composed', textCues: [] }), 20)).toEqual([
      { startSec: 1, endSec: 3.9 }, { startSec: 10, endSec: 13 },
    ]);
    // A hero cue is a title over the lyrics, not a stand-in for them.
    const hero = { id: 'h', text: 'TITLE', startSec: 0, endSec: 2, emphasis: 'hero' };
    expect(composedLyricWindows(project({ mode: 'composed', textCues: [hero] }), 20)).toHaveLength(2);
  });

  it('suppresses automatic overlay windows without consuming timed lyrics or authored text', () => {
    const hidden = { ...project({ mode: 'composed', textCues: [] }), lyricOverlayEnabled: false };
    expect(composedLyricWindows(hidden, 20)).toEqual([]);
    expect(hidden.lyricCues).toEqual(lyricCues);
    expect(composedLyricWindows({ ...hidden, lyricOverlayEnabled: true }, 20)).toHaveLength(2);
    const title = { id: 'title', text: 'Example title', startSec: 0, endSec: 1, emphasis: 'hero' };
    expect(projectTypographyPlan({ ...hidden, composition: { mode: 'composed', textCues: [title] } }, [], [], 20).cues).toHaveLength(1);
  });

  it('leaves the lyrics to subtitle cues, and to every other render mode', () => {
    const subtitle = { id: 's', text: 'my own line', startSec: 0, endSec: 2, emphasis: 'subtitle' };
    expect(composedLyricWindows(project({ mode: 'composed', textCues: [subtitle] }), 20)).toEqual([]);
    expect(composedLyricWindows(project({ mode: 'concat', textCues: [] }), 20)).toEqual([]);
    expect(composedLyricWindows(project(undefined), 20)).toEqual([]);
  });
});

describe('card cues (#11185)', () => {
  it('turns the sheet joiner into real line breaks and draws in the lyric type look', () => {
    const cards = sectionCardCues(
      [{ sceneId: 's1', layer: 'card', cardText: 'First line / Second line' }],
      [{ sceneId: 's1', startSec: 0, endSec: 3 }], 10);
    expect(cards[0].text).toBe('First line\nSecond line');
    const html = buildTypographyDocument({ cues: cards, width: 1280, height: 720, durationSec: 10, fps: 24 });
    expect(html).toContain('"MV Archivo"');
    expect(html).toContain('white-space: pre-line');
  });
});

describe('opening title card in composed renders', () => {
  const titleCard = { enabled: true, title: 'Example Song', artist: 'Example Artist', year: '2026', startSec: 1, endSec: 6 };

  it('is a capture window drawn by the title card runtime, not a text cue', () => {
    const plan = projectTypographyPlan({ composition: { mode: 'composed' }, titleCard }, [], [], 10);
    const cue = plan.cues.find((c) => c.titleCard);
    expect(cue).toMatchObject({ startSec: 1, endSec: 6, titleCard: { title: 'Example Song' } });
    const html = buildTypographyDocument({ cues: plan.cues, width: 1280, height: 720, durationSec: 10, fps: 24 });
    expect(html).toContain('__portosTitleCard');
    expect(html).not.toContain('"id":"title-card"');
  });

  it('is left out when the project is not composed or the card is off', () => {
    expect(projectTypographyPlan({ composition: { mode: 'footage' }, titleCard }, [], [], 10).cues).toEqual([]);
    expect(projectTypographyPlan({ composition: { mode: 'composed' }, titleCard: { ...titleCard, enabled: false } }, [], [], 10).cues).toEqual([]);
  });

  it('adds the end showing as a second window when it is on, clipped to the cut', () => {
    const withEnd = { ...titleCard, outro: true, outroStartSec: 7, outroEndSec: 12 };
    const cues = projectTypographyPlan({ composition: { mode: 'composed' }, titleCard: withEnd }, [], [], 10).cues.filter((c) => c.titleCard);
    expect(cues.map(({ id, startSec, endSec }) => ({ id, startSec, endSec }))).toEqual([
      { id: 'title-card', startSec: 1, endSec: 6 }, { id: 'title-card-end', startSec: 7, endSec: 10 }]);
    const past = { ...withEnd, outroStartSec: 11, outroEndSec: 14 };
    expect(projectTypographyPlan({ composition: { mode: 'composed' }, titleCard: past }, [], [], 10).cues.filter((c) => c.titleCard)).toHaveLength(1);
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

describe('withAutopilotCutting keeps the Art approval basis (#14174)', () => {
  it('defaulting cutting does not stale Art for a project with no composition or no mode', () => {
    for (const project of [{ id: 'p' }, { id: 'p', composition: { cutting: undefined } }]) {
      const started = withAutopilotCutting(project);
      expect(started.composition.cutting).toBe('intercut');
      expect(productionReviewBasis(started).art).toBe(productionReviewBasis(project).art);
    }
  });

  it('a real render mode change still stales Art', () => {
    const project = { id: 'p', composition: { mode: 'concat' } };
    const started = withAutopilotCutting(project);
    expect(started.composition.mode).toBe('concat');
    expect(productionReviewBasis(started).art).toBe(productionReviewBasis(project).art);
    expect(productionReviewBasis({ ...started, composition: { ...started.composition, mode: 'composed' } }).art)
      .not.toBe(productionReviewBasis(project).art);
  });
});
