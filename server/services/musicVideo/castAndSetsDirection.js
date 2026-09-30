/**
 * Music Video — Cast & Sets creative direction (pure): the LLM prompt, the
 * response parser and the absent-vs-empty merge.
 *
 * Before any image is made, one provider call reads the song as a story and
 * returns the production's cast and world: a logline, one protagonist (face,
 * hair, signature prop, a recurring gesture tied to a lyric hook, continuity
 * rules), 1–4 wardrobe looks mapped to chapters, 3–8 sets (one dominant light
 * each) mapped to song sections, 2–4 in-set test frames, an overlay concept,
 * and the 2–4 mood-board images that best show the look. The prompt is told
 * explicitly that the mood board is look/lighting/texture reference only —
 * the world comes from the song's own references and themes.
 *
 * A regeneration sends the current direction plus the director's notes and
 * asks for the full revised object. The merge follows the repo's LLM rule:
 * a key the model left out keeps the current value; a key present with an
 * empty value is an intentional clear (for the optional fields that allow it).
 */

import { z } from 'zod';
import { extractJson } from '../../lib/jsonExtract.js';
import { musicVideoCreativeContext } from '../../lib/musicVideoCreativeContext.js';
import { trimTo } from '../../lib/textUtils.js';

export const CAST_SETS_LIMITS = Object.freeze({
  looks: { min: 1, max: 4 },
  sets: { min: 3, max: 8 },
  tests: { min: 2, max: 4 },
  moodRefs: { min: 2, max: 4 },
  rules: 6,
  questions: 4,
  overlayElements: 4,
});
const TEXT = 1000;
const SHORT = 120;
const LYRICS_MAX = 6000;
const MOOD_ITEMS_MAX = 40;
const MOOD_ITEM_TEXT = 280;

// ---- context ---------------------------------------------------------------

const fmtTime = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** The lyric sheet as the model should read it: section headers and delivery directions inline. */
function lyricSheetText(project) {
  const cues = Array.isArray(project?.lyricCues) ? project.lyricCues : [];
  const markers = Array.isArray(project?.lyricMarkers) ? project.lyricMarkers : [];
  const lines = [];
  for (let i = 0; i <= cues.length; i += 1) {
    for (const m of markers.filter((mk) => mk?.line === i)) {
      if (typeof m.label === 'string' && m.label.trim()) lines.push(`[${m.label.trim()}]`);
    }
    const text = typeof cues[i]?.text === 'string' ? cues[i].text.trim() : '';
    if (text) lines.push(text);
  }
  return lines.join('\n').slice(0, LYRICS_MAX);
}

/** The analyzed song sections the song map is keyed by. */
export function songSections(project) {
  const sections = Array.isArray(project?.audioAnalysis?.sections) ? project.audioAnalysis.sections : [];
  return sections
    .filter((s) => typeof s?.startSec === 'number' && typeof s?.endSec === 'number' && s.endSec > s.startSec)
    .map((s, index) => ({ index, label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : `Section ${index + 1}`, startSec: s.startSec, endSec: s.endSec }));
}

/**
 * The mood board's images with what is known about each (caption, per-item
 * vision analysis). `resolveItem` maps a board item to its local image
 * (`boardItemLocalImage`) — injected so this module stays free of the store.
 */
export function moodBoardImageList(board, resolveItem) {
  const out = [];
  for (const item of Array.isArray(board?.items) ? board.items : []) {
    const asset = typeof resolveItem === 'function' ? resolveItem(item) : null;
    if (!asset?.filename) continue;
    if (out.some((e) => e.kind === asset.kind && e.filename === asset.filename)) continue;
    out.push({
      kind: asset.kind,
      filename: asset.filename,
      caption: trimTo(item.caption, MOOD_ITEM_TEXT),
      analysis: trimTo(item.analysis?.prompt, MOOD_ITEM_TEXT),
    });
    if (out.length >= MOOD_ITEMS_MAX) break;
  }
  return out;
}

