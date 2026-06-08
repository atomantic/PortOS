/**
 * Songs AI — generate & evaluate a cappella arrangements.
 *
 * Two single-shot LLM calls (the synchronous universe-builder pattern, NOT
 * streaming): `generateSong` drafts a full arrangement from a title/brief, and
 * `evaluateSong` critiques an existing one. Both build the prompt inline (no
 * shipped stage-prompt file — these are one-shot JSON contracts, so the inline
 * pattern from recordMergeAI.js/agentContentGenerator.js fits) and parse the
 * response with the shared jsonExtract helper.
 *
 * Output is projected onto the canonical song shape via sanitizeSong (generate)
 * or a small verdict shape (evaluate) so a hallucinated/extra field can't leak
 * into storage. The rhythm-shape and voice-layer vocabularies are injected into
 * the prompt from songCraftRef.js so the model returns ids the editor's pickers
 * already understand — but unknown ids are accepted downstream (free-text
 * fallback), so a drifted model can't 400.
 *
 * Kept separate from services/songs.js (pure CRUD) so the AI dependency
 * (promptRunner → providers → runner) doesn't load on every plain song read.
 */

import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from '../lib/promptRunner.js';
import { extractJson } from '../lib/jsonExtract.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  RHYTHM_SHAPES, VOICE_LAYERS, DIRGE_RHYTHM_SHAPES,
  HARMONY_PARTS, DERIVABLE_HARMONY_PARTS,
} from '../lib/songCraftRef.js';
import {
  sanitizeSong, FIELD_MAX_LENGTH, SECTIONS_MAX, LAYERS_MAX,
  SCORE_MAX_LENGTH, SCORE_PARTS_MAX,
} from './songs.js';

// Strip dangerous control chars that would corrupt the prompt or invite
// structure-injection (a lyric containing a fake "# Output contract" header),
// and cap length so a giant pasted lyric can't blow the context budget.
// Newlines and tabs are PRESERVED — lyric line breaks carry meaning here.
const PROMPT_FIELD_MAX = 4000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (v) =>
  (typeof v === 'string' ? v.replace(CONTROL_CHARS, '').slice(0, PROMPT_FIELD_MAX) : '');

// Compact vocabulary blocks the model can choose ids from. Listing them inline
// keeps the editor pickers and the generated ids in sync without a round-trip.
const rhythmVocab = () =>
  RHYTHM_SHAPES.map((s) => `- ${s.id}: ${s.label}${s.dirge ? ' (dirge/lament)' : ''} — ${s.feel}`).join('\n');
const layerVocab = () =>
  VOICE_LAYERS.map((l) => `- ${l.id}: ${l.label} (${l.voices}) — ${l.role}`).join('\n');

// --- Shape predicates (jsonExtract) ----------------------------------------
const isGeneratedShape = (o) =>
  o && typeof o === 'object' &&
  (Array.isArray(o.sections) || Array.isArray(o.layers) || typeof o.notation === 'string' || typeof o.notes === 'string');

const isVerdictShape = (o) =>
  o && typeof o === 'object' &&
  (typeof o.score === 'number' || Array.isArray(o.strengths) || Array.isArray(o.suggestions));

// Pull JSON out of the LLM body or throw a typed 502 the route maps verbatim.
const parseOrThrow = (raw, shapePredicate, what) => {
  const { value, lastPreview } = extractJson(raw, { shapePredicate });
  if (value !== undefined) return value;
  throw new ServerError(
    `The AI returned invalid JSON for song ${what}. Try a different model or rerun.`,
    { status: 502, code: 'LLM_INVALID_JSON', context: { details: { preview: lastPreview } } },
  );
};

