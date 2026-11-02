import { musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';
/**
 * Music Video — Cast & Sets creative direction (pure): the LLM prompt, the
 * response parser and the absent-vs-empty merge.
 *
 * Before any image is made, one provider call reads the song as a story and
 * returns the production's cast and world: a logline, one protagonist (face,
 * hair, signature prop, a recurring gesture tied to a lyric hook, continuity
 * rules), 1–4 wardrobe looks mapped to chapters, every catalog-linked supporting
 * character the director cast plus up to 4 more the model invents (photographic
 * only), 3–8 sets (one dominant light
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
 * The director's own story ("Story in your own words") and the art-direction
 * guides they wrote lead the direction: the world, the cast and their names
 * come from the story, and the lyrics color it. A photographic protagonist
 * also gets the story's own `expressions` (the moods the expression sheet
 * shows; never singing unless the video lip-syncs) and `forms`, one per other
 * age the story shows them at, each rendered as its own reference sheet.
 *
 * A regeneration sends the current direction plus the director's notes and
 * asks for the full revised object. The merge follows the repo's LLM rule:
 * a key the model left out keeps the current value; a key present with an
 * empty value is an intentional clear (for the optional fields that allow it).
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import { ServerError } from '../../lib/errorHandler.js';
import { extractJson } from '../../lib/jsonExtract.js';
import { musicVideoCreativeContext, musicVideoSongStyleContext, withoutPeople } from '../../lib/musicVideoCreativeContext.js';
import { isOutsideMusicVideoReference } from '../../lib/musicVideoConditioning.js';
import { musicVideoBriefTools as briefTools } from '../../lib/musicVideoMediumPlan.js';
import { trimTo } from '../../lib/textUtils.js';
import { moodBoardItemCaption } from '../../lib/moodBoardStyleContext.js';
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
  // Supporting cast the model invents. Catalog-linked supporting characters the
  // director cast (fixedSupportingCast) never count against it: each one keeps
  // its sheet, bounded only by the project's own subject cap.
  cast: 4,
  // Recurring objects (cameras, instruments, vehicles, signature items) on one prop sheet.
  props: 6,
  fixedCast: 24,
  forms: 3,
});
export const CAST_SETS_IMAGE_ROLES = Object.freeze(['background', 'texture', 'decoration', 'cutout']);
const TEXT = 1000;
const SHORT = 120;
const HEIGHT = 80;
const LYRICS_MAX = 6000;
const MOOD_ITEMS_MAX = 40;
const MOOD_ITEM_TEXT = 280;

// ---- medium ------------------------------------------------------------------

/**
 * The medium the check-in is directed in. A code-first production policy with
 * no generated footage, or a brief that selected code tools and no video tool,
 * is procedural; everything else (an image-only brief included) stays
 * photographic, so footage always has a character sheet to hold identity.
 * Tools and policy are read together because either can be saved without the other.
 */
export function castAndSetsMedium(project) {
  if (!musicVideoAllowsMedia(project, 'image')) return 'procedural';
  const policy = project?.productionPolicy;
  if (policy?.strategy === 'code-first' && !(policy.maxGeneratedVideoPercent > 0 && musicVideoAllowsMedia(project, 'video'))) return 'procedural';
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
export function lyricSheetText(project) {
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
      caption: trimTo(moodBoardItemCaption(item), MOOD_ITEM_TEXT),
      analysis: trimTo(item.analysis?.prompt, MOOD_ITEM_TEXT),
    });
    if (out.length >= MOOD_ITEMS_MAX) break;
  }
  return out;
}

export const CAST_SETS_SUBJECT_PREFIX = 'cs-';
const CATALOG_TYPE_PREFIX = { character: 'chr', place: 'plc', object: 'obj' };

/**
 * The catalog record a music video subject is saved to (catalogCast.js):
 * deterministic per (project, subject), like the universe canon promotion, so
 * two machines saving the same synced video converge on one row.
 */
