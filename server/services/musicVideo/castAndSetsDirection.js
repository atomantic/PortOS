import { musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';
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
 * The check-in has two media. `photographic` (the legacy default) asks for a
 * human cast: face, hair, wardrobe looks and in-set test frames. `procedural`
 * (a code-first project, or a brief with code tools and no video tool) asks
 * instead how the characters are BUILT in code (construction, shape language,
 * materials, expressions, movement) and how the world behaves (layout, depth,
 * lighting, camera, transitions), and gives every planned image an intentional
 * role (background, texture, decoration, or an explicit cutout). The medium is
 * stored on the direction so a revision never silently switches it. A procedural
 * direction may also carry `definitions`: a bounded, validated code definition
 * per reusable character (castAndSetsDefinitions.js) that the sheet previews and
 * the code-authoring request reuses.
 *
 * A regeneration sends the current direction plus the director's notes and
 * asks for the full revised object. The merge follows the repo's LLM rule:
 * a key the model left out keeps the current value; a key present with an
 * empty value is an intentional clear (for the optional fields that allow it).
 */

import { z } from 'zod';
import { ServerError } from '../../lib/errorHandler.js';
import { extractJson } from '../../lib/jsonExtract.js';
import { musicVideoCreativeContext, musicVideoSongStyleContext, withoutPeople } from '../../lib/musicVideoCreativeContext.js';
import { musicVideoBriefTools as briefTools } from '../../lib/musicVideoMediumPlan.js';
import { trimTo } from '../../lib/textUtils.js';
import { CAST_SETS_DEFINITION_LIMITS, normalizeDefinitions } from './castAndSetsDefinitions.js';

// Mood board images are outside inspiration (Pinterest pins, uploads): they
// shape the direction as words and are never image-generation inputs.
const MOOD_BOARD_TEXT_ONLY = 'The image generator never sees the mood board: carry what you take from it (light, color, texture, grain, wardrobe feel) into your own words in the descriptions, lighting and looks.';

// The look line rides on every plate prompt, and a plate is shot empty: a person
// in either (a mood board's composed style often describes one) lands in the plate.
const LOOK_AND_SET_RULES = [
  '- look: palette, light quality, film stock, grain and texture only. Never a person, place, object or pose: it is appended to every image, including the empty set plates.',
  '- sets: describe the EMPTY place. No people, characters, figures or actions; the protagonist appears only in tests.',
].join('\n');

export const CAST_SETS_LIMITS = Object.freeze({
  looks: { min: 1, max: 4 },
  sets: { min: 3, max: 8 },
  tests: { min: 2, max: 4 },
  rules: 6,
  expressions: 8,
  questions: 4,
  overlayElements: 4,
});
export const CAST_SETS_IMAGE_ROLES = Object.freeze(['background', 'texture', 'decoration', 'cutout']);
const TEXT = 1000;
const SHORT = 120;
const LYRICS_MAX = 6000;
const MOOD_ITEMS_MAX = 40;
const MOOD_ITEM_TEXT = 280;

// ---- medium ------------------------------------------------------------------

/**
 * The medium the check-in is directed in. A code-first production policy, or a
 * brief that selected code tools and no video tool, is procedural; everything
 * else (an image-only brief included) stays photographic. Tools and policy are
 * read together because either can be saved without the other.
 */
export function castAndSetsMedium(project) {
  if (!musicVideoAllowsMedia(project, 'image')) return 'procedural';
  if (project?.productionPolicy?.strategy === 'code-first') return 'procedural';
  const tools = briefTools(project);
  return tools.some((t) => t.startsWith('code:')) && !tools.some((t) => t.startsWith('video:')) ? 'procedural' : 'photographic';
}

/** False when the brief names tools and none of them makes images (a code-only project). */
export function castAndSetsAllowsImages(project) {
  if (!musicVideoAllowsMedia(project, 'image')) return false;
  const tools = briefTools(project);
  return tools.length === 0 || tools.some((t) => t.startsWith('image:'));
}

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
  "look": "<one line of photographic look: palette, light quality, film stock, grain, texture; no people, places, objects or poses>",
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
  "sets": [{ "id": "<short-slug>", "name": "<set name>", "description": "<the empty location, concrete and visual, with nobody in it>", "lighting": "<its one dominant light>", "sections": ["<section label it serves>"] }],
  "songMap": [{ "section": 0, "setId": "<short-slug>" }],
  "tests": [{ "setId": "<short-slug>", "look": "<SHORT NAME>", "action": "<what the protagonist does in this frame>", "caption": "<the lyric or beat it serves>" }],
  "overlayConcept": { "summary": "<one persistent graphic layer that ties every shot together>", "elements": [{ "name": "<element>", "description": "<what it shows and when it changes>" }] },
  "questions": ["<a question for the director>"]
}`;

const PROCEDURAL_OUTPUT_SHAPE = `{
  "logline": "<one or two sentences: who, where, what happens>",
  "interpretation": "<how the song's references and themes shape this world>",
  "look": "<one line of photographic look: palette, light quality, film stock, grain, texture; no people, places, objects or poses>",
  "protagonist": {
    "name": "<a name or designation>",
    "description": "<who or what they are in the song: vibe, attitude>",
    "construction": "<how the character is built in code: the parts, proportions and pivots>",
    "shapeLanguage": "<the shapes that define them: round, angular, stacked, ...>",
    "materials": "<fills, gradients, outlines, glow, texture>",
    "palette": "<the exact colors, as hex values>",
    "expressions": ["<expression name: how the face or shape changes>"],
    "movement": "<motion rules: easing, idle loop, how it reacts to the beat>",
    "signature": "<one detail present in every pose>",
    "gesture": "<a recurring gesture tied to a lyric hook, quoting the hook>",
    "rules": ["<continuity rule>"]
  },
  "looks": [{ "name": "<SHORT NAME>", "description": "<a palette or costume variant>", "chapters": "<which parts of the song>" }],
  "world": {
    "layout": "<how the environments are composed>",
    "depth": "<the layers and parallax planes>",
    "lighting": "<how light behaves across the video>",
    "camera": "<camera behavior: moves, framing, speed>",
    "transitions": "<how one environment hands off to the next>"
  },
  "sets": [{ "id": "<short-slug>", "name": "<set name>", "description": "<the environment, concrete and visual>", "lighting": "<its one dominant light>", "imageRole": "<background | texture | decoration | cutout>", "sections": ["<section label it serves>"] }],
  "songMap": [{ "section": 0, "setId": "<short-slug>" }],
  "overlayConcept": { "summary": "<one persistent graphic layer that ties every shot together>", "elements": [{ "name": "<element>", "description": "<what it shows and when it changes>" }] },
  "definitions": {
    "characters": [{
      "id": "<short-slug>",
      "name": "<character name>",
      "renderer": "svg | canvas2d | three",
      "palette": [{ "name": "<color-name>", "hex": "#rrggbb" }],
      "parts": [{ "id": "<part-slug>", "shape": "circle | ellipse | rect | polygon | path | line", "x": 100, "y": 100, "r": 40, "fill": "<palette color name or #hex>", "stroke": "<palette color name or #hex>", "strokeWidth": 2, "pivot": [100, 100] }],
      "expressions": [{ "name": "<expression name>", "overrides": { "<part-slug>": { "translate": [0, 0], "rotate": 0, "scale": 1, "fill": "<palette color name or #hex>", "hidden": false } } }],
      "poses": [{ "name": "<pose name>", "overrides": { "<part-slug>": { "rotate": 0 } } }],
      "motion": [{ "name": "<motion name>", "target": "<part-slug or all>", "property": "rotate | scale | translateX | translateY | opacity", "amplitude": 4, "periodBeats": 1, "easing": "linear | ease-in-out | ease-out | bounce | step", "trigger": "idle | beat | downbeat | lyric | section" }]
    }]
  },
  "questions": ["<a question for the director>"]
}`;

/**
 * Build the direction prompt. `context` is `{ board, moodImages, track }`
 * (all optional). With `previous` + `notes` it becomes a revision request.
 * `medium` defaults to the previous direction's, else the project's.
 */
export function buildCastAndSetsPrompt(project, { moodImages = [], board = null, track = null, previous = null, notes = [], medium = null, feedback = [] } = {}) {
  // A saved direction without a medium predates the procedural one: photographic.
  const procedural = (medium || (previous ? (previous.medium || 'photographic') : castAndSetsMedium(project))) === 'procedural';
  const concept = project?.concept || {};
  const analysis = project?.audioAnalysis || {};
  const sections = songSections(project);
  const lyrics = lyricSheetText(project);
  const guidance = trimTo(project?.automation?.guidance, 2000);
  // The song's Suno style shapes the design; the director's visual style is the look.
  const songStyle = musicVideoSongStyleContext({ songStyle: concept.songStyle || track?.prompt });
  const visualStyle = trimTo(concept.style, 1500);
  // The board's pictured people are never design input (#10982).
  const boardStyle = withoutPeople(trimTo(board?.style?.prompt, 1500) || trimTo(concept.moodBoardStyle, 1500));
  const boardNegative = trimTo(board?.style?.negativePrompt, 600);
  const moodLines = moodImages.map((img, i) => `${i}. ${[img.caption, img.analysis].filter(Boolean).join(' — ') || '(no caption or analysis)'}`);
  const sectionLines = sections.map((s) => `${s.index}. ${s.label} ${fmtTime(s.startSec)}–${fmtTime(s.endSec)}`);
  // The character style is given in full below, so the bible leaves it out.
  const bible = musicVideoCreativeContext({ ...concept, characterStyle: undefined });

  const header = procedural ? [
    `You are the creative director preparing the CAST & SETS check-in for a PROCEDURAL music video of "${project?.name || 'Untitled'}": its characters and environments are authored in code (SVG, Three.js or canvas), not filmed or photographed.`,
    'Read the lyrics as a story. Interpret the song: its references, themes and subtext. The world of the video (who the protagonist is, where it happens, what the sets are) must come from that interpretation.',
    'Design the protagonist as a reusable construction: parts, shape language, materials, a fixed palette, a few named expressions and motion rules that every scene will reuse. Design the world as layered environments with a camera and transition language.',
    'The mood board is reference for LOOK, LIGHTING, COLOR and TEXTURE only. Never copy its literal locations, rooms or props into the sets.',
    MOOD_BOARD_TEXT_ONLY,
  ].join('\n') : [
    `You are the creative director preparing the CAST & SETS check-in for a music video of "${project?.name || 'Untitled'}".`,
    'Read the lyrics as a story. Interpret the song: its references, themes and subtext, including any real events, ideas or cultural touchstones the words point at. The world of the video (who the protagonist is, where it happens, what the sets are) must come from that interpretation.',
    'The mood board is reference for LOOK, LIGHTING, COLOR and TEXTURE only. Never copy its literal locations, rooms or props into the sets: a kitchen photo on the board does not put the video in a kitchen.',
    MOOD_BOARD_TEXT_ONLY,
  ].join('\n');

  const facts = [
    `Duration: ${fmtTime(analysis.durationSec)}${analysis.bpm ? ` · ${Math.round(analysis.bpm)} BPM` : ''}`,
    concept.prompt && `Concept: ${trimTo(concept.prompt, 2000)}`,
    visualStyle && `Director's visual style: ${visualStyle}`,
    guidance && `Director guidance: ${guidance}`,
    bible && bible,
  ].filter(Boolean).join('\n');

  // A loaded character style fixes who the protagonist is; the song still
  // decides the world, the sets and which looks she wears.
  const characterStyle = concept.characterStyle ? [
    'CHARACTER STYLE (fixed): the protagonist is the character below. Use her name, write face, hair and signature from her identity text, and keep every rule and never-list item.',
    'Choose looks from the wardrobe options or design new ones in the same spirit for this song\'s world.',
    concept.characterStyle,
  ].join('\n') : '';

  const board_ = [
    boardStyle && `Mood board composed style: ${boardStyle}`,
    boardNegative && `Mood board avoid: ${boardNegative}`,
    moodLines.length ? `Mood board images (index. caption — per-image analysis):\n${moodLines.join('\n')}` : 'No mood board images.',
  ].filter(Boolean).join('\n');

  const proceduralRules = [
    `- ${CAST_SETS_LIMITS.sets.min}–${CAST_SETS_LIMITS.sets.max} sets; looks are optional palette or costume variants (at most ${CAST_SETS_LIMITS.looks.max}).`,
    '- Never describe photographic people: no skin, pores, realistic hair, wardrobe photography or singing close-ups. A human or photo cutout is allowed ONLY as a set whose imageRole is "cutout", and only when the director guidance asks for one.',
    '- imageRole says what each planned image is FOR: "background" (a full-bleed environment layer), "texture" (a seamless surface), "decoration" (an isolated ornament) or "cutout" (an isolated subject to composite). Default to "background".',
    '- Give every set ONE dominant light color or quality so a cut tells the viewer where we are.',
    LOOK_AND_SET_RULES,
    '- songMap: one entry per song section index listed above, naming the set that section plays in.',
    `- definitions: one reusable code definition per recurring character (at most ${CAST_SETS_DEFINITION_LIMITS.characters}). Draw it in a 200×200 box (origin top-left, y down) from at most ${CAST_SETS_DEFINITION_LIMITS.parts} simple parts; fills and strokes name a palette entry or a #hex. Expressions and poses are per-part overrides of the base parts; motion rules say what moves, by how much, over how many beats. Keep the definition consistent with the prose above.`,
    '- questions: up to three things you need the director to decide.',
  ].join('\n');
  const photographicRules = [
    `- ${CAST_SETS_LIMITS.looks.min}–${CAST_SETS_LIMITS.looks.max} looks, ${CAST_SETS_LIMITS.sets.min}–${CAST_SETS_LIMITS.sets.max} sets, ${CAST_SETS_LIMITS.tests.min}–${CAST_SETS_LIMITS.tests.max} tests.`,
    '- Give every set ONE dominant light color or quality so a cut tells the viewer where we are.',
    LOOK_AND_SET_RULES,
    '- songMap: one entry per song section index listed above, naming the set that section plays in.',
    '- tests: in-set frames of the protagonist that prove the cast works in the world; each names a set id and a look name.',
    '- Wet or revealing looks use opaque fabric so the video stays safe to post.',
    '- questions: up to three things you need the director to decide.',
  ].join('\n');
  const rules = procedural ? proceduralRules : photographicRules;

  // The director's standing sheet feedback: every direction call honors it,
  // a fresh rebuild included, and it rewrites the look line every image
  // prompt carries (`look` in the answer) instead of being pasted onto prompts.
  const standing = (Array.isArray(feedback) ? feedback : []).map((f) => trimTo(f?.text, FEEDBACK_TEXT)).filter(Boolean);
  const standingBlock = standing.length ? [
    'DIRECTOR FEEDBACK ON EARLIER SHEETS (always honor it; where it disagrees with the mood board or visual style, the feedback wins):',
    ...standing.map((t) => `- ${t}`),
    'Carry it into every field it touches (each set\'s description and lighting, the looks, the protagonist), and write "look": one line, under 400 characters, of the look every image prompt carries (film stock, light quality and sources, grain, color), rewritten so it agrees with this feedback.',
  ].join('\n') : '';

  const revision = previous ? [
    'This is a REVISION. The current direction is:',
    JSON.stringify(previous),
    notes.length ? `Director notes to address:\n${notes.map((n) => `- ${n.target ? `[${n.target}] ` : ''}${n.text}`).join('\n')}` : 'No notes: refine it.',
    'Return the FULL revised JSON object. Change only what the notes ask for and keep every other field exactly as it is.',
  ].join('\n') : '';

  return [
    header,
    facts,
    characterStyle,
    songStyle,
    `Lyrics (section headers and delivery directions in brackets):\n${lyrics || '(instrumental — no lyrics)'}`,
    sectionLines.length ? `Song sections (index. label start–end):\n${sectionLines.join('\n')}` : 'The song has not been sectioned.',
    board_,
    rules,
    standingBlock,
    revision,
    `Respond with ONLY one JSON object in this shape (replace every <…> with real content; do NOT output the angle-bracket text), no other text:\n${withLookField(procedural ? PROCEDURAL_OUTPUT_SHAPE : OUTPUT_SHAPE, standing.length > 0)}`,
  ].filter(Boolean).join('\n\n');
}

