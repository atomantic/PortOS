import { describe, it, expect } from 'vitest';
import {
  CHORD_TOKEN_RE,
  detectFormat,
  parseTabSheet,
  normalizePastedTab,
  transposeChordName,
  transposeText,
} from './tabNotation.js';

// All fixture content is invented ("Example Song" by "The Placeholders") —
// never real lyrics or real records.

describe('CHORD_TOKEN_RE', () => {
  const CHORDS = [
    'C', 'A', 'G7', 'Am', 'Am7', 'Bm', 'F#', 'Bb', 'F#m', 'Bbm7',
    'Cmaj7', 'Cmin7', 'CM7', 'Cm7b5', 'F#m7b5', 'C7#9', 'Cdim', 'Cdim7',
    'Caug', 'C+', 'Asus', 'Asus2', 'Dsus4', 'Cadd9', 'Gadd9', 'C6', 'C9',
    'C11', 'C13', 'C6/9', 'G/B', 'D/F#', 'Eb/Bb', 'Am7/G', 'Co7', 'C°', 'Cø7',
    'B7sus4', 'C(b5)', 'Cm(maj7)', 'N.C.', 'NC',
  ];
  it.each(CHORDS)('matches %s', (token) => {
    expect(CHORD_TOKEN_RE.test(token)).toBe(true);
  });

  const WORDS = [
    'day', 'the', 'life', 'Amen', 'Ambient', 'Bad', 'Dad', 'Go', 'Do', 'No',
    'Hey', 'Chorus', 'maj7', 'H', 'A-round', 'Bass', 'Edge', 'Gone', 'Fine',
    'Am7x', 'C/H', 'lantern', 'a',
  ];
  it.each(WORDS)('does not match %s', (token) => {
    expect(CHORD_TOKEN_RE.test(token)).toBe(false);
  });
});

describe('parseTabSheet — line classification', () => {
  const types = (text) => parseTabSheet(text).lines.map((l) => l.type);

  it('classifies a full invented sheet', () => {
    const sheet = [
      '[Verse 1]',
      'C        G        Am',
      'Paper boats on a cardboard sea',
      '',
      'e|--3--2--0-------|',
      'B|------3--1------|',
      'Just some spoken stage notes here',
    ].join('\n');
    expect(types(sheet)).toEqual([
      'section', 'chords', 'lyric', 'blank', 'tabstaff', 'tabstaff', 'text',
    ]);
  });

  it('extracts chord names and columns from a chords line', () => {
    const { lines } = parseTabSheet('C        G7       Am');
    expect(lines[0].type).toBe('chords');
    expect(lines[0].chords).toEqual([
      { name: 'C', col: 0 },
      { name: 'G7', col: 9 },
      { name: 'Am', col: 18 },
    ]);
  });

  it('accepts bar separators and repeat markers as filler on chord lines', () => {
    const { lines } = parseTabSheet('| C | G | Am | (x2)');
    expect(lines[0].type).toBe('chords');
    expect(lines[0].chords.map((c) => c.name)).toEqual(['C', 'G', 'Am']);
  });

  it('counts parenthesized chords with an offset col', () => {
    const { lines } = parseTabSheet('C (Am7) G');
    expect(lines[0].chords).toEqual([
      { name: 'C', col: 0 },
      { name: 'Am7', col: 3 },
      { name: 'G', col: 8 },
    ]);
  });

  it('does NOT classify "A day in the life" style lyrics as chords', () => {
    expect(types('A day in the life')).toEqual(['text']);
    expect(types('Amber waves and gray tin skies')).toEqual(['text']);
    expect(types('Be Good Every Day')).toEqual(['text']);
  });

  it('treats a lone bare "A" line as text, but unambiguous singles as chords', () => {
    expect(types('A')).toEqual(['text']);
    expect(types('Am')).toEqual(['chords']);
    expect(types('F#')).toEqual(['chords']);
    expect(types('Am7')).toEqual(['chords']);
  });

  it('classifies 2+ bare-letter tokens as chords', () => {
    expect(types('A D A E')).toEqual(['chords']);
  });

  it('rejects lines below the 80% chord density gate', () => {
    expect(types('C G and then repeat forever')).toEqual(['text']);
    expect(types('C Am F G repeat')).toEqual(['chords']); // 4/5 = 80%
  });

  it('promotes only the line directly under a chords line to lyric', () => {
    const sheet = 'C   G\nFirst invented line\nSecond invented line';
    expect(types(sheet)).toEqual(['chords', 'lyric', 'text']);
  });

  it('does not promote across a blank line', () => {
    expect(types('C   G\n\nInvented line')).toEqual(['chords', 'blank', 'text']);
  });
});

