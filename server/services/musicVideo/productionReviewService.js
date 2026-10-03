import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { musicVideoEvents } from './events.js';
import { productionReadiness, productionReviewBasis, productionAlignmentBasis, documentStoryboardBasis, approveProductionStage, assertProductionApproval, recordProductionFeedback, resolveProductionFeedback } from './productionReview.js';

const reviewProcessId = randomUUID();

async function requireProject(id) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

const present = project => ({ project, readiness: productionReadiness(project) });
function changed(project) {
  // Reuse the existing project-bearing development-artifact notification.
  musicVideoEvents.emit('dev-artifact', { projectId: project.id, artifactId: null, project });
  return present(project);
}

export const getProductionReview = async id => present(await requireProject(id));

export async function assertMusicVideoSceneReview(tag) {
  if (!tag?.projectId || !tag.sceneId) return;
  const project = await requireProject(tag.projectId);
  assertProductionApproval(project, 'storyboard');
  if (tag.productionRunId) {
    const run = project.productionRuns?.find(r => r.id === tag.productionRunId);
    if (!run?.pilot?.scenes?.some(scene => scene.sceneId === tag.sceneId)) assertProductionApproval(project, 'proof');
  }
}

/** Preserve the original handoff verbatim in an immutable artifact, never its approvals. */
export async function importProductionPlanning(id, source) {
  let input;
  try { input = JSON.parse(source); } catch { throw new ServerError('Choose a valid planning JSON document.', { status: 422, code: 'VALIDATION_ERROR' }); }
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new ServerError('The planning document must be an object.', { status: 422, code: 'VALIDATION_ERROR' });
  const { musicVideoProductionDraftSchema } = await import('../../lib/musicVideoValidation.js');
  const prose = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const draft = musicVideoProductionDraftSchema.parse({
    cast: prose(input.cast), environments: prose(input.environments), visualLanguage: prose(input.visualLanguage),
    motionLanguage: prose(input.motionLanguage), implementationPlan: prose(input.implementationPlan || input.feasibility), guideArtifactId: null, lyricsMode: 'vocal',
    timingStatus: 'provisional', timingNotes: prose(input.timing),
    storyboard: (Array.isArray(input.storyboard) ? input.storyboard : []).map((shot, index) => ({
      id: shot.id || `draft-${index + 1}`, sceneId: shot.sceneId || null,
      startSec: shot.startSec, endSec: shot.endSec, lyricCueIds: shot.lyricCueIds || [],
      action: prose(shot.action), staging: prose(shot.staging), camera: prose(shot.camera), transition: prose(shot.transition),
    })),
  });
  const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const { escapeHtml } = await import('./castAndSetsSheet.js');
  const { artifact } = await saveGeneratedDevArtifact(id, { kind: 'other', title: 'Original planning import — unapproved',
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Original planning import</title></head><body><h1>Original planning import — unapproved</h1><pre style="white-space:pre-wrap">${escapeHtml(source)}</pre></body></html>`, source: 'planning-import' });
  const { project } = await mutateProjectRecord(id, current => ({ project: { ...current,
    productionReview: { ...current.productionReview, draft: { ...draft, sourceArtifactId: artifact.id }, approvals: {}, proof: null } } }));
  return changed(project);
}

/** A director supplies source-authored shot IDs/times; never infer shots from a generic Board row. */
export async function importDocumentShots(id, input) {
  const before = await requireProject(id);
  if (!before.productionReview?.draft) throw new ServerError('Save a planning draft before importing document shots.', { status: 409, code: 'PLANNING_DRAFT_REQUIRED' });
  if (before.composition?.mode !== 'document' || before.composition.document?.directory !== input.documentDirectory || productionAlignmentBasis(before) !== input.audioBasis) {
    throw new ServerError('The composition version changed. Export its source and import a matching shot manifest.', { status: 409, code: 'DOCUMENT_STORYBOARD_STALE' });
  }
  const { resolveDocumentFile } = await import('./compositionDocument.js');
  await resolveDocumentFile(before, input.sourceFile);
  const alignment = productionAlignmentBasis(before);
  const { project } = await mutateProjectRecord(id, current => {
    if (current.composition?.document?.directory !== input.documentDirectory || productionAlignmentBasis(current) !== alignment) {
      throw new ServerError('Document or audio changed during import.', { status: 409, code: 'DOCUMENT_STORYBOARD_STALE' });
    }
    const next = { ...current, productionReview: { ...current.productionReview,
      draft: { ...current.productionReview?.draft, storyboardSource: 'document', storyboard: input.shots } } };
    next.productionReview.documentStoryboard = { directory: input.documentDirectory, sourceFile: input.sourceFile,
      basis: documentStoryboardBasis(next), importedAt: new Date().toISOString() };
    return { project: next };
  });
  return changed(project);
}

/** Explicitly create and bind an unbound draft shot, under the project write lock. */
export async function bindProductionShot(id, shotId) {
  const { addScene } = await import('./projectsLogic.js');
  const { project } = await mutateProjectRecord(id, current => {
    const draft = current.productionReview?.draft;
    if (draft?.storyboardSource === 'document') throw new ServerError('Document shots are edited in their authored source, not bound to Board scenes.', { status: 409, code: 'DOCUMENT_STORYBOARD' });
    const shot = draft?.storyboard.find(s => s.id === shotId);
    if (!shot) throw new ServerError('Draft shot not found', { status: 404, code: 'NOT_FOUND' });
    if (shot.sceneId) throw new ServerError('This draft shot is already bound. Edit its existing Board scene.', { status: 409, code: 'SHOT_ALREADY_BOUND' });
    const out = addScene(current, { label: shot.id, startSec: shot.startSec ?? null, endSec: shot.endSec ?? null,
      visualIntent: shot.action, prompt: [shot.action, shot.camera, shot.transition].join('\n'), framePrompt: shot.staging });
    out.project.productionReview = { ...current.productionReview, draft: { ...draft,
      storyboard: draft.storyboard.map(s => s === shot ? { ...s, sceneId: out.scene.sceneId } : s) } };
    return { project: out.project };
  });
  return changed(project);
}

/** The existing password is reverified; agent session tokens are not approval authority.
 * This protects against delegated agents, not an adversary controlling the host or password.
 * No password is persisted and password-free installs fail closed for approvals.
 */
export async function requireProductionOperator(req) {
  const { isAuthEnabled, verifyPassword } = await import('../auth.js');
  if (!await isAuthEnabled()) throw new ServerError('Set an instance password in Settings > Security before approving production. Draft editing remains available.', { status: 403, code: 'OPERATOR_PASSWORD_REQUIRED' });
  if (req.headers?.authorization || !await verifyPassword(req.body?.password)) {
    throw new ServerError('Enter the instance password yourself to approve this revision. Agent/API credentials cannot approve it.', { status: 403, code: 'OPERATOR_REAUTH_REQUIRED' });
  }
}

export async function saveProductionDraft(id, draft) {
  const guard = await validateGuideSelection(await requireProject(id), () => draft.guideArtifactId);
  const { project } = await mutateProjectRecord(id, current => {
    guard(current);
    return { project: { ...current,
    productionReview: { ...current.productionReview, draft,
      alignmentBasis: draft.timingStatus === 'verified'
        ? (current.productionReview?.draft?.timingStatus !== 'verified' ? productionAlignmentBasis(current) : current.productionReview?.alignmentBasis)
        : null } } };
  });
  return changed(project);
}

export async function approveProductionReview(id, input) {
  const guard = await validateGuideSelection(await requireProject(id), current => current.productionReview?.draft?.guideArtifactId);
  const { project } = await mutateProjectRecord(id, current => {
    guard(current);
    return { project: approveProductionStage(current, input) };
  });
  return changed(project);
}

// Historical guides remain readable. Selecting or approving one validates its
// immutable bytes under today's policy, including HTML saved before narrowing.
async function validateGuideSelection(project, selectedId) {
  const { musicVideoMediaMode } = await import('../../lib/musicVideoMediaPolicy.js');
  const signature = current => {
    const id = selectedId(current);
    const artifact = current.devArtifacts?.find(entry => entry.id === id && !entry.deleted);
    return JSON.stringify([musicVideoMediaMode(current), id || null, artifact?.file, artifact?.version]);
  };
  const initial = signature(project);
  const id = selectedId(project);
  if (id) {
    const { findDevArtifact } = await import('./devArtifacts.js');
    const { resolveDevArtifactFile } = await import('./devArtifactStore.js');
    const { assertDocumentMediaPolicy } = await import('./documentMediaPolicy.js');
    const artifact = findDevArtifact(project, id);
    const abs = resolveDevArtifactFile(artifact.file);
    if (!abs) throw new ServerError('Guide artifact file path is invalid', { status: 422, code: 'VALIDATION_ERROR' });
    await assertDocumentMediaPolicy(project, [{ rel: artifact.file, abs }]);
  }
  return current => {
    if (signature(current) !== initial) throw new ServerError('The guide or media mode changed while it was being checked — review it again.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
  };
}

/** Prepare ordinary editable artifacts; never mark any stage approved. */
export async function prepareProductionReview(id, options = {}) {
  let project = await requireProject(id);
  if (project.productionReview?.draft?.storyboardSource === 'document') return present(project);
  const stage = project.castAndSets;
  const hasManualGuide = !productionReadiness(project).art.problems.length;
  if (!hasManualGuide && (!stage?.direction || !stage.artifactId)) {
    if (!stage || ['failed', 'skipped'].includes(stage.status)) {
      const { startCastAndSets } = await import('./castAndSetsService.js');
      await startCastAndSets(id, options);
    }
    return present(await requireProject(id));
  }
  // Applying references does not grant production approval. That lives only in
  // productionReview.approvals and requires the operator route.
  if (!hasManualGuide && stage?.status === 'review') {
    const { approveCastAndSets } = await import('./castAndSetsService.js');
    await approveCastAndSets(id);
    project = await requireProject(id);
  }
  const d = stage?.direction || {};
  const describe = value => typeof value === 'string' ? value : JSON.stringify(value || {}, null, 2);
  // Merge against the latest draft while holding the write lock: a guide job
  // may finish while the operator is editing its text.
  await mutateProjectRecord(id, current => {
    if (current.productionReview?.draft?.storyboardSource === 'document') return { project: current };
    const prior = current.productionReview?.draft || {};
    const draft = { lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [], ...prior,
      cast: prior.cast || describe(d.protagonist), environments: prior.environments || describe(d.sets),
      visualLanguage: prior.visualLanguage || describe({ look: d.look, palette: d.protagonist?.palette, world: d.world }),
      motionLanguage: prior.motionLanguage || describe({ movement: d.protagonist?.movement, camera: d.world?.camera, transitions: d.world?.transitions }),
      guideArtifactId: prior.guideArtifactId || stage?.artifactId };
    return { project: { ...current, productionReview: { ...current.productionReview, draft } } };
  });
  project = await requireProject(id);
  if (project.productionReview?.draft?.storyboardSource === 'document' || !productionReadiness(project).art.approved) return present(project);
  if (!project.scenes?.length) {
    const { planProject } = await import('./planner.js');
    await planProject(id, { ...options, seedPrompts: true });
    project = await requireProject(id);
  }
  // New code-first projects need an executable medium plan as well as scenes.
  // Prepare supplies deterministic defaults before human storyboard approval;
  // it never recompiles an existing treatment or replaces authored direction.
  if (project.productionPolicy?.strategy === 'code-first' && !project.treatment) {
    const { buildTreatmentDraft } = await import('./treatmentDraft.js');
    const { treatmentBasis, writeCompiledTreatment, applyTreatmentToProject } = await import('./treatment.js');
    ({ project } = await mutateProjectRecord(id, current => {
      if (current.productionPolicy?.strategy !== 'code-first' || current.treatment
        || !productionReadiness(current).art.approved) return { project: current };
      const compiled = writeCompiledTreatment(current, { baseRevision: 0, basis: treatmentBasis(current),
        draft: buildTreatmentDraft(current), compiledWith: { source: 'deterministic', providerId: null, model: null } });
      const applied = applyTreatmentToProject(compiled, { revision: compiled.treatment.revision }).project;
      const original = new Map(current.scenes.map(scene => [scene.sceneId, scene]));
      return { project: { ...applied, scenes: applied.scenes.map(scene => ({ ...scene,
        ...(original.get(scene.sceneId)?.direction ? { direction: original.get(scene.sceneId).direction } : {}) })) } };
    }));
  }
  const { project: planned } = await mutateProjectRecord(id, current => {
    const latest = current.productionReview.draft;
    if (latest.storyboardSource === 'document') return { project: current };
    const storyboard = [...latest.storyboard, ...current.scenes.filter(scene => !latest.storyboard.some(shot => shot.sceneId === scene.sceneId)).map(scene => ({
      sceneId: scene.sceneId,
      lyricCueIds: (current.lyricCues || []).filter(c => c.startSec < scene.endSec && c.endSec > scene.startSec).map(c => c.id),
      action: scene.visualIntent || scene.prompt || '', staging: scene.framePrompt || '',
      camera: scene.direction?.camera || d.world?.camera || '', transition: d.world?.transitions || '',
    }))];
    return { project: { ...current, productionReview: { ...current.productionReview, draft: { ...latest, storyboard } } } };
  });
  return changed(planned);
}

export async function renderProductionProof(id, { startSec, endSec, kind = 'proof' }) {
  let project = await requireProject(id);
  if (kind === 'proof') assertProductionApproval(project, 'storyboard');
  const minDuration = kind === 'prototype' ? 1 : 10;
  if (!(endSec - startSec >= minDuration && endSec - startSec <= 45 && endSec <= project.audioAnalysis?.durationSec)) throw new ServerError(`Choose a ${minDuration}–45 second window within the current master song.`, { status: 422, code: 'PROOF_WINDOW_REQUIRED' });
  const requestId = randomUUID();
  let previous;
  ({ project } = await mutateProjectRecord(id, current => {
    for (const key of ['proof', 'prototype']) {
      const evidence = current.productionReview?.[key];
      if ((evidence?.requestId && evidence.requestOwner === reviewProcessId) || current.excerpts?.some(e => e.id === evidence?.excerptId && e.status === 'rendering')) throw new ServerError('An evidence render is already starting or running.', { status: 409, code: 'EXCERPT_RENDER_IN_PROGRESS' });
    }
    previous = current.productionReview?.[kind] || null;
    return { project: { ...current, productionReview: { ...current.productionReview, [kind]: { startSec, endSec, excerptId: null, requestId, requestOwner: reviewProcessId } } } };
  }));
  const basis = productionReviewBasis(project).proof;
  const { startExcerptRender } = await import('./excerptRender.js');
  let result;
  try {
    result = await startExcerptRender(id, { startSec, endSec }, { verifyCurrent: current => {
      if (kind === 'proof') assertProductionApproval(current, 'storyboard');
      if (productionReviewBasis(current).proof !== basis) throw new ServerError('The proof inputs changed', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
    } });
  } catch (error) {
    await mutateProjectRecord(id, current => ({ project: current.productionReview?.[kind]?.requestId === requestId
      ? { ...current, productionReview: { ...current.productionReview, [kind]: previous } } : current }));
    throw error;
  }
  const { project: next } = await mutateProjectRecord(id, current => ({ project: { ...current,
    productionReview: { ...current.productionReview, [kind]: { startSec, endSec, excerptId: result.excerptId, basis } } } }));
  return { ...changed(next), ...result };
}

/** An existing, dependency-checked asset pilot becomes a human review candidate. */
export async function attachProductionPilotProof(id, excerptId) {
  const { musicVideoDependencyChanges } = await import('../../lib/musicVideoDependencies.js');
  const { project } = await mutateProjectRecord(id, current => {
    const excerpt = current.excerpts?.find(e => e.id === excerptId);
    if (excerpt?.status !== 'complete' || !excerpt.filename || musicVideoDependencyChanges(current, excerpt.dependencies).length) {
      throw new ServerError('The pilot evidence is missing or stale. Render it again.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
    }
    const next = { ...current, productionReview: { ...current.productionReview,
      proof: { excerptId, startSec: excerpt.startSec, endSec: excerpt.endSec } } };
    next.productionReview.proof.basis = productionReviewBasis(next).proof;
    return { project: next };
  });
  return changed(project);
}

export async function addProductionFeedback(id, input) {
  const { project } = await mutateProjectRecord(id, current => ({ project: recordProductionFeedback(current, input) }));
  return changed(project);
}
export async function closeProductionFeedback(id, input) {
  const { project } = await mutateProjectRecord(id, current => ({ project: resolveProductionFeedback(current, input) }));
  return changed(project);
}