const FEEDBACK_TEXT = 2000;
// Every direction writes its own look line (palette, light, grain, texture);
// with standing feedback it must also agree with that feedback.
const LOOK_FIELD = '"look": "<one line of photographic look: palette, light quality, film stock, grain, texture; no people, places, objects or poses>"';
const withLookField = (shape, wanted) => (wanted
  ? shape.replace(LOOK_FIELD, '"look": "<one line: film stock, light quality and sources, grain, color, agreeing with the director feedback; no people, places, objects or poses>"')
  : shape);

// ---- parsing ----------------------------------------------------------------

const isPlaceholder = (s) => typeof s === 'string' && /^\s*<.+>\s*$/.test(s);
const text = (max) => z.string().transform((s) => (isPlaceholder(s) ? '' : s.trim().slice(0, max)));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
// Prose fields a model sometimes answers in structure (a palette as {"primary":"#fff"} or a
// list of hexes), as null when it has nothing to say, or as a bare boolean. Flatten those to
// text rather than letting one sub-field reject the whole protagonist or world, which reads
// as "missing" and fails the stage. Empty and null parts are dropped from the flattened text.
const flatten = (v) => (v == null ? ''
  : Array.isArray(v) ? v.map(flatten).filter(Boolean).join(', ')
  : typeof v === 'object' ? Object.entries(v).map(([k, x]) => [k, flatten(x)]).filter(([, x]) => x).map(([k, x]) => `${k}: ${x}`).join(', ')
  : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v);
