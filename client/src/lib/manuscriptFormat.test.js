import { describe, it, expect } from 'vitest';
import { formatManuscript } from './manuscriptFormat.js';

describe('formatManuscript — prose reflow', () => {
  it('rejoins a stylized drop-cap split onto its own line', () => {
    const out = formatManuscript('T\nhe dawn cycle hums to life.', 'prose');
    expect(out).toBe('The dawn cycle hums to life.');
  });

  it('de-hyphenates a word split across a wrap', () => {
    const out = formatManuscript('something approxi-\nmating daylight.', 'prose');
    expect(out).toBe('something approximating daylight.');
  });

  it('joins soft-wrapped lines back into one paragraph', () => {
    const input = [
      'The dawn cycle hums to life the way it',
      'always does — fluorescents warming from',
      'bruise-purple to something approximating',
      'daylight, the sublevel\'s cooling vents.',
    ].join('\n');
    expect(formatManuscript(input, 'prose')).toBe(
      "The dawn cycle hums to life the way it always does — fluorescents warming from "
      + "bruise-purple to something approximating daylight, the sublevel's cooling vents.",
    );
  });

  it('keeps a short heading line separate from the paragraph that follows', () => {
    const input = [
      'Chapter 12: Natural Frequency',
      'The dawn cycle hums to life the way it',
      'always does, warming the cold sublevel air.',
    ].join('\n');
    const out = formatManuscript(input, 'prose');
    expect(out.split('\n')[0]).toBe('Chapter 12: Natural Frequency');
    expect(out.split('\n')[1]).toBe(
      'The dawn cycle hums to life the way it always does, warming the cold sublevel air.',
    );
  });

  it('reproduces the pasted-PDF epigraph artifact end to end', () => {
    const input = [
      'Chapter 12: Natural Frequency',
      '— JUNO, novel manuscript,',
      'final line',
      'T',
      'he dawn cycle hums to life the way it',
      'always does, fluorescents warming the room.',
    ].join('\n');
    expect(formatManuscript(input, 'prose')).toBe([
      'Chapter 12: Natural Frequency',
      '— JUNO, novel manuscript, final line',
      'The dawn cycle hums to life the way it always does, fluorescents warming the room.',
    ].join('\n'));
  });

  it('does not cross a blank-line paragraph break', () => {
    const input = 'First paragraph line one\nline two of it.\n\nSecond paragraph here.';
    expect(formatManuscript(input, 'prose')).toBe(
      'First paragraph line one line two of it.\n\nSecond paragraph here.',
    );
  });

  it('never merges two already-single-line paragraphs (no false join)', () => {
    // Each paragraph is already one line and ends mid-thought without terminal
    // punctuation; a width-threshold heuristic would wrongly fuse them. The
    // lowercase-continuation rule keeps capital-started paragraphs apart.
    const input = [
      'The console hums to life, same as every morning',
      'Maggie does not look up from her diagnostic sweep',
    ].join('\n');
    expect(formatManuscript(input, 'prose')).toBe(input);
  });

  it('is idempotent — formatting clean prose is a no-op', () => {
    const clean = 'A tidy paragraph that needs no changes at all.';
    const once = formatManuscript(clean, 'prose');
    expect(once).toBe(clean);
    expect(formatManuscript(once, 'prose')).toBe(once);
  });
});