describe('parseTabSheet — sections', () => {
  const first = (text) => parseTabSheet(text).lines[0];

  it('bracket headers become sections with a label', () => {
    expect(first('[Verse 1]')).toEqual({ type: 'section', text: '[Verse 1]', label: 'Verse 1' });
    expect(first('[Pre-Chorus]').type).toBe('section');
    expect(first('[Intro]').label).toBe('Intro');
  });

  it('a whole-line bracketed chord is chordlyric, not a section', () => {
    const line = first('[Am]');
    expect(line.type).toBe('chordlyric');
    expect(line.chords).toEqual([{ name: 'Am', col: 0 }]);
  });

  it('ChordPro long and short section directives', () => {
    expect(first('{start_of_chorus}')).toMatchObject({ type: 'section', label: 'Chorus' });
    expect(first('{soc}')).toMatchObject({ type: 'section', label: 'Chorus' });
    expect(first('{sov}')).toMatchObject({ type: 'section', label: 'Verse' });
    expect(first('{sot}')).toMatchObject({ type: 'section', label: 'Tab' });
    expect(first('{start_of_verse: Verse 2}')).toMatchObject({ type: 'section', label: 'Verse 2' });
  });

  it('ChordPro end directives are sections with an empty label', () => {
    expect(first('{end_of_chorus}')).toMatchObject({ type: 'section', label: '' });
    expect(first('{eoc}')).toMatchObject({ type: 'section', label: '' });
  });

  it('bare section words with optional number/colon', () => {
    expect(first('Chorus').type).toBe('section');
    expect(first('Verse 2:')).toMatchObject({ type: 'section', label: 'Verse 2' });
    expect(first('CHORUS:').type).toBe('section');
  });

  it('unknown {directives} are text, not sections', () => {
    expect(first('{comment: play softly}').type).toBe('text');
  });
});

describe('parseTabSheet — tab staffs', () => {
  const type = (line) => parseTabSheet(line).lines[0].type;

  it('recognizes string-letter-prefixed staffs on all six strings', () => {
    for (const staff of [
      'e|--3--2--0-------|',
      'B|------3--1------|',
      'G|----0-----0-----|',
      'D|-0--------------|',
      'A|----------------|',
      'E|----------------|',
    ]) {
      expect(type(staff), staff).toBe('tabstaff');
    }
  });

  it('recognizes bar-first staffs and technique glyphs', () => {
    expect(type('|--3h5p3--7/9--12\\10--|')).toBe('tabstaff');
    expect(type('e|--<7>--x--~~--|')).toBe('tabstaff');
    expect(type('C#|--4--6--|')).toBe('tabstaff');
  });

  it('does not classify chord lines with bars as tabstaff', () => {
    expect(type('C | G | Am')).toBe('chords');
  });

  it('does not classify divider lines as tabstaff', () => {
    expect(type('----------------')).toBe('text');
  });
});

describe('parseTabSheet — chordlyric', () => {
  it('extracts chords with col offsets into the bare lyric', () => {
    const { lines } = parseTabSheet('[C]Twinkle [G]little [Am]lamp');
    expect(lines[0].type).toBe('chordlyric');
    expect(lines[0].text).toBe('Twinkle little lamp');
    expect(lines[0].chords).toEqual([
      { name: 'C', col: 0 },
      { name: 'G', col: 8 },
      { name: 'Am', col: 15 },
    ]);
  });

  it('mid-word chords land at the right column', () => {
    const { lines } = parseTabSheet('Won[C]der[G]ful');
    expect(lines[0].text).toBe('Wonderful');
    expect(lines[0].chords).toEqual([
      { name: 'C', col: 3 },
      { name: 'G', col: 6 },
    ]);
  });

  it('non-chord brackets stay literal in the lyric', () => {
    const { lines } = parseTabSheet('[C]La la [weird] la');
    expect(lines[0].text).toBe('La la [weird] la');
    expect(lines[0].chords).toEqual([{ name: 'C', col: 0 }]);
  });
});

