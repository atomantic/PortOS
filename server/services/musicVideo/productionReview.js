/** Revision-bound creative approvals. Technical renders never imply approval. */
import { randomUUID } from 'node:crypto';
import { canonicalSnapshotChecksum as hash } from '../../lib/snapshotChecksum.js';
import { ServerError } from '../../lib/errorHandler.js';
import { musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';

import { isNonBlankStr as text } from '../../lib/textUtils.js';
import { cameraMovementFromText, getCameraMovement, shotCameraLabel } from '../../lib/cameraMovements.js';
import { cameraVarietyReport } from './shotCamera.js';
import { overlayTextReport } from './overlayText.js';
import { musicVideoAspect } from '../../lib/musicVideoAspect.js';
import { lyricCueSpan } from './timedText.js';
import { cuesSungWithin } from '../../lib/musicVideoLyricAnchors.js';
import { isLayeredComposition, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { coldOpenScenes, songScenes } from '../../lib/musicVideoColdOpen.js';
const artifact = (project, id) => (project.devArtifacts || []).find(a => a.id === id && !a.deleted);
const artifactBasis = a => a ? { id: a.id, version: a.version, file: a.file } : null;
const source = p => {
  const timing = p.audioTimingRevisions?.at(-1);
  return { trackId: p.trackId, uploadedAudioFilename: p.uploadedAudioFilename,
    duration: p.audioAnalysis?.durationSec, beats: p.audioAnalysis?.beats, sections: p.audioAnalysis?.sections,
    // These drive authored musical actions even when the beat grid and lyrics
    // stay unchanged. Waveform display samples and receipt timestamps do not.
    downbeats: p.audioAnalysis?.downbeats, features: p.audioAnalysis?.features,
    audioTiming: timing ? { version: timing.version, basis: timing.basis, input: timing.input } : null,
    lyrics: p.lyricCues, markers: p.lyricMarkers, phrases: p.phrases };
};
export const productionAlignmentBasis = project => hash(source(project));

/** The storyboard problem raised while the lyric timing is unverified for the current master. */
export const ALIGNMENT_UNVERIFIED_PROBLEM = 'Lyric alignment is provisional or changed. Listen and verify the current word timings.';

/** A shot manifest belongs to one immutable authored document and one master timeline. */
export const documentStoryboardBasis = project => hash({
  document: project.composition?.document?.directory, source: source(project),
  shots: project.productionReview?.draft?.storyboard,
});

/**
 * What an overlay text check saw (overlayTextService.js): the document, the
 * frame, the song timing and lyrics, the text cues, the type style and every
 * shot's text placement and selected take. A change to any of them makes a check stale.
 */
export const overlayTextBasis = project => hash({
  ...(project.lyricOverlayEnabled === false ? { lyricOverlayEnabled: false } : {}),
  document: project.composition?.document?.directory || null, aspect: musicVideoAspect(project), source: source(project),
  textCues: project.composition?.textCues ?? null, overlay: project.composition?.overlay ?? null, style: project.composition?.style ?? null,
  scenes: (project.scenes || []).map(({ sceneId, startSec, endSec, textZone, lyricRole, lyricSize, lyricText, cardText, referenceImageId, videoHistoryId, performanceEdit, visualLayer, photoSequence }) =>
    ({ sceneId, startSec, endSec, textZone, lyricRole, lyricSize, lyricText, cardText, referenceImageId, videoHistoryId, performanceEdit, visualLayer,
      ...(photoSequence && photoSequence.enabled !== false ? { photoSequence } : {}) })),
});

// Share the evidence contract between new decisions and persisted approvals:
// a legacy automatic waiver must not become production-ready after an upgrade.
// Playback notes are optional: approving is the director's call, not a form to fill in.
function hasProofEvidence(review) {
  if (!review || review.autoApproved) return false;
  if (review.method === 'machine') {
    const evidence = review.machineEvidence;
    return review.watchedWithAudio === false && text(evidence?.visualReview) && evidence.visualReview.trim().length >= 40
      && text(evidence?.audioReview) && evidence.audioReview.trim().length >= 40 && text(evidence?.limitations);
  }
  return (review.method == null || review.method === 'playback') && review.watchedWithAudio === true;
}

const describeDirection = value => typeof value === 'string' ? value : JSON.stringify(value || {}, null, 2);

// What the art draft fields are seeded from. A seeded field that the user has
// not edited follows the newest approved direction; an edited one is kept.
const ART_SEEDS = {
  cast: d => d.protagonist,
  environments: d => d.sets,
  visualLanguage: d => ({ look: d.look, palette: d.protagonist?.palette, world: d.world }),
  motionLanguage: d => ({ movement: d.protagonist?.movement, camera: d.world?.camera, transitions: d.world?.transitions }),
};
// Equal content in any formatting: JSON compares by value (key order and
// whitespace ignored), plain text by its trimmed string.
const parsedJson = value => {
  if (!/^[[{]/.test(value.trim())) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};
const sameContent = (a, b) => {
  const [x, y] = [parsedJson(a), parsedJson(b)];
  return x !== undefined && y !== undefined ? hash(x) === hash(y) : a.trim() === b.trim();
};

/**
 * Seed the art-direction draft fields (and the visual guide) from a Cast & Sets
 * sheet. A blank field, or one still holding the exact text an earlier approval
 * seeded, follows the newest direction. Text that already says what the
 * direction says is kept as written (rewriting its formatting would stale an
 * art approval for nothing), and any other text the director or an agent
 * entered — and a guide already chosen — is never overwritten. A document-shot
 * draft is left alone. Seeding supplies editable content only; it never records
 * an approval.
 */
export function seedArtDraft(project, stage = project.castAndSets) {
  const prior = project.productionReview?.draft || {};
  if (prior.storyboardSource === 'document' || !stage?.direction) return project;
  const recorded = project.productionReview?.seededDraft || {};
  const draft = { lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [], ...prior,
    guideArtifactId: prior.guideArtifactId || (artifact(project, stage.artifactId) ? stage.artifactId : null) };
  // Kept outside the strict draft schema: the hash of each field as last seeded.
  // A field absent here was entered by hand and is never rewritten.
  const seededDraft = {};
  for (const [key, from] of Object.entries(ART_SEEDS)) {
    const seed = describeDirection(from(stage.direction));
    const current = text(prior[key]) ? prior[key] : null;
    if (current && sameContent(current, seed)) seededDraft[key] = hash(current);
    else if (!current || recorded[key] === hash(current)) {
      draft[key] = seed;
      seededDraft[key] = hash(seed);
    }
  }
  return { ...project, productionReview: { ...project.productionReview, draft, seededDraft } };
}

/**
 * The art-direction guides the director wrote (or accepted from a story
 * draft): cast, environments, visual language. A field still holding the text
 * a Cast & Sets approval seeded is the sheet's own echo, so it is left out.
 */
export function directorArtGuides(project) {
  const draft = project?.productionReview?.draft || {};
  const seeded = project?.productionReview?.seededDraft || {};
  return Object.fromEntries(['cast', 'environments', 'visualLanguage']
    .filter((key) => text(draft[key]) && seeded[key] !== hash(draft[key]))
    .map((key) => [key, draft[key].trim()]));
}

/**
 * What one Board shot renders from: its prompts and direction, its span and
 * lyric, its selected frames and performance setup, and its storyboard row.
 * The selected clip is the shot's output, not an input. A lock saved before
 * still locks ignored timing (no `v`) still binds to this whole basis.
 */
function shotApprovalBasis(project, scene) {
  const row = (project.productionReview?.draft?.storyboard || []).find(shot => shot?.sceneId === scene.sceneId);
  const { prompt, framePrompt, visualIntent, camera, direction, startSec, endSec, lyricText, referenceImageId, endImageId,
    shotMode, performanceSpeaker, performanceStyle, visualLayer, loop } = scene;
  return hash({ prompt, framePrompt, visualIntent, camera, direction, startSec, endSec, lyricText, referenceImageId, endImageId,
    shotMode, performanceSpeaker, performanceStyle, visualLayer, loop,
    row: row ? { action: row.action, staging: row.staging, camera: row.camera, transition: row.transition, lyricCueIds: row.lyricCueIds } : null });
}

/**
 * What a still lock (`productionReview.shotApprovals[sceneId]`, `v: 2`) binds
 * to: the shot's render inputs without its timing. Moving a cut, and the lyric
 * that moves with it, keeps the still approved.
 */
function stillLockBasis(project, scene) {
  const row = (project.productionReview?.draft?.storyboard || []).find(shot => shot?.sceneId === scene.sceneId);
  const { prompt, framePrompt, visualIntent, camera, direction, referenceImageId, endImageId,
    shotMode, performanceSpeaker, performanceStyle, visualLayer, loop } = scene;
  return hash({ prompt, framePrompt, visualIntent, camera, direction, referenceImageId, endImageId,
    shotMode, performanceSpeaker, performanceStyle, visualLayer, loop,
    row: row ? { action: row.action, staging: row.staging, camera: row.camera, transition: row.transition } : null });
}

const STILL_LOCK_VERSION = 2;
const stillLock = (project, scene, fields) => ({ ...fields, basis: stillLockBasis(project, scene), v: STILL_LOCK_VERSION });
const stillLockHolds = (project, scene, approval) => approval.v === STILL_LOCK_VERSION
  ? approval.basis === stillLockBasis(project, scene) : approval.basis === shotApprovalBasis(project, scene);

/** Is the whole-board storyboard approval (given before shots locked one by one, or by Approve all) current? */
const boardApprovalCovers = project => storyboardApprovalCurrent(project.productionReview?.approvals?.storyboard, productionReviewBasis(project));

/**
 * Each Board shot's lock: `locked`, `changed` (locked, then edited) or `open`. Null for a document storyboard.
 * A shot with no lock of its own is locked while a current whole-board approval covers it, so a board
 * approved before per-shot locks existed stays approved after one shot is locked or unlocked.
 */
export function shotLocks(project) {
  if (project.productionReview?.draft?.storyboardSource === 'document') return null;
  const approvals = project.productionReview?.shotApprovals || {};
  const covered = (project.scenes || []).some(scene => !approvals[scene.sceneId]) && boardApprovalCovers(project);
  return Object.fromEntries((project.scenes || []).map(scene => {
    const approval = approvals[scene.sceneId];
    return [scene.sceneId, !approval ? (covered ? 'locked' : 'open') : stillLockHolds(project, scene, approval) ? 'locked' : 'changed'];
  }));
}

/**
 * Whether a shot locks in two steps: a generated clip locks its still (ready to
 * render), then the clip. Stills, cards, code shots and clips rendered from code
 * have nothing more to approve after their first lock.
 */
const shotHasVideoStage = (project, scene) => !scene.codeClip
  && sceneVisualLayer(scene, { layered: isLayeredComposition(project) }) === 'footage';

/**
 * Read-only legacy approval compatibility: no route or service sets a clip lock
 * any more, but projects locked before lock removal keep `clipApprovals`, and
 * the render gates still exempt their `locked` clips so those projects render.
 * Each video shot's clip lock (`productionReview.clipApprovals[sceneId]`):
 * `locked` while its still stays locked and the clip it locked is still the
 * selected one, `changed` once either moved, `open` before it is locked. Null
 * for a shot with no video step, and for a document storyboard.
 */
export function clipLocks(project, locks = shotLocks(project)) {
  if (!locks) return null;
  const approvals = project.productionReview?.clipApprovals || {};
  return Object.fromEntries((project.scenes || []).map(scene => {
    if (!shotHasVideoStage(project, scene)) return [scene.sceneId, null];
    const approval = approvals[scene.sceneId];
    return [scene.sceneId, !approval ? 'open'
      : locks[scene.sceneId] === 'locked' && approval.videoHistoryId === scene.videoHistoryId ? 'locked' : 'changed'];
  }));
}

/** Each timed scene's shot number as the board shows it: song order, from 1. */
export function shotNumbers(project) {
  // Cold-open shots play before the song and are numbered on their own (nameShots).
  const order = songScenes(project).filter(scene => Number.isFinite(scene?.startSec)).sort((a, b) => a.startSec - b.startSec);
  return new Map(order.map((scene, i) => [scene.sceneId, i + 1]));
}

/**
 * Names shots for an error message in song order: "Shot 4", "Shots 2, 9", or
 * with notes "Shots 2 (re-timed), 9 (not lip-synced)". `entries` are sceneIds
 * or `{ sceneId, note }`. Untimed scenes have no number, so a list that holds
 * one falls back to a count ("3 shots"). Shots before the song are named in
 * cold-open order: "Cold open shot 1".
 */
export function nameShots(project, entries) {
  const numbers = shotNumbers(project);
  const cold = new Map(coldOpenScenes(project).map((scene, i) => [scene.sceneId, i + 1]));
  const items = entries.map(entry => (typeof entry === 'string' ? { sceneId: entry } : entry));
  const name = (list, number, singular, plural) => {
    if (!list.length) return null;
    const numbered = list.map(({ sceneId, note }) => ({ n: number.get(sceneId), note }));
    if (numbered.some(({ n }) => !n)) return `${numbered.length} ${numbered.length === 1 ? 'shot' : 'shots'}`;
    const text = numbered.sort((a, b) => a.n - b.n).map(({ n, note }) => (note ? `${n} (${note})` : `${n}`)).join(', ');
    return `${numbered.length === 1 ? singular : plural} ${text}`;
  };
  const before = name(items.filter(({ sceneId }) => cold.has(sceneId)), cold, 'Cold open shot', 'Cold open shots');
  const song = name(items.filter(({ sceneId }) => !cold.has(sceneId)), numbers, 'Shot', 'Shots');
  return [before, song].filter(Boolean).join(' and ') || '0 shots';
}

/**
 * Keep the director's still locks through a change that adds shots or reshapes
 * the board (a new shot, a split). Every shot locked before stays locked by its
 * own timing-free lock, even one covered only by a whole-board approval the
 * change stales; `from` maps a new shot to the shot it was cut from, and a new
 * piece of a locked still is locked too. Clip locks are not copied: a new piece
 * has no clip of its own.
 */
export function carryShotLocks(before, after, { from = {} } = {}) {
  const locks = shotLocks(before);
  if (!locks) return after;
  const held = before.productionReview?.shotApprovals || {};
  const board = before.productionReview?.approvals?.storyboard;
  const lockOf = scene => held[scene.sceneId] || { ...board, fromBoardApproval: true };
  const shotApprovals = { ...after.productionReview?.shotApprovals };
  let carried = false;
  for (const scene of before.scenes || []) {
    if (locks[scene.sceneId] !== 'locked' || !after.scenes?.some(s => s.sceneId === scene.sceneId)) continue;
    const own = held[scene.sceneId];
    if (own?.v === STILL_LOCK_VERSION) continue;
    shotApprovals[scene.sceneId] = stillLock(before, scene, lockOf(scene));
    carried = true;
  }
  for (const [pieceId, sourceId] of Object.entries(from)) {
    const source = before.scenes?.find(s => s.sceneId === sourceId);
    const piece = after.scenes?.find(s => s.sceneId === pieceId);
    if (!source || !piece || locks[sourceId] !== 'locked') continue;
    shotApprovals[pieceId] = stillLock(after, piece, lockOf(source));
    carried = true;
  }
  return carried ? { ...after, productionReview: { ...after.productionReview, shotApprovals } } : after;
}

/**
 * Is a storyboard approval current on this revision? Either it was given on
 * exactly this revision, or only the wording, prompts or timing of the shots
 * it covered have changed since (`shotsBasis`; approvals recorded before it
 * existed match on the exact revision only).
 */
const storyboardApprovalCurrent = (approval, basis) => !!approval
  && (approval.basis === basis.storyboard || (!!basis.storyboardShots && approval.shotsBasis === basis.storyboardShots));

// A subject's catalog link and keep-local choice are bookkeeping saved after an
// approval (catalogCast.js), never a change to who or what was approved.
const CATALOG_SUBJECT_KEYS = ['ingredientId', 'castForm', 'localOnly'];
const withoutCatalogFields = subjects => (subjects || []).map(s => (s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).filter(([k]) => !CATALOG_SUBJECT_KEYS.includes(k))) : s));
const approvalConcept = concept => (concept?.subjects ? { ...concept, subjects: withoutCatalogFields(concept.subjects) } : concept);
// Restoring approved subjects keeps the catalog fields saved since.
const keepCatalogFields = (subjects, current) => {
  const byId = new Map((current || []).map(s => [s?.id, s]));
  return (subjects || []).map(s => ({ ...s, ...Object.fromEntries(CATALOG_SUBJECT_KEYS.filter(k => byId.get(s?.id)?.[k] !== undefined).map(k => [k, byId.get(s.id)[k]])) }));
};

export function productionReviewBasis(project) {
  const draft = project.productionReview?.draft || {};
  const art = hash({ projectId: project.id, mediaMode: project.mediaMode, authoringRenderer: project.composition?.authoringRenderer, mode: project.composition?.mode, policy: project.productionPolicy,
    concept: approvalConcept(project.concept), visualSpec: project.visualSpec, styleReferences: project.styleReferences,
    direction: project.castAndSets?.direction,
    cast: draft.cast, environments: draft.environments, visualLanguage: draft.visualLanguage,
    motionLanguage: draft.motionLanguage, implementationPlan: draft.implementationPlan, guide: artifactBasis(artifact(project, draft.guideArtifactId)) });
  const storyboardInputs = { art, source: source(project), lyricsMode: draft.lyricsMode,
    timingStatus: draft.timingStatus, timingNotes: draft.timingNotes, storyboard: draft.storyboard,
    storyboardSource: draft.storyboardSource || 'board', documentStoryboard: project.productionReview?.documentStoryboard,
    document: draft.storyboardSource === 'document' ? project.composition?.document : null,
    // A planned camera (#10589) joins the hash only when set, so older approvals stay current.
    scenes: (project.scenes || []).map(({ sceneId, startSec, endSec, lyricText, visualIntent, prompt, framePrompt, camera }) =>
      ({ sceneId, startSec, endSec, lyricText, visualIntent, prompt, framePrompt, ...(camera ? { camera } : {}) })), treatment: project.treatment };
  const storyboard = hash(storyboardInputs);
  // The same revision without each shot's own wording and span: a director rewording or retiming
  // a shot keeps the board they approved, while new shots, lyrics, song or direction still stale it.
  // A document storyboard's shots live in its source, so it has no such allowance.
  const storyboardShots = draft.storyboardSource === 'document' ? null : hash({ ...storyboardInputs,
    storyboard: Array.isArray(draft.storyboard) ? draft.storyboard.map(shot => shot?.sceneId ?? null) : draft.storyboard,
    scenes: (project.scenes || []).map(({ sceneId, lyricText }) => ({ sceneId, lyricText })) });
  const window = project.productionReview?.proof;
  const proof = hash({ storyboard, composition: project.composition,
    ...(project.lyricOverlayEnabled === false ? { lyricOverlayEnabled: false } : {}),
    window: window && { startSec: window.startSec, endSec: window.endSec },
    scenes: (project.scenes || []).filter(s => !window || s.startSec < window.endSec && s.endSec > window.startSec)
      .map(({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer, preMusic, photoSequence }) =>
        ({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer, ...(preMusic ? { preMusic } : {}),
          ...(photoSequence && photoSequence.enabled !== false ? { photoSequence } : {}) })),
    soundBed: project.soundBed, videoSettings: project.videoSettings });
  return { art, storyboard, storyboardShots, proof };
}

/** Labeled per-input hashes so a stale approval can name what changed since. */
const h = v => hash(v ?? null);
function productionApprovalInputs(project) {
  const draft = project.productionReview?.draft || {};
  const art = {
    concept: h(approvalConcept(project.concept)), 'visual spec': h(project.visualSpec), 'style references': h(project.styleReferences),
    'media mode': h([project.mediaMode, project.composition?.authoringRenderer, project.composition?.mode, project.productionPolicy]),
    'art direction': h(project.castAndSets?.direction), cast: h(draft.cast), environments: h(draft.environments),
    'visual language': h(draft.visualLanguage), 'motion language': h(draft.motionLanguage),
    'implementation plan': h(draft.implementationPlan), 'visual guide': h(artifactBasis(artifact(project, draft.guideArtifactId))),
  };
  const scenes = {};
  for (const [i, s] of (project.scenes || []).entries()) {
    const n = i + 1;
    scenes[`scene ${n} timing`] = h([s.startSec, s.endSec]);
    scenes[`scene ${n} lyrics`] = h(s.lyricText);
    scenes[`scene ${n} prompt`] = h([s.visualIntent, s.prompt, s.framePrompt]);
    if (s.camera) scenes[`scene ${n} camera`] = h(s.camera);
  }
  const storyboard = { ...art, song: h([source(project).trackId, source(project).uploadedAudioFilename, source(project).duration, source(project).beats, source(project).sections]),
    lyrics: h([source(project).lyrics, source(project).markers, source(project).phrases]), 'lyric timing': h([draft.lyricsMode, draft.timingStatus, draft.timingNotes]),
    'storyboard shots': h([draft.storyboard, draft.storyboardSource, project.productionReview?.documentStoryboard]), treatment: h(project.treatment), ...scenes };
  const window = project.productionReview?.proof;
  const proof = { ...storyboard, composition: h(project.composition), 'proof window': h(window && [window.startSec, window.endSec]),
    ...(project.lyricOverlayEnabled === false ? { 'automatic lyric overlays': h(false) } : {}),
    takes: h((project.scenes || []).map(({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer, photoSequence }) =>
      ({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer,
        ...(photoSequence && photoSequence.enabled !== false ? { photoSequence } : {}) }))),
    'sound bed': h(project.soundBed), 'video settings': h(project.videoSettings) };
  return { art, storyboard, proof };
}

// The labels whose hash moved (or disappeared) between two input snapshots.
const changedInputs = (before, now) => Object.keys(now).filter(k => before[k] !== now[k])
  .concat(Object.keys(before).filter(k => !(k in now)));

// Approved VALUES for the small text inputs a director edits by hand, stored
// beside the hashes so a changed input can be reverted (#10241). Anything over
// the cap, and anything that is not text (media, takes, the song), keeps only
// its hash and so is never revertible. Absent from the record = not revertible.
const MAX_SNAPSHOT_CHARS = 8 * 1024;
const snapshotValue = v => {
  const json = JSON.stringify(v);
  return json !== undefined && json.length <= MAX_SNAPSHOT_CHARS ? JSON.parse(json) : undefined;
};
const snapshotAll = entries => Object.fromEntries(Object.entries(entries)
  .map(([label, v]) => [label, snapshotValue(v)]).filter(([, v]) => v !== undefined));
const DRAFT_FIELD_LABELS = { cast: 'cast', environments: 'environments', 'visual language': 'visualLanguage',
  'motion language': 'motionLanguage', 'implementation plan': 'implementationPlan' };
const SCENE_PROMPT_LABEL = /^scene \d+ prompt$/;
const SCENE_PROMPT_KEYS = ['visualIntent', 'prompt', 'framePrompt'];

/** The approved values of a production stage's revertible inputs, keyed by the same labels as its hashes. */
function productionApprovalValues(project, stage) {
  const draft = project.productionReview?.draft || {};
  const entries = { concept: project.concept };
  for (const [label, key] of Object.entries(DRAFT_FIELD_LABELS)) entries[label] = draft[key];
  if (stage !== 'art') {
    for (const [i, s] of (project.scenes || []).entries()) {
      entries[`scene ${i + 1} prompt`] = { sceneId: s.sceneId, visualIntent: s.visualIntent, prompt: s.prompt, framePrompt: s.framePrompt };
    }
  }
  return snapshotAll(entries);
}

const CAST_SETS_CONCEPT_STYLE_KEYS = ['style', 'universeStyle', 'moodBoardStyle'];
const CAST_SETS_SPEC_STYLE_KEYS = ['palette', 'typography', 'cameraRules', 'moodBoardId'];
const objectConcept = project => project.concept && typeof project.concept === 'object' ? project.concept : {};
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));

