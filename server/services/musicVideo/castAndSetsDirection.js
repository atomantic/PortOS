import { activeMusicVideoSubjects } from '../../lib/musicVideo/musicVideoCastSelection.js';
import { midiSongSummary, midiWindowFacts } from '../../lib/musicVideo/musicVideoMidiDigest.js';
import { musicVideoAllowsMedia } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
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
import { extractJson } from '../../lib/jsonExtract.js';
import { musicVideoCreativeContext, musicVideoSongStyleContext, withoutPeople } from '../../lib/musicVideo/musicVideoCreativeContext.js';
import { isOutsideMusicVideoReference } from '../../lib/musicVideo/musicVideoConditioning.js';
import { musicVideoBriefTools as briefTools, musicVideoGenerationAllowance } from '../../lib/musicVideo/musicVideoMediumPlan.js';
import { trimTo } from '../../lib/textUtils.js';
import { moodBoardItemCaption } from '../../lib/moodBoardStyleContext.js';
import { CAST_SETS_DEFINITION_LIMITS, normalizeDefinitions } from './castAndSetsDefinitions.js';
import { CAST_SETS_LIMITS, HEIGHT, SHORT, TEXT } from './castAndSetsDirectionLimits.js';

export { CAST_SETS_IMAGE_ROLES, CAST_SETS_LIMITS } from './castAndSetsDirectionLimits.js';
export { mergeCastAndSetsDirection } from './castAndSetsDirectionMerge.js';
export {
  applyCastAndSetsDirectionEdits,
  applyCastAndSetsDirectionTextEdits,
  CAST_SETS_EDITABLE_PHOTO_PROTAGONIST,
  CAST_SETS_EDITABLE_PROTAGONIST,
  CAST_SETS_EDITABLE_WORLD,
  describeDirectionChanges,
} from './castAndSetsDirectionEdits.js';

// Mood board images are outside inspiration (Pinterest pins, uploads): they
// shape the direction as words and are never image-generation inputs.
const MOOD_BOARD_TEXT_ONLY = 'The image generator never sees the mood board: carry what you take from it (light, color, texture, grain, wardrobe feel) into your own words in the descriptions, lighting and looks.';

// Set plates and in-set frames carry the scene look. A set plate is empty: a person
// in either (a mood board's composed style often describes one) lands in the plate.
const LOOK_AND_SET_RULES = [
  '- look: palette, light quality, film stock, grain, texture and any explicitly requested rendering medium only. Never a person, place, object or pose: the scene look is appended to set plates and in-set frames; people reference sheets retain only the rendering medium on a neutral field.',
  '- renderingMedium: the explicit visual medium (for example scratchboard, watercolor or photography), separate from scene look and the execution-policy medium. Preserve a director-specified medium verbatim, without adding lighting, film stock or grading. Populate it for new photographic directions. An age form may override it; empty or absent inherits the direction medium. On revisions preserve existing renderingMedium values unless the director requests a change.',
  '- sets: describe the EMPTY place. No people, characters, figures or actions; the protagonist appears only in tests. In description, name concrete foreground, midground and background planes with environmental or architectural geometry and surface wear.',
  '- sets.lighting: name a physical in-world source and its direction, quality and color temperature. Avoid unspecified studio or film fixtures such as softbox, C-stand, beauty dish or key light rig; preserve explicitly requested or story-appropriate in-world fixtures. Preserve atmosphere explicitly requested by the director; otherwise no fog, mist, haze, smoke plumes or volumetric light shafts unless physically produced by a named in-frame source.',
  '- sets: preserve the director\'s requested story details, including deliberate unusual or stylized arrangements. Otherwise, choose details consistent with each other, the described place and its era; avoid unexplained contradictions such as a pristine parked car at a place described as deserted or an unintended second post on a single-pole hoop. Name each fixture once.',
].join('\n');

const LYRICS_MAX = 6000;
const MOOD_ITEMS_MAX = 40;
const MOOD_ITEM_TEXT = 280;

// ---- medium ------------------------------------------------------------------

/**
 * The medium the check-in is directed in. A project that may generate no video
 * is procedural when it is code-first or its brief selected code tools; a
 * project that may generate video, and an image-only legacy brief, stay
 * photographic, so footage always has a character sheet to hold identity.
 * The generation allowance folds the media mode, the brief's tools and the
 * production policy together, because each can be saved without the others.
 */
