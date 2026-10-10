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
  document: project.composition?.document?.directory || null, aspect: musicVideoAspect(project), source: source(project),
  textCues: project.composition?.textCues ?? null, overlay: project.composition?.overlay ?? null, style: project.composition?.style ?? null,
  scenes: (project.scenes || []).map(({ sceneId, startSec, endSec, textZone, lyricRole, lyricText, cardText, referenceImageId, videoHistoryId, performanceEdit, visualLayer }) =>
    ({ sceneId, startSec, endSec, textZone, lyricRole, lyricText, cardText, referenceImageId, videoHistoryId, performanceEdit, visualLayer })),
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

/**
 * Seed the empty art-direction draft fields (and the visual guide) from a
 * Cast & Sets sheet. Text the director already typed — and a guide already
 * chosen — is never overwritten, and a document-shot draft is left alone.
 * Seeding supplies editable content only; it never records an approval.
 */
export function seedArtDraft(project, stage = project.castAndSets) {
  const prior = project.productionReview?.draft || {};
  if (prior.storyboardSource === 'document' || !stage?.direction) return project;
  const d = stage.direction;
  const keep = (key, fallback) => text(prior[key]) ? prior[key] : fallback;
  const draft = { lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [], ...prior,
    cast: keep('cast', describeDirection(d.protagonist)),
    environments: keep('environments', describeDirection(d.sets)),
    visualLanguage: keep('visualLanguage', describeDirection({ look: d.look, palette: d.protagonist?.palette, world: d.world })),
    motionLanguage: keep('motionLanguage', describeDirection({ movement: d.protagonist?.movement, camera: d.world?.camera, transitions: d.world?.transitions })),
    guideArtifactId: prior.guideArtifactId || (artifact(project, stage.artifactId) ? stage.artifactId : null) };
  return { ...project, productionReview: { ...project.productionReview, draft } };
}

export function productionReviewBasis(project) {
  const draft = project.productionReview?.draft || {};
  const art = hash({ projectId: project.id, mediaMode: project.mediaMode, authoringRenderer: project.composition?.authoringRenderer, mode: project.composition?.mode, policy: project.productionPolicy,
    concept: project.concept, visualSpec: project.visualSpec, styleReferences: project.styleReferences,
    direction: project.castAndSets?.direction,
    cast: draft.cast, environments: draft.environments, visualLanguage: draft.visualLanguage,
    motionLanguage: draft.motionLanguage, implementationPlan: draft.implementationPlan, guide: artifactBasis(artifact(project, draft.guideArtifactId)) });
  const storyboard = hash({ art, source: source(project), lyricsMode: draft.lyricsMode,
    timingStatus: draft.timingStatus, timingNotes: draft.timingNotes, storyboard: draft.storyboard,
    storyboardSource: draft.storyboardSource || 'board', documentStoryboard: project.productionReview?.documentStoryboard,
    document: draft.storyboardSource === 'document' ? project.composition?.document : null,
    // A planned camera (#10589) joins the hash only when set, so older approvals stay current.
    scenes: (project.scenes || []).map(({ sceneId, startSec, endSec, lyricText, visualIntent, prompt, framePrompt, camera }) =>
      ({ sceneId, startSec, endSec, lyricText, visualIntent, prompt, framePrompt, ...(camera ? { camera } : {}) })), treatment: project.treatment });
  const window = project.productionReview?.proof;
  const proof = hash({ storyboard, composition: project.composition,
    window: window && { startSec: window.startSec, endSec: window.endSec },
    scenes: (project.scenes || []).filter(s => !window || s.startSec < window.endSec && s.endSec > window.startSec)
      .map(({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer }) =>
        ({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer })),
    soundBed: project.soundBed, videoSettings: project.videoSettings });
  return { art, storyboard, proof };
}

/** Labeled per-input hashes so a stale approval can name what changed since. */
const h = v => hash(v ?? null);
function productionApprovalInputs(project) {
  const draft = project.productionReview?.draft || {};
  const art = {
    concept: h(project.concept), 'visual spec': h(project.visualSpec), 'style references': h(project.styleReferences),
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
    takes: h((project.scenes || []).map(({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer }) =>
      ({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer }))),
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
    subjects: h([subjects || [], (spec.references || []).map(r => r?.imageId || null)]),
    song: h([project.trackId || null, project.uploadedAudioFilename || null]),
  };
}

/**
 * The Cast & Sets check-in as an approval: `{ approved, stale }`. An approved
 * stage stays approved when its inputs move (its references still condition
 * the frames) but reports what changed since. A stage approved before inputs
 * were recorded has no basis to compare and reports no staleness.
 */
function castAndSetsApproval(project) {
  const stage = project.castAndSets;
  const approved = stage?.status === 'approved';
  if (!approved || !stage.approvedInputs) return { approved, stale: null };
  const changedFields = changedInputs(stage.approvedInputs, castAndSetsApprovalInputs(project));
  return { approved, stale: changedFields.length ? withRevertible({ approvedAt: stage.approvedAt || null, changedFields }, stage.approvedValues) : null };
}