const OUTPUT_SHAPE = `{
  "logline": "<one or two sentences: who, where, what happens>",
  "interpretation": "<how the song's references and themes shape this world>",
  "protagonist": {
    "name": "<a name or designation>",
    "description": "<who they are in the song: age, vibe, attitude>",
    "face": "<face: skin, eyes, brows, distinguishing features>",
    "hair": "<hair that reads in silhouette>",
    "signature": "<one signature prop or detail present in every look>",
    "gesture": "<a recurring gesture tied to a lyric hook, quoting the hook>",
    "rules": ["<continuity or safety rule>"]
  },
  "looks": [{ "name": "<SHORT NAME>", "description": "<the complete outfit>", "chapters": "<which parts of the song>" }],
  "sets": [{ "id": "<short-slug>", "name": "<set name>", "description": "<the empty location, concrete and visual>", "lighting": "<its one dominant light>", "sections": ["<section label it serves>"] }],
  "songMap": [{ "section": 0, "setId": "<short-slug>" }],
  "tests": [{ "setId": "<short-slug>", "look": "<SHORT NAME>", "action": "<what the protagonist does in this frame>", "caption": "<the lyric or beat it serves>" }],
  "overlayConcept": { "summary": "<one persistent graphic layer that ties every shot together>", "elements": [{ "name": "<element>", "description": "<what it shows and when it changes>" }] },
  "moodRefs": [0, 1],
  "questions": ["<a question for the director>"]
}`;

/**
 * Build the direction prompt. `context` is `{ board, moodImages, track }`
 * (all optional). With `previous` + `notes` it becomes a revision request.
 */
export function buildCastAndSetsPrompt(project, { moodImages = [], board = null, track = null, previous = null, notes = [] } = {}) {
  const concept = project?.concept || {};
  const analysis = project?.audioAnalysis || {};
  const sections = songSections(project);
  const lyrics = lyricSheetText(project);
  const guidance = trimTo(project?.automation?.guidance, 2000);
  const trackStyle = trimTo(track?.prompt, 1500) || trimTo(concept.style, 1500);
  const boardStyle = trimTo(board?.style?.prompt, 1500) || trimTo(concept.moodBoardStyle, 1500);
  const boardNegative = trimTo(board?.style?.negativePrompt, 600);
  const moodLines = moodImages.map((img, i) => `${i}. ${[img.caption, img.analysis].filter(Boolean).join(' — ') || '(no caption or analysis)'}`);
  const sectionLines = sections.map((s) => `${s.index}. ${s.label} ${fmtTime(s.startSec)}–${fmtTime(s.endSec)}`);
  const bible = musicVideoCreativeContext(concept);

  const header = [
    `You are the creative director preparing the CAST & SETS check-in for a music video of "${project?.name || 'Untitled'}".`,
    'Read the lyrics as a story. Interpret the song: its references, themes and subtext, including any real events, ideas or cultural touchstones the words point at. The world of the video (who the protagonist is, where it happens, what the sets are) must come from that interpretation.',
    'The mood board is reference for LOOK, LIGHTING, COLOR and TEXTURE only. Never copy its literal locations, rooms or props into the sets: a kitchen photo on the board does not put the video in a kitchen.',
  ].join('\n');

  const facts = [
    `Duration: ${fmtTime(analysis.durationSec)}${analysis.bpm ? ` · ${Math.round(analysis.bpm)} BPM` : ''}`,
    trackStyle && `Track style prompt: ${trackStyle}`,
    concept.prompt && `Concept: ${trimTo(concept.prompt, 2000)}`,
    guidance && `Director guidance: ${guidance}`,
    bible && bible,
  ].filter(Boolean).join('\n');

  const board_ = [
    boardStyle && `Mood board composed style: ${boardStyle}`,
    boardNegative && `Mood board avoid: ${boardNegative}`,
    moodLines.length ? `Mood board images (index. caption — per-image analysis):\n${moodLines.join('\n')}` : 'No mood board images.',
  ].filter(Boolean).join('\n');

  const rules = [
    `- ${CAST_SETS_LIMITS.looks.min}–${CAST_SETS_LIMITS.looks.max} looks, ${CAST_SETS_LIMITS.sets.min}–${CAST_SETS_LIMITS.sets.max} sets, ${CAST_SETS_LIMITS.tests.min}–${CAST_SETS_LIMITS.tests.max} tests.`,
    '- Give every set ONE dominant light color or quality so a cut tells the viewer where we are.',
    '- songMap: one entry per song section index listed above, naming the set that section plays in.',
    '- tests: in-set frames of the protagonist that prove the cast works in the world; each names a set id and a look name.',
    `- moodRefs: the ${CAST_SETS_LIMITS.moodRefs.min}–${CAST_SETS_LIMITS.moodRefs.max} mood board image indices that best show the look for the character sheet${moodImages.length ? '' : ' (empty: there are none)'}.`,
    '- Wet or revealing looks use opaque fabric so the video stays safe to post.',
    '- questions: up to three things you need the director to decide.',
  ].join('\n');

  const revision = previous ? [
    'This is a REVISION. The current direction is:',
    JSON.stringify(previous),
    notes.length ? `Director notes to address:\n${notes.map((n) => `- ${n.target ? `[${n.target}] ` : ''}${n.text}`).join('\n')}` : 'No notes: refine it.',
    'Return the FULL revised JSON object. Change only what the notes ask for and keep every other field exactly as it is.',
  ].join('\n') : '';

  return [
    header,
    facts,
    `Lyrics (section headers and delivery directions in brackets):\n${lyrics || '(instrumental — no lyrics)'}`,
    sectionLines.length ? `Song sections (index. label start–end):\n${sectionLines.join('\n')}` : 'The song has not been sectioned.',
    board_,
    rules,
    revision,
    `Respond with ONLY one JSON object in this shape (replace every <…> with real content; do NOT output the angle-bracket text), no other text:\n${OUTPUT_SHAPE}`,
  ].filter(Boolean).join('\n\n');
}