export function musicVideoCastIngredientId(projectId, subject) {
  const seed = `music-video:${projectId}:${subject.kind}:${subject.id}`;
  return `cat-${CATALOG_TYPE_PREFIX[subject.kind]}-mv-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

// The first number in a free-text age ("17", "about 60"), or null.
export const leadingAge = (value) => {
  const match = String(value ?? '').match(/\d{1,3}/);
  return match ? Number(match[0]) : null;
};

// "Nora (17)" → { base: 'Nora', qualifier: '17' }: a subject named for one age
// or look of a cast member. "Nora, 17" is read the same way; only a trailing
// number follows a comma.
export function subjectNameParts(name) {
  const text = String(name || '').trim();
  const match = text.match(/^(.*?)\s*[([]\s*([^)\]]*?)\s*[)\]]\s*$/) || text.match(/^(.*?)\s*,\s*(\d{1,3})$/);
  return match && match[1] ? { base: match[1].trim(), qualifier: match[2] } : { base: text, qualifier: '' };
}

/**
 * Catalog-linked cast and places the director chose in Creative setup: fixed
 * casting the check-in keeps instead of redesigning. Each carries the image
 * the Look step pulled for it (a reference labelled with its name), which
 * conditions its sheet or plate when its catalog record has no images
 * (castAndSetsCatalogLikeness.js). Cast & Sets' own earlier subjects saved to
 * their own catalog record are left out, so a regenerate can still redesign
 * them; one the director re-linked to another Casting record is fixed.
 */
export function fixedCasting(project) {
  const refs = project?.visualSpec?.references || [];
  return (project?.concept?.subjects || [])
    .filter((s) => s?.ingredientId && s.name && (s.kind === 'character' || s.kind === 'place')
      && !(String(s.id || '').startsWith(CAST_SETS_SUBJECT_PREFIX) && s.ingredientId === musicVideoCastIngredientId(project.id, s)))
    .map((s) => {
      const role = s.kind === 'place' ? 'set' : 'character';
      const name = s.name.trim().toLowerCase();
      const ref = refs.find((r) => r?.imageId && r.role === role && String(r.label || '').trim().toLowerCase() === name
        && !isOutsideMusicVideoReference(r));
      return {
        id: s.id, kind: s.kind, name: s.name.trim(), role: s.role || null, description: s.description || '',
        ...(s.castForm?.label ? { castForm: s.castForm.label } : {}), imageId: ref?.imageId || null,
        ingredientId: s.ingredientId, castFormId: s.castForm?.id || null,
      };
    });
}

/**
 * The project subjects a protagonist form may be bound to (`form.subjectId`):
 * the fixed-casting characters, so a form is only ever grounded on a catalog
 * record the director chose, never on an identity read out of free text.
 */
export const formSubjects = (project) => fixedCasting(project).filter((f) => f.kind === 'character');

/**
 * The fixed-casting characters that must each appear in `direction.cast`: every
 * catalog-linked character except the protagonist, and except an age form of
 * the protagonist's own catalog record (that one belongs in protagonist.forms).
 */
export function fixedSupportingCast(project) {
  const subjects = project?.concept?.subjects || [];
  const leadRecords = new Set(subjects.filter((s) => s?.role === 'protagonist' && s.ingredientId).map((s) => s.ingredientId));
  const recordOf = new Map(subjects.map((s) => [s?.id, s?.ingredientId]));
  return formSubjects(project)
    .filter((f) => f.role !== 'protagonist' && !leadRecords.has(recordOf.get(f.id)))
    .slice(0, CAST_SETS_LIMITS.fixedCast);
}

/**
 * The catalog objects the director linked (subjects of kind 'object'): the
 * direction keeps each as a prop under its own name and description.
 */
export function fixedProps(project) {
  return (project?.concept?.subjects || [])
    .filter((s) => s?.kind === 'object' && s.name && !String(s.id || '').startsWith(CAST_SETS_SUBJECT_PREFIX))
    .map((s) => ({ id: s.id, name: s.name.trim(), description: s.description || '' }))
    .slice(0, CAST_SETS_LIMITS.props);
}

function fixedPropsBlock(project) {
  const fixed = fixedProps(project);
  if (!fixed.length) return '';
  return [
    'FIXED PROPS (catalog objects the director chose; keep each in "props" under its own name and description):',
    ...fixed.map((p) => `- ${trimTo(p.name, 120)}${p.description ? ` — ${trimTo(p.description, 500)}` : ''}`),
  ].join('\n');
}

function fixedCastingBlock(project) {
  const fixed = fixedCasting(project);
  if (!fixed.length) return '';
  return [
    'FIXED CASTING (catalog records the director chose; keep them):',
    ...fixed.map((f) => `- ${f.kind}${f.role === 'protagonist' ? ' (protagonist)' : ''}: ${trimTo(f.name, 120)}${f.description ? ` — ${trimTo(f.description, 500)}` : ''}${f.kind === 'character' ? ` [subject id: ${f.id}${f.castForm ? `, shown as: ${trimTo(f.castForm, 80)}` : ''}]` : ''}`),
    'Use each one as given: the same name, and its description for face, hair and wardrobe, or for the empty location. A character marked protagonist is the protagonist unless a character style above fixes it; other characters go in "cast"; places become sets. Design only what this list leaves missing.',
  ].join('\n');
}

const OUTPUT_SHAPE = `{
  "logline": "<one or two sentences: who, where, what happens>",
  "interpretation": "<how the song's references and themes shape this world>",
  "look": "<one line of photographic look: palette, light quality, film stock, grain, texture; no people, places, objects or poses>",
  "protagonist": {
    "name": "<a name or designation>",
    "description": "<who they are in the song: age, vibe, attitude>",
    "height": "<their height at their present-story age, e.g. 5 ft 6 in (168 cm)>",
    "face": "<face: skin, eyes, brows, distinguishing features>",
    "hair": "<hair that reads in silhouette>",
    "signature": "<one signature prop or detail present in every look>",
    "gesture": "<a recurring gesture tied to a lyric hook, quoting the hook>",
    "rules": ["<continuity or safety rule>"],
    "expressions": ["<a mood from the story: what the face, eyes and head do>"],
    "forms": [{ "id": "<short-slug>", "label": "<e.g. Age 7>", "age": "<age>", "description": "<how they look at that age>", "hair": "<hair at that age>", "wardrobe": "<their outfit at that age>", "height": "<their height at that age, e.g. 4 ft (122 cm) at 7>", "era": "<the year or period this age is seen in, e.g. 1965>", "look": "<the film stock, format and color of that memory when it differs from the main look, e.g. black-and-white 8mm home movie, heavy grain; or empty>", "subjectId": "<the FIXED CASTING subject id of the protagonist at this age, or empty>" }]
  },
  "looks": [{ "name": "<SHORT NAME>", "description": "<the complete outfit>", "chapters": "<which parts of the song>" }],
  "cast": [{ "id": "<short-slug>", "name": "<a name>", "role": "<what they are in the video: drummer, shopkeeper, ...>", "description": "<who they are: age, vibe, attitude>", "height": "<their height, e.g. 5 ft 10 in (178 cm)>", "face": "<face: skin, eyes, brows, distinguishing features>", "hair": "<hair>", "wardrobe": "<their one outfit>" }],
  "props": [{ "id": "<short-slug>", "name": "<what it is and whose, e.g. Renee's camera>", "owner": "<who carries, uses or rides it, or empty>", "description": "<exactly how it looks: type, era, shape, size, colors, materials and distinguishing marks; no brand names or text>" }],
  "sets": [{ "id": "<short-slug>", "name": "<set name>", "description": "<the empty location, concrete and visual, with nobody in it; furniture and objects standing upright and apart, never stacked, interlocked or piled>", "lighting": "<its one dominant light>", "era": "<the year or period it is seen in when that is not the present story, or empty>", "look": "<the film stock, format and color of that era when it differs from the main look, or empty>", "sections": ["<section label it serves>"] }],
  "songMap": [{ "section": 0, "setId": "<short-slug>" }],
  "tests": [{ "setId": "<short-slug>", "look": "<SHORT NAME>", "action": "<what the protagonist does in this frame>", "caption": "<the lyric or beat it serves>", "formId": "<the protagonist.forms id when this frame shows them at that other age, or empty>" }],
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

const STORY_MAX = 8000;
const GUIDE_MAX = 3000;
const GUIDE_LABELS = { cast: 'Cast guide', environments: 'Environment guide', visualLanguage: 'Visual language and mood board' };

/** True when a planned shot already lip-syncs (a performance that is not music-driven motion). */
export const musicVideoLipSyncs = (project) => (project?.scenes || [])
  .some((scene) => scene?.shotMode === 'performance' && scene.performanceStyle !== 'music');

/**
 * The director's story and the art-direction guides they wrote, as the
 * direction reads them. `guides` is `{ cast?, environments?, visualLanguage? }`
 * (productionReview.directorArtGuides), never a guide the sheet itself seeded.
 */
function storyBlock(project, guides = {}) {
  const story = trimTo(project?.storySummary, STORY_MAX);
  const written = Object.entries(GUIDE_LABELS).filter(([key]) => guides?.[key]).map(([key, label]) => `${label}:\n${trimTo(guides[key], GUIDE_MAX)}`);
  if (!story && !written.length) return '';
  return [
    story && `THE DIRECTOR'S STORY (their own words; the video tells THIS story, and the lyrics color it):\n${story}`,
    written.length && `THE DIRECTOR'S ART DIRECTION GUIDES (follow them; they win over your own reading of the song):\n${written.join('\n\n')}`,
    'Take the protagonist, supporting cast, places and their names from the story and the subjects listed above. Every place the story happens in that the camera returns to becomes a set; design only what the story leaves out.',
  ].filter(Boolean).join('\n\n');
}

/**
 * Build the direction prompt. `context` is `{ board, moodImages, track }`
 * (all optional). With `previous` + `notes` it becomes a revision request.
 * `medium` defaults to the previous direction's, else the project's.
 * `guides` are the director's own art-direction guides (see storyBlock).
 */
export function buildCastAndSetsPrompt(project, { moodImages = [], board = null, track = null, previous = null, notes = [], medium = null, feedback = [], guides = {} } = {}) {
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
    '- looks: each is a different complete outfit the protagonist wears at their present-story age. An outfit from another age goes in that age\'s protagonist.forms wardrobe, never in looks.',
    '- sets in another era: a place the story shows in a memory or another period gets that era and, when the story gives the era its own film stock or color, that look; the same place in two eras is two sets. Present-story sets leave both empty.',
    '- tests: in-set frames of the protagonist that prove the cast works in the world; each names a set id and a look name, and shows a moment from the story. A test showing the protagonist at one of their other ages names that form\'s id in formId; otherwise formId is empty.',
    `- protagonist.expressions: 4–6 moods the protagonist actually shows in THIS story, each "<mood>: <what the face, eyes and head do>" (e.g. "grief held in: eyes closed, head bowed"). They become the expression sheet. ${musicVideoLipSyncs(project)
    ? 'Some shots lip-sync, so one may be singing.'
    : 'Nobody sings or mouths the words on camera in this video: no singing, open-mouthed or straight-to-lens performance expressions.'}`,
    `- protagonist.forms: when the story shows the protagonist at OTHER ages (a childhood memory, a teenage flashback), one entry per other age, at most ${CAST_SETS_LIMITS.forms}: its age, a short label ("Age 7"), how they look then, their height then (a child is far shorter than an adult: about 4 ft at 7), their hair, their outfit, the era (year or period) that age is seen in, and that memory's own film stock, format and color in look when the story gives each era its own (empty when it shares the main look). The other protagonist fields describe them at their present-story age. When FIXED CASTING lists a character who is the protagonist at that age, put its subject id in subjectId; otherwise subjectId is empty. [] when they appear at one age only.`,
    `- cast: the RECURRING supporting characters besides the protagonist that the song, concept or guidance calls for (band members, someone who returns across scenes)${fixedSupportingCast(project).length
    ? `: every character FIXED CASTING lists that is not the protagonist or one of their other ages, each as its own entry under its own name, plus at most ${CAST_SETS_LIMITS.cast} more`
    : `, at most ${CAST_SETS_LIMITS.cast}; [] when the protagonist is alone`}. Each gets their own photographic character sheet. Shots that name a cast member by name or role are conditioned on that sheet, so give each a distinct name and a plain role word.`,
    `- props: EVERY object a character carries, holds, uses or rides in more than one shot (cameras, phones, instruments, bikes, cars, a signature item), at most ${CAST_SETS_LIMITS.props}. Leave none out: a prop the concept, lyrics or guidance mentions must be here. Describe each exactly enough to draw the same object every time (type, era, shape, colors, materials, wear, distinguishing marks), with no brand names or text. Two characters with the same kind of object get one entry each when theirs differ, or one entry naming both owners when they are identical. They render on one prop sheet that every shot showing a prop is conditioned on; [] only when nobody uses one.`,
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
    fixedCastingBlock(project),
    procedural ? '' : fixedPropsBlock(project),
    storyBlock(project, guides),
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

// One other age of the protagonist (a childhood or teenage form).
const formSchema = z.preprocess(withoutNulls, z.object({
  id: z.string().optional(),
  label: prose(SHORT).optional(),
  age: prose(40).optional(),
  description: prose(TEXT).optional(),
  hair: prose(TEXT).optional(),
  wardrobe: prose(TEXT).optional(),
  height: prose(HEIGHT).optional(),
  era: prose(SHORT).optional(),
  look: prose(500).optional(),
  subjectId: text(64).optional(),
}).passthrough());

const protagonistSchema = z.preprocess(withoutNulls, z.object({
  name: prose(SHORT).optional(),
  description: prose(TEXT).optional(),
  height: prose(HEIGHT).optional(),
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
  forms: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(formSchema)).optional(),
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
  era: text(SHORT).optional(),
  look: text(500).optional(),
  imageRole: z.string().optional(),
  sections: z.union([z.array(z.union([z.string(), z.number()])), z.string()]).optional(),
}).passthrough();
const songMapSchema = z.object({ section: z.union([z.number(), z.string()]), setId: z.string() }).passthrough();
const castSchema = z.preprocess(withoutNulls, z.object({
  id: z.string().optional(),
  name: prose(SHORT),
  role: prose(SHORT).optional(),
  description: prose(TEXT).optional(),
  height: prose(HEIGHT).optional(),
  face: prose(TEXT).optional(),
  hair: prose(TEXT).optional(),
  wardrobe: prose(TEXT).optional(),
}).passthrough());
const propSchema = z.preprocess(withoutNulls, z.object({
  id: z.string().optional(),
  name: prose(SHORT),
  owner: prose(SHORT).optional(),
  description: prose(TEXT),
}).passthrough());
const testSchema = z.object({ setId: z.string(), look: text(SHORT).optional(), action: text(TEXT), caption: text(300).optional(), formId: text(64).optional() }).passthrough();
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
  cast: z.array(castSchema),
  props: z.array(propSchema),
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
      // A memory set's period and film stock; present-story sets keep their legacy shape.
      ...(!procedural && s.era ? { era: s.era } : {}),
      ...(!procedural && s.look ? { look: s.look } : {}),
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

const castKey = (name) => String(name || '').trim().toLowerCase();

// Supporting cast: a named person with something to draw (face or description),
// unique slug ids, never the protagonist again. Each `fixed` subject (the
// director's catalog-linked supporting characters) is kept once by name beyond
// the invented-cast cap; one the answer left out (or left undrawable) is added
// from its catalog description, unless it is the protagonist or a bound age form.
// Identity here is the name on purpose: fixedCasting pulls each subject's image
// by reference label, sheets and shot conditioning match a cast member by name,
// and a fixed subject sharing the protagonist's name is the one the direction
// cast as the protagonist. Two same-named subjects are one person to all of them.
function normalizeCast(cast, protagonist, { fixed = [], forms = [] } = {}) {
  const seen = new Set();
  const lead = castKey(protagonist?.name);
  const fixedNames = new Set(fixed.map((f) => castKey(f.name)));
  // A fixed subject bound to a protagonist age form is that form, never also supporting cast.
  const bound = new Set(forms.map((f) => f.subjectId).filter(Boolean));
  const boundNames = new Set(fixed.filter((f) => bound.has(f.id)).map((f) => castKey(f.name)));
  const placed = new Set([lead, ...boundNames]);
  let invented = 0;
  const kept = cast.filter((c) => {
    const key = castKey(c.name);
    if (!key || !(c.face || c.description) || key === lead || boundNames.has(key)) return false;
    if (fixedNames.has(key)) {
      if (placed.has(key)) return false;
      placed.add(key);
      return true;
    }
    if (invented >= CAST_SETS_LIMITS.cast) return false;
    invented += 1;
    return true;
  });
  const added = fixed.filter((f) => {
    const key = castKey(f.name);
    if (placed.has(key)) return false;
    placed.add(key);
    return true;
  }).map((f) => ({ name: f.name, role: f.role === 'band' ? 'band member' : '', description: trimTo(f.description, TEXT) }));
  return [...kept, ...added].map((c, i) => {
    let id = slug(c.id) || slug(c.name) || `cast-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { id, name: c.name, role: c.role || '', description: c.description || '', face: c.face || '', hair: c.hair || '', wardrobe: c.wardrobe || '',
      ...(c.height ? { height: c.height } : {}) };
  });
}

// Recurring objects: described, unique slug ids, capped; the director's catalog
// objects (`fixed`) are added by name when the answer left one out.
function normalizeProps(props, { fixed = [] } = {}) {
  const seen = new Set();
  const kept = (Array.isArray(props) ? props : []).filter((p) => p && p.name && p.description);
  const named = new Set(kept.map((p) => String(p.name).trim().toLowerCase()));
  const added = fixed.filter((p) => p.description && !named.has(p.name.toLowerCase())).map((p) => ({ name: p.name, description: p.description }));
  return [...added, ...kept].slice(0, CAST_SETS_LIMITS.props).map((p, i) => {
    let id = slug(p.id) || slug(p.name) || `prop-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { id, name: p.name, owner: p.owner || '', description: p.description };
  });
}

// Other ages of the protagonist: a described form, unique slug ids, capped.
// `subjectId` (optional) binds the form to a fixed-casting subject's reference;
// a form listed without the key keeps the binding `previous` had for its id.
function normalizeForms(forms, previous = []) {
  const seen = new Set();
  return (Array.isArray(forms) ? forms : []).filter((f) => f && (f.label || f.age) && f.description)
    .slice(0, CAST_SETS_LIMITS.forms).map((f, i) => {
      let id = slug(f.id) || slug(f.label) || slug(f.age && `age-${f.age}`) || `form-${i + 1}`;
      while (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id);
      const prior = previous.find((p) => p?.id === id);
      const subjectId = String((hasOwn(f, 'subjectId') ? f.subjectId : prior?.subjectId) || '').trim().slice(0, 64);
      // The bound subject's name (stamped by the service), kept while the binding is.
      const subjectName = subjectId && String((subjectId === prior?.subjectId && prior?.subjectName) || f.subjectName || '').trim().slice(0, 120);
      return { id, label: f.label || `Age ${f.age}`, age: f.age || '', description: f.description, hair: f.hair || '', wardrobe: f.wardrobe || '',
        ...(f.height ? { height: f.height } : {}), ...(f.era ? { era: f.era } : {}), ...(f.look ? { look: f.look } : {}),
        ...(subjectId ? { subjectId } : {}), ...(subjectName ? { subjectName } : {}) };
    });
}

// A test naming a form shows the protagonist at that age; one naming a form the
// direction no longer has is dropped, never re-cast as the present-day protagonist.
function normalizeTests(tests, sets, looks, forms = []) {
  const setIds = new Set(sets.map((s) => s.id));
  const formIds = new Set(forms.map((f) => f.id));
  return tests
    .map((t) => ({ ...t, setId: slug(t.setId), formId: typeof t.formId === 'string' ? t.formId.trim() : '' }))
    .filter((t) => setIds.has(t.setId) && t.action && (!t.formId || formIds.has(t.formId)))
    .slice(0, CAST_SETS_LIMITS.tests.max)
    .map((t) => ({
      setId: t.setId,
      look: looks.find((l) => l.name.toLowerCase() === String(t.look || '').toLowerCase())?.name || looks[0]?.name || '',
      action: t.action,
      caption: t.caption || '',
      ...(t.formId ? { formId: t.formId } : {}),
    }));
}

/** The tests in `tests` whose form is not among `forms` (a 422 for a director edit). */
function testsWithMissingForm(tests, forms) {
  const formIds = new Set((forms || []).map((f) => f.id));
  return (tests || []).flatMap((t, i) => (t?.formId && !formIds.has(t.formId) ? [i + 1] : []));
}

/**
 * Merge a parsed (partial) answer onto the current direction and normalize
 * the result. Absent keys keep `previous`; present keys replace (an empty
 * string/array clears the optional text/list fields). `fixedCast` is the
 * project's fixedSupportingCast: each stays in the cast (see normalizeCast). Returns
 * `{ direction, missing }` — `missing` lists the required parts still absent,
 * so a first pass with an unusable answer can be refused.
 */
export function mergeCastAndSetsDirection(previous, parsed, { sections = [], medium = null, minSets = CAST_SETS_LIMITS.sets.min, fixedCast = [], fixedProps: fixedPropList = [] } = {}) {
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
  };
  // Optional so a protagonist without one keeps its legacy shape.
  if (!procedural && pField('height')) protagonist.height = pField('height');
  const expressions = (hasOwn(p1, 'expressions') ? p1.expressions : (p0.expressions || [])).filter(Boolean).slice(0, CAST_SETS_LIMITS.expressions);
  const forms = procedural ? [] : normalizeForms(hasOwn(p1, 'forms') ? p1.forms : p0.forms, p0.forms || []);
  // A photographic protagonist without moods or other ages keeps its legacy shape
  // (its seeded Cast guide still reads as the same content).
  if (procedural || expressions.length) protagonist.expressions = expressions;
  if (forms.length) protagonist.forms = forms;
  if (procedural) {
    Object.assign(protagonist, {
      construction: pField('construction'),
      shapeLanguage: pField('shapeLanguage'),
      materials: pField('materials'),
      palette: pField('palette'),
      movement: pField('movement'),
    });
  }
  const w0 = base.world || {};
  const w1 = hasOwn(parsed, 'world') ? parsed.world : {};
  const wField = (key) => (hasOwn(w1, key) ? w1[key] : (w0[key] ?? ''));
  const world = { layout: wField('layout'), depth: wField('depth'), lighting: wField('lighting'), camera: wField('camera'), transitions: wField('transitions') };
  const looks = (pick('looks', [])).filter((l) => l.name && l.description).slice(0, CAST_SETS_LIMITS.looks.max)
    .map((l) => ({ name: l.name, description: l.description, chapters: l.chapters || '' }));
  const sets = (hasOwn(parsed, 'sets') ? normalizeSets(parsed.sets, sections, procedural) : (base.sets || [])).map((set) => {
    const prior = base.sets?.find((s) => s.id === set.id);
    return prior?.setReference ? { ...set, setReference: prior.setReference } : set;
  });
  const songMap = normalizeSongMap(pick('songMap', []), sets, sections);
  const tests = normalizeTests(pick('tests', []), sets, looks, forms);
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
    // Photographic only: a procedural cast lives in `definitions`.
    ...(procedural ? {} : { cast: normalizeCast(pick('cast', []), protagonist, { fixed: fixedCast, forms }) }),
    // Photographic only; a direction saved before props existed keeps its shape.
    ...(!procedural && (hasOwn(parsed, 'props') || base.props || fixedPropList.length)
      ? { props: normalizeProps(pick('props', []), { fixed: fixedPropList }) } : {}),
    sets,
    songMap,
    tests,
    overlayConcept,
    questions: (pick('questions', [])).filter(Boolean).slice(0, CAST_SETS_LIMITS.questions),
    // The director edited the tests: plannedTests stops topping them up.
    ...(pick('testsFixed', false) ? { testsFixed: true } : {}),
  };
  const missing = [
    !direction.logline && 'logline',
    !(protagonist.name && (protagonist.face || protagonist.description || protagonist.construction)) && 'protagonist',
    !procedural && looks.length < CAST_SETS_LIMITS.looks.min && 'looks',
    sets.length < minSets && 'sets',
  ].filter(Boolean);
  return { direction, missing };
}

// ---- director edits -----------------------------------------------------------

// The fields the director can edit directly, with the caps the provider answer
// is held to. Procedural protagonists keep their construction fields; a
// photographic one its face, hair and signature.
export const CAST_SETS_EDITABLE_PROTAGONIST = Object.freeze({ construction: TEXT, shapeLanguage: 500, materials: 500, palette: 300, movement: TEXT });
export const CAST_SETS_EDITABLE_PHOTO_PROTAGONIST = Object.freeze({ name: SHORT, description: TEXT, height: HEIGHT, face: TEXT, hair: TEXT, signature: TEXT, gesture: TEXT });
export const CAST_SETS_EDITABLE_WORLD = Object.freeze({ layout: TEXT, depth: 500, lighting: 500, camera: 500, transitions: 500 });
const EDITABLE_CAST = Object.freeze({ name: SHORT, role: SHORT, description: TEXT, height: HEIGHT, face: TEXT, hair: TEXT, wardrobe: TEXT });
const EDITABLE_SET = Object.freeze({ name: SHORT, description: TEXT, lighting: 300, era: SHORT, look: 500 });
const EDITABLE_TEST = Object.freeze({ action: TEXT, caption: 300, look: SHORT });
// A test's form binding: a present `formId` replaces it (null or '' clears it).
const testFormPatch = (patch) => (hasOwn(patch, 'formId') ? { formId: patch.formId || '' } : {});

const pickText = (source, caps) => Object.fromEntries(
  Object.entries(caps).filter(([key]) => typeof source?.[key] === 'string').map(([key, max]) => [key, source[key].trim().slice(0, max)]),
);

const unknownItem = (what, ids) => new ServerError(`Unknown ${what}: ${ids.join(', ')}`, { status: 422, code: what === 'set' ? 'CAST_SETS_UNKNOWN_SET' : 'CAST_SETS_UNKNOWN_ITEM' });

/**
 * Apply per-item patches (`{ <key>, remove?, ...fields }`) to a list: a patch
 * with `remove` drops the item, any other replaces the text fields it names.
 * `keyOf(item, index)` names an item the way its patch does.
 */
function patchItems(list, patches, { what, keyOf, fields, extra = () => ({}) }) {
  const byKey = new Map(patches.map((p) => [String(p.key), p]));
  const known = new Set(list.map((item, i) => String(keyOf(item, i))));
  const unknown = [...byKey.keys()].filter((key) => !known.has(key));
  if (unknown.length) throw unknownItem(what, unknown);
  return list.flatMap((item, i) => {
    const patch = byKey.get(String(keyOf(item, i)));
    if (!patch) return [item];
    if (patch.remove) return [];
    return [{ ...item, ...pickText(patch, fields), ...extra(patch) }];
  });
}

/**
 * Apply the director's direct edits to a direction (either medium). `edits`:
 *   protagonist?: text fields (a present one replaces, '' clears, absent keeps),
 *                 `expressions` (the whole list), `forms` (the whole list, photographic);
 *   world?:       procedural world rules;
 *   looks?:       the whole wardrobe list;
 *   cast?:        `[{ id, remove?, name?, role?, description?, height?, face?, hair?, wardrobe? }]`;
 *   props?:       the whole prop list (`[{ id?, name, owner?, description }]`, photographic);
 *   sets?:        `[{ id, remove?, name?, description?, lighting?, era?, look?, imageRole? }]`, or
 *                 greybox selections only (`[{ id, setReference }]`, saved apart);
 *   tests?:       `[{ index (1-based), remove?, action?, caption?, look? }]` — an
 *                 edited test list is no longer topped up with automatic tests.
 * The result goes through the same merge + normalize as a provider answer, so
 * it can never be shaped differently from one; the director may cut the sets
 * down to one. Returns `{ direction, changed }` (`changed` names what actually
 * changed, for the revision record); throws 422 for an unknown item, an edit
 * that would leave the direction unusable, or one that removes or renames a
 * catalog-linked supporting character (`fixedCast`; unlink it in Creative setup).
 */
export function applyCastAndSetsDirectionEdits(previous, edits, { sections = [], fixedCast = [] } = {}) {
  if (edits?.sets?.length && !edits.protagonist && !edits.world && edits.sets.every((s) => Object.hasOwn(s, 'setReference') && !Object.hasOwn(s, 'imageRole'))) {
    const updates = new Map(edits.sets.map((s) => [s.id, s.setReference]));
    if ([...updates.keys()].some((id) => !previous.sets?.some((s) => s.id === id))) {
      throw new ServerError('Unknown set', { status: 422, code: 'CAST_SETS_UNKNOWN_SET' });
    }
    const sets = previous.sets.map((s) => updates.has(s.id) ? { ...s, setReference: updates.get(s.id) } : s);
    const changed = sets.filter((s) => JSON.stringify(s.setReference ?? null) !== JSON.stringify(previous.sets.find((old) => old.id === s.id).setReference ?? null)).map((s) => `${s.name} greybox reference`);
    return { direction: { ...previous, sets }, changed };
  }
  const procedural = previous?.medium === 'procedural';
  const parsed = {};
  let renamedLooks = new Map(), currentLookNames = new Set(), currentLookNamesExact = new Set();
  if (edits?.protagonist) {
    const protagonist = pickText(edits.protagonist, procedural ? CAST_SETS_EDITABLE_PROTAGONIST : CAST_SETS_EDITABLE_PHOTO_PROTAGONIST);
    if (Array.isArray(edits.protagonist.expressions)) {
      protagonist.expressions = edits.protagonist.expressions.map((x) => String(x).trim().slice(0, 300)).filter(Boolean);
    }
    if (!procedural && Array.isArray(edits.protagonist.forms)) protagonist.forms = edits.protagonist.forms;
    parsed.protagonist = protagonist;
  }
  if (procedural && edits?.world) parsed.world = pickText(edits.world, CAST_SETS_EDITABLE_WORLD);
  if (Array.isArray(edits?.looks)) {
    parsed.looks = edits.looks.map((l) => pickText(l, { name: SHORT, description: TEXT, chapters: 300 }));
    const originals = edits.looks.map((l) => l.originalName).filter(Boolean);
    const names = edits.looks.map((l) => l.name.toLowerCase());
    if (new Set(originals).size !== originals.length || originals.some((name) => !(previous.looks || []).some((look) => look.name === name)) || new Set(names).size !== names.length) {
      throw new ServerError('Look names or original references are ambiguous', { status: 422, code: 'CAST_SETS_EDIT_INVALID' });
    }
    const renames = new Map(edits.looks.flatMap((look, i) => look.originalName ? [[look.originalName, parsed.looks[i].name]] : []));
    renamedLooks = renames;
    currentLookNames = new Set(parsed.looks.map((look) => look.name.toLowerCase()));
    currentLookNamesExact = new Set(parsed.looks.map((look) => look.name));
    parsed.tests = (previous.tests || []).map((test) => ({ ...test, look: renames.get(test.look) || test.look }));
  }
  if (!procedural && Array.isArray(edits?.props)) {
    parsed.props = edits.props.map((p) => pickText(p, { id: 64, name: SHORT, owner: SHORT, description: TEXT }));
  }
  if (!procedural && Array.isArray(edits?.cast) && edits.cast.length) {
    const fixedNames = new Set(fixedCast.map((f) => castKey(f.name)));
    const locked = edits.cast.flatMap((patch) => {
      const member = (previous.cast || []).find((c) => c.id === patch.id);
      const renamed = typeof patch.name === 'string' && castKey(patch.name) !== castKey(member?.name);
      return member && fixedNames.has(castKey(member.name)) && (patch.remove || renamed) ? [member.name] : [];
    });
    if (locked.length) {
      throw new ServerError(`${locked.join(', ')} ${locked.length > 1 ? 'are' : 'is'} cast from the catalog in Creative setup. Unlink ${locked.length > 1 ? 'them' : 'it'} there to remove or rename ${locked.length > 1 ? 'them' : 'it'}.`, { status: 422, code: 'CAST_SETS_FIXED_CAST' });
    }
    parsed.cast = patchItems(previous.cast || [], edits.cast.map((c) => ({ ...c, key: c.id })), { what: 'cast member', keyOf: (c) => c.id, fields: EDITABLE_CAST });
  }
  if (Array.isArray(edits?.sets) && edits.sets.length) {
    parsed.sets = patchItems(previous.sets || [], edits.sets.map((s) => ({ ...s, key: s.id })), {
      what: 'set', keyOf: (s) => s.id, fields: EDITABLE_SET,
      extra: (patch) => (procedural && patch.imageRole ? { imageRole: patch.imageRole } : {}),
    });
  }
  if (!procedural && Array.isArray(edits?.tests) && edits.tests.length) {
    const tests = edits.tests.map((test) => {
      if (test.remove) return { ...test, key: test.index };
      const name = test.look?.trim();
      let renamed = null;
      if (name && !currentLookNamesExact.has(name)) {
        const matches = [...renamedLooks].filter(([original]) => original.toLowerCase() === name.toLowerCase());
        if (currentLookNames.has(name.toLowerCase())) {
          if (matches.some(([, target]) => target && target.toLowerCase() !== name.toLowerCase())) {
            throw new ServerError('Look reference is ambiguous', { status: 422, code: 'CAST_SETS_EDIT_INVALID' });
          }
        } else {
          renamed = renamedLooks.get(name);
          if (!renamed && matches.length > 1) throw new ServerError('Look reference is ambiguous', { status: 422, code: 'CAST_SETS_EDIT_INVALID' });
          renamed ||= matches[0]?.[1];
        }
      }
      return { ...test, ...(renamed && { look: renamed }), key: test.index };
    });
    parsed.tests = patchItems(parsed.tests || previous.tests || [], tests, { what: 'test', keyOf: (_t, i) => i + 1, fields: EDITABLE_TEST, extra: testFormPatch });
    parsed.testsFixed = true;
  }
  // A director edit never drops a test silently: removing (or mistyping) the age
  // a test shows is refused until that test is reassigned or removed.
  if (!procedural) {
    const forms = normalizeForms(hasOwn(parsed.protagonist, 'forms') ? parsed.protagonist.forms : previous?.protagonist?.forms, previous?.protagonist?.forms || []);
    const orphaned = testsWithMissingForm(parsed.tests || previous?.tests, forms);
    if (orphaned.length) {
      throw new ServerError(`An age that is not on the sheet is shown by test ${orphaned.join(', ')}. Give each another age or remove it first.`, { status: 422, code: 'CAST_SETS_UNKNOWN_FORM' });
    }
  }
  const { direction, missing } = mergeCastAndSetsDirection(previous, parsed, { sections, medium: procedural ? 'procedural' : 'photographic', minSets: 1, fixedCast });
  if (missing.length) throw new ServerError(`That edit would leave the direction without: ${missing.join(', ')}`, { status: 422, code: 'CAST_SETS_EDIT_INVALID' });
  return { direction: { ...direction, look: previous.look || '' }, changed: describeEdits(previous, direction) };
}

const differs = (a, b) => JSON.stringify(a ?? '') !== JSON.stringify(b ?? '');

/** What a direct edit changed, named for the revision record. */
function describeEdits(previous, direction) {
  const p0 = previous.protagonist || {};
  const p1 = direction.protagonist || {};
  const listChanges = (label, before = [], after = [], keyOf, nameOf) => {
    const next = new Map(after.map((item, i) => [keyOf(item, i), item]));
    return before.flatMap((item, i) => {
      const now = next.get(keyOf(item, i));
      if (!now) return [`${nameOf(item, i)} removed`];
      return differs(item, now) ? [`${label} ${nameOf(now, i)}`] : [];
    });
  };
  return [
    ...Object.keys({ ...CAST_SETS_EDITABLE_PROTAGONIST, ...CAST_SETS_EDITABLE_PHOTO_PROTAGONIST }).filter((key) => differs(p0[key], p1[key])),
    ...['expressions', 'forms'].filter((key) => differs(p0[key] || [], p1[key] || [])),
    ...Object.keys(CAST_SETS_EDITABLE_WORLD).filter((key) => differs(previous.world?.[key], direction.world?.[key])).map((key) => `world ${key}`),
    ...(differs(previous.looks || [], direction.looks || []) ? ['looks'] : []),
    ...(differs(previous.props || [], direction.props || []) ? ['props'] : []),
    ...listChanges('cast', previous.cast, direction.cast, (c) => c.id, (c) => c.name),
    ...(direction.medium === 'procedural'
      ? direction.sets.filter((set) => differs(previous.sets.find((s) => s.id === set.id)?.imageRole, set.imageRole)).map((set) => `${set.name} image role`)
      : []),
    ...listChanges('set', previous.sets, direction.sets, (s) => s.id, (s) => s.name)
      .filter((line) => direction.medium !== 'procedural' || line.endsWith(' removed') || !direction.sets.some((s) => line === `set ${s.name}` && differs(previous.sets.find((p) => p.id === s.id)?.imageRole, s.imageRole) && !differs({ ...previous.sets.find((p) => p.id === s.id), imageRole: s.imageRole }, s))),
    ...(direction.testsFixed && differs(previous.tests || [], direction.tests || []) ? ['tests'] : []),
  ];
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
  // A list a legacy direction never had reads the same as an empty one.
  const norm = (v) => (v == null || (Array.isArray(v) && !v.length) ? '' : v);
  const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  const out = [];
  if (!same(previous.look, next.look)) out.push('Look rewritten for every image');
  const p0 = previous.protagonist || {};
  const p1 = next.protagonist || {};
  const protagonistFields = Object.keys({ ...p0, ...p1 }).filter((k) => !same(p0[k], p1[k]));
  if (protagonistFields.length) out.push(`Protagonist: ${nameList(protagonistFields)}`);
  if (!same(previous.looks, next.looks)) out.push('Wardrobe looks revised');
  if (!same(previous.cast || [], next.cast || [])) out.push('Supporting cast revised');
  if (!same(previous.props || [], next.props || [])) out.push('Props revised');
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