/**
 * The storyboard row a Board scene with no draft shot of its own stands for:
 * its planned action, staging and camera, the Cast & Sets world's camera and
 * transition language where the scene has none (unless the sheet was skipped),
 * and the lyric lines it overlaps. Planning shots after the art approval
 * writes scenes without draft rows, so the storyboard reads them this way
 * until a director edits a shot; preparing the review writes the same rows.
 */
function boardShotFromScene(project, scene) {
  const world = (project.castAndSets?.status !== 'skipped' && project.castAndSets?.direction?.world) || {};
  return {
    sceneId: scene.sceneId,
    lyricCueIds: (project.lyricCues || []).filter(c => c.startSec < scene.endSec && c.endSec > scene.startSec).map(c => c.id),
    action: scene.visualIntent || scene.prompt || '', staging: scene.framePrompt || '',
    camera: shotCameraLabel(scene.camera) || scene.direction?.camera || world.camera || '', transition: world.transitions || '',
  };
}

/** The Board storyboard as reviewed: every draft shot, then a derived row for each scene that has none. */
export function boardStoryboard(project, storyboard = project.productionReview?.draft?.storyboard || []) {
  return [...storyboard, ...(project.scenes || []).filter(scene => !storyboard.some(shot => shot.sceneId === scene.sceneId))
    .map(scene => boardShotFromScene(project, scene))];
}