// --- Generate --------------------------------------------------------------
const buildGeneratePrompt = ({ title, artist, brief, mood, existing }) => {
  const want = [
    title && `Title: ${title}`,
    artist && `Artist / in the style of: ${artist}`,
    brief && `Brief: ${brief}`,
    mood && `Mood / feel: ${mood}`,
  ].filter(Boolean).join('\n');

  const existingBlock = existing
    ? `\n\nThe user already has this draft — extend and improve it, keep what works, fill the gaps:\n${existing}`
    : '';

  return `You are an a cappella arranger and songwriter. Write a singable, original a cappella arrangement (lyrics + voice-layer plan) the user can learn and perform unaccompanied. Lean toward folk/ballad/dirge sensibilities (e.g. "500 Miles" by Peter, Paul and Mary) unless the brief says otherwise.

${want || 'Write a short, mournful a cappella ballad.'}${existingBlock}

# Rhythm shapes you may pick from (return the id in rhythmShapeId)
${rhythmVocab()}
Dirge/lament shapes: ${DIRGE_RHYTHM_SHAPES.map((s) => s.id).join(', ')}.

# Voice layers — return these foundation-first (melody, then bass, then the mid harmonies, then the high harmonies). Use the id when it matches.
${layerVocab()}

# Output contract
Return ONLY a JSON object (no prose, no markdown fence) with this shape:
{
  "title": "string",
  "artist": "string (optional — performer or 'in the style of')",
  "key": "string e.g. 'C major'",
  "tempo": 68,                       // integer BPM, 20–320, or null
  "rhythmShapeId": "one of the ids above",
  "notation": "string — chord progression / lead-sheet notes / solfège, e.g. 'C — Am — F — G'",
  "notes": "string — how it should feel, dynamics, where to breathe, what to drill",
  "sections": [ { "label": "Verse 1", "lyrics": "..." } ],   // max ${SECTIONS_MAX}
  "layers":   [ { "id": "melody", "label": "Melody", "part": "Soprano/Tenor", "notes": "learning notes — intervals, entrances, breaths" } ]  // max ${LAYERS_MAX}
}
Keep lyrics original (do not reproduce copyrighted lyrics verbatim). Each string field under ${FIELD_MAX_LENGTH} characters.`;
};

/**
 * Generate a full song arrangement from a brief. Returns the sanitized song
 * fields (NOT persisted — the route/caller merges into a stored record) plus an
 * `llm` attribution block. `existingSong` (optional) is folded into the prompt
 * so "generate" doubles as "expand this draft".
 */
export async function generateSong({ title, artist, brief, mood, existingSong, providerId, model } = {}) {
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available for song generation', code: 'NO_PROVIDER' });

  const existing = existingSong ? summarizeSongForPrompt(existingSong) : '';
  const prompt = buildGeneratePrompt({
    title: clean(title), artist: clean(artist), brief: clean(brief), mood: clean(mood), existing,
  });

  const { text: raw, model: ranModel } = await runPromptThroughProvider({
    provider, model: selectedModel, prompt, source: 'song-generate',
  });

  const parsed = parseOrThrow(raw, isGeneratedShape, 'generation');
  // Project onto the canonical shape; sanitizeSong requires an id, so stamp a
  // placeholder the caller replaces — we only want the normalized fields back.
  const song = sanitizeSong({ ...parsed, id: 'draft' });
  if (!song) {
    throw new ServerError('The AI produced an unusable song. Try rerunning.', { status: 502, code: 'LLM_EMPTY' });
  }
  const { id: _drop, createdAt: _c, updatedAt: _u, ...fields } = song;
  console.log(`🎵 Generated song "${fields.title}" via ${provider.id}/${ranModel || 'default'}`);
  return { song: fields, llm: { provider: provider.id, model: ranModel || null } };
}

// --- Evaluate --------------------------------------------------------------
// Render a stored song into a compact prompt block — used by evaluate and by
// generate's "expand existing" path.
export function summarizeSongForPrompt(song) {
  if (!song || typeof song !== 'object') return '';
  const shape = RHYTHM_SHAPES.find((s) => s.id === song.rhythmShapeId);
  const lines = [
    song.title && `Title: ${clean(song.title)}`,
    song.artist && `Artist: ${clean(song.artist)}`,
    song.key && `Key: ${clean(song.key)}`,
    song.tempo && `Tempo: ${song.tempo} BPM`,
    shape && `Rhythm shape: ${shape.label}${shape.dirge ? ' (dirge)' : ''}`,
    song.notation && `Notation: ${clean(song.notation)}`,
    song.notes && `Arrangement notes: ${clean(song.notes)}`,
  ].filter(Boolean);

  const sections = (song.sections || []).slice(0, SECTIONS_MAX)
    .map((s) => `[${clean(s.label) || 'Section'}]\n${clean(s.lyrics)}`).join('\n\n');
  const layers = (song.layers || []).slice(0, LAYERS_MAX)
    .map((l) => `- ${clean(l.label)}${l.part ? ` (${clean(l.part)})` : ''}: ${clean(l.notes)}`).join('\n');

  return [
    lines.join('\n'),
    sections && `\nLyrics & structure:\n${sections}`,
    layers && `\nVoice layers:\n${layers}`,
  ].filter(Boolean).join('\n');
}

const buildEvaluatePrompt = (songBlock) =>
  `You are an a cappella coach evaluating an arrangement for singability, harmonic soundness, and emotional impact. Be specific and constructive — name the section/layer you mean.

# The arrangement
${songBlock}

# What to assess
- Singability: are the parts in comfortable ranges, do entrances/breaths work unaccompanied?
- Harmony: do the layers build foundation-first (melody, bass, mid harmonies, high harmonies) and stay in tune as a stack?
- Structure & lyrics: does the form serve the mood; do lyrics scan and breathe across the bar?
- Layer balance: is anything missing (the bass floor, a sustained high pad) or overcrowded?

# Output contract
Return ONLY a JSON object (no prose, no markdown fence):
{
  "score": 0,                 // integer 0–100, overall performance-readiness
  "summary": "one or two sentence overall take",
  "strengths": ["..."],       // up to 6
  "weaknesses": ["..."],      // up to 6
  "suggestions": ["concrete, actionable next steps"]   // up to 6
}`;

