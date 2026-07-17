// PortOS tab/chord-sheet notation — pure, dependency-free helpers for the
// SongBook feature (/songbook): classify pasted guitar-tab / chord-sheet /
// ChordPro text line-by-line, extract ChordPro meta, clean up pasted content,
// and transpose chord symbols. Modeled on scoreNotation.js: forgiving (never
// throws — unknown lines classify as 'text', problems collect into errors[]),
// pure (no React, no browser APIs — these tests also run in node env in CI).
//
// NOT the lead-sheet parser (scoreNotation.js) and NOT the SMF parser
// (midiNotes.js) — this module understands the loose text formats people paste
// from tab sites: chords-over-lyrics, monospace tab staffs, and ChordPro.
//
// API (contract the SongBook UI builds against):
//   detectFormat(text)          → 'chordpro' | 'tab' | 'plain'
//   parseTabSheet(text)         → { lines: [Line], meta, errors }
//   normalizePastedTab(text)    → cleaned text
//   transposeChordName(name, n) → transposed chord symbol
//   transposeText(text, n)      → text with chord lines transposed in place
//   CHORD_TOKEN_RE              → anchored single-token chord matcher
//
// Line = { type, text, chords?, label? } where type is one of:
//   'section'    — [Verse 1], {start_of_chorus}/{soc}, or a bare "Chorus:" line
//   'chords'     — a line that is ≥~80% chord tokens (C, Am7, F#m7b5, G/B, N.C.)
//   'lyric'      — a plain line directly under a 'chords' line
//   'tabstaff'   — monospace tab staff (e|--3--2--| ; string-letter prefixed)
//   'chordlyric' — ChordPro inline [C]lyric; text is the bare lyric, chords
//                  carry col offsets into it
//   'blank'      — whitespace-only
//   'directive'  — ChordPro meta directives ({title:}/{artist:}/{key:}/{capo:});
//                  values populate meta, renderers hide the raw line
//   'text'       — everything else (incl. non-meta {directive} lines)

// ---------------------------------------------------------------------------
// Chord tokens
// ---------------------------------------------------------------------------

// Anchored matcher for ONE chord symbol (test whitespace-split tokens against
// it). Root A–G + optional #/b, then any run of quality/extension parts, then
// an optional /bass. Deliberate anti-word choices: roots are uppercase-only,
// bare ASCII `o` (diminished shorthand) requires a following digit so "Go" /
// "Do" / "No" never match, and there is no bare `-` quality so hyphenated
// lyric fragments stay words. "N.C." (no chord) is accepted as-is.
export const CHORD_TOKEN_RE = new RegExp(
  '^(?:N\\.?C\\.?|[A-G][#b]?' +
    '(?:6/9|maj|min|dim|aug|sus|add|M|m|\\+|°|ø|o(?=\\d)|\\d{1,2}|[#b]\\d{1,2}|' +
    '\\(\\s*(?:maj|add|sus|dim|aug|[#b])?\\d{1,2}\\s*\\))*' +
    '(?:/[A-G][#b]?)?)$',
);

// Length cap keeps the alternation-star from chewing on long pasted garbage.
const isChordToken = (token) => token.length > 0 && token.length <= 12 && CHORD_TOKEN_RE.test(token);

// A chord token that could ALSO plausibly be an English word: a bare root
// letter ("A"). Everything else that matches CHORD_TOKEN_RE (accidental,
// quality, slash, N.C.) is treated as unambiguous — a lone "Am" line is far
// more often the chord than the word, and word usage ("Am I…") brings other
// tokens that fail the density gate anyway.
const isAmbiguousChordToken = (token) => /^[A-G]$/.test(token);

// Dash-joined chord changes ("Am-Am7", "E-Em7") — chord sheets write these
// for a quick change inside one bar. Valid only when every dash-separated
// part is a chord token AND at least one part is unambiguous, so hyphenated
// lyric fragments ("A-round") and letter runs ("A-B-C") stay words.
const isDashChordToken = (token) => {
  if (token.length > 25 || !token.includes('-')) return false;
  const parts = token.split('-');
  if (parts.length < 2) return false;
  return parts.every(isChordToken) && parts.some((p) => !isAmbiguousChordToken(p));
};

// Rhythm/bar noise commonly interleaved on chord lines — ignored by the
// density calculation rather than counted against it.
const FILLER_TOKEN_RE = /^(?:\|+|\/+|%|-+|\.+|,|[([]?x\d{1,2}[)\]]?)$/i;