describe('parseTabSheet — meta + errors', () => {
  it('extracts ChordPro meta directives', () => {
    const { meta } = parseTabSheet(
      '{title: Example Song}\n{artist: The Placeholders}\n{key: G}\n{capo: 2}',
    );
    expect(meta).toEqual({ title: 'Example Song', artist: 'The Placeholders', key: 'G', capo: 2 });
  });

  it('supports the short aliases {t:} and {st:}', () => {
    const { meta } = parseTabSheet('{t: Example Song}\n{st: The Placeholders}');
    expect(meta).toEqual({ title: 'Example Song', artist: 'The Placeholders' });
  });

  it('first occurrence wins for duplicate directives', () => {
    const { meta } = parseTabSheet('{title: Example Song}\n{title: Other Title}');
    expect(meta.title).toBe('Example Song');
  });

  it('collects invalid capo values as errors without throwing', () => {
    const { meta, errors } = parseTabSheet('{capo: banana}\n{title: Example Song}');
    expect(meta.capo).toBeUndefined();
    expect(meta.title).toBe('Example Song');
    expect(errors).toEqual(['invalid capo value "banana"']);
  });

  it('never throws on junk input and keeps lines 1:1', () => {
    expect(parseTabSheet(null)).toEqual({ lines: [{ type: 'blank', text: '' }], meta: {}, errors: [] });
    expect(parseTabSheet(undefined).errors).toEqual([]);
    expect(parseTabSheet('a\nb\nc').lines).toHaveLength(3);
  });
});

describe('detectFormat', () => {
  it('chordpro via directives', () => {
    expect(detectFormat('{title: Example Song}\nC G Am')).toBe('chordpro');
    expect(detectFormat('{soc}\nla la\n{eoc}')).toBe('chordpro');
  });

  it('chordpro via inline chord brackets', () => {
    expect(detectFormat('[C]Hum a [G]made-up tune')).toBe('chordpro');
  });

  it('chordpro wins even when tab staffs appear first', () => {
    expect(detectFormat('e|--3--|\n{capo: 1}')).toBe('chordpro');
  });

  it('tab via staff lines or chord lines', () => {
    expect(detectFormat('e|--3--2--|\nB|--1--3--|')).toBe('tab');
    expect(detectFormat('C   G   Am\nInvented lyric line')).toBe('tab');
  });

  it('plain for prose', () => {
    expect(detectFormat('Just a note the user typed about a song.')).toBe('plain');
    expect(detectFormat('')).toBe('plain');
    expect(detectFormat(undefined)).toBe('plain');
  });
});