/**
 * Evaluate a stored song arrangement. Returns a verdict { score, summary,
 * strengths[], weaknesses[], suggestions[] } plus an `llm` block. Pure
 * read-side AI — does not mutate the song.
 */
export async function evaluateSong({ song, providerId, model } = {}) {
  if (!song || typeof song !== 'object') {
    throw new ServerError('A song is required to evaluate', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available for song evaluation', code: 'NO_PROVIDER' });

  const prompt = buildEvaluatePrompt(summarizeSongForPrompt(song));
  const { text: raw, model: ranModel } = await runPromptThroughProvider({
    provider, model: selectedModel, prompt, source: 'song-evaluate',
  });

  const parsed = parseOrThrow(raw, isVerdictShape, 'evaluation');
  const verdict = normalizeVerdict(parsed);
  console.log(`🎼 Evaluated song "${clean(song.title) || song.id}" → ${verdict.score}/100 via ${provider.id}/${ranModel || 'default'}`);
  return { evaluation: verdict, llm: { provider: provider.id, model: ranModel || null } };
}

// Coerce the model's verdict into a known shape: clamp the score, cap each
// list, and drop non-string entries so a malformed list can't reach the UI.
const LIST_MAX = 6;
const strList = (v) =>
  (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .slice(0, LIST_MAX);

export function normalizeVerdict(raw) {
  const scoreNum = Number(raw?.score);
  const score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : null;
  return {
    score,
    summary: typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, FIELD_MAX_LENGTH) : '',
    strengths: strList(raw?.strengths),
    weaknesses: strList(raw?.weaknesses),
    suggestions: strList(raw?.suggestions),
  };
}

// --- Derive harmony parts --------------------------------------------------
// A compact spec of the PortOS lead-sheet DSL so the model can both READ the base
// melody and WRITE parts in the same format. Mirrors client/src/lib/
// scoreNotation.js — the format is small enough to inline; the worked base score
// in the prompt is the real teacher.
const LEAD_SHEET_SPEC = `PortOS lead-sheet notation:
- Header lines (one per line, before the music): "clef: treble|bass", "key: G", "time: 4/4", "tempo: 68".
- Music: measures separated by "|". Notes are space-separated within a bar.
- A note token is [chord]? PITCH DURATION dots? (lyric)? e.g. [G] B4q.(miss)
  - PITCH = letter A–G + optional accidental (#, b, n) + octave digit (C4 = middle C). e.g. C4, F#4, Bb3.
  - DURATION = w h q e s t (whole, half, quarter, eighth, sixteenth, 32nd). Trailing "." dots it (q. = 1.5 beats).
  - Rest = "r" + duration (rq, rh) — no pitch, no lyric.
  - [chord] draws a chord symbol above; (lyric) draws a syllable beneath (trailing "-" = held syllable).`;

// The "parts to write" block — id + range + voicing rule for each requested
// part, low→high so the model builds the stack in order.
const partsBrief = (parts) =>
  parts
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .map((p) => `- ${p.id} ("${p.label}", range ${p.range}): ${p.voicing}`)
    .join('\n');

const isDerivedPartsShape = (o) =>
  o && typeof o === 'object' && Array.isArray(o.parts);

const buildDerivePrompt = ({ song, parts }) => {
  const key = clean(song.key) || 'C major';
  const baseScore = clean(song.score);
  return `You are an a cappella arranger building a layered folk vocal stack (think a sparse, TikTok-style harmony build, NOT a dense chorale). Given a base MELODY in PortOS lead-sheet notation, write singable HARMONY parts that stack with it.

# Format (the melody below uses it; your output must too)
${LEAD_SHEET_SPEC}

# Base melody — key: ${key}
${baseScore}

# Parts to write (low → high)
${partsBrief(parts)}

# How to voice each part — CHORD-TONE, not parallel
- For each chord symbol ([G], [Em], [C], [Am7], [D7] …), spell its chord tones, then give each voice a chord tone from that chord, picking the octave that fits the voice's range. This vertical chord-tone map is the goal — NOT tracking the melody a fixed interval away.
- DO NOT move every voice in parallel with the melody. Parallel 3rds/6ths under every syllable sound like a MIDI choir. Instead: favour COMMON TONES held across a chord change, and move by the smallest step when the chord changes (smooth voice leading).
- SUSTAIN. A harmony voice should usually hold one chord tone per chord (whole/half notes) rather than singing every melodic syllable. It does NOT need the melody's rhythm or every lyric — use long notes and rests.
- When the melody passes through a non-chord (passing) tone, HOLD the harmony on the nearest stable chord tone; don't chase the passing note.
- Preserve leading tones: the third of a dominant-7 chord (e.g. F# under D7 in the key of G) MUST stay — it pulls up to the tonic. Never flatten it to a modal sound.
- Stagger entrances. Lower/inner voices can enter after the opening; the top descant ("high-harmony-1") should be SPARSE — rest through the opening bars (use whole rests \`rw\`) and enter only on the later, emotional phrases. The bass and inner pads carry the body.
- Keep each voice within its stated range, and keep the lower voices below the melody, the upper voices above the inner ones.

# Output rules
- Same number of measures as the melody, same key signature, same time and tempo headers. Use "clef: bass" for the bass part and "clef: treble" for the others.
- Carry the chord symbols ([G] …) on each part's downbeats so it is readable on its own.
- Lyrics are optional on harmony parts — a sustained note can carry the bar's lead word (or none). Do not force a syllable onto every note.

# Output contract
Return ONLY a JSON object (no prose, no markdown fence):
{
  "parts": [
    { "id": "bass", "score": "clef: bass\\nkey: ${key.split(/\\s/)[0]}\\ntime: 4/4\\ntempo: 68\\n\\n| ... |" }
  ]
}
Include exactly one entry per requested part id, each a complete lead-sheet string (headers + measures). Each score under ${SCORE_MAX_LENGTH} characters.`;
};

// Project the model's parts onto the canonical scorePart shape. Matches each
// returned id to a known HARMONY_PARTS entry for its label (falling back to the
// model's label, then the id), length-caps the score, and drops parts with no
// notation. Bounded to SCORE_PARTS_MAX.
const normalizeDerivedParts = (rawParts) =>
  (Array.isArray(rawParts) ? rawParts : [])
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const score = typeof p.score === 'string' ? p.score.trim().slice(0, SCORE_MAX_LENGTH) : '';
      if (!score) return null;
      const id = typeof p.id === 'string' ? p.id.trim() : '';
      const known = HARMONY_PARTS.find((h) => h.id === id);
      const label = known?.label
        || (typeof p.label === 'string' && p.label.trim())
        || id
        || 'Part';
      return { role: known?.id || id, label, score };
    })
    .filter(Boolean)
    .slice(0, SCORE_PARTS_MAX);