/** The approved values behind a Cast & Sets approval's `concept`, `style` and `subjects` hashes. */
export function castAndSetsApprovalValues(project) {
  const { subjects, style, universeStyle, moodBoardStyle, ...concept } = objectConcept(project);
  return snapshotAll({ concept, subjects: subjects ?? [],
    style: { ...pick(objectConcept(project), CAST_SETS_CONCEPT_STYLE_KEYS), ...pick(project.visualSpec, CAST_SETS_SPEC_STYLE_KEYS), styleReferences: project.styleReferences ?? null } });
}

const revertibleOf = (changedFields, values) => changedFields.filter(f => values && f in values);
const withRevertible = (stale, values) => {
  const revertible = revertibleOf(stale.changedFields, values);
  return revertible.length ? { ...stale, revertible } : stale;
};

/** `{ approvedAt, changedFields, revertible? }` when a stage was approved on inputs that have since moved; null otherwise. */
function staleApproval(project, stage, current, inputs) {
  const approval = project.productionReview?.approvals?.[stage];
  if (!approval || approval.basis === current) return null;
  const before = approval.inputs;
  const changedFields = before ? changedInputs(before, inputs[stage]) : [];
  return withRevertible({ approvedAt: approval.approvedAt || null, changedFields: changedFields.length ? changedFields : (before ? ['proof render'] : []) }, approval.values);
}