describe('normalizePastedTab', () => {
  it('normalizes CRLF and bare CR to LF', () => {
    expect(normalizePastedTab('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips HTML tags and converts breaks to newlines', () => {
    expect(normalizePastedTab('<span class="c">C  G</span><br>la la')).toBe('C  G\nla la');
    expect(normalizePastedTab('<div>C</div><p>G</p>')).toBe('C\nG');
  });

  it('preserves tab harmonics angle brackets', () => {
    expect(normalizePastedTab('e|--<7>--|')).toBe('e|--<7>--|');
  });

  it('decodes common HTML entities', () => {
    expect(normalizePastedTab('&amp; &lt;3 &#39;tis &quot;x&quot; &#65;&#x42;')).toBe(
      '& <3 \'tis "x" AB',
    );
    expect(normalizePastedTab('C&nbsp;&nbsp;G')).toBe('C  G');
  });

  it('does not double-decode &amp;lt;', () => {
    expect(normalizePastedTab('&amp;lt;')).toBe('&lt;');
  });

  it('expands tabs to 8-column stops', () => {
    expect(normalizePastedTab('C\tG')).toBe('C       G');
    expect(normalizePastedTab('Am7\tD')).toBe('Am7     D');
  });

  it('collapses 3+ blank lines to 2 and trims edges', () => {
    expect(normalizePastedTab('a\n\n\n\n\nb')).toBe('a\n\n\nb');
    expect(normalizePastedTab('a\n\nb')).toBe('a\n\nb');
    expect(normalizePastedTab('\n\na\n\n')).toBe('a');
  });

  it('trims trailing whitespace per line', () => {
    expect(normalizePastedTab('C   \nlyric  ')).toBe('C\nlyric');
  });

  it('returns empty string for non-string input', () => {
    expect(normalizePastedTab(null)).toBe('');
    expect(normalizePastedTab(undefined)).toBe('');
    expect(normalizePastedTab(42)).toBe('');
  });
});

describe('transposeChordName', () => {
  it('transposes basic chords', () => {
    expect(transposeChordName('Am7', 2)).toBe('Bm7');
    expect(transposeChordName('C', 7)).toBe('G');
    expect(transposeChordName('G', 5)).toBe('C');
  });

  it('wraps around the octave in both directions', () => {
    expect(transposeChordName('B7', 1)).toBe('C7');
    expect(transposeChordName('C', -1)).toBe('B');
    expect(transposeChordName('Am7', 14)).toBe('Bm7');
    expect(transposeChordName('Am7', -10)).toBe('Bm7');
    expect(transposeChordName('C#m', 12)).toBe('C#m');
    expect(transposeChordName('Db', 0)).toBe('Db');
  });

  it('transposes slash chords, bass included', () => {
    expect(transposeChordName('G/B', 2)).toBe('A/C#');
    expect(transposeChordName('D/F#', 2)).toBe('E/G#');
    expect(transposeChordName('Eb/Bb', 2)).toBe('F/C');
    expect(transposeChordName('Am7/G', -2)).toBe('Gm7/F');
  });

  it('preserves the extension text verbatim', () => {
    expect(transposeChordName('F#m7b5', 1)).toBe('Gm7b5');
    expect(transposeChordName('C7#9', 2)).toBe('D7#9');
    expect(transposeChordName('Cadd9', 2)).toBe('Dadd9');
    expect(transposeChordName('C6/9', 2)).toBe('D6/9');
  });

  it('spells with flats when the source used flats, sharps when sharps', () => {
    expect(transposeChordName('Bb', 1)).toBe('B');
    expect(transposeChordName('Bb', 3)).toBe('Db');
    expect(transposeChordName('F#', 2)).toBe('G#');
    expect(transposeChordName('Eb', -2)).toBe('Db');
  });

  it('uses conventional mixed spelling from natural roots', () => {
    expect(transposeChordName('A', 1)).toBe('Bb');
    expect(transposeChordName('C', 1)).toBe('C#');
    expect(transposeChordName('D', 1)).toBe('Eb');
    expect(transposeChordName('F', 1)).toBe('F#');
    expect(transposeChordName('G', 1)).toBe('Ab');
  });

  it('passes through N.C. and non-chords unchanged', () => {
    expect(transposeChordName('N.C.', 5)).toBe('N.C.');
    expect(transposeChordName('hello', 3)).toBe('hello');
    expect(transposeChordName('Amen', 2)).toBe('Amen');
    expect(transposeChordName('', 2)).toBe('');
    expect(transposeChordName(null, 2)).toBe('');
    expect(transposeChordName('C', NaN)).toBe('C');
  });
});

describe('transposeText', () => {
  it('transposes chord lines and leaves lyric/text lines alone', () => {
    const input = 'C        G7\nLantern light on a tin-can sea';
    expect(transposeText(input, 2)).toBe('D        A7\nLantern light on a tin-can sea');
  });

  it('leaves lyric lines starting with chord-shaped words untouched', () => {
    const input = 'A day in the life of a paper boat';
    expect(transposeText(input, 2)).toBe(input);
  });

  it('leaves tab staffs and section headers untouched', () => {
    const input = '[Verse 1]\ne|--3--2--0--|';
    expect(transposeText(input, 3)).toBe(input);
  });

  it('preserves columns when names keep their length', () => {
    expect(transposeText('C        G        Am', 2)).toBe('D        A        Bm');
  });

  it('pads after shrinking names so following chords keep their columns', () => {
    expect(transposeText('C#m  F#', -1)).toBe('Cm   F');
    expect(transposeText('Bbm7    C', 2)).toBe('Cm7     D');
  });

  it('eats trailing spaces when names grow so following chords keep their columns', () => {
    expect(transposeText('E7  A', 1)).toBe('F7  Bb');
    expect(transposeText('A Bb', 2)).toBe('B C');
  });

  it('keeps a single separating space when a grown name would collide', () => {
    expect(transposeText('Am7b5 G', 1)).toBe('Bbm7b5 Ab');
  });

  it('transposes chordlyric bracket chords in place', () => {
    expect(transposeText('[C]Hum a [G]made-up [Am]tune', 2)).toBe('[D]Hum a [A]made-up [Bm]tune');
  });

  it('leaves non-chord brackets alone on chordlyric lines', () => {
    expect(transposeText('[C]La la [weird] la', 2)).toBe('[D]La la [weird] la');
  });

  it('transposes parenthesized and slash chords on chord lines', () => {
    expect(transposeText('C (Am7) G/B', 2)).toBe('D (Bm7) A/C#');
  });

  it('is identity at n = 0 for chord content', () => {
    const input = 'C   G/B   Am7\n[C]la [G]la';
    expect(transposeText(input, 0)).toBe(input);
  });

  it('round-trips: +n then -n restores enharmonic pitch classes', () => {
    expect(transposeText(transposeText('C   Em   G/B', 3), -3)).toBe('C   Em   G/B');
  });

  it('never throws on junk input', () => {
    expect(transposeText(null, 2)).toBe('');
    expect(transposeText('C G', NaN)).toBe('C G');
  });
});
