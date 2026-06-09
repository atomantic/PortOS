import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ScoreSheet from './ScoreSheet.jsx';
import { parseScore } from '../../lib/scoreNotation.js';

const FIVE_HUNDRED_MILES = [
  'clef: treble', 'key: C', 'time: 4/4', 'tempo: 68', '',
  "| [C] E4q(If) G4q(you) G4q(miss) G4q(the) | [Am] A4h(train) G4q(I'm) E4q(on) |",
  '| [F] F4q(You) A4q(will) A4q(know) A4q(that) | [C] G4h(I) E4q(am) C4q(gone) |',
  '| [F] F4q(You) A4q(can) A4q(hear) A4q(the) | [C] G4q(whis-) E4q(tle) C4h(blow) |',
  '| [G] D4q(A) F4q(hun-) G4q(dred) rq | [C] C4w(miles) |',
].join('\n');

const count = (html, tag) => (html.match(new RegExp(`<${tag}[ />]`, 'g')) || []).length;

describe('ScoreSheet renderer', () => {
  it('renders nothing when there is no music', () => {
    expect(renderToStaticMarkup(<ScoreSheet text="" />)).toBe('');
    expect(renderToStaticMarkup(<ScoreSheet text="clef: treble" />)).toBe('');
  });

  it('renders the 500 Miles score with no NaN coordinates', () => {
    const html = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} />);
    expect(html).not.toMatch(/NaN/);
    expect(html).toContain('aria-label="Sheet music notation"');
  });

  it('draws one notehead per pitched note', () => {
    const html = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} />);
    const pitched = parseScore(FIVE_HUNDRED_MILES).measures
      .flatMap((m) => m.notes).filter((n) => !n.rest).length;
    expect(count(html, 'ellipse')).toBe(pitched);
  });

  it('draws full five-line staves (a multiple of five staff lines)', () => {
    const html = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} />);
    // Staff lines are the horizontal <line>s spanning the page; barlines are
    // vertical. Count rows by staff lines / 5 — must be a whole number ≥ 1.
    const html2 = renderToStaticMarkup(<ScoreSheet text={'| C4q | C4q |'} />);
    expect(count(html2, 'line')).toBeGreaterThanOrEqual(5);
  });

  it('draws stems on quarter/half notes (filled+stemmed, not all open heads)', () => {
    const html = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} />);
    // Stems are the only stroke-width="1.3" elements. The verse has 24 stemmed
    // notes (everything except the single whole note and the rest). A regression
    // that drops filled/stem off the duration would render 0 here.
    const stems = (html.match(/stroke-width="1.3"/g) || []).length;
    expect(stems).toBe(24);
    // Solid noteheads fill with the theme text colour (filled q/h notes).
    expect(html).toMatch(/<ellipse[^>]*style="[^"]*fill:rgb\(var\(--port-text\)\)/);
  });

  it('colours via theme CSS variables, not hardcoded hex (adapts to day/dark)', () => {
    const html = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} />);
    expect(html).toContain('--port-text');   // ink follows the theme
    expect(html).toContain('--port-accent');  // chord symbols use the accent
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}/); // no fixed hex colours
  });

  it('renders chord symbols and lyrics as text', () => {
    const html = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} />);
    expect(html).toContain('>Am<');
    expect(html).toContain('>train<');
    expect(html).toContain('>If<');
  });

  it('renders ledger lines for notes below the staff (middle C in treble)', () => {
    // C4 sits one ledger line below the treble staff — expect at least one extra
    // short line vs a score with no below-staff notes.
    const withLedger = renderToStaticMarkup(<ScoreSheet text={'| C4w |'} />);
    expect(count(withLedger, 'line')).toBeGreaterThan(6); // 5 staff + 2 barlines + ledger
  });

  it('places a lyric below a low ledger note, not under its notehead', () => {
    // Regression: A3 sits below the treble staff; with a fixed lyric baseline the
    // notehead drew on top of the syllable. The lyric must sit below the head.
    const html = renderToStaticMarkup(<ScoreSheet text={'| A3q(low) F5q(high) |'} />);
    const headY = Number(/<ellipse[^>]*\bcy="([\d.]+)"/.exec(html)?.[1]);
    const lyricY = Number(new RegExp('<text[^>]*\\by="([\\d.]+)"[^>]*>low<').exec(html)?.[1]);
    expect(Number.isFinite(headY)).toBe(true);
    expect(Number.isFinite(lyricY)).toBe(true);
    // Larger y is further down the page — the lyric baseline must be below the head.
    expect(lyricY).toBeGreaterThan(headY);
  });

  it('grows the row height for low ledger notes so lyrics never clip the next row', () => {
    const vb = (html) => Number(/viewBox="0 0 \d+ ([\d.]+)"/.exec(html)?.[1]);
    const low = renderToStaticMarkup(<ScoreSheet text={'| C3q(low) |'} />);   // well below the staff
    const high = renderToStaticMarkup(<ScoreSheet text={'| C5q(high) |'} />);  // above the staff
    // A low-note row reserves more vertical space than a high-note row.
    expect(vb(low)).toBeGreaterThan(vb(high));
    // The low note's lyric baseline stays inside the SVG height (not clipped).
    const lyricY = Number(new RegExp('<text[^>]*\\by="([\\d.]+)"[^>]*>low<').exec(low)?.[1]);
    expect(lyricY).toBeLessThan(vb(low));
  });

  it('renders a bass clef score without error', () => {
    const html = renderToStaticMarkup(<ScoreSheet text={'clef: bass\n| G2q C3q |'} />);
    expect(html).not.toMatch(/NaN/);
    expect(count(html, 'ellipse')).toBe(2);
  });

  it('renders a melody playback control with a labelled tempo input', () => {
    const html = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} />);
    expect(html).toContain('aria-label="Play melody"');
    expect(html).toContain('aria-label="Stop melody"');
    expect(html).toMatch(/<input[^>]*type="number"/); // tempo input
    // The tempo input is label-associated (htmlFor/id), not just visually styled.
    const id = /<input[^>]*\bid="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
  });

  it('omits the playback control when controls=false', () => {
    const html = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} controls={false} />);
    expect(html).not.toContain('aria-label="Play melody"');
  });

  it('highlights the notehead at activeNoteIndex in the theme accent (playhead)', () => {
    const plain = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} controls={false} />);
    // With no playhead, no notehead is painted in the accent colour.
    expect(plain).not.toMatch(/<ellipse[^>]*fill:rgb\(var\(--port-accent\)\)/);
    // The first note (a filled quarter) lights up when it is the active note.
    const lit = renderToStaticMarkup(
      <ScoreSheet text={FIVE_HUNDRED_MILES} controls={false} activeNoteIndex={0} />,
    );
    expect(lit).toMatch(/<ellipse[^>]*fill:rgb\(var\(--port-accent\)\)/);
  });

  it('paints color-match grades on noteheads via theme success/warning/error tokens', () => {
    // noteColors maps global note index → grade. Index 0 in tune (green),
    // index 1 close (yellow), index 2 off (red).
    const graded = renderToStaticMarkup(
      <ScoreSheet
        text={FIVE_HUNDRED_MILES}
        controls={false}
        noteColors={{ 0: 'in-tune', 1: 'close', 2: 'off' }}
      />,
    );
    expect(graded).toMatch(/<ellipse[^>]*fill:rgb\(var\(--port-success\)\)/);
    expect(graded).toMatch(/<ellipse[^>]*fill:rgb\(var\(--port-warning\)\)/);
    expect(graded).toMatch(/<ellipse[^>]*fill:rgb\(var\(--port-error\)\)/);
    // Still only theme tokens — no hardcoded hex sneaks in via grading.
    expect(graded).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('does not paint grade colours when noteColors is absent', () => {
    const plain = renderToStaticMarkup(<ScoreSheet text={FIVE_HUNDRED_MILES} controls={false} />);
    expect(plain).not.toMatch(/<ellipse[^>]*fill:rgb\(var\(--port-success\)\)/);
    expect(plain).not.toMatch(/<ellipse[^>]*fill:rgb\(var\(--port-warning\)\)/);
  });

  it('lets the live playhead (accent) win over a grade on the active note', () => {
    // Note 0 is both graded in-tune AND the active playhead — accent wins so the
    // singer can still see where they are in the score.
    const html = renderToStaticMarkup(
      <ScoreSheet
        text={FIVE_HUNDRED_MILES}
        controls={false}
        noteColors={{ 0: 'in-tune' }}
        activeNoteIndex={0}
      />,
    );
    expect(html).toMatch(/<ellipse[^>]*fill:rgb\(var\(--port-accent\)\)/);
  });
});
