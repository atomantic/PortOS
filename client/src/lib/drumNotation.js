// Parser for the PortOS drum-kit notation (#3115) — a dependency-free GRID DSL (`HH: x x x x`) for the
// SongBook `drum` content format, drawn by `<DrumSheetView>` (hand-rolled SVG, no engraving lib).
//
// PortOS drum-kit notation — a tiny, dependency-free grid DSL for a drum groove
// and the pure parser that turns it into the structured chart <DrumSheetView>
// draws and drumPlayback.js sounds. Companion to `scoreNotation.js` (pitched
// lead sheets) and `tabNotation.js` (chord/tab sheets): same contract — one pure
// forgiving parser, one hand-rolled SVG renderer, no engraving library.
//
// A drum chart IS a grid, so the format reads like the sheet it renders:
//
//   time: 4/4
//   tempo: 96
//   subdivision: 4        ← grid steps per beat (4 = 16ths, 2 = 8ths, 3 = triplets)
//
//   # Bar 1 — basic rock beat
//   HH: x x x x x x x x
//   S:  - - - - o - - -
//   K:  o - - - - - o -
//
// HEADER lines are `key: value`, in any order, before the music: `time`,
// `tempo`, `subdivision`, and an optional `kit` (a comma/space list of piece
// ids that overrides the row ORDER — never which rows exist). Defaults are
// 4/4, 90 BPM, subdivision 4.
//
// BAR BLOCKS are separated by blank lines. A `#` line is a comment — and
// doubles as the block's label when it's the block's first line. A trailing
// `x2` / `x4` on the label repeats the whole block that many times.
//
// PIECE ROWS are `PIECE: cells`. PIECE is one of the nine kit ids below
// (case-insensitive, long aliases accepted: `crash`, `snare`, `kick`, …).
// CELLS are single characters; whitespace between them is optional and
// ignored, so `xxxxxxxx` and `x x x x x x x x` are the same row.
//
// The parser is forgiving and NEVER throws: an unknown piece token, a bad
// header, or an over-long row collects a message into `errors[]` and the rest
// of the chart still parses. Keep this module pure (no React, no imports) —
// it's unit-tested in a node env and barrelled.

// --- Kit -------------------------------------------------------------------
// One entry per kit piece, in TOP-TO-BOTTOM sheet order (cymbals above drums
// above feet, matching how a drum chart is conventionally engraved). `midi` is
// the General MIDI percussion note (documented reference for anyone wiring a
// MIDI export later — the synth in drumPlayback.js reads `sound`, not `midi`).
// `sound` picks the synth voice; `glyph` picks the notehead shape.
// `technique` is how the piece is struck, in the words a drummer would use at
// the kit — the sheet's tap-a-note readout and legend show it, because a
// hand-rolled notation has no engraving convention to look up. Handedness-
// neutral: which foot works the kick and which side the floor tom sits on depend
// on the kit and the player, so it says what to strike and how, never which limb.
export const KIT_PIECES = [
  { id: 'CR', label: 'Crash', aliases: ['crash', 'cr', 'cc'], midi: 49, sound: 'crash', glyph: 'cross', technique: 'The crash cymbal — strike the edge with the shoulder of the stick and let it ring out.' },
  { id: 'RD', label: 'Ride', aliases: ['ride', 'rd'], midi: 51, sound: 'ride', glyph: 'cross', technique: 'The ride cymbal — stick tip on the bow for a clear "ping", nearer the edge for a wash, on the bell for a clang.' },
  { id: 'HH', label: 'Hi-Hat', aliases: ['hihat', 'hi-hat', 'hh', 'hat'], midi: 42, sound: 'hihat', glyph: 'cross', technique: 'The hi-hat pair, played with a stick — tip on the edge, cymbals held shut by the pedal unless the note is open.' },
  { id: 'T1', label: 'Tom 1', aliases: ['tom1', 'tom', 't1', 'hitom'], midi: 48, sound: 'tom1', glyph: 'head', technique: 'The highest tom — stick tip near the middle of the head.' },
  { id: 'T2', label: 'Tom 2', aliases: ['tom2', 't2', 'midtom'], midi: 47, sound: 'tom2', glyph: 'head', technique: 'The middle tom — stick tip near the middle of the head.' },
  { id: 'S', label: 'Snare', aliases: ['snare', 's', 'sd'], midi: 38, sound: 'snare', glyph: 'head', technique: 'The snare drum — a full stroke in the middle of the head for the sharpest crack.' },
  { id: 'FT', label: 'Floor Tom', aliases: ['floor', 'floortom', 'ft', 't3'], midi: 43, sound: 'floor', glyph: 'head', technique: 'The floor tom, the biggest and lowest of the toms — stick tip near the middle of the head.' },
  { id: 'K', label: 'Kick', aliases: ['kick', 'k', 'bd', 'bass'], midi: 36, sound: 'kick', glyph: 'head', technique: 'The bass drum, played with the kick pedal rather than a stick.' },
  { id: 'HF', label: 'Hi-Hat (foot)', aliases: ['hihatfoot', 'hhfoot', 'hf', 'foot'], midi: 44, sound: 'hihatFoot', glyph: 'cross', technique: 'The hi-hat pedal with no stick — press it to clap the cymbals shut for a short "chick".' },
];