// ---- parsing ----------------------------------------------------------------

const isPlaceholder = (s) => typeof s === 'string' && /^\s*<.+>\s*$/.test(s);
const text = (max) => z.string().transform((s) => (isPlaceholder(s) ? '' : s.trim().slice(0, max)));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const protagonistSchema = z.object({
  name: text(SHORT).optional(),
  description: text(TEXT).optional(),
  face: text(TEXT).optional(),
  hair: text(TEXT).optional(),
  signature: text(TEXT).optional(),
  gesture: text(TEXT).optional(),
  rules: z.array(text(300)).optional(),
}).passthrough();
const lookSchema = z.object({ name: text(SHORT), description: text(TEXT), chapters: text(300).optional() }).passthrough();
const setSchema = z.object({
  id: z.string().optional(),
  name: text(SHORT),
  description: text(TEXT),
  lighting: text(300).optional(),
  sections: z.union([z.array(z.union([z.string(), z.number()])), z.string()]).optional(),
}).passthrough();
const songMapSchema = z.object({ section: z.union([z.number(), z.string()]), setId: z.string() }).passthrough();
const testSchema = z.object({ setId: z.string(), look: text(SHORT).optional(), action: text(TEXT), caption: text(300).optional() }).passthrough();
const overlaySchema = z.union([
  text(TEXT).transform((summary) => ({ summary, elements: [] })),
  z.object({
    summary: text(TEXT).optional(),
    elements: z.array(z.object({ name: text(SHORT), description: text(TEXT) }).passthrough()).optional(),
  }).passthrough(),
]);

// One lenient parser per field: a field that does not fit its shape counts as
// absent (the merge keeps the current value) rather than failing the answer.
const FIELD_PARSERS = {
  logline: text(TEXT),
  interpretation: text(2000),
  protagonist: protagonistSchema,
  looks: z.array(lookSchema),
  sets: z.array(setSchema),
  songMap: z.array(songMapSchema),
  tests: z.array(testSchema),
  overlayConcept: overlaySchema,
  moodRefs: z.array(z.number().int().min(0)),
  questions: z.array(text(400)),
};

// A real answer (not the echoed schema) carries at least one non-placeholder
// logline or protagonist name — or, on a revision, any other known field.
const realText = (v) => typeof v === 'string' && v.trim() && !isPlaceholder(v);
const looksLikeDirection = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && (realText(value.logline) || realText(value.protagonist?.name)
    || (!('logline' in value) && Object.keys(FIELD_PARSERS).some((k) => k in value)));

/**
 * Parse a provider answer into a PARTIAL direction: only the keys the model
 * returned in a usable shape are present. Returns null when no JSON object
 * could be found at all.
 */