// Classify one whitespace-delimited token from a candidate chord line.
// '(Am)' counts as a chord (name Am, col offset +1 past the paren).
const chordTokenInfo = (token, col) => {
  if (isChordToken(token)) return { kind: 'chord', name: token, col };
  const paren = /^\((.+)\)$/.exec(token);
  if (paren && isChordToken(paren[1])) return { kind: 'chord', name: paren[1], col: col + 1 };
  if (isDashChordToken(token)) return { kind: 'chord', name: token, col };
  if (FILLER_TOKEN_RE.test(token)) return { kind: 'filler' };
  return { kind: 'other' };
};

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

const META_DIRECTIVE_RE = /^\s*\{\s*(title|t|artist|subtitle|st|key|capo)\s*:\s*([^}]*?)\s*\}\s*$/i;
const CHORDPRO_SECTION_RE =
  /^\s*\{\s*(start_of_\w+|end_of_\w+|soc|eoc|sov|eov|sob|eob|sot|eot)\s*(?::\s*([^}]*?)\s*)?\}\s*$/i;
const GENERIC_DIRECTIVE_RE = /^\s*\{\s*[A-Za-z_]+\s*(?::[^}]*)?\}\s*$/;
const BRACKET_SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
const WORD_SECTION_RE =
  /^\s*(intro|verse|chorus|pre[- ]?chorus|bridge|outro|solo|interlude|instrumental|refrain|coda)(\s+\d+)?\s*:?\s*$/i;
const META_ALIASES = { t: 'title', subtitle: 'artist', st: 'artist' };

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Short ChordPro section codes → [start|end, kind].
const CHORDPRO_SHORT = {
  soc: ['start', 'chorus'], eoc: ['end', 'chorus'],
  sov: ['start', 'verse'], eov: ['end', 'verse'],
  sob: ['start', 'bridge'], eob: ['end', 'bridge'],
  sot: ['start', 'tab'], eot: ['end', 'tab'],
};

// Tab staff detection. Two shapes:
//   (a) string-letter prefix straight into a bar: `e|--3--2--|`, `D|-0-`, `B:`
//   (b) bar-first staffs with no string name: `|--3--5--|`
// The body charset is dashes/digits/bars plus tab technique glyphs
// (h p b r s t x v ~ / \ ^ * < > = . :) — deliberately NO uppercase letters
// (except X for dead notes), so chord lines with bars ("C | G | Am") fall
// through to the chords classifier.
const TAB_BODY_RE = /^[\s\-0-9|/\\hpbrstxvX~.^*()<>=:]*$/;
const isTabstaffLine = (line) => {
  const t = line.trimEnd();
  if (!t.trim()) return false;
  const prefix = /^\s*[A-Ga-g][#b]?\s*[|:]/.exec(t);
  const dashes = (t.match(/-/g) || []).length;
  if (prefix) return dashes >= 2 && TAB_BODY_RE.test(t.slice(prefix[0].length));
  return t.includes('|') && dashes >= 3 && TAB_BODY_RE.test(t);
};

// ChordPro inline [C]lyric → { text: bare lyric, chords: [{ name, col }] } or
// null when the line has no chord-token brackets. Non-chord brackets ([x2],
// [weird]) stay literal in the lyric text.
const parseChordLyric = (line) => {
  const chords = [];
  let bare = '';
  let last = 0;
  const re = /\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(line))) {
    bare += line.slice(last, m.index);
    if (isChordToken(m[1]) || isDashChordToken(m[1])) chords.push({ name: m[1], col: bare.length });
    else bare += m[0];
    last = m.index + m[0].length;
  }
  bare += line.slice(last);
  return chords.length ? { text: bare, chords } : null;
};

// A 'chords' line: ≥1 chord token, chord density ≥ 80% among non-filler
// tokens, and either 2+ chord tokens or at least one unambiguous one — so a
// lone "A" line stays text ("A day in the life" already fails on density).
const parseChordsLine = (line) => {
  const chords = [];
  let other = 0;
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) {
    const info = chordTokenInfo(m[0], m.index);
    if (info.kind === 'chord') chords.push({ name: info.name, col: info.col });
    else if (info.kind === 'other') other += 1;
  }
  if (!chords.length) return null;
  if (chords.length / (chords.length + other) < 0.8) return null;
  if (chords.length < 2 && chords.every((c) => isAmbiguousChordToken(c.name))) return null;
  return chords;
};