// Row order index for a piece id — the renderer and the `kit:` override both
// sort by this so a chart's rows always read in kit order regardless of the
// order the author typed them.
const PIECE_ORDER = new Map(KIT_PIECES.map((p, i) => [p.id, i]));

// Every accepted spelling → the canonical piece id. Built from `aliases` plus
// the id itself, all lowercased, so lookup is a single normalize + get.
const PIECE_BY_TOKEN = new Map();
for (const piece of KIT_PIECES) {
  PIECE_BY_TOKEN.set(piece.id.toLowerCase(), piece.id);
  for (const alias of piece.aliases) PIECE_BY_TOKEN.set(alias.toLowerCase(), piece.id);
}

// Piece descriptor by id (renderer/synth lookup).
export const kitPiece = (id) => KIT_PIECES.find((p) => p.id === id) || null;

// --- Cell glyphs -----------------------------------------------------------
// The six cell characters and what each means. `velocity` is the relative hit
// strength drumPlayback scales its voice gain by; `open` lengthens the hi-hat
// decay; `flam` sounds a grace note just before the beat. `char` is the entry's
// own key, carried on the value so a cell (which is a shared reference to one of
// these) can name the character it came from without a reverse lookup.
export const CELL_GLYPHS = {
  '-': { id: 'rest', char: '-', rest: true, velocity: 0 },
  x: { id: 'normal', char: 'x', rest: false, velocity: 0.8 },
  X: { id: 'accent', char: 'X', rest: false, velocity: 1, accent: true },
  o: { id: 'open', char: 'o', rest: false, velocity: 0.85, open: true },
  g: { id: 'ghost', char: 'g', rest: false, velocity: 0.35, ghost: true },
  f: { id: 'flam', char: 'f', rest: false, velocity: 0.9, flam: true },
};

// A cell char → its descriptor, or null when it isn't a known glyph. `.` and
// `_` are tolerated as rest synonyms because both read as "empty" in a grid and
// an author reaching for either means the same thing.
const REST_SYNONYMS = new Set(['.', '_']);
const cellFor = (ch) => {
  if (REST_SYNONYMS.has(ch)) return CELL_GLYPHS['-'];
  return CELL_GLYPHS[ch] || null;
};

// --- Plain-language explanations --------------------------------------------
// A hand-rolled grid notation has no engraving convention to look up, so the
// sheet has to be able to answer "what IS this glyph and how do I play it?"
// itself — that's what `<DrumSheetView>`'s tap-a-note readout and its legend
// read. Kept here, beside the notation it describes (and derived from the same
// two tables), so prose and notation can't drift apart.