export function productionReadiness(project) {
  const review = project.productionReview || {};
  const draft = review.draft || {};
  const basis = productionReviewBasis(project);
  const alignmentBasis = productionAlignmentBasis(project);
  const inputs = productionApprovalInputs(project);
  const unresolved = stage => (review.feedback || []).filter(f => f.stage === stage && f.decision === 'request-changes' && !f.resolvedAt);
  const artProblems = unresolved('art').map(f => `Resolve art feedback for ${f.target}: ${f.text}`);
  for (const [key, label] of [['cast', 'Cast guide'], ['environments', 'Environment guide'],
    ['visualLanguage', 'Visual guide and mood board'], ['motionLanguage', 'Motion guide']]) {
    if (!text(draft[key])) artProblems.push(`${label} needs editable direction.`);
  }
  if (!['text/html', 'image/png', 'image/jpeg'].includes(artifact(project, draft.guideArtifactId)?.mimeType)) artProblems.push('Attach a visual cast/environment sheet from Development artifacts.');
  if (artifact(project, draft.guideArtifactId)?.mimeType?.startsWith('image/') && !musicVideoAllowsMedia(project, 'image')) artProblems.push('Code only requires a code-authored visual guide; select a compatible Development artifact.');
  const artApproved = !artProblems.length && review.approvals?.art?.basis === basis.art;
  const boardProblems = unresolved('storyboard').map(f => `Resolve storyboard feedback for ${f.target}: ${f.text}`);
  if (!artApproved) boardProblems.push('Review and approve the current art direction first.');
  const duration = project.audioAnalysis?.durationSec;
  if (!(duration > 0)) boardProblems.push('Analyze the current master song.');
  const cues = (project.lyricCues || []).filter(c => text(c.text));
  if (draft.lyricsMode === 'instrumental') {
    if (cues.length) boardProblems.push('This song has lyrics. Remove the instrumental exception or correct the song data.');
  } else {
    if (!cues.length) boardProblems.push('Import lyrics and align them to the current vocal; missing lyrics are not an instrumental.');
    if (draft.timingStatus !== 'verified' || review.alignmentBasis !== alignmentBasis) boardProblems.push(ALIGNMENT_UNVERIFIED_PROBLEM);
    // A line is judged on the span its words give it (lyricCueSpan), the span the renderer shows:
    // forced-aligned words may run a little past a line window taken from the song's line timestamps.
    if (cues.some(c => !c.words?.length || c.words.some(w => !(Number.isFinite(w.startSec) && w.endSec > w.startSec))
      || !(lyricCueSpan(c)?.endSec <= duration))) {
      boardProblems.push('Every lyric line needs bounded, positive-duration word timings; repair zero-length or missing words.');
    }
  }
  const documentShots = draft.storyboardSource === 'document';
  const scenes = documentShots ? (draft.storyboard || []).map(shot => ({ ...shot, sceneId: shot.id, label: shot.id })) : project.scenes || [];
  if (documentShots) {
    if (project.composition?.mode !== 'document' || !project.composition.document?.directory
      || review.documentStoryboard?.basis !== documentStoryboardBasis(project)) {
      boardProblems.push('Import a shot manifest from the current authored document and master audio. Reauthor or reimport after source, timing or shot changes.');
    }
    if (new Set(scenes.map(s => s.id)).size !== scenes.length || scenes.some(s => !text(s.id))) boardProblems.push('Document shots need unique source IDs.');
  } else {
    if (draft.storyboard?.some(shot => !shot.sceneId || !scenes.some(s => s.sceneId === shot.sceneId))) boardProblems.push('Bind every draft shot to a real Board scene.');
    if (new Set((draft.storyboard || []).map(s => s.sceneId)).size !== draft.storyboard?.length) boardProblems.push('Each storyboard shot must bind to its own Board scene.');
  }
  if (!scenes.length) boardProblems.push('Create a timed shot storyboard.');
  const timedScenes = scenes.filter(s => Number.isFinite(s.startSec) && s.endSec > s.startSec).sort((a, b) => a.startSec - b.startSec);
  if (timedScenes.length && (timedScenes[0].startSec > 1 / 24
    || Math.abs(timedScenes.at(-1).endSec - duration) > 1 / 24
    || timedScenes.some((s, i) => i > 0 && Math.abs(s.startSec - timedScenes[i - 1].endSec) > 1 / 24))) {
    boardProblems.push('Storyboard shots must cover the master without unintended gaps or overlaps.');
  }
  for (const scene of scenes) {
    const shot = documentShots ? scene : draft.storyboard?.find(s => s.sceneId === scene.sceneId) || boardShotFromScene(project, scene);
    if (!(Number.isFinite(scene.startSec) && scene.endSec > scene.startSec && scene.endSec <= duration)
      || !shot || ['action', 'staging', 'camera', 'transition'].some(key => !text(shot[key]))) {
      boardProblems.push(`Complete timing, action, staging, camera and transition for ${scene.label || 'each shot'}.`);
    }
    const overlapping = cues.filter(c => c.startSec < scene.endSec && c.endSec > scene.startSec);
    if (overlapping.some(c => !shot?.lyricCueIds?.includes(c.id))
      || shot?.lyricCueIds?.some(id => !cues.some(c => c.id === id))) boardProblems.push(`Review lyric anchors for ${scene.label || 'each shot'}.`);
  }
  const storyboardApproved = !boardProblems.length && review.approvals?.storyboard?.basis === basis.storyboard;
  const camera = storyboardCameraReport(scenes, documentShots ? null : boardStoryboard(project));
  const proof = review.proof;
  const excerpt = (project.excerpts || []).find(e => e.id === proof?.excerptId);
  const proofProblems = unresolved('proof').map(f => `Resolve proof feedback for ${f.target}: ${f.text}`);
  if (!storyboardApproved) proofProblems.push('Approve the current lyric-timed storyboard before the animated proof.');
  if (!proof || proof.basis !== basis.proof || excerpt?.status !== 'complete' || !excerpt?.filename) {
    proofProblems.push('Render and watch a current animated chorus proof with the master song.');
  }
  const proofApproved = !proofProblems.length && hasProofEvidence(review.approvals?.proof?.proofReview) && review.approvals?.proof?.basis === hash({ basis: basis.proof, excerptId: excerpt.id, filename: excerpt.filename });
  return { basis, inputs, alignment: { basis: alignmentBasis, status: draft.lyricsMode === 'instrumental' ? 'instrumental'
    : draft.timingStatus !== 'verified' ? 'provisional' : review.alignmentBasis === alignmentBasis ? 'verified' : 'stale' }, documentShotImport: { documentDirectory: project.composition?.document?.directory || null, audioBasis: alignmentBasis }, art: { approved: artApproved, problems: [...new Set(artProblems)], stale: artApproved ? null : staleApproval(project, 'art', basis.art, inputs) },
    // The overlay text check is advice on the storyboard, like camera variety; it never blocks approval.
    storyboard: { approved: storyboardApproved, problems: [...new Set(boardProblems)], camera,
      // Board shots as reviewed, derived rows included, so the editor and approval card show what the gate checked.
      shots: documentShots ? null : boardStoryboard(project), text: overlayTextReport(project, overlayTextBasis), stale: storyboardApproved ? null : staleApproval(project, 'storyboard', basis.storyboard, inputs) },
    proof: { approved: proofApproved, problems: proofProblems, excerptId: excerpt?.id || null, stale: proofApproved ? null : staleApproval(project, 'proof', basis.proof, inputs) },
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
  if (field === 'subjects') return { ...project, concept: { ...concept, subjects: value } };
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
  if (field === 'concept') return { ...project, concept: value };
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
  const expected = stage === 'proof'
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
  const decision = { stage, basis: expected, inputs: productionApprovalInputs(project)[stage], values: productionApprovalValues(project, stage), approvedAt: new Date().toISOString(),
    ...(approvedBy ? { approvedBy } : {}), ...(reviewer ? { reviewer: structuredClone(reviewer) } : {}),
    ...(stage === 'proof' ? { proofReview: structuredClone(proofReview) } : {}) };
  return { ...project, productionReview: { ...project.productionReview,
    approvalHistory: [...(project.productionReview?.approvalHistory || []), decision],
    reviewedRevisions: { ...project.productionReview?.reviewedRevisions, [basis]: { draft: structuredClone(project.productionReview?.draft || {}), scenes: structuredClone(project.scenes || []), proof: structuredClone(project.productionReview?.proof || null), capturedAt: new Date().toISOString() } },
    approvals: { ...project.productionReview?.approvals, [stage]: decision } } };
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
  return { ...project, productionReview: { ...review, approvals, reviewedRevisions: snapshots,
    feedback: [...(review.feedback || []), entry] } };
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