/**
 * The labeled inputs a Cast & Sets approval rests on — the concept, its style,
 * the subjects (with the cast references the approval wrote) and the song —
 * hashed per label. Stored on the stage at approval as `approvedInputs`.
 * References hash by image only, so re-normalizing a reference's optional
 * fields is not mistaken for a new subject.
 */
export function castAndSetsApprovalInputs(project) {
  const { subjects, style, universeStyle, moodBoardStyle, ...concept } = project.concept || {};
  const spec = project.visualSpec || {};
  return {
    concept: h(concept),
    style: h([style || '', universeStyle || '', moodBoardStyle || '', spec.palette || [], spec.typography || '',
      spec.cameraRules || '', spec.moodBoardId || null, project.styleReferences ?? null]),
    subjects: h([withoutCatalogFields(subjects), (spec.references || []).map(r => r?.imageId || null)]),
    song: h([project.trackId || null, project.uploadedAudioFilename || null]),
  };
}

const STORY_INPUT_LABELS = { story: null, 'cast guide': 'cast', 'environment guide': 'environments', 'visual language': 'visualLanguage' };

/**
 * The director's own words a Cast & Sets direction reads: the story and the
 * guides they wrote (seeded echoes excluded), hashed per label. Stored on the
 * stage as `directedInputs` each time the direction is written.
 */