const prose = (max) => z.preprocess(flatten, text(max));
// A list field answered as one string instead of an array of strings.
const proseList = (max) => z.preprocess((v) => (v == null ? [] : Array.isArray(v) ? v : [v]), z.array(prose(max)).transform((items) => items.filter(Boolean)));
// A null field means "nothing to change" (models write it when told to keep the rest), so it
// reads as absent and a revision keeps the current value; an empty string or list clears.
const withoutNulls = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x != null)) : v);

const protagonistSchema = z.preprocess(withoutNulls, z.object({
  name: prose(SHORT).optional(),
  description: prose(TEXT).optional(),
  face: prose(TEXT).optional(),
  hair: prose(TEXT).optional(),
  signature: prose(TEXT).optional(),
  gesture: prose(TEXT).optional(),
  rules: proseList(300).optional(),
  // Procedural medium: how the character is built and moves in code.
  construction: prose(TEXT).optional(),
  shapeLanguage: prose(500).optional(),
  materials: prose(500).optional(),
  palette: prose(300).optional(),
  movement: prose(TEXT).optional(),
  expressions: proseList(300).optional(),
}).passthrough());
const worldSchema = z.preprocess(withoutNulls, z.object({
  layout: prose(TEXT).optional(),
  depth: prose(500).optional(),
  lighting: prose(500).optional(),
  camera: prose(500).optional(),
  transitions: prose(500).optional(),
}).passthrough());
// Unusable definitions (not an object, or no character survives validation) count as
// absent so the merge keeps the current ones; `{ characters: [] }` is a deliberate clear.
const definitionsSchema = z.unknown().transform((value, ctx) => {
  const normalized = normalizeDefinitions(value);
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: 'no usable character definitions' });
    return z.NEVER;
  }
  return normalized;
});
const lookSchema = z.object({ name: text(SHORT), description: text(TEXT), chapters: text(300).optional() }).passthrough();
const setSchema = z.object({
  id: z.string().optional(),
  name: text(SHORT),
  description: text(TEXT),
  lighting: text(300).optional(),
  imageRole: z.string().optional(),
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
  look: text(500),
  logline: text(TEXT),
  interpretation: text(2000),
  protagonist: protagonistSchema,
  world: worldSchema,
  definitions: definitionsSchema,
  looks: z.array(lookSchema),
  sets: z.array(setSchema),
  songMap: z.array(songMapSchema),
  tests: z.array(testSchema),
  overlayConcept: overlaySchema,
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

const normalizeRole = (role) => {
  const r = String(role || '').trim().toLowerCase();
  return CAST_SETS_IMAGE_ROLES.includes(r) ? r : 'background';
};

function normalizeSets(sets, sections, procedural = false) {
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
      ...(procedural ? { imageRole: normalizeRole(s.imageRole) } : {}),
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
export function mergeCastAndSetsDirection(previous, parsed, { sections = [], medium = null } = {}) {
  const base = previous || {};
  const procedural = (medium || base.medium) === 'procedural';
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
    ...(procedural ? {
      construction: pField('construction'),
      shapeLanguage: pField('shapeLanguage'),
      materials: pField('materials'),
      palette: pField('palette'),
      movement: pField('movement'),
      expressions: (hasOwn(p1, 'expressions') ? p1.expressions : (p0.expressions || [])).filter(Boolean).slice(0, CAST_SETS_LIMITS.expressions),
    } : {}),
  };
  const w0 = base.world || {};
  const w1 = hasOwn(parsed, 'world') ? parsed.world : {};
  const wField = (key) => (hasOwn(w1, key) ? w1[key] : (w0[key] ?? ''));
  const world = { layout: wField('layout'), depth: wField('depth'), lighting: wField('lighting'), camera: wField('camera'), transitions: wField('transitions') };
  const looks = (pick('looks', [])).filter((l) => l.name && l.description).slice(0, CAST_SETS_LIMITS.looks.max)
    .map((l) => ({ name: l.name, description: l.description, chapters: l.chapters || '' }));
  const sets = hasOwn(parsed, 'sets') ? normalizeSets(parsed.sets, sections, procedural) : (base.sets || []);
  const songMap = normalizeSongMap(pick('songMap', []), sets, sections);
  const tests = normalizeTests(pick('tests', []), sets, looks);
  const overlayRaw = pick('overlayConcept', { summary: '', elements: [] }) || {};
  const overlayConcept = {
    summary: overlayRaw.summary || '',
    elements: (overlayRaw.elements || []).filter((e) => e.name && e.description).slice(0, CAST_SETS_LIMITS.overlayElements)
      .map((e) => ({ name: e.name, description: e.description })),
  };
  const definitions = hasOwn(parsed, 'definitions') ? parsed.definitions : (base.definitions || { characters: [] });
  const direction = {
    ...(procedural ? { medium: 'procedural', world, definitions } : {}),
    logline: pick('logline', ''),
    interpretation: pick('interpretation', ''),
    look: pick('look', ''),
    protagonist,
    looks,
    sets,
    songMap,
    tests,
    overlayConcept,
    questions: (pick('questions', [])).filter(Boolean).slice(0, CAST_SETS_LIMITS.questions),
  };
  const missing = [
    !direction.logline && 'logline',
    !(protagonist.name && (protagonist.face || protagonist.description || protagonist.construction)) && 'protagonist',
    !procedural && looks.length < CAST_SETS_LIMITS.looks.min && 'looks',
    sets.length < CAST_SETS_LIMITS.sets.min && 'sets',
  ].filter(Boolean);
  return { direction, missing };
}

// ---- director edits -----------------------------------------------------------

// The procedural fields the director can edit directly, with the caps the
// provider answer is held to.
export const CAST_SETS_EDITABLE_PROTAGONIST = Object.freeze({ construction: TEXT, shapeLanguage: 500, materials: 500, palette: 300, movement: TEXT });
export const CAST_SETS_EDITABLE_WORLD = Object.freeze({ layout: TEXT, depth: 500, lighting: 500, camera: 500, transitions: 500 });

const pickText = (source, caps) => Object.fromEntries(
  Object.entries(caps).filter(([key]) => typeof source?.[key] === 'string').map(([key, max]) => [key, source[key].trim().slice(0, max)]),
);

/**
 * Apply the director's direct edits to a procedural direction. `edits` is
 * `{ protagonist?, world?, sets? }`: a text field that is present replaces the
 * current value (an empty string clears it), one that is absent keeps it;
 * `protagonist.expressions` replaces the whole list; `sets` is
 * `[{ id, imageRole }]`. The result goes through the same merge + normalize as
 * a provider answer, so it can never be shaped differently from one. Returns
 * `{ direction, changed }` (`changed` names the fields that actually changed, for
 * the revision record); throws 409 for a photographic direction and 422 for an
 * unknown set or an edit that would leave the direction unusable.
 */
export function applyCastAndSetsDirectionEdits(previous, edits, { sections = [] } = {}) {
  if (previous?.medium !== 'procedural') {
    throw new ServerError('Only a procedural direction has editable construction and world rules', { status: 409, code: 'CAST_SETS_NOT_PROCEDURAL' });
  }
  const parsed = {};
  if (edits?.protagonist) {
    const protagonist = pickText(edits.protagonist, CAST_SETS_EDITABLE_PROTAGONIST);
    if (Array.isArray(edits.protagonist.expressions)) {
      protagonist.expressions = edits.protagonist.expressions.map((x) => String(x).trim().slice(0, 300)).filter(Boolean);
    }
    parsed.protagonist = protagonist;
  }
  if (edits?.world) {
    parsed.world = pickText(edits.world, CAST_SETS_EDITABLE_WORLD);
  }
  if (Array.isArray(edits?.sets) && edits.sets.length) {
    const roles = new Map(edits.sets.map((s) => [s.id, s.imageRole]));
    const unknown = [...roles.keys()].filter((id) => !(previous.sets || []).some((s) => s.id === id));
    if (unknown.length) throw new ServerError(`Unknown set: ${unknown.join(', ')}`, { status: 422, code: 'CAST_SETS_UNKNOWN_SET' });
    parsed.sets = previous.sets.map((s) => (roles.has(s.id) ? { ...s, imageRole: roles.get(s.id) } : s));
  }
  const { direction, missing } = mergeCastAndSetsDirection(previous, parsed, { sections, medium: 'procedural' });
  if (missing.length) throw new ServerError(`That edit would leave the direction without: ${missing.join(', ')}`, { status: 422, code: 'CAST_SETS_EDIT_INVALID' });
  const differs = (a, b) => JSON.stringify(a ?? '') !== JSON.stringify(b ?? '');
  const changed = [
    ...Object.keys(CAST_SETS_EDITABLE_PROTAGONIST).filter((key) => differs(previous.protagonist?.[key], direction.protagonist[key])),
    ...(differs(previous.protagonist?.expressions, direction.protagonist.expressions) ? ['expressions'] : []),
    ...Object.keys(CAST_SETS_EDITABLE_WORLD).filter((key) => differs(previous.world?.[key], direction.world[key])).map((key) => `world ${key}`),
    ...direction.sets.filter((set) => differs(previous.sets.find((s) => s.id === set.id)?.imageRole, set.imageRole)).map((set) => `${set.name} image role`),
  ];
  return { direction: { ...direction, look: previous.look || '' }, changed };
}

// ---- what a revision changed -------------------------------------------------

const MAX_CHANGE_LINES = 8;
const nameList = (names) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));