// What each cell character asks for. Every key but the three `open*` ones is a
// cell-glyph id; `open` is piece-dependent, because "open" means a different
// technique — or none at all — depending on what it lands on, and only the hi-hat
// voice actually sustains it in playback (it is the only voice with an
// `openDecay`, see drumPlayback.js). So the variants say what the player should
// do AND, where the play-along can't reproduce it, that it sounds the same.
const ARTICULATIONS = {
  rest: { name: 'Rest', detail: 'Nothing is played on this step — count it, don\'t fill it.' },
  normal: { name: 'Normal hit', detail: 'An unaccented stroke at your regular playing volume.' },
  accent: { name: 'Accent', detail: 'Strike noticeably harder than the notes around it. The ">" chevron drawn above the glyph is the accent mark.' },
  open: { name: 'Open', detail: 'Ease off the hi-hat pedal as you strike so the cymbals ring instead of clicking shut, then close again on the next unopened note. The circle drawn around the "×" is the open mark, and the play-along lets the note sustain.' },
  openRing: { name: 'Open (let it ring)', detail: 'The circle around the "×" says let the cymbal sustain rather than choking it with your hand. A crash or ride rings freely already, so the play-along sounds this the same as a normal hit.' },
  openFoot: { name: 'Open (foot splash)', detail: 'Let the pedal rebound as you press it so the cymbals splash open instead of clapping shut. The play-along sounds it as a normal foot "chick".' },
  openHead: { name: 'Normal hit', detail: 'The "o" open mark only changes hi-hats and cymbals — on a drum there is nothing to open, so this sounds and draws as a normal hit.' },
  ghost: { name: 'Ghost note', detail: 'A very light tap that sits under the groove rather than in it, drawn as a small hollow glyph.' },
  flam: { name: 'Flam', detail: 'Two strokes so close together they read as one thick hit: the small grace glyph just before the beat lands a hair early, then the main note on the beat.' },
};

// Which `open` entry a piece takes, keyed off the piece's SYNTH VOICE rather than
// its glyph shape: the parser accepts `o` on any row, and `CR: o` draws the same
// open ring a hi-hat does, but only the hi-hat voice sustains it — so keying on
// `glyph === 'cross'` alone would tell a crash player to work the hi-hat pedal.
const OPEN_BY_SOUND = { hihat: 'open', hihatFoot: 'openFoot' };
const openArticulationFor = (piece) => (piece.glyph === 'cross'
  ? (OPEN_BY_SOUND[piece.sound] || 'openRing')
  : 'openHead');

// Deterministic order for the `open` variants when a legend has to describe more
// than one of them (see below) — kit order, cymbals first.
const OPEN_KEYS = ['open', 'openRing', 'openFoot', 'openHead'];

/**
 * The six cell characters for a legend panel, resolved FOR THE PIECES A CHART
 * ACTUALLY USES.
 *
 * `o` is the reason this takes an argument rather than being a constant: its
 * meaning is per-piece (see `openArticulationFor`), so a fixed legend row would
 * tell someone reading a crash-only chart to work the hi-hat pedal — contradicting
 * what tapping that same note says. A chart whose pieces all resolve to one
 * variant gets exactly that variant; a mixed kit gets each applicable reading, in
 * kit order, so the row is right no matter which row of the chart you're looking at.
 *
 * @param {string[]} [pieceIds] - The chart's piece ids (`chart.pieces`).
 * @returns {{ char: string, name: string, detail: string }[]}
 */
export const drumGlyphLegend = (pieceIds = []) => {
  const present = pieceIds.map(kitPiece).filter(Boolean).map(openArticulationFor);
  const keys = OPEN_KEYS.filter((key) => present.includes(key));
  const open = keys.length === 1
    ? ARTICULATIONS[keys[0]]
    : {
      name: 'Open',
      // Mixed kit (or no pieces at all): every applicable reading, since one
      // sentence can't cover a hi-hat and a crash at once.
      detail: (keys.length ? keys : OPEN_KEYS).map((key) => ARTICULATIONS[key].detail).join(' '),
    };
  return Object.values(CELL_GLYPHS)
    .map((glyph) => ({ char: glyph.char, ...(glyph.id === 'open' ? open : ARTICULATIONS[glyph.id]) }));
};

/**
 * Explain ONE cell of a parsed chart in plain language — what the glyph means,
 * how the piece is struck, and how loud the hit is relative to a full stroke.
 *
 * @param {string} pieceId - Canonical kit-piece id (`'CR'`, `'S'`, …).
 * @param {object} cell - A cell from `parseDrumChart` (a `CELL_GLYPHS` entry).
 * @returns {{ pieceLabel, char, rest, articulation, detail, technique, velocityPercent }|null}
 *   `null` only when the piece id is unknown — an unknown/missing cell is
 *   described as a rest, matching how the parser already treats one.
 */
