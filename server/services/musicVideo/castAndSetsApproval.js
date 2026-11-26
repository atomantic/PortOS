/** Approval mutations shared by the automatic check-in and director actions. */
import { isCatalogCheckin, resolveCatalogCheckin, assertCatalogCheckinReady, assertLegacyCheckin } from './catalogCheckin.js';
import { assertMusicVideoMediaSelections } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
import { castAndSetsApprovalInputs, castAndSetsApprovalValues, seedArtDraft } from './productionReview.js';
import { CAST_SETS_PROCESS_ID as PROCESS_ID, presentProjectCastAndSets } from './processPins.js';
import { ServerError } from '../../lib/errorHandler.js';
import { castAndSetsPendingGreyboxSetIds } from '../../lib/musicVideo/musicVideoGreybox.js';
import { mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';
import { musicVideoEvents } from './events.js';
import {
  assertCastAndSetsApprovable,
  presentCastAndSets,
  setCastAndSetsStatus,
} from './castAndSets.js';
import {
  CAST_SETS_REF_PREFIX,
  castAndSetsOverflowFaceReferences,
  castAndSetsReferences,
  castAndSetsSubjects,
  fixedCastSheetsWithoutReference,
} from './castAndSetsPlan.js';
import { reviewDevArtifact } from './devArtifacts.js';
import { rebaseProductionAfterCheckin } from './production.js';

export const short = (id) => String(id || '').slice(3, 11);

// Reconcile the old single pending flag against the actual capture sent to the plate.
export async function pendingGreyboxState(project, catalog) {
  const stage = project.castAndSets;
  if (!stage?.greyboxPending) return { direct: [], legacy: [], unavailable: [] };
  const direct = Array.isArray(stage.greyboxPendingSetIds) ? stage.greyboxPendingSetIds : [];
  const legacyIds = Array.isArray(stage.greyboxLegacyPendingSetIds) ? stage.greyboxLegacyPendingSetIds
    : Array.isArray(stage.greyboxPendingSetIds) ? [] : (stage.direction?.sets || []).map((set) => set.id);
  const candidates = new Set(legacyIds);
  const selected = (stage.direction?.sets || []).filter((set) => candidates.has(set.id) && set.setReference?.greyboxShotId);
  const legacyStage = { ...stage, greyboxPendingSetIds: [], greyboxLegacyPendingSetIds: legacyIds };
  if (!selected.length) return { direct, legacy: castAndSetsPendingGreyboxSetIds(legacyStage), unavailable: [] };
  const { loadMusicVideoGreybox } = await import('./greyboxReferences.js');
  const captures = await Promise.all(selected.map(async (set) => {
    const greybox = await loadMusicVideoGreybox(project, { sceneId: `set:${set.id}`, setReference: set.setReference }, { catalog }).catch(() => null);
    return [set.id, greybox?.reference?.imageId || null];
  }));
  return { direct, legacy: castAndSetsPendingGreyboxSetIds(legacyStage, Object.fromEntries(captures)), unavailable: captures.filter(([, imageId]) => !imageId).map(([id]) => id) };
}

export function publish(projectId, project) {
  const presented = presentProjectCastAndSets(project);
  musicVideoEvents.emit('cast-and-sets', {
    projectId,
    stage: presented?.castAndSets || null,
    project: presented,
  });
}

// Save the approved check-in's new cast and sets to the catalog (Casting /
// Environments), then show the stamped subjects. The approval already landed.
function queueCheckinCastToCatalog(projectId) {
  import('./catalogCast.js')
    .then(({ saveCheckinCastToCatalog }) => saveCheckinCastToCatalog(projectId))
    .then((result) => { if (result?.project) publish(projectId, result.project); })
    .catch((err) => console.error(`❌ Music Video Cast & Sets ${short(projectId)}: saving cast to the catalog failed: ${err.message}`));
}

/**
 * Apply an approved check-in to the project (references, subjects), approve
 * its artifact, and re-base a production run that was waiting on it.
 */
function applyApproval(project, now) {
  const stage = project.castAndSets;
  const references = castAndSetsReferences(project, stage);
  const unseated = fixedCastSheetsWithoutReference(project, stage, references);
  if (unseated.length) {
    const characterLost = stage.images?.character?.imageId && !references.some((r) => r.id === `${CAST_SETS_REF_PREFIX}character`);
    throw new ServerError(`The project's reference list is full, so the cast sheet${unseated.length > 1 ? 's' : ''} for ${unseated.join(', ')} cannot be added. Remove ${unseated.length + (characterLost ? 1 : 0)} of the project's own visual references and approve again.`, { status: 409, code: 'CAST_SETS_REFERENCE_LIMIT' });
  }
  let next = {
    ...project,
    visualSpec: {
      palette: [], typography: '', cameraRules: '', moodBoardId: null,
      ...(project.visualSpec || {}),
      references,
    },
    concept: { ...(project.concept || {}), subjects: castAndSetsSubjects(project, stage) },
  };
  assertMusicVideoMediaSelections(next);
  // Approving the sheet seeds the art-direction draft and guide so the next
  // approval is one click, not a re-typing of what the sheet already says.
  next = seedArtDraft(next, stage);
  if (stage.artifactId && (next.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted)) {
    next = reviewDevArtifact(next, stage.artifactId, { status: 'approved' }, now).project;
  }
  // Record what the approval rests on, so a later concept/style/subject/song
  // edit can be named as "changed since" (#10141).
  return setCastAndSetsStatus(next, 'approved', { extra: {
    approvedInputs: castAndSetsApprovalInputs(next), approvedValues: castAndSetsApprovalValues(next),
    overflowFaceReferences: castAndSetsOverflowFaceReferences(stage, references),
  } }, now);
}

// Settle the stage and re-base a production run waiting on it, in ONE write,
// so the run never observes the new references without its new basis.
export const settleAndRebase = (next, now) => {
  const { project } = rebaseProductionAfterCheckin(next.project, now);
  return { project, stage: project.castAndSets };
};

/** Approve & continue. Returns `{ project, stage }`. */
export async function approveCastAndSetsCheckin(projectId, input, { catalog, refreshSheet }) {
  if (isCatalogCheckin(await requireProject(projectId))) return approveCatalogCheckin(projectId, input, catalog);
  const now = new Date().toISOString();
  const out = await mutateProjectRecord(projectId, async (current) => {
    assertLegacyCheckin(current);
    assertCastAndSetsApprovable(current);
    const pending = await pendingGreyboxState(current, catalog);
    if (pending.unavailable.length) throw new ServerError('The selected greybox capture could not be checked. Restore it or clear the selection, then try again.', { status: 409, code: 'CAST_SETS_GREYBOX_PENDING' });
    if (pending.direct.length || pending.legacy.length) throw new ServerError('Regenerate the set plates with the selected greybox references before approving.', { status: 409, code: 'CAST_SETS_GREYBOX_PENDING' });
    const ready = { ...current, castAndSets: { ...current.castAndSets, greyboxPending: false, greyboxPendingSetIds: [], greyboxLegacyPendingSetIds: [] } };
    return settleAndRebase(applyApproval(ready, now), now);
  });
  console.log(`✅ Music Video Cast & Sets ${short(projectId)} approved (r${out.stage.revision})`);
  publish(projectId, out.project);
  queueCheckinCastToCatalog(projectId);
  if (!input.sheetRendered) refreshSheet(projectId);
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

export async function approveCatalogCheckin(projectId, { catalogBasis }, catalog) {
  const out = await mutateProjectRecord(projectId, async (current, { client } = {}) => {
    if (!isCatalogCheckin(current)) throw new ServerError('The check-in changed. Reload it before approving.', { status: 409, code: 'CAST_SETS_PLAN_STALE' });
    const checkin = await resolveCatalogCheckin(current, { catalog, client });
    assertCatalogCheckinReady(checkin);
    if (!catalogBasis || catalogBasis !== checkin.basis) throw new ServerError('The catalog check-in changed. Review the current links and images before approving.', { status: 409, code: 'CAST_SETS_CATALOG_STALE' });
    const now = new Date().toISOString();
    const stage = { ...current.castAndSets, status: 'approved', catalogApprovedBasis: checkin.basis, approvedAt: now, updatedAt: now };
    let next = { ...current, castAndSets: stage };
    if (stage.artifactId && (next.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted)) {
      next = reviewDevArtifact(next, stage.artifactId, { status: 'approved' }, now).project;
    }
    return settleAndRebase({ project: next }, now);
  });
  publish(projectId, out.project);
  return { project: out.project, stage: out.project.castAndSets, catalogCheckin: await resolveCatalogCheckin(out.project, { catalog }) };
}