// Classify one raw line (context-free — the lyric-under-chords promotion is a
// post-pass in parseTabSheet). Returns { type, text, chords?, label?, meta?,
// error?, chordpro? } — meta/error/chordpro are internal and stripped from the
// public parse result.
const classifyLine = (raw) => {
  const line = String(raw ?? '');
  if (!line.trim()) return { type: 'blank', text: line };

  const meta = META_DIRECTIVE_RE.exec(line);
  if (meta) {
    // 'directive' (not 'text'): the value is extracted into meta, so renderers
    // hide the raw {title:}/{artist:}/{key:}/{capo:} line instead of showing
    // ChordPro plumbing above the song.
    const key = META_ALIASES[meta[1].toLowerCase()] || meta[1].toLowerCase();
    const value = meta[2];
    if (key === 'capo') {
      if (/^\d{1,2}$/.test(value)) return { type: 'directive', text: line, meta: { capo: Number(value) }, chordpro: true };
      return { type: 'directive', text: line, error: `invalid capo value "${value}"`, chordpro: true };
    }
    return { type: 'directive', text: line, meta: { [key]: value }, chordpro: true };
  }

  const cpSection = CHORDPRO_SECTION_RE.exec(line);
  if (cpSection) {
    const code = cpSection[1].toLowerCase();
    const custom = (cpSection[2] || '').trim();
    const [phase, kind] = CHORDPRO_SHORT[code] || [code.startsWith('end_of_') ? 'end' : 'start', code.replace(/^(start|end)_of_/, '').replace(/_/g, ' ')];
    const label = phase === 'end' ? '' : custom || capitalize(kind);
    return { type: 'section', text: line, label, chordpro: true };
  }

  if (GENERIC_DIRECTIVE_RE.test(line)) return { type: 'text', text: line, chordpro: true };

  const bracket = BRACKET_SECTION_RE.exec(line);
  // A whole-line bracketed chord — plain ([Am]) or dash-joined ([Am-Am7]) — is
  // ChordPro inline notation, not a section header.
  if (bracket && !isChordToken(bracket[1].trim()) && !isDashChordToken(bracket[1].trim())) {
    return { type: 'section', text: line, label: bracket[1].trim() };
  }

  const word = WORD_SECTION_RE.exec(line);
  if (word) return { type: 'section', text: line, label: line.trim().replace(/:\s*$/, '') };

  if (isTabstaffLine(line)) return { type: 'tabstaff', text: line };

  const chordLyric = parseChordLyric(line);
  if (chordLyric) return { type: 'chordlyric', text: chordLyric.text, chords: chordLyric.chords, chordpro: true };

  const chords = parseChordsLine(line);
  if (chords) return { type: 'chords', text: line, chords };

  return { type: 'text', text: line };
};

// ---------------------------------------------------------------------------
// Public parsing API
// ---------------------------------------------------------------------------

// 'chordpro' when any ChordPro machinery appears ({directives} or inline
// [C]lyric chords); else 'tab' when the sheet has tab staffs or chord lines
// (monospace rendering matters); else 'plain'.
export const detectFormat = (text) => {
  let sawSheet = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const c = classifyLine(raw);
    if (c.chordpro) return 'chordpro';
    if (c.type === 'tabstaff' || c.type === 'chords') sawSheet = true;
  }
  return sawSheet ? 'tab' : 'plain';
};

// Parse a full sheet into classified lines + ChordPro meta ({title:}/{t:},
// {artist:}/{subtitle:}/{st:}, {key:}, {capo:} — first occurrence wins) +
// collected (never thrown) errors. lines is 1:1 with the input lines.
export const parseTabSheet = (text) => {
  const meta = {};
  const errors = [];
  const classified = String(text ?? '').split(/\r?\n/).map((raw) => classifyLine(raw));

  for (const line of classified) {
    if (line.meta) {
      for (const [key, value] of Object.entries(line.meta)) {
        if (!(key in meta)) meta[key] = value;
      }
    }
    if (line.error) errors.push(line.error);
  }

  // Promote the plain line directly under a chords line to 'lyric' — the
  // classic chords-over-lyrics pairing. Only the immediately-following line
  // (no blank between) qualifies; standalone prose stays 'text'.
  const lines = classified.map(({ type, text: lineText, chords, label }, i) => {
    const promoted = type === 'text' && classified[i - 1]?.type === 'chords' ? 'lyric' : type;
    const out = { type: promoted, text: lineText };
    if (chords) out.chords = chords;
    if (label !== undefined) out.label = label;
    return out;
  });

  return { lines, meta, errors };
};

// ---------------------------------------------------------------------------
// Paste normalization
// ---------------------------------------------------------------------------

// Mirrors server/lib/xmlEntities.js `decodeXmlEntities` (with `nbsp` as the
// one extra entity) — keep the two in sync. Single-pass scan is double-decode-
// safe: `&amp;lt;` decodes to `&lt;`, never `<`. Out-of-range numeric code
// points are left untouched (String.fromCodePoint would throw a RangeError,
// and this module must never throw on pasted garbage).
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

const decodeEntities = (s) =>
  s.replace(ENTITY_RE, (match, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[code] ?? match;
  });

// Expand tabs to 8-column stops (what <pre> renders), preserving alignment.
const detabLine = (line) => {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(8 - (out.length % 8));
    else out += ch;
  }
  return out;
};