export function castAndSetsMedium(project) {
  if (!musicVideoAllowsMedia(project, 'image')) return 'procedural';
  const { video, strategy } = musicVideoGenerationAllowance(project);
  if (video) return 'photographic';
  return strategy === 'code-first' || briefTools(project).some((t) => t.startsWith('code:')) ? 'procedural' : 'photographic';
}

/** False when the media mode forbids images or the brief names tools and none of them makes images. */
export const castAndSetsAllowsImages = (project) => musicVideoGenerationAllowance(project).image;

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
  return activeMusicVideoSubjects(project?.concept)
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
 * A form's subject binding a caller just set (it differs from the one `previous`
 * held for that form id) that names no fixed-casting character of `project`.
 * An unchanged binding whose subject was since unlinked is left for the plan
 * to report as missing, so it never blocks an unrelated edit.
 */
export function newUnknownFormSubjects(project, direction, previous) {
  const known = new Set(formSubjects(project).map((s) => s.id));
  const before = new Map((previous?.protagonist?.forms || []).map((f) => [f.id, f.subjectId]));
  return (direction?.protagonist?.forms || []).filter((f) => f.subjectId && f.subjectId !== before.get(f.id) && !known.has(f.subjectId));
}

/**
 * Bind forms only to subjects the director cast: a provider's new binding to
 * any other id is dropped (a director edit is refused before this runs), and
 * each binding to a known subject records that subject's name, so its
 * reference can still be kept off the present-day sheet if the subject is
 * later removed from the video.
 */
export function withCheckedFormSubjects(project, direction, previous) {
  const forms = direction?.protagonist?.forms;
  if (!forms?.length) return direction;
  const unknown = new Set(newUnknownFormSubjects(project, direction, previous).map((f) => f.id));
  const names = new Map(formSubjects(project).map((s) => [s.id, s.name]));
  const checked = forms.map((f) => {
    if (!f.subjectId) return f;
    const { subjectId, subjectName, ...rest } = f;
    if (unknown.has(f.id)) return rest;
    const name = names.get(subjectId) || subjectName;
    return { ...rest, subjectId, ...(name ? { subjectName: name } : {}) };
  });
  return { ...direction, protagonist: { ...direction.protagonist, forms: checked } };
}

/**
 * The fixed-casting characters that must each appear in `direction.cast`: every
 * catalog-linked character except the protagonist, and except an age form of
 * the protagonist's own catalog record (that one belongs in protagonist.forms).
 */