/**
 * A short, plain-language list of what a revised direction changed, for the
 * director to read after feedback is applied: the look line, the protagonist,
 * the wardrobe, and per-set lighting/description. Empty when nothing the
 * images are built from changed.
 */
export function describeDirectionChanges(previous, next) {
  if (!previous || !next) return [];
  const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
  const out = [];
  if (!same(previous.look, next.look)) out.push('Look rewritten for every image');
  const p0 = previous.protagonist || {};
  const p1 = next.protagonist || {};
  const protagonistFields = Object.keys({ ...p0, ...p1 }).filter((k) => !same(p0[k], p1[k]));
  if (protagonistFields.length) out.push(`Protagonist: ${nameList(protagonistFields)}`);
  if (!same(previous.looks, next.looks)) out.push('Wardrobe looks revised');
  if (!same(previous.world?.lighting, next.world?.lighting)) out.push('World lighting revised');
  const before = new Map((previous.sets || []).map((s) => [s.id, s]));
  const lit = [];
  const described = [];
  for (const set of next.sets || []) {
    const old = before.get(set.id);
    if (!old) continue;
    if (!same(old.lighting, set.lighting)) lit.push(set.name);
    if (!same(old.description, set.description)) described.push(set.name);
  }
  if (lit.length) out.push(`Lighting: ${nameList(lit)}`);
  if (described.length) out.push(`Set descriptions: ${nameList(described)}`);
  const added = (next.sets || []).filter((s) => !before.has(s.id)).map((s) => s.name);
  const removed = (previous.sets || []).filter((s) => !(next.sets || []).some((n) => n.id === s.id)).map((s) => s.name);
  if (added.length) out.push(`New sets: ${nameList(added)}`);
  if (removed.length) out.push(`Sets dropped: ${nameList(removed)}`);
  return out.slice(0, MAX_CHANGE_LINES);
}