describe('formatManuscript — orphaned closing quotes (prose)', () => {
  it('collapses a closing quote left alone on its own line', () => {
    const input = '"The universe is under no obligation to make sense.\n"\n— Maggie Lam';
    expect(formatManuscript(input, 'prose')).toBe(
      '"The universe is under no obligation to make sense."\n— Maggie Lam',
    );
  });

  it('re-attaches a closing quote that wrapped to the start of the next line', () => {
    const input = '"Good morning, Panel Seven,\n" I say, because someone has to talk first.';
    expect(formatManuscript(input, 'prose')).toBe(
      '"Good morning, Panel Seven," I say, because someone has to talk first.',
    );
  });

  it('removes a stray space before a closing quote at end of line', () => {
    const input = '"That\'s more than I can say for most of my relationships. "';
    expect(formatManuscript(input, 'prose')).toBe(
      '"That\'s more than I can say for most of my relationships."',
    );
  });

  it('does not strip the space before an opening quote mid-line', () => {
    const clean = 'She said "hello" and walked on.';
    expect(formatManuscript(clean, 'prose')).toBe(clean);
  });

  it('leaves an opening quote whose dialogue wrapped to the next line intact', () => {
    // `said, "` ends a line because the OPENING quote wrapped — the space sits
    // after a comma, not a sentence-ender, so it must not be eaten like a stray
    // space before a closing quote.
    const input = 'Maggie said, "\nGood morning.';
    expect(formatManuscript(input, 'prose')).toBe('Maggie said, "\nGood morning.');
  });

  it('is idempotent over dirty quote inputs (re-running format = running once)', () => {
    const cases = [
      'A line of prose.\n"\n— Author',          // lone closing quote
      'Some text.\n\n"\n— Author',              // lone closing quote after a blank line
      '"Good morning,\n" I say, and continue.', // wrapped closing quote
      '"You look stable. "',                    // stray space before closing quote
    ];
    for (const dirty of cases) {
      const once = formatManuscript(dirty, 'prose');
      expect(formatManuscript(once, 'prose')).toBe(once);
    }
  });

  it('cleans the full pasted epigraph + dialogue block end to end', () => {
    const input = [
      'Chapter 1: Anomalous Readings',
      '"The universe is under no obligation to make sense to you, but it will absolutely mess with your diagnostics.',
      '"',
      '— Maggie Lam, maintenance log entry #4,072',
      "The universe is under no obligation to make sense to me, but at 0347 station time, I'm not asking it to.",
      '"Good morning, Panel Seven,',
      '" I say, because someone has to talk first.',
      '"You look stable. That\'s more than I can say for most of my relationships. "',
    ].join('\n');
    expect(formatManuscript(input, 'prose')).toBe([
      'Chapter 1: Anomalous Readings',
      '"The universe is under no obligation to make sense to you, but it will absolutely mess with your diagnostics."',
      '— Maggie Lam, maintenance log entry #4,072',
      "The universe is under no obligation to make sense to me, but at 0347 station time, I'm not asking it to.",
      '"Good morning, Panel Seven," I say, because someone has to talk first.',
      '"You look stable. That\'s more than I can say for most of my relationships."',
    ].join('\n'));
  });

  it('leaves script quotes alone — no reflow or quote surgery off the prose path', () => {
    const input = 'CAPTION: "Good morning,\n" she says.';
    expect(formatManuscript(input, 'comicScript')).toBe(input);
  });
});

describe('formatManuscript — conservative (non-prose) stages', () => {
  it('does NOT reflow a comic script — line breaks are structural', () => {
    const input = [
      'PAGE 1',
      'PANEL 1',
      'A wide shot of the plasma pool, steam rising.',
      'JUNO: We shouldn\'t be here.',
    ].join('\n');
    expect(formatManuscript(input, 'comicScript')).toBe(input);
  });

  it('does NOT reflow a teleplay', () => {
    const input = 'INT. SUBLEVEL - DAWN\n\nJUNO crosses to the diagnostic array.';
    expect(formatManuscript(input, 'teleplay')).toBe(input);
  });

  it('still fixes drop-caps and hyphen splits in a comic script', () => {
    const input = 'CAPTION: T\nhe morning of the over-\nride.';
    expect(formatManuscript(input, 'comicScript')).toBe('CAPTION: T\nhe morning of the override.');
    // (drop-cap rejoin is anchored to line start, so the inline "T" above is
    //  untouched; the hyphen split is repaired.)
  });

  it('repairs a true line-start drop-cap in a script', () => {
    expect(formatManuscript('T\nhe end.', 'comicScript')).toBe('The end.');
  });
});

describe('formatManuscript — whitespace hygiene (all stages)', () => {
  it('normalizes CRLF and strips trailing whitespace', () => {
    expect(formatManuscript('line one  \r\nline two\t', 'comicScript')).toBe('line one\nline two');
  });

  it('collapses runs of 3+ blank lines to a single blank line', () => {
    expect(formatManuscript('a\n\n\n\nb', 'teleplay')).toBe('a\n\nb');
  });

  it('returns empty input untouched', () => {
    expect(formatManuscript('', 'prose')).toBe('');
    expect(formatManuscript(null, 'prose')).toBe('');
  });
});