export function castAndSetsStoryInputs(project) {
  const guides = directorArtGuides(project);
  return Object.fromEntries(Object.entries(STORY_INPUT_LABELS)
    .map(([label, key]) => [label, h(key ? guides[key] || null : text(project?.storySummary) ? project.storySummary.trim() : null)]));
}

/**
 * `{ changedFields }` when the story or a director-written guide moved since
 * the direction was written; null otherwise. A direction written before the
 * story was recorded never read it, so a sheet in review (or failed) with no
 * `directedInputs` is out of date on every story input that now has text. A
 * legacy approved sheet is left alone: its approval already names what moved.
 */
function castAndSetsStoryStale(project) {
  const stage = project.castAndSets;
  if (!stage?.direction || stage.status === 'skipped') return null;
  const now = castAndSetsStoryInputs(project);
  const empty = h(null);
  const changedFields = stage.directedInputs ? changedInputs(stage.directedInputs, now)
    : stage.status === 'approved' ? [] : Object.keys(now).filter(label => now[label] !== empty);
  return changedFields.length ? { changedFields } : null;
}

/**
 * The Cast & Sets check-in as an approval: `{ approved, stale, storyStale }`. An approved
 * stage stays approved when its inputs move (its references still condition
 * the frames) but reports what changed since. A stage approved before inputs
 * were recorded has no basis to compare and reports no staleness.
 */
function castAndSetsApproval(project) {
  const stage = project.castAndSets;
  const approved = stage?.status === 'approved';
  const storyStale = castAndSetsStoryStale(project);
  if (!approved || !stage.approvedInputs) return { approved, stale: null, storyStale };
  const changedFields = changedInputs(stage.approvedInputs, castAndSetsApprovalInputs(project));
  return { approved, stale: changedFields.length ? withRevertible({ approvedAt: stage.approvedAt || null, changedFields }, stage.approvedValues) : null, storyStale };
}

// A treatment's per-shot entry and exit (scene.direction, treatment.js), as one storyboard transition line.
const sceneTransition = direction => [direction?.transitionIn && `Entry: ${direction.transitionIn}`, direction?.transitionOut && `Exit: ${direction.transitionOut}`]
  .filter(part => text(part)).join('. ');

/**
 * The storyboard row a Board scene with no draft shot of its own stands for:
 * its planned action, staging and camera, its treatment entry and exit as the
 * transition, the Cast & Sets world's camera and transition language where the
 * scene has none (unless the sheet was skipped; a photographic direction has
 * no world), else a plain cut, and the lyric lines it overlaps. Planning shots
 * after the art approval writes scenes without draft rows, so the storyboard
 * reads them this way until a director edits a shot; preparing the review
 * writes the same rows.
 */