// Clean up pasted content: CRLF/CR → LF, <br>/<p>/<div> boundaries → newlines,
// strip real HTML tags (a tag must start with a letter, so tab harmonics like
// e|--<7>--| survive), decode common entities, map Unicode accidentals
// (♯ → #, ♭ → b) so 'F♯m' classifies and transposes like 'F#m', expand tabs,
// trim trailing whitespace per line, collapse runs of 3+ blank lines to 2, and
// trim leading/trailing blank lines.
export const normalizePastedTab = (text) => {
  if (typeof text !== 'string' || !text) return '';
  const cleaned = decodeEntities(
    text
      .replace(/\r\n?/g, '\n')
      .replace(/<(?:br|p|div)(?:\s[^>]*)?\/?>/gi, '\n')
      .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/g, ''),
  );
  return cleaned
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .split('\n')
    .map((line) => detabLine(line).replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
};

// ---------------------------------------------------------------------------
// Transposition
// ---------------------------------------------------------------------------

// NOTE_TO_PC and spellPitchClass are exported (minimally) for chordShapes.js,
// which reuses this module's pitch-class math for chord-voicing derivation
// rather than duplicating the tables.
export const NOTE_TO_PC = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11, 'B#': 0,
};
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// Conventional mixed spelling for roots with no source accidental to honor —
// the names guitarists actually write (C# D Eb E F F# G Ab A Bb B).
const DEFAULT_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Spell a pitch class (0–11) honoring an accidental preference: 'b' → flat
// names, '#' → sharp names, anything else → the conventional mixed table.
export const spellPitchClass = (pc, pref) =>
  (pref === 'b' ? FLAT_NAMES : pref === '#' ? SHARP_NAMES : DEFAULT_NAMES)[pc];

// Transpose one chord symbol by n semitones (wraps mod 12; negative fine).
// The source accidental steers spelling: a flat-spelled chord stays in flats,
// sharp stays in sharps, naturals use the conventional mixed table. Slash
// basses transpose with the chord (their own accidental wins, else the
// root's). "N.C." and anything that isn't a chord token pass through
// unchanged — forgiving, never throws.
export const transposeChordName = (name, n) => {
  const raw = String(name ?? '');
  if (!Number.isFinite(n)) return raw;
  if (/^N\.?C\.?$/.test(raw)) return raw;
  if (isDashChordToken(raw)) {
    return raw.split('-').map((part) => transposeChordName(part, n)).join('-');
  }
  if (!isChordToken(raw)) return raw;
  const m = /^([A-G])([#b]?)(.*)$/.exec(raw);
  if (!m) return raw;
  const shift = ((Math.trunc(n) % 12) + 12) % 12;
  const pref = m[2];
  let quality = m[3];
  let bassOut = '';
  const slash = /^(.*)\/([A-G])([#b]?)$/.exec(quality);
  if (slash) {
    quality = slash[1];
    const bassPc = (NOTE_TO_PC[slash[2] + slash[3]] + shift) % 12;
    bassOut = `/${spellPitchClass(bassPc, slash[3] || pref)}`;
  }
  const rootPc = (NOTE_TO_PC[m[1] + pref] + shift) % 12;
  return spellPitchClass(rootPc, pref) + quality + bassOut;
};

const transposeToken = (token, n) => {
  if (isChordToken(token) || isDashChordToken(token)) return transposeChordName(token, n);
  const paren = /^\((.+)\)$/.exec(token);
  if (paren && isChordToken(paren[1])) return `(${transposeChordName(paren[1], n)})`;
  return token;
};

// Rebuild a chords line with each token transposed, keeping every token at
// its original column where possible: shorter names pad back out with spaces,
// longer names eat the following gap. When a grown name would collide with
// the next token, a single separating space is kept (the rest of the line
// shifts by the overflow).
const transposeChordLine = (line, n) => {
  let out = '';
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) {
    if (out.length < m.index) out += ' '.repeat(m.index - out.length);
    else if (out.length > 0) out += ' ';
    out += transposeToken(m[0], n);
  }
  return out;
};

// Transpose every chord token on 'chords' and 'chordlyric' lines; all other
// lines (lyrics, tab staffs, sections, prose) pass through untouched. Line
// endings normalize to \n. Never mutates or throws.
export const transposeText = (text, n) => {
  if (!Number.isFinite(n)) return String(text ?? '');
  return String(text ?? '')
    .split(/\r?\n/)
    .map((raw) => {
      const c = classifyLine(raw);
      if (c.type === 'chords') return transposeChordLine(raw, Math.trunc(n));
      if (c.type === 'chordlyric') {
        return raw.replace(/\[([^\]]*)\]/g, (all, inner) =>
          isChordToken(inner) || isDashChordToken(inner)
            ? `[${transposeChordName(inner, n)}]`
            : all,
        );
      }
      return raw;
    })
    .join('\n');
};
