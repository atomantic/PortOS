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

  it('is idempotent — formatting clean prose is a no-op', () => {
    const clean = 'A tidy paragraph that needs no changes at all.';
    const once = formatManuscript(clean, 'prose');
    expect(once).toBe(clean);
    expect(formatManuscript(once, 'prose')).toBe(once);
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
