import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DrumSheetView from './DrumSheetView.jsx';

// Invented grooves only (privacy convention).
const ROCK_BEAT = `time: 4/4
tempo: 96
subdivision: 4

# Bar 1 — basic rock beat
HH: x x x x x x x x
S:  - - - - o - - -
K:  o - - - - - o -`;

const count = (html, tag) => (html.match(new RegExp(`<${tag}[ />]`, 'g')) || []).length;

describe('DrumSheetView', () => {
  it('renders a bar-gridded kit sheet with no NaN geometry', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={ROCK_BEAT} />);
    expect(html).not.toMatch(/NaN/);
    expect(html).toContain('aria-label="Drum bar 1: Bar 1 — basic rock beat"');
    expect(html).toContain('Hi-Hat');
    expect(html).toContain('Snare');
    expect(html).toContain('Kick');
  });

  it('shows the chart header summary', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={ROCK_BEAT} />);
    expect(html).toContain('4/4');
    expect(html).toContain('96');
    expect(html).toContain('4 per beat');
    expect(html).toContain('1 bar');
  });

  it('labels the tempo with the ACTUAL beat unit, not always a quarter note', () => {
    // The tempo counts notated beats (the time-signature denominator), which is
    // what playback schedules against — so 6/8 must read as eighth = bpm.
    expect(renderToStaticMarkup(<DrumSheetView text={'time: 4/4\ntempo: 96\n\nK: o'} />)).toContain('♩ = 96');
    expect(renderToStaticMarkup(<DrumSheetView text={'time: 6/8\ntempo: 96\n\nK: o'} />)).toContain('♪ = 96');
    expect(renderToStaticMarkup(<DrumSheetView text={'time: 2/2\ntempo: 60\n\nK: o'} />)).toContain('= 60');
    // An unlisted denominator degrades to a fraction rather than a wrong glyph.
    expect(renderToStaticMarkup(<DrumSheetView text={'time: 4/3\ntempo: 60\n\nK: o'} />)).toContain('1/3 = 60');
  });

  it('takes ink from the theme CSS vars via style, never a var() attribute', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={ROCK_BEAT} />);
    // SVG presentation attributes don't evaluate var() — every themed color must
    // arrive through the style prop.
    expect(html).not.toMatch(/(?:fill|stroke)="(?:rgb\()?var\(/);
    expect(html).toContain('--port-text');
  });

  it('draws one glyph per struck cell only', () => {
    // subdivision 1 → 4 cells/bar; two hits on one row.
    const html = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nK: o-o-'} />);
    expect(count(html, 'circle')).toBe(2);
  });

  it('draws crosses for cymbal-family rows and heads for drums', () => {
    const hats = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nHH: xxxx'} />);
    const kick = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nK: oooo'} />);
    expect(count(hats, 'circle')).toBe(0);      // × strokes, no noteheads
    expect(count(kick, 'circle')).toBe(4);
  });

  it('rings an open hi-hat and adds an accent chevron', () => {
    const open = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nHH: o---'} />);
    expect(count(open, 'circle')).toBe(1);      // the open ring around the ×
    const accent = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nS: X---'} />);
    expect(count(accent, 'path')).toBe(1);      // the accent chevron
  });

  it('draws a flam as a grace glyph plus the main hit', () => {
    const plain = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nS: x---'} />);
    const flam = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nS: f---'} />);
    expect(count(flam, 'circle')).toBe(count(plain, 'circle') + 1);
  });

  it('renders one bar block per bar, including repeat expansions', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={'# A x3\nHH: xxxx'} />);
    expect(count(html, 'svg')).toBe(3);
    expect(html).toContain('(1/3)');
    expect(html).toContain('(3/3)');
  });

  it('gives every bar its own scroll container so wide bars scroll as a unit', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={'# A\nHH: xxxxxxxxxxxxxxxx\n\n# B\nHH: xxxx'} />);
    expect((html.match(/overflow-x-auto/g) || []).length).toBe(2);
  });

  it('highlights the active step column in the active bar only', () => {
    const chart = '# A\nHH: xxxx\n\n# B\nHH: xxxx';
    const none = renderToStaticMarkup(<DrumSheetView text={chart} />);
    const lit = renderToStaticMarkup(<DrumSheetView text={chart} activeStep={{ bar: 2, step: 1 }} />);
    expect(count(none, 'rect')).toBe(0);
    expect(count(lit, 'rect')).toBe(1);           // exactly one playhead column
    expect(lit).toContain('--port-accent');
  });

  it('ignores an out-of-range activeStep instead of drawing off-grid', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nHH: xxxx'} activeStep={{ bar: 1, step: 99 }} />);
    expect(count(html, 'rect')).toBe(0);
    expect(html).not.toMatch(/NaN/);
  });

  it('renders the sheet AND an errors summary for a partly-bad chart', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={'CB: xxxx\nHH: xxxx'} />);
    expect(html).toContain('aria-label="Drum bar 1"');   // the good row still drew
    expect(html).toContain('unknown kit piece');
    expect(html).toContain('1 chart note');
  });

  it('shows an empty-state hint (not a crash) for empty input', () => {
    for (const text of ['', null, undefined, 'time: 4/4']) {
      const html = renderToStaticMarkup(<DrumSheetView text={text} />);
      expect(html).toContain('No drum chart yet');
    }
  });

  it('reports errors even when nothing parsed into a bar', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={'time: nope\n\nCB: xxxx'} />);
    expect(html).toContain('No readable bars');
    expect(html).toContain('bad time signature');
  });

  it('adds tap targets only when onStepClick is provided', () => {
    const chart = 'subdivision: 1\n\nHH: xxxx';
    expect(count(renderToStaticMarkup(<DrumSheetView text={chart} />), 'rect')).toBe(0);
    const interactive = renderToStaticMarkup(<DrumSheetView text={chart} onStepClick={() => {}} />);
    expect(count(interactive, 'rect')).toBe(4);   // one per cell of the single row
  });
});