export function fixedSupportingCast(project) {
  const subjects = activeMusicVideoSubjects(project?.concept);
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
  return activeMusicVideoSubjects(project?.concept)
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
  "renderingMedium": "<visual medium only, preserving the director's words; e.g. scratchboard>",
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
    "stillness": "<weight, posture, hands and default expression at rest>",
    "movement": "<gait, gesture quality and physical habits>",
    "rules": ["<continuity or safety rule>"],
    "expressions": ["<a mood from the story: what the face, eyes and head do>"],
    "forms": [{ "id": "<short-slug>", "label": "<e.g. Age 7>", "age": "<age>", "description": "<how they look at that age>", "hair": "<hair at that age>", "wardrobe": "<their outfit at that age>", "height": "<their height at that age, e.g. 4 ft (122 cm) at 7>", "era": "<the year or period this age is seen in, e.g. 1965>", "look": "<the film stock, format and color of that memory when it differs from the main look, e.g. black-and-white 8mm home movie, heavy grain; or empty>", "renderingMedium": "<visual medium override for this age, or empty to inherit>", "subjectId": "<the FIXED CASTING subject id of the protagonist at this age, or empty>" }]
  },
  "looks": [{ "name": "<SHORT NAME>", "description": "<the complete outfit>", "chapters": "<which parts of the song>" }],
  "cast": [{ "id": "<short-slug>", "name": "<a name>", "role": "<what they are in the video: drummer, shopkeeper, ...>", "description": "<who they are: age, vibe, attitude>", "height": "<their height, e.g. 5 ft 10 in (178 cm)>", "face": "<face: skin, eyes, brows, distinguishing features>", "hair": "<hair>", "wardrobe": "<their one outfit>", "stillness": "<weight, posture, hands and default expression at rest>", "movement": "<gait, gesture quality and physical habits>" }],
  "props": [{ "id": "<short-slug>", "name": "<what it is and whose, e.g. Ada's camera>", "owner": "<who carries, uses or rides it, or empty>", "description": "<exactly how it looks: type, era, shape, size, colors, materials and distinguishing marks; no brand names or text>" }],
  "sets": [{ "id": "<short-slug>", "name": "<set name>", "description": "<the empty location with concrete foreground, midground and background geometry and wear; furniture and objects upright and apart>", "lighting": "<physical in-world source, direction, quality and color temperature>", "era": "<the year or period it is seen in when that is not the present story, or empty>", "look": "<the film stock, format and color of that era when it differs from the main look, or empty>", "sections": ["<section label it serves>"] }],
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
    "stillness": "<how the character holds its shape at rest>",
    "movement": "<motion rules: easing, idle loop, how it reacts to the beat>",
    "signature": "<one detail present in every pose>",
    "gesture": "<a recurring gesture tied to a lyric hook, quoting the hook>",
    "rules": ["<continuity rule>"]
  },
  "looks": [{ "name": "<SHORT NAME>", "description": "<a palette or costume variant>", "chapters": "<which parts of the song>" }],
  "cast": [{ "id": "<short-slug>", "name": "<a name>", "role": "<role in the story>", "description": "<who or what they are>", "stillness": "<how they hold their shape at rest>", "movement": "<motion rules and physical habits>" }],
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
export function buildCastAndSetsPrompt(project, { moodImages = [], board = null, track = null, previous = null, notes = [], medium = null, feedback = [], guides = {}, midi = null } = {}) {
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
  // The audio→MIDI transcription (songMidiDigest.js), when the director made one: what plays in each section.
  const sectionLines = sections.map((s) => {
    const music = midiWindowFacts(midi, s.startSec, s.endSec);
    return `${s.index}. ${s.label} ${fmtTime(s.startSec)}–${fmtTime(s.endSec)}${music ? ` — ${music}` : ''}`;
  });
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
    midi && `${midiSongSummary(midi)}. Let the instrumentation and each section's arc (where parts enter, hits land and the top line climbs) shape which set each section plays in.`,
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
    '- Describe stillness and movement for the protagonist and recurring supporting cast; keep cast consistent with their code definitions.',
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
    '- For protagonist and each cast member, stillness describes weight, posture, hands and default expression at rest; movement describes gait, gesture quality and physical habits.',
    '- People and wardrobe sheets show empty, relaxed hands. In protagonist/cast/form appearance descriptions, looks and wardrobe, describe the person, worn clothing and worn accessories only. Put carried or held objects in props, never in these descriptions; signature may describe a story prop, but it is not drawn on a person or wardrobe sheet.',
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
  // a fresh rebuild included, and it rewrites the scene look for set plates
  // and in-set frames (`look` in the answer) instead of being pasted onto prompts.
  const standing = (Array.isArray(feedback) ? feedback : []).map((f) => trimTo(f?.text, FEEDBACK_TEXT)).filter(Boolean);
  const standingBlock = standing.length ? [
    'DIRECTOR FEEDBACK ON EARLIER SHEETS (always honor it; where it disagrees with the mood board or visual style, the feedback wins):',
    ...standing.map((t) => `- ${t}`),
    'Carry it into every field it touches (each set\'s description and lighting, the looks, the protagonist), and write "look": one line, under 400 characters, of the scene look set plates and in-set frames carry (film stock, light quality and sources, grain, color, and any explicitly requested rendering medium), rewritten so it agrees with this feedback.',
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
    sectionLines.length ? `Song sections (index. label start–end${midi ? ' — what the transcription shows' : ''}):\n${sectionLines.join('\n')}` : 'The song has not been sectioned.',
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
  renderingMedium: z.string().max(500).optional(),
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
  stillness: prose(TEXT).optional(),
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
  stillness: prose(TEXT).optional(),
  movement: prose(TEXT).optional(),
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
  renderingMedium: z.string().max(500),
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