export function parseCastAndSetsResponse(responseText) {
  const { value } = extractJson(responseText, { blockType: 'object', shapePredicate: looksLikeDirection });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, parser] of Object.entries(FIELD_PARSERS)) {
    if (!(key in value) || value[key] == null) continue;
    const parsed = parser.safeParse(value[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

// ---- merge + normalize ------------------------------------------------------

const hasOwn = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

function normalizeSets(sets, sections) {
  const seen = new Set();
  const labels = new Map(sections.map((s) => [String(s.index), s.label]));
  return sets.filter((s) => s.name && s.description).slice(0, CAST_SETS_LIMITS.sets.max).map((s, i) => {
    let id = slug(s.id) || slug(s.name) || `set-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const rawSections = Array.isArray(s.sections) ? s.sections : (typeof s.sections === 'string' ? s.sections.split(/[,;]/) : []);
    return {
      id,
      name: s.name,
      description: s.description,
      lighting: s.lighting || '',
      sections: rawSections.map((x) => (typeof x === 'number' ? labels.get(String(x)) || '' : String(x).trim())).filter(Boolean).slice(0, 12),
    };
  });
}

function normalizeSongMap(entries, sets, sections) {
  const setIds = new Set(sets.map((s) => s.id));
  const bySlug = new Map(sets.map((s) => [slug(s.name), s.id]));
  const byLabel = new Map(sections.map((s) => [s.label.toLowerCase(), s.index]));
  const out = new Map();
  for (const entry of entries) {
    const index = typeof entry.section === 'number' ? entry.section : (byLabel.get(String(entry.section).trim().toLowerCase()) ?? Number(entry.section));
    const setId = setIds.has(slug(entry.setId)) ? slug(entry.setId) : bySlug.get(slug(entry.setId));
    if (!Number.isInteger(index) || !sections.some((s) => s.index === index) || !setId) continue;
    if (!out.has(index)) out.set(index, { section: index, setId });
  }
  return [...out.values()].sort((a, b) => a.section - b.section);
}

function normalizeTests(tests, sets, looks) {
  const setIds = new Set(sets.map((s) => s.id));
  return tests
    .map((t) => ({ ...t, setId: slug(t.setId) }))
    .filter((t) => setIds.has(t.setId) && t.action)
    .slice(0, CAST_SETS_LIMITS.tests.max)
    .map((t) => ({
      setId: t.setId,
      look: looks.find((l) => l.name.toLowerCase() === String(t.look || '').toLowerCase())?.name || looks[0]?.name || '',
      action: t.action,
      caption: t.caption || '',
    }));
}

/**
 * Merge a parsed (partial) answer onto the current direction and normalize
 * the result. Absent keys keep `previous`; present keys replace (an empty
 * string/array clears the optional text/list fields). Returns
 * `{ direction, missing }` — `missing` lists the required parts still absent,
 * so a first pass with an unusable answer can be refused.
 */
export function mergeCastAndSetsDirection(previous, parsed, { sections = [], moodImageCount = 0 } = {}) {
  const base = previous || {};
  const pick = (key, fallback) => (hasOwn(parsed, key) ? parsed[key] : (hasOwn(base, key) ? base[key] : fallback));
  const p0 = base.protagonist || {};
  const p1 = hasOwn(parsed, 'protagonist') ? parsed.protagonist : {};
  const pField = (key) => (hasOwn(p1, key) ? p1[key] : (p0[key] ?? ''));
  const protagonist = {
    name: pField('name'),
    description: pField('description'),
    face: pField('face'),
    hair: pField('hair'),
    signature: pField('signature'),
    gesture: pField('gesture'),
    rules: (hasOwn(p1, 'rules') ? p1.rules : (p0.rules || [])).filter(Boolean).slice(0, CAST_SETS_LIMITS.rules),
  };
  const looks = (pick('looks', [])).filter((l) => l.name && l.description).slice(0, CAST_SETS_LIMITS.looks.max)
    .map((l) => ({ name: l.name, description: l.description, chapters: l.chapters || '' }));
  const sets = hasOwn(parsed, 'sets') ? normalizeSets(parsed.sets, sections) : (base.sets || []);
  const songMap = normalizeSongMap(pick('songMap', []), sets, sections);
  const tests = normalizeTests(pick('tests', []), sets, looks);
  const overlayRaw = pick('overlayConcept', { summary: '', elements: [] }) || {};
  const overlayConcept = {
    summary: overlayRaw.summary || '',
    elements: (overlayRaw.elements || []).filter((e) => e.name && e.description).slice(0, CAST_SETS_LIMITS.overlayElements)
      .map((e) => ({ name: e.name, description: e.description })),
  };
  const moodRefs = [...new Set(pick('moodRefs', []))].filter((i) => i < moodImageCount).slice(0, CAST_SETS_LIMITS.moodRefs.max);
  const direction = {
    logline: pick('logline', ''),
    interpretation: pick('interpretation', ''),
    protagonist,
    looks,
    sets,
    songMap,
    tests,
    overlayConcept,
    moodRefs,
    questions: (pick('questions', [])).filter(Boolean).slice(0, CAST_SETS_LIMITS.questions),
  };
  const missing = [
    !direction.logline && 'logline',
    !(protagonist.name && (protagonist.face || protagonist.description)) && 'protagonist',
    looks.length < CAST_SETS_LIMITS.looks.min && 'looks',
    sets.length < CAST_SETS_LIMITS.sets.min && 'sets',
  ].filter(Boolean);
  return { direction, missing };
}