function boardShotFromScene(project, scene) {
  const world = (project.castAndSets?.status !== 'skipped' && project.castAndSets?.direction?.world) || {};
  return {
    sceneId: scene.sceneId,
    lyricCueIds: cuesSungWithin(project.lyricCues, scene.startSec, scene.endSec).map(c => c.id),
    action: scene.visualIntent || scene.prompt || '', staging: scene.framePrompt || '',
    camera: shotCameraLabel(scene.camera) || scene.direction?.camera || world.camera || '', transition: sceneTransition(scene.direction) || world.transitions || 'Cut',
  };
}

/** The Board storyboard as reviewed: every draft shot, then a derived row for each scene that has none. */
export function boardStoryboard(project, storyboard = project.productionReview?.draft?.storyboard || []) {
  return [...storyboard, ...(project.scenes || []).filter(scene => !storyboard.some(shot => shot.sceneId === scene.sceneId))
    .map(scene => boardShotFromScene(project, scene))];
}

/** Draft rows still bound to a Board scene that no longer exists: leftovers from a cut, merge or re-plan. */
function staleStoryboardRows(project) {
  const draft = project.productionReview?.draft;
  if (!Array.isArray(draft?.storyboard) || draft.storyboardSource === 'document') return [];
  const ids = new Set((project.scenes || []).map(scene => scene.sceneId));
  return draft.storyboard.filter(shot => shot?.sceneId && !ids.has(shot.sceneId));
}

/** The project without its stale draft rows; unchanged when there are none. Unbound rows stay to be bound. */
export function dropStaleStoryboardRows(project) {
  const stale = staleStoryboardRows(project);
  if (!stale.length) return project;
  const draft = project.productionReview.draft;
  return { ...project, productionReview: { ...project.productionReview,
    draft: { ...draft, storyboard: draft.storyboard.filter(shot => !stale.includes(shot)) } } };
}

/**
 * Re-anchor the storyboard rows of `sceneIds` (every shot when null) to the
 * lyric lines sung over their scenes now, keeping each row's span in step with
 * its scene. A shot with no draft row already reads its anchors from its scene.
 * Returns the project unchanged when nothing moved.
 */
export function anchorShotsToSungLyrics(project, sceneIds = null) {
  const draft = project.productionReview?.draft;
  if (!Array.isArray(draft?.storyboard) || draft.storyboardSource === 'document') return project;
  const scenes = new Map((project.scenes || []).map(scene => [scene.sceneId, scene]));
  const cues = (project.lyricCues || []).filter(c => text(c.text));
  let moved = false;
  const storyboard = draft.storyboard.map(shot => {
    const scene = shot?.sceneId && scenes.get(shot.sceneId);
    if (!scene || (sceneIds && !sceneIds.includes(shot.sceneId))) return shot;
    const lyricCueIds = cuesSungWithin(cues, scene.startSec, scene.endSec).map(c => c.id);
    const span = 'startSec' in shot || 'endSec' in shot ? { startSec: scene.startSec, endSec: scene.endSec } : {};
    const same = lyricCueIds.length === (shot.lyricCueIds || []).length && lyricCueIds.every((id, i) => shot.lyricCueIds[i] === id)
      && Object.entries(span).every(([key, value]) => shot[key] === value);
    if (same) return shot;
    moved = true;
    return { ...shot, ...span, lyricCueIds };
  });
  return moved ? { ...project, productionReview: { ...project.productionReview, draft: { ...draft, storyboard } } } : project;
}

const unresolvedFeedback = (review, stage) => (review.feedback || []).filter(f => f.stage === stage && f.decision === 'request-changes' && !f.resolvedAt);
const feedbackProblems = (review, stage) => unresolvedFeedback(review, stage).map(f => `Resolve ${stage} feedback for ${f.target}: ${f.text}`);

const ART_GUIDE_FIELDS = [['cast', 'Cast guide'], ['environments', 'Environment guide'],
  ['visualLanguage', 'Visual guide and mood board'], ['motionLanguage', 'Motion guide']];
const GUIDE_MIME_TYPES = ['text/html', 'image/png', 'image/jpeg'];

// Art direction: open change requests, every guide written, and a visual sheet the render mode accepts.
function artDirectionProblems(project, review, draft) {
  const problems = feedbackProblems(review, 'art');
  for (const [key, label] of ART_GUIDE_FIELDS) if (!text(draft[key])) problems.push(`${label} needs editable direction.`);
  const guide = artifact(project, draft.guideArtifactId);
  if (!GUIDE_MIME_TYPES.includes(guide?.mimeType)) problems.push('Attach a visual cast/environment sheet from Development artifacts.');
  if (guide?.mimeType?.startsWith('image/') && !musicVideoAllowsMedia(project, 'image')) problems.push('Code only requires a code-authored visual guide; select a compatible Development artifact.');
  return problems;
}

// Lyric timing: an instrumental has no sung lines; a song with lyrics needs them imported, aligned
// to the current master, and every line's words bounded inside the song.
function lyricTimingProblems(review, draft, cues, duration, alignmentBasis) {
  if (draft.lyricsMode === 'instrumental') return cues.length ? ['This song has lyrics. Remove the instrumental exception or correct the song data.'] : [];
  const problems = [];
  if (!cues.length) problems.push('Import lyrics and align them to the current vocal; missing lyrics are not an instrumental.');
  if (draft.timingStatus !== 'verified' || review.alignmentBasis !== alignmentBasis) problems.push(ALIGNMENT_UNVERIFIED_PROBLEM);
  // A line is judged on the span its words give it (lyricCueSpan), the span the renderer shows:
  // forced-aligned words may run a little past a line window taken from the song's line timestamps.
  if (cues.some(c => !c.words?.length || c.words.some(w => !(Number.isFinite(w.startSec) && w.endSec > w.startSec))
    || !(lyricCueSpan(c)?.startSec >= 0 && lyricCueSpan(c).endSec <= duration))) {
    problems.push('Every lyric line needs bounded, positive-duration word timings; repair zero-length or missing words.');
  }
  return problems;
}

// Where the shots come from: a document manifest imported from the current authored source and
// master, or Board rows each bound to its own live scene.
function shotSourceProblems(project, review, draft, scenes, documentShots, staleRows) {
  const problems = [];
  if (documentShots) {
    if (project.composition?.mode !== 'document' || !project.composition.document?.directory
      || review.documentStoryboard?.basis !== documentStoryboardBasis(project)) {
      problems.push('Import a shot manifest from the current authored document and master audio. Reauthor or reimport after source, timing or shot changes.');
    }
    if (new Set(scenes.map(s => s.id)).size !== scenes.length || scenes.some(s => !text(s.id))) problems.push('Document shots need unique source IDs.');
    return problems;
  }
  if (draft.storyboard?.some(shot => !shot.sceneId)) problems.push('Bind every draft shot to a real Board scene.');
  if (staleRows.length) problems.push(`Remove ${staleRows.length} storyboard row${staleRows.length === 1 ? '' : 's'} left from deleted shots.`);
  if (new Set((draft.storyboard || []).map(s => s.sceneId)).size !== draft.storyboard?.length) problems.push('Each storyboard shot must bind to its own Board scene.');
  return problems;
}