export const describeDrumCell = (pieceId, cell) => {
  const piece = kitPiece(pieceId);
  if (!piece) return null;
  const glyph = CELL_GLYPHS[cell?.char] || CELL_GLYPHS['-'];
  const articulation = ARTICULATIONS[
    glyph.id === 'open' ? openArticulationFor(piece) : glyph.id
  ];
  return {
    pieceLabel: piece.label,
    char: glyph.char,
    rest: glyph.rest,
    articulation: articulation.name,
    detail: articulation.detail,
    technique: piece.technique,
    velocityPercent: Math.round(glyph.velocity * 100),
  };
};

// Count-along syllables for a step inside its beat — how a drummer says the
// position out loud ("2 e & a"). A subdivision with no conventional syllable
// falls back to an exact "beat +n/N" rather than borrowing the wrong one.
const SUBDIVISION_SYLLABLES = { 2: ['', '&'], 3: ['', 'trip', 'let'], 4: ['', 'e', '&', 'a'] };

/**
 * Where a cell falls, as a drummer would say it: `bar 6, count “2 e”`.
 *
 * @param {number} bar - 1-based bar number (post repeat-expansion).
 * @param {number} step - 0-based grid step within the bar.
 * @param {number} subdivision - Grid steps per notated beat.
 * @returns {string}
 */
export const describeDrumPosition = (bar, step, subdivision) => {
  const beat = Math.floor(step / subdivision) + 1;
  const within = step % subdivision;
  const syllable = within ? SUBDIVISION_SYLLABLES[subdivision]?.[within] : '';
  const count = within
    ? `${beat} ${syllable || `+${within}/${subdivision}`}`
    : `${beat}`;
  return `bar ${bar}, count “${count}”`;
};

// --- Header ----------------------------------------------------------------
const DEFAULT_HEADER = { beats: 4, beatValue: 4, tempo: 90, subdivision: 4, kit: null };

export const DEFAULT_DRUM_TEMPO = 90;
// Grid-resolution band. 1 = one cell per beat; 12 keeps a 4/4 bar under 50
// cells so the renderer stays legible and a typo like `subdivision: 400` can't
// build a 1600-cell bar.
export const SUBDIVISION_MIN = 1;
export const SUBDIVISION_MAX = 12;

const parseTimeSignature = (raw) => {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(raw || '');
  if (!m) return null;
  const beats = Number(m[1]);
  const beatValue = Number(m[2]);
  if (!beats || !beatValue) return null;
  return { beats, beatValue };
};

// Header `kit:` value → an ordered piece-id list, or null when nothing in it
// resolves (so the caller keeps the default KIT_PIECES order rather than an
// empty override that would hide every row).
const parseKitOrder = (raw) => {
  const ids = String(raw || '')
    .split(/[\s,]+/)
    .map((token) => PIECE_BY_TOKEN.get(token.toLowerCase()))
    .filter(Boolean);
  return ids.length ? [...new Set(ids)] : null;
};

