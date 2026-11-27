/** Bind Music Video approvals and checks to the exact creative inputs they covered. */
import { musicVideoAspect } from '../../lib/musicVideo/musicVideoAspect.js';
import { canonicalSnapshotChecksum as hash } from '../../lib/snapshotChecksum.js';

export const artifact = (project, id) => (project.devArtifacts || []).find(a => a.id === id && !a.deleted);
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
// Lyric timing is verified against the master audio and the word times only. Section names, lyric
// markers and the beat grid are storyboard inputs (source()); editing them moves no word.
const alignmentSource = p => {
  const timing = p.audioTimingRevisions?.at(-1);
  return { trackId: p.trackId, uploadedAudioFilename: p.uploadedAudioFilename, duration: p.audioAnalysis?.durationSec,
    audioTiming: timing ? { version: timing.version, basis: timing.basis, input: timing.input } : null,
    lyrics: (p.lyricCues || []).map(c => ({ text: c.text, startSec: c.startSec ?? null, endSec: c.endSec ?? null,
      words: (c.words || []).map(w => ({ w: w.w, startSec: w.startSec, endSec: w.endSec })) })) };
};
export const productionAlignmentBasis = project => hash({ alignment: alignmentSource(project) });
/** Verification stored before alignment had its own basis hashed the whole storyboard source; it stays valid. */
const legacyAlignmentBasis = project => hash(source(project));
/** True when a stored or supplied basis names this project's current timing, under either formula. */
export const alignmentBasisMatches = (project, basis) => !!basis
  && (basis === productionAlignmentBasis(project) || basis === legacyAlignmentBasis(project));

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

/**
 * Is a storyboard approval current on this revision? Either it was given on
 * exactly this revision, or only the wording, prompts or timing of the shots
 * it covered have changed since (`shotsBasis`; approvals recorded before it
 * existed match on the exact revision only).
 */
export const storyboardApprovalCurrent = (approval, basis) => !!approval
  && (approval.basis === basis.storyboard || (!!basis.storyboardShots && approval.shotsBasis === basis.storyboardShots));

// A subject's catalog link and keep-local choice are bookkeeping saved after an
// approval (catalogCast.js), never a change to who or what was approved.
const CATALOG_SUBJECT_KEYS = ['ingredientId', 'castForm', 'localOnly'];
const withoutCatalogFields = subjects => (subjects || []).map(s => (s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).filter(([k]) => !CATALOG_SUBJECT_KEYS.includes(k))) : s));
const approvalConcept = concept => (concept?.subjects ? { ...concept, subjects: withoutCatalogFields(concept.subjects) } : concept);
// Restoring approved subjects keeps the catalog fields saved since.
export const keepCatalogFields = (subjects, current) => {
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
    ...(project.templateEffects ? { templateEffects: project.templateEffects } : {}),
    ...(project.lyricOverlayEnabled === false ? { lyricOverlayEnabled: false } : {}),
    window: window && { startSec: window.startSec, endSec: window.endSec },
    scenes: (project.scenes || []).filter(s => !window || s.startSec < window.endSec && s.endSec > window.startSec)
      .map(({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer, preMusic, photoSequence, templateEffects }) =>
        ({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer, ...(templateEffects ? { templateEffects } : {}), ...(preMusic ? { preMusic } : {}),
          ...(photoSequence && photoSequence.enabled !== false ? { photoSequence } : {}) })),
    soundBed: project.soundBed, videoSettings: project.videoSettings });
  return { art, storyboard, storyboardShots, proof };
}

/** Labeled per-input hashes so a stale approval can name what changed since. */
export const reviewInputHash = v => hash(v ?? null);
export function productionApprovalInputs(project) {
  const draft = project.productionReview?.draft || {};
  const art = {
    concept: reviewInputHash(approvalConcept(project.concept)), 'visual spec': reviewInputHash(project.visualSpec), 'style references': reviewInputHash(project.styleReferences),
    'media mode': reviewInputHash([project.mediaMode, project.composition?.authoringRenderer, project.composition?.mode, project.productionPolicy]),
    'art direction': reviewInputHash(project.castAndSets?.direction), cast: reviewInputHash(draft.cast), environments: reviewInputHash(draft.environments),
    'visual language': reviewInputHash(draft.visualLanguage), 'motion language': reviewInputHash(draft.motionLanguage),
    'implementation plan': reviewInputHash(draft.implementationPlan), 'visual guide': reviewInputHash(artifactBasis(artifact(project, draft.guideArtifactId))),
  };
  const scenes = {};
  for (const [i, s] of (project.scenes || []).entries()) {
    const n = i + 1;
    scenes[`scene ${n} timing`] = reviewInputHash([s.startSec, s.endSec]);
    scenes[`scene ${n} lyrics`] = reviewInputHash(s.lyricText);
    scenes[`scene ${n} prompt`] = reviewInputHash([s.visualIntent, s.prompt, s.framePrompt]);
    if (s.camera) scenes[`scene ${n} camera`] = reviewInputHash(s.camera);
  }
  const storyboard = { ...art, song: reviewInputHash([source(project).trackId, source(project).uploadedAudioFilename, source(project).duration, source(project).beats, source(project).sections]),
    lyrics: reviewInputHash([source(project).lyrics, source(project).markers, source(project).phrases]), 'lyric timing': reviewInputHash([draft.lyricsMode, draft.timingStatus, draft.timingNotes]),
    'storyboard shots': reviewInputHash([draft.storyboard, draft.storyboardSource, project.productionReview?.documentStoryboard]), treatment: reviewInputHash(project.treatment), ...scenes };
  const window = project.productionReview?.proof;
  const proof = { ...storyboard, composition: reviewInputHash(project.composition), 'proof window': reviewInputHash(window && [window.startSec, window.endSec]),
    ...(project.lyricOverlayEnabled === false ? { 'automatic lyric overlays': reviewInputHash(false) } : {}),
    takes: reviewInputHash((project.scenes || []).map(({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer, photoSequence }) =>
      ({ sceneId, referenceImageId, videoHistoryId, performanceEdit, direction, visualLayer,
        ...(photoSequence && photoSequence.enabled !== false ? { photoSequence } : {}) }))),
    'sound bed': reviewInputHash(project.soundBed), 'video settings': reviewInputHash(project.videoSettings) };
  return { art, storyboard, proof };
}

// The labels whose hash moved (or disappeared) between two input snapshots.
export const changedInputs = (before, now) => Object.keys(now).filter(k => before[k] !== now[k])
  .concat(Object.keys(before).filter(k => !(k in now)));

export const pickReviewFields = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));

const revertibleOf = (changedFields, values) => changedFields.filter(f => values && f in values);
export const withRevertible = (stale, values) => {
  const revertible = revertibleOf(stale.changedFields, values);
  return revertible.length ? { ...stale, revertible } : stale;
};

/** `{ approvedAt, changedFields, revertible? }` when a stage was approved on inputs that have since moved; null otherwise. */
export function staleApproval(project, stage, current, inputs) {
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
    concept: reviewInputHash(concept),
    style: reviewInputHash([style || '', universeStyle || '', moodBoardStyle || '', spec.palette || [], spec.typography || '',
      spec.cameraRules || '', spec.moodBoardId || null, project.styleReferences ?? null]),
    subjects: reviewInputHash([withoutCatalogFields(subjects), (spec.references || []).map(r => r?.imageId || null)]),
    song: reviewInputHash([project.trackId || null, project.uploadedAudioFilename || null]),
  };
}