const FRAME = 1 / 24;
// Each place the shots leave the song uncovered or covered twice, on the shot where it happens, so the checklist can name it.
function storyboardCoverage(timedScenes, duration) {
  if (!timedScenes.length) return [];
  const coverage = [];
  const [first, last] = [timedScenes[0], timedScenes.at(-1)];
  if (first.startSec > FRAME) coverage.push({ sceneId: first.sceneId, issue: 'late-start', startSec: 0, endSec: first.startSec });
  timedScenes.forEach((s, i) => {
    const prev = timedScenes[i - 1];
    if (!prev || Math.abs(s.startSec - prev.endSec) <= FRAME) return;
    coverage.push({ sceneId: s.sceneId, issue: s.startSec > prev.endSec ? 'gap' : 'overlap',
      startSec: Math.min(s.startSec, prev.endSec), endSec: Math.max(s.startSec, prev.endSec) });
  });
  if (Math.abs(last.endSec - duration) > FRAME) coverage.push({ sceneId: last.sceneId, issue: last.endSec > duration ? 'past-end' : 'early-end',
    startSec: Math.min(last.endSec, duration), endSec: Math.max(last.endSec, duration) });
  return coverage;
}

// A Board shot with no camera note is a valid choice (a cutaway rendered from its start frame plays
// whatever motion its clip has); camera variety stays advice. Document shots spell out every field.
const BOARD_SHOT_FIELDS = ['action', 'staging', 'transition'];
const DOCUMENT_SHOT_FIELDS = ['action', 'staging', 'camera', 'transition'];

/**
 * Every shot's open work: the timing or storyboard fields it is missing
 * (`incompleteShots`), and lyric anchors that disagree with the lines sung over it
 * (`lyricAnchors`, with both sides so the checklist can show and fix them), each
 * also named in `problems`.
 */
function shotProblems(project, draft, scenes, { documentShots, cues, duration }) {
  const problems = [];
  const incompleteShots = [];
  const lyricAnchors = [];
  for (const scene of scenes) {
    const shot = documentShots ? scene : draft.storyboard?.find(s => s.sceneId === scene.sceneId) || boardShotFromScene(project, scene);
    const missing = !(Number.isFinite(scene.startSec) && scene.endSec > scene.startSec) ? ['timing']
      : scene.endSec > duration ? ['an end inside the song'] : [];
    missing.push(...(documentShots ? DOCUMENT_SHOT_FIELDS : BOARD_SHOT_FIELDS).filter(key => !text(shot?.[key])));
    if (missing.length) {
      problems.push(`Complete timing, action, staging, camera and transition for ${scene.label || 'each shot'}.`);
      incompleteShots.push({ sceneId: scene.sceneId, missing });
    }
    // A shot anchors every line sung over it, counted from the line's first sung word (lib/musicVideoLyricAnchors.js).
    const sung = cuesSungWithin(cues, scene.startSec, scene.endSec);
    if (sung.some(c => !shot?.lyricCueIds?.includes(c.id))
      || shot?.lyricCueIds?.some(id => !cues.some(c => c.id === id))) {
      problems.push(`Review lyric anchors for ${scene.label || 'each shot'}.`);
      if (!documentShots) lyricAnchors.push({ sceneId: scene.sceneId, sung: sung.map(c => c.text),
        anchored: (shot?.lyricCueIds || []).map(id => cues.find(c => c.id === id)?.text).filter(Boolean) });
    }
  }
  return { problems, incompleteShots, lyricAnchors };
}

// The animated proof: a current chorus excerpt rendered with the master and watched once the storyboard is approved.
function proofReadiness(project, review, basis, storyboardApproved) {
  const proof = review.proof;
  const excerpt = (project.excerpts || []).find(e => e.id === proof?.excerptId);
  const problems = feedbackProblems(review, 'proof');
  if (!storyboardApproved) problems.push('Approve the current lyric-timed storyboard before the animated proof.');
  if (!proof || proof.basis !== basis.proof || excerpt?.status !== 'complete' || !excerpt?.filename) {
    problems.push('Render and watch a current animated chorus proof with the master song.');
  }
  const approved = !problems.length && hasProofEvidence(review.approvals?.proof?.proofReview) && review.approvals?.proof?.basis === hash({ basis: basis.proof, excerptId: excerpt.id, filename: excerpt.filename });
  return { approved, problems, excerptId: excerpt?.id || null };
}

const alignmentStatus = (review, draft, alignmentBasis) => draft.lyricsMode === 'instrumental' ? 'instrumental'
  : draft.timingStatus !== 'verified' ? 'provisional' : review.alignmentBasis === alignmentBasis ? 'verified' : 'stale';

export function productionReadiness(project) {
  const review = project.productionReview || {};
  const draft = review.draft || {};
  const basis = productionReviewBasis(project);
  const alignmentBasis = productionAlignmentBasis(project);
  const inputs = productionApprovalInputs(project);
  const artProblems = artDirectionProblems(project, review, draft);
  const artApproved = !artProblems.length && review.approvals?.art?.basis === basis.art;
  const boardProblems = feedbackProblems(review, 'storyboard');
  if (!artApproved) boardProblems.push('Review and approve the current art direction first.');
  const duration = project.audioAnalysis?.durationSec;
  if (!(duration > 0)) boardProblems.push('Analyze the current master song.');
  const cues = (project.lyricCues || []).filter(c => text(c.text));
  boardProblems.push(...lyricTimingProblems(review, draft, cues, duration, alignmentBasis));
  const documentShots = draft.storyboardSource === 'document';
  // Each row left from a deleted shot, by its span and action, so the checklist can name it and remove them all.
  const staleRows = documentShots ? [] : staleStoryboardRows(project)
    .map(shot => ({ id: shot.id || null, sceneId: shot.sceneId, startSec: shot.startSec ?? null, endSec: shot.endSec ?? null, action: shot.action || '' }));
  // Shots before the song (the cold open) have no song time to cover or anchor lyrics to.
  const scenes = documentShots ? (draft.storyboard || []).map(shot => ({ ...shot, sceneId: shot.id, label: shot.id })) : songScenes(project);
  boardProblems.push(...shotSourceProblems(project, review, draft, scenes, documentShots, staleRows));
  if (!scenes.length) boardProblems.push('Create a timed shot storyboard.');
  const timedScenes = scenes.filter(s => Number.isFinite(s.startSec) && s.endSec > s.startSec).sort((a, b) => a.startSec - b.startSec);
  const coverage = storyboardCoverage(timedScenes, duration);
  if (coverage.length) boardProblems.push('Storyboard shots must cover the master without unintended gaps or overlaps.');
  const shots = shotProblems(project, draft, scenes, { documentShots, cues, duration });
  boardProblems.push(...shots.problems);
  // Once any shot has been locked, the board is approved exactly when every shot is.
  const locks = shotLocks(project);
  const byShot = !!locks && Object.keys(review.shotApprovals || {}).length > 0;
  const unlocked = locks ? Object.keys(locks).filter(id => locks[id] !== 'locked') : [];
  const clips = clipLocks(project, locks);
  // A current whole-board approval is independent of old per-shot locks. Keep
  // previously completed per-shot reviews valid for projects saved before this change.
  const storyboardApproved = !boardProblems.length && (storyboardApprovalCurrent(review.approvals?.storyboard, basis)
    || (byShot && scenes.length > 0 && !unlocked.length));
  const camera = storyboardCameraReport(scenes, documentShots ? null : boardStoryboard(project));
  const proof = proofReadiness(project, review, basis, storyboardApproved);
  return { basis, inputs, alignment: { basis: alignmentBasis, status: alignmentStatus(review, draft, alignmentBasis) }, documentShotImport: { documentDirectory: project.composition?.document?.directory || null, audioBasis: alignmentBasis }, art: { approved: artApproved, problems: [...new Set(artProblems)], stale: artApproved ? null : staleApproval(project, 'art', basis.art, inputs) },
    // The overlay text check is advice on the storyboard, like camera variety; it never blocks approval.
    storyboard: { approved: storyboardApproved, problems: [...new Set(boardProblems)], camera,
      // Board shots as reviewed, derived rows included, so the editor and approval card show what the gate checked.
      shots: documentShots ? null : boardStoryboard(project), lyricAnchors: shots.lyricAnchors, staleRows, coverage, incompleteShots: shots.incompleteShots, text: overlayTextReport(project, overlayTextBasis), stale: storyboardApproved ? null : staleApproval(project, 'storyboard', basis.storyboard, inputs),
      shotLocks: locks, unlocked: byShot ? unlocked : [], clipLocks: clips,
      // Video shots whose clip is not locked yet: the board is finished when every shot is fully locked.
      clipsUnlocked: clips ? Object.keys(clips).filter(id => clips[id] && clips[id] !== 'locked') : [] },
    proof: { ...proof, stale: proof.approved ? null : staleApproval(project, 'proof', basis.proof, inputs) },
    castAndSets: castAndSetsApproval(project),
    // The animated proof is optional review evidence: the approved storyboard is what the final render needs.
    readyForProduction: storyboardApproved };
}