// A `# comment` label with an optional repeat suffix → { label, repeat }.
// `# Bar 1 — fill x2` repeats the block twice; the suffix is stripped from the
// label so the sheet shows "Bar 1 — fill" and the repeat shows as its own badge.
const REPEAT_SUFFIX = /\s*[x×]\s*(\d{1,2})\s*$/i;
const parseLabel = (raw) => {
  const text = raw.replace(/^#+\s*/, '').trim();
  const m = REPEAT_SUFFIX.exec(text);
  if (!m) return { label: text, repeat: 1 };
  const repeat = Number(m[1]);
  return {
    label: text.slice(0, m.index).trim(),
    // A `x0`/`x1` suffix is not a repeat — treat it as 1 rather than dropping
    // the bar entirely (an author typing x0 meant "once", not "delete this").
    repeat: Number.isFinite(repeat) && repeat > 1 ? Math.min(repeat, 32) : 1,
  };
};

// A header line is `word: value` and its key is one of ours. Anything else
// shaped like `word: value` is a piece row (`HH: x x …`) or garbage.
const HEADER_KEYS = new Set(['time', 'tempo', 'subdivision', 'kit']);
// Digits and dashes are part of the key, not the value — piece ids include `T1`
// and aliases include `hi-hat`, so a letters-only key would silently reject both.
const HEADER_RE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

/**
 * Parse a drum chart into `{ time, tempo, subdivision, bars, pieces, errors }`.
 *
 * - `time` — `{ beats, beatValue }` (4/4 default).
 * - `tempo` — the written BPM (90 default). The viewer seeds its practice-tempo
 *   control from this; playback takes an explicit bpm.
 * - `subdivision` — grid cells per beat.
 * - `bars` — `[{ index, label, repeat, rows: [{ piece, cells }] }]`. `index` is
 *   the 1-based BAR number AFTER repeat expansion, so bar numbers on the sheet
 *   match the loop-range control and the playback schedule. `cells` is always
 *   exactly `beats × subdivision` long (short rows pad with rests).
 * - `pieces` — the ordered piece ids that appear anywhere in the chart (the
 *   renderer's row list).
 * - `errors` — human-readable strings; never thrown.
 *
 * Always returns a usable object.
 */
export const parseDrumChart = (text) => {
  const header = { ...DEFAULT_HEADER };
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);

  // Pass 1: pull header lines out, group the rest into blank-line-separated
  // blocks. A header is only honored BEFORE any music (per the format doc), so
  // a stray `tempo:` mid-chart is an error rather than a silent tempo change.
  const blocks = [];
  let current = null;
  let sawMusic = false;
  const flush = () => { if (current && current.rows.length) blocks.push(current); current = null; };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flush(); continue; }

    if (line.startsWith('#')) {
      // A comment that opens a block is its label; later comments inside a
      // block are just comments.
      if (!current) current = { ...parseLabel(line), rows: [] };
      continue;
    }

    const headerMatch = HEADER_RE.exec(line);
    const key = headerMatch ? headerMatch[1].toLowerCase() : null;
    if (key && HEADER_KEYS.has(key)) {
      const value = headerMatch[2].trim();
      if (sawMusic) { errors.push(`header "${key}" appears after the music started — ignored`); continue; }
      if (key === 'time') {
        const ts = parseTimeSignature(value);
        if (ts) { header.beats = ts.beats; header.beatValue = ts.beatValue; }
        else errors.push(`bad time signature "${value}"`);
      } else if (key === 'tempo') {
        const t = Number(value);
        if (Number.isFinite(t) && t > 0) header.tempo = t;
        else errors.push(`bad tempo "${value}"`);
      } else if (key === 'subdivision') {
        const s = Number(value);
        if (Number.isInteger(s) && s >= SUBDIVISION_MIN && s <= SUBDIVISION_MAX) header.subdivision = s;
        else errors.push(`bad subdivision "${value}" (expected ${SUBDIVISION_MIN}–${SUBDIVISION_MAX})`);
      } else {
        const order = parseKitOrder(value);
        if (order) header.kit = order;
        else errors.push(`kit "${value}" names no known pieces — using the default row order`);
      }
      continue;
    }

    // Music line — `PIECE: cells`.
    sawMusic = true;
    if (!current) current = { label: '', repeat: 1, rows: [] };
    if (!headerMatch) { errors.push(`unrecognized line "${line}"`); continue; }
    const piece = PIECE_BY_TOKEN.get(key);
    if (!piece) { errors.push(`unknown kit piece "${headerMatch[1]}" — row skipped`); continue; }
    current.rows.push({ piece, raw: headerMatch[2] });
  }
  flush();

  const stepsPerBar = Math.max(1, header.beats * header.subdivision);

  // Pass 2: cells. Each raw row becomes an exactly-stepsPerBar-long cell array.
  const parsedBlocks = blocks.map((block, bi) => {
    const rows = [];
    for (const row of block.rows) {
      const cells = [];
      // One error per distinct bad character, not per occurrence — a row of the
      // wrong alphabet should read as one problem, not sixteen.
      const reported = new Set();
      for (const ch of row.raw) {
        if (/\s|\|/.test(ch)) continue; // spacing + optional bar-line decoration
        const cell = cellFor(ch);
        if (!cell && !reported.has(ch)) {
          reported.add(ch);
          errors.push(`bar ${bi + 1} ${row.piece}: unknown cell "${ch}" — treated as a rest`);
        }
        cells.push(cell || CELL_GLYPHS['-']);
      }
      if (cells.length > stepsPerBar) {
        errors.push(`bar ${bi + 1} ${row.piece}: ${cells.length} cells for a ${stepsPerBar}-step bar — extra cells truncated`);
        cells.length = stepsPerBar;
      }
      while (cells.length < stepsPerBar) cells.push(CELL_GLYPHS['-']);
      // A repeated piece within one block merges into the first row (an author
      // splitting `HH:` across two lines means one hi-hat part, not two rows) —
      // a struck cell always wins over a rest.
      const existing = rows.find((r) => r.piece === row.piece);
      if (existing) {
        existing.cells = existing.cells.map((c, i) => (cells[i].rest ? c : cells[i]));
      } else {
        rows.push({ piece: row.piece, cells });
      }
    }
    rows.sort((a, b) => (PIECE_ORDER.get(a.piece) ?? 0) - (PIECE_ORDER.get(b.piece) ?? 0));
    return { label: block.label, repeat: block.repeat, rows };
  }).filter((block) => block.rows.length > 0);

  // Pass 3: expand repeats into real bars so every downstream consumer (sheet,
  // schedule, loop range) counts bars the same way.
  const bars = [];
  for (const block of parsedBlocks) {
    for (let pass = 0; pass < block.repeat; pass += 1) {
      bars.push({
        index: bars.length + 1,
        label: block.label,
        repeat: block.repeat,
        repeatPass: pass + 1,
        rows: block.rows.map((r) => ({ piece: r.piece, cells: r.cells })),
      });
    }
  }

  // Rows the chart actually uses. `kit:` reorders them; it must NOT hide any —
  // a piece the header omits is still played back, so dropping it from `pieces`
  // would sound a snare the sheet never draws. So: the listed pieces first (in
  // the author's order, filtered to what's present, since an override must not
  // invent empty rows), then everything else in default kit order.
  const present = new Set(bars.flatMap((bar) => bar.rows.map((r) => r.piece)));
  const preferred = (header.kit || []).filter((id) => present.has(id));
  const rest = KIT_PIECES.map((p) => p.id)
    .filter((id) => present.has(id) && !preferred.includes(id));
  const pieces = [...preferred, ...rest];

  return {
    time: { beats: header.beats, beatValue: header.beatValue },
    tempo: header.tempo,
    subdivision: header.subdivision,
    stepsPerBar,
    bars,
    pieces,
    errors,
  };
};