/**
 * Derive harmony parts (bass, mid/high harmonies) from a song's base melody.
 * Returns `{ scoreParts, llm }` — the parts are NOT persisted; the route hands
 * them back for the client to merge into the editor draft (the user reviews +
 * Saves), matching the generate/expand flow. `partIds` (optional) restricts the
 * set; default is every derivable harmony part. Throws 400 if the song has no
 * base score to derive from.
 */
export async function deriveSongParts({ song, partIds, providerId, model } = {}) {
  if (!song || typeof song !== 'object') {
    throw new ServerError('A song is required to derive parts', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!clean(song.score)) {
    throw new ServerError('This song has no base sheet music to derive harmony from. Add a melody in the Sheet music editor first.', { status: 400, code: 'NO_BASE_SCORE' });
  }
  // Restrict to the requested ids (when given) but only ever derivable parts —
  // never the melody (that's the input). Empty/unknown selection falls back to
  // the full derivable set so a drifted client can't ask for nothing.
  const wanted = Array.isArray(partIds) && partIds.length
    ? DERIVABLE_HARMONY_PARTS.filter((p) => partIds.includes(p.id))
    : DERIVABLE_HARMONY_PARTS;
  const parts = wanted.length ? wanted : DERIVABLE_HARMONY_PARTS;

  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to derive parts', code: 'NO_PROVIDER' });

  const prompt = buildDerivePrompt({ song, parts });
  const { text: raw, model: ranModel } = await runPromptThroughProvider({
    provider, model: selectedModel, prompt, source: 'song-derive-parts',
  });

  const parsed = parseOrThrow(raw, isDerivedPartsShape, 'part derivation');
  const scoreParts = normalizeDerivedParts(parsed.parts);
  if (!scoreParts.length) {
    throw new ServerError('The AI returned no usable harmony parts. Try a different model or rerun.', { status: 502, code: 'LLM_EMPTY' });
  }
  console.log(`🎶 Derived ${scoreParts.length} harmony part(s) for "${clean(song.title) || song.id}" via ${provider.id}/${ranModel || 'default'}`);
  return { scoreParts, llm: { provider: provider.id, model: ranModel || null } };
}