/**
 * Non-blocking camera-variety notes for the storyboard (#10589). A Board
 * scene's planned `camera.move` wins; otherwise the draft shot's free-text
 * camera is matched against the catalog (document shots use their own text).
 */
function storyboardCameraReport(scenes, draftShots) {
  const shots = scenes.filter(s => Number.isFinite(s.startSec)).sort((a, b) => a.startSec - b.startSec).map((scene) => {
    const shot = draftShots ? draftShots.find(s => s.sceneId === scene.sceneId) : scene;
    const planned = getCameraMovement(scene.camera?.move)?.value;
    return { label: scene.label || scene.sceneId, move: planned || cameraMovementFromText(typeof shot?.camera === 'string' ? shot.camera : ''),
      sectionKey: scene.sectionIndex ?? scene.sectionLabel ?? null, sectionLabel: scene.sectionLabel || '', startSec: scene.startSec };
  });
  return cameraVarietyReport(shots);
}

const refuseRevert = (message, code) => new ServerError(message, { status: 409, code });

function restoreScenePrompt(project, value) {
  if (!project.scenes?.some(s => s.sceneId === value.sceneId)) throw refuseRevert('That scene no longer exists, so its prompt cannot be restored.', 'MUSIC_VIDEO_REVERT_UNAVAILABLE');
  return { ...project, scenes: project.scenes.map(s => s.sceneId === value.sceneId ? { ...s, ...Object.fromEntries(SCENE_PROMPT_KEYS.map(k => [k, value[k]])) } : s) };
}

function restoreCastAndSets(project, field, value) {
  const concept = objectConcept(project);
  if (field === 'concept') return { ...project, concept: { ...value, ...pick(concept, ['subjects', ...CAST_SETS_CONCEPT_STYLE_KEYS]) } };
  if (field === 'subjects') return { ...project, concept: { ...concept, subjects: keepCatalogFields(value, concept.subjects) } };
  const { styleReferences, ...rest } = value;
  const nextConcept = { ...concept };
  for (const k of CAST_SETS_CONCEPT_STYLE_KEYS) delete nextConcept[k];
  return { ...project, concept: { ...nextConcept, ...pick(rest, CAST_SETS_CONCEPT_STYLE_KEYS) },
    visualSpec: { ...project.visualSpec, ...pick(rest, CAST_SETS_SPEC_STYLE_KEYS) }, styleReferences };
}

/**
 * Write one changed input back to the value an approval was granted on (#10241).
 * Refuses (409) unless the approval is stale, that input's hash moved, and a
 * value was recorded for it; a legacy approval or an oversized/media input has none.
 */
export function revertApprovedInput(project, { stage, field }) {
  const unavailable = reason => refuseRevert(reason, 'MUSIC_VIDEO_REVERT_UNAVAILABLE');
  const cast = stage === 'castAndSets';
  let record;
  let now;
  if (cast) {
    const approval = project.castAndSets;
    if (approval?.status !== 'approved') throw unavailable('The Cast & Sets check-in is not approved.');
    record = { inputs: approval.approvedInputs, values: approval.approvedValues };
    now = castAndSetsApprovalInputs(project);
  } else {
    const readiness = productionReadiness(project);
    if (readiness[stage].approved) throw unavailable('This approval is current; there is nothing to revert.');
    record = project.productionReview?.approvals?.[stage];
    now = readiness.inputs[stage];
  }
  if (!record?.inputs || changedInputs(record.inputs, now).includes(field) === false) throw unavailable('That input has not changed since the approval.');
  const value = record.values?.[field];
  if (value === undefined) throw unavailable('The approved value of that input was not kept, so it cannot be restored.');
  if (cast) return restoreCastAndSets(project, field, value);
  if (field === 'concept') return { ...project, concept: value?.subjects ? { ...value, subjects: keepCatalogFields(value.subjects, project.concept?.subjects) } : value };
  if (DRAFT_FIELD_LABELS[field]) return { ...project, productionReview: { ...project.productionReview,
    draft: { ...project.productionReview?.draft, [DRAFT_FIELD_LABELS[field]]: value } } };
  if (SCENE_PROMPT_LABEL.test(field)) return restoreScenePrompt(project, value);
  throw unavailable('That input cannot be reverted.');
}

export function assertProductionApproval(project, stage = 'proof') {
  const readiness = productionReadiness(project);
  if (!readiness[stage].approved) throw new ServerError(
    readiness[stage].problems[0] || `A reviewer must approve the current ${stage === 'art' ? 'art direction' : stage} in Production review.`,
    { status: 409, code: 'MUSIC_VIDEO_APPROVAL_REQUIRED', context: { stage, readiness } });
}

/** Evidence is bound to the exact revision and excerpt. Machine review never
 * claims human playback; rendering alone is not a review. */