// True when `text` looks like a drum chart — used by the import page to pick the
// `drum` format BEFORE falling through to tabNotation's `detectFormat` (which
// would classify a grid row as plain text). Deliberately strict: a chart needs
// at least one real piece row whose cells are all grid glyphs, so a chord sheet
// with a stray `S:` line doesn't get misread as a groove.
export const isDrumNotation = (text) => {
  const lines = String(text || '').split(/\r?\n/);
  let pieceRows = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = HEADER_RE.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (HEADER_KEYS.has(key)) continue;
    if (!PIECE_BY_TOKEN.has(key)) continue;
    const cells = m[2].replace(/[\s|]/g, '');
    // A row of grid glyphs only, with at least one actual hit — `S: hello`
    // shares the `PIECE:` shape but is prose, and `S: ----` alone is ambiguous.
    if (!cells || !/^[-xXogf._]+$/.test(cells) || !/[xXogf]/.test(cells)) continue;
    pieceRows += 1;
    if (pieceRows >= 2) return true;
  }
  // A single strong row still counts when a drum-specific header is present
  // (`subdivision:` has no meaning in any other SongBook format).
  return pieceRows >= 1 && /^\s*subdivision\s*:/im.test(String(text || ''));
};

// True when an ALREADY-PARSED chart contains at least one struck cell — lets the
// UI show an empty-state hint instead of an all-rest grid. Split from the
// text-taking form below so a caller that already holds a parsed chart doesn't
// pay for a second full parse of the same source.
export const chartHasMusic = (chart) => (chart?.bars || [])
  .some((bar) => bar.rows.some((row) => row.cells.some((cell) => !cell.rest)));
