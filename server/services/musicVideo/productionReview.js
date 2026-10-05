/** Revision-bound creative approvals. Technical renders never imply approval. */
import { randomUUID } from 'node:crypto';
import { canonicalSnapshotChecksum as hash } from '../../lib/snapshotChecksum.js';
import { ServerError } from '../../lib/errorHandler.js';
import { musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';

import { isNonBlankStr as text } from '../../lib/textUtils.js';
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

/** A shot manifest belongs to one immutable authored document and one master timeline. */
export const documentStoryboardBasis = project => hash({
  document: project.composition?.document?.directory, source: source(project),
  shots: project.productionReview?.draft?.storyboard,
});

// Share the evidence contract between new decisions and persisted approvals:
// a legacy automatic waiver must not become production-ready after an upgrade.
function hasProofEvidence(review) {
  if (!review || review.autoApproved || !text(review.energyComparison) || !text(review.timecodedNotes)
    || !/(?:\b\d{1,2}:\d{2}(?:\.\d+)?\b|\b\d+(?:\.\d+)?s\b)/.test(review.timecodedNotes)) return false;
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
    scenes: (project.scenes || []).map(({ sceneId, startSec, endSec, lyricText, visualIntent, prompt, framePrompt }) =>
      ({ sceneId, startSec, endSec, lyricText, visualIntent, prompt, framePrompt })), treatment: project.treatment });
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

/** `{ approvedAt, changedFields }` when a stage was approved on inputs that have since moved; null otherwise. */
function staleApproval(project, stage, current, inputs) {
  const approval = project.productionReview?.approvals?.[stage];
  if (!approval || approval.basis === current) return null;
  const before = approval.inputs;
  const changedFields = before ? Object.keys(inputs[stage]).filter(k => before[k] !== inputs[stage][k])
    .concat(Object.keys(before).filter(k => !(k in inputs[stage]))) : [];
  return { approvedAt: approval.approvedAt || null, changedFields: changedFields.length ? changedFields : (before ? ['proof render'] : []) };
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
    if (!text(draft.timingNotes)) boardProblems.push('Explain and confirm the instrumental exception.');
  } else {
    if (!cues.length) boardProblems.push('Import lyrics and align them to the current vocal; missing lyrics are not an instrumental.');
    if (draft.timingStatus !== 'verified' || review.alignmentBasis !== alignmentBasis) boardProblems.push('Lyric alignment is provisional or changed. Listen and verify the current word timings.');
    if (!text(draft.timingNotes)) boardProblems.push('Record how the vocal timings were checked.');
    if (cues.some(c => !(Number.isFinite(c.startSec) && c.endSec > c.startSec && c.endSec <= duration)
      || !c.words?.length || c.words.some(w => !(Number.isFinite(w.startSec) && w.endSec > w.startSec)
        || w.startSec < c.startSec || w.endSec > c.endSec))) {
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
    const shot = documentShots ? scene : draft.storyboard?.find(s => s.sceneId === scene.sceneId);
    if (!(Number.isFinite(scene.startSec) && scene.endSec > scene.startSec && scene.endSec <= duration)
      || !shot || ['action', 'staging', 'camera', 'transition'].some(key => !text(shot[key]))) {
      boardProblems.push(`Complete timing, action, staging, camera and transition for ${scene.label || 'each shot'}.`);
    }
    const overlapping = cues.filter(c => c.startSec < scene.endSec && c.endSec > scene.startSec);
    if (overlapping.some(c => !shot?.lyricCueIds?.includes(c.id))
      || shot?.lyricCueIds?.some(id => !cues.some(c => c.id === id))) boardProblems.push(`Review lyric anchors for ${scene.label || 'each shot'}.`);
  }
  const storyboardApproved = !boardProblems.length && review.approvals?.storyboard?.basis === basis.storyboard;
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
    storyboard: { approved: storyboardApproved, problems: [...new Set(boardProblems)], stale: storyboardApproved ? null : staleApproval(project, 'storyboard', basis.storyboard, inputs) },
    proof: { approved: proofApproved, problems: proofProblems, excerptId: excerpt?.id || null, stale: proofApproved ? null : staleApproval(project, 'proof', basis.proof, inputs) },
    readyForProduction: proofApproved };
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
  const decision = { stage, basis: expected, inputs: productionApprovalInputs(project)[stage], approvedAt: new Date().toISOString(),
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