export function approveProductionStage(project, { stage, basis, proofReview, approvedBy, reviewer }) {
  const readiness = productionReadiness(project);
  let expected = stage === 'proof'
    ? hash({ basis: readiness.basis.proof, excerptId: project.productionReview?.proof?.excerptId,
      filename: project.excerpts?.find(e => e.id === project.productionReview?.proof?.excerptId)?.filename })
    : readiness.basis[stage];
  if (basis !== readiness.basis[stage]) throw new ServerError('This revision changed while you were reviewing it. Review it again.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
  if (readiness[stage].problems.length) throw new ServerError(readiness[stage].problems.join(' '), { status: 409, code: 'MUSIC_VIDEO_REVIEW_INCOMPLETE' });
  if (stage === 'proof') {
    const excerpt = project.excerpts?.find(e => e.id === project.productionReview?.proof?.excerptId);
    if (!hasProofEvidence(proofReview)) {
      throw new ServerError('Review this proof with audio and record the energy comparison and timecoded choreography notes. Machine reviews also require visual, audio and limitation evidence.', { status: 409, code: 'MUSIC_VIDEO_PROOF_REVIEW_REQUIRED' });
    }
    if (proofReview.excerptId !== excerpt?.id || proofReview.filename !== excerpt?.filename || !excerpt?.filename) {
      throw new ServerError('The rendered proof changed. Play and review the new excerpt before approving.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
    }
  }
  // Approving a Board storyboard writes the derived rows it was judged on (boardStoryboard) into the
  // draft, so code, renders and the making-of read the approved shots. The approval binds to that revision.
  if (stage === 'storyboard' && project.productionReview?.draft?.storyboardSource !== 'document' && (project.scenes || []).length) {
    project = { ...project, productionReview: { ...project.productionReview,
      draft: { ...project.productionReview?.draft, storyboard: boardStoryboard(project) } } };
    expected = productionReviewBasis(project).storyboard;
  }
  const decision = { stage, basis: expected, ...(stage === 'storyboard' ? { shotsBasis: productionReviewBasis(project).storyboardShots } : {}), inputs: productionApprovalInputs(project)[stage], values: productionApprovalValues(project, stage), approvedAt: new Date().toISOString(),
    ...(approvedBy ? { approvedBy } : {}), ...(reviewer ? { reviewer: structuredClone(reviewer) } : {}),
    ...(stage === 'proof' ? { proofReview: structuredClone(proofReview) } : {}) };
  return { ...project, productionReview: { ...project.productionReview,
    approvalHistory: [...(project.productionReview?.approvalHistory || []), decision].slice(-MAX_APPROVAL_HISTORY),
    reviewedRevisions: pruneReviewedRevisions({ ...omitKey(project.productionReview?.reviewedRevisions, basis), [basis]: { draft: structuredClone(project.productionReview?.draft || {}), scenes: structuredClone(project.scenes || []), proof: structuredClone(project.productionReview?.proof || null), capturedAt: new Date().toISOString() } }, project.productionReview?.feedback),
    approvals: { ...project.productionReview?.approvals, [stage]: decision } } };
}

/**
 * Re-bind the stages that were approved before a machine-only change (a legacy
 * footage project switched to compose its shots) onto the changed project, so
 * a change no one reviewed does not stale an approval no one revoked. A stage
 * that was not approved stays as it was.
 */
export function carryProductionApprovals(before, after, reason) {
  const was = productionReadiness(before);
  const basis = productionReviewBasis(after);
  const inputs = productionApprovalInputs(after);
  const proofExcerpt = after.excerpts?.find(e => e.id === after.productionReview?.proof?.excerptId);
  const approvals = { ...after.productionReview?.approvals };
  for (const stage of ['art', 'storyboard', 'proof']) {
    if (!was[stage]?.approved || !approvals[stage]) continue;
    const next = stage === 'proof' ? hash({ basis: basis.proof, excerptId: proofExcerpt?.id, filename: proofExcerpt?.filename }) : basis[stage];
    approvals[stage] = { ...approvals[stage], basis: next, ...(stage === 'storyboard' ? { shotsBasis: basis.storyboardShots } : {}), inputs: inputs[stage], carriedOver: { reason, at: new Date().toISOString() } };
  }
  return { ...after, productionReview: { ...after.productionReview, approvals } };
}

/**
 * Keep a current storyboard approval across a director's own shot edit (a cut,
 * a merge, a retime or a reworded prompt): it adds no shot or lyric the
 * approval did not already cover, so the director is not asked to approve the
 * same board again. The proof stays bound to its render and stales
 * as before. Returns `after` unchanged when the storyboard was not approved on
 * `before`'s current revision.
 */
export function carryStoryboardApproval(before, after, reason) {
  const approval = before.productionReview?.approvals?.storyboard;
  if (!storyboardApprovalCurrent(approval, productionReviewBasis(before))) return after;
  const basis = productionReviewBasis(after);
  const approvals = { ...after.productionReview?.approvals, storyboard: { ...approval,
    basis: basis.storyboard, shotsBasis: basis.storyboardShots, inputs: productionApprovalInputs(after).storyboard,
    carriedOver: { reason, at: new Date().toISOString() } } };
  return { ...after, productionReview: { ...after.productionReview, approvals } };
}

// A refreshed snapshot is re-inserted last so insertion order doubles as recency.
const omitKey = (obj, key) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => k !== key));
const MAX_APPROVAL_HISTORY = 50;
const MAX_RECENT_REVISIONS = 5;

/**
 * Bound the reviewed-revision snapshots, which ride every project write and sync:
 * keep the newest few plus every snapshot an open comment still points at.
 */
function pruneReviewedRevisions(snapshots, feedback) {
  const keep = new Set((feedback || []).filter(f => !f.resolvedAt).map(f => f.basis));
  // Reversed first so a same-millisecond tie keeps the later-inserted (newer) snapshot.
  Object.entries(snapshots).reverse().sort(([, a], [, b]) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
    .slice(0, MAX_RECENT_REVISIONS).forEach(([key]) => keep.add(key));
  return Object.fromEntries(Object.entries(snapshots).filter(([key]) => keep.has(key)));
}

/** Comments retain the exact reviewed draft, even after a replacement import. */
export function recordProductionFeedback(project, input) {
  const review = project.productionReview || {};
  const basis = productionReviewBasis(project)[input.stage];
  if (input.basis !== basis) throw new ServerError('This revision changed. Review the current revision before commenting.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
  const snapshots = { ...review.reviewedRevisions };
  if (!snapshots[basis]) snapshots[basis] = { draft: structuredClone(review.draft || {}),
    scenes: structuredClone(project.scenes || []), capturedAt: new Date().toISOString() };
  const entry = { id: randomUUID(), stage: input.stage, target: input.target, text: input.text,
    decision: input.decision, basis, createdAt: new Date().toISOString() };
  const approvals = { ...review.approvals };
  if (input.decision === 'request-changes') {
    for (const stage of ['art', 'storyboard', 'proof'].slice(['art', 'storyboard', 'proof'].indexOf(input.stage))) delete approvals[stage];
  }
  const feedback = [...(review.feedback || []), entry];
  return { ...project, productionReview: { ...review, approvals, reviewedRevisions: pruneReviewedRevisions(snapshots, feedback), feedback } };
}

export function resolveProductionFeedback(project, { feedbackId, resolution, reviewer }) {
  const review = project.productionReview || {};
  const entry = review.feedback?.find(f => f.id === feedbackId);
  if (!entry || entry.resolvedAt) throw new ServerError('Open feedback not found.', { status: 409, code: 'MUSIC_VIDEO_FEEDBACK_CLOSED' });
  return { ...project, productionReview: { ...review, feedback: review.feedback.map(f => f.id === feedbackId
    ? { ...f, resolution, ...(reviewer ? { resolvedBy: structuredClone(reviewer) } : {}), resolvedAt: new Date().toISOString(), resolvedBasis: productionReviewBasis(project)[f.stage] } : f) } };
}

export function productionFeedbackContext(project) {
  const feedback = (project.productionReview?.feedback || []).filter(f => !f.resolvedAt);
  return feedback.length ? `\nUNRESOLVED REVIEW FEEDBACK (retain until an authenticated reviewer resolves it):\n${feedback.map(f => `${f.stage} / ${f.target} / ${f.decision}: ${f.text}`).join('\n')}` : '';
}


/** A live capture keeps its slot; failed, canceled or missing evidence is retryable on explicit Resume. */
export function productionProofNeedsRender(project, basis) {
  const proof = project.productionReview?.proof;
  const excerpt = project.excerpts?.find(e => e.id === proof?.excerptId);
  if (excerpt?.status === 'rendering') return false;
  return !proof || proof.basis !== basis || excerpt?.status !== 'complete' || !excerpt.filename;
}

/** Keep the chorus in frame even when it starts near the end of the master. */
export function productionProofWindow(project) {
  const duration = project.audioAnalysis.durationSec;
  const chorus = project.audioAnalysis.sections?.find(s => /chorus|hook/i.test(s.label || s.type || ''));
  const startSec = Math.min(Math.max(0, chorus?.startSec || 0), Math.max(0, duration - 20));
  return { startSec, endSec: Math.min(startSec + 20, duration) };
}
