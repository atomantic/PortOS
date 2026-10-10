/**
 * "Needs attention" for the Music Video header (#9940): the server-held states
 * a client-orchestrated workflow can strand — an open revision, an interrupted
 * Cast & Sets stage, a running auto-review that never handed out its revised sections, a
 * final render nobody is watching. Request A opens server state and step B
 * finalizes it, so a throw or reload between them leaves a record that blocks
 * production while nothing on screen says why. Everything here is derived from
 * the PERSISTED project, never from what this tab remembers, so the same
 * answer holds after a reload.
 *
 * Pure: `deriveAttentionItems(project, live)` returns the banner's rows;
 * `NeedsAttentionBanner` renders them and the page wires their actions.
 */

import { describeAutonomousWait } from './musicVideoAutonomous.js';
import { RESUMABLE_RUN_STATUSES, changedFieldsText, currentProductionRun } from './musicVideoStages.js';

/** The DOM id of the banner, so a refusal toast can scroll to it. */
export const ATTENTION_ANCHOR_ID = 'mv-needs-attention';

const OPEN_REVISION = new Set(['open', 'rendering']);
const SLOT = { image: 'referenceImageId', video: 'videoHistoryId' };
const asList = (value) => (Array.isArray(value) ? value : []);

/** The open or rendering revision the project holds, or null. */
export const openRevisionOf = (project) => asList(project?.revisions).find((r) => OPEN_REVISION.has(r.status)) || null;

// A rejected section's new take lives on its scene; count what has landed.
function sectionProgress(project, revision) {
  const scenes = new Map(asList(project?.scenes).map((s) => [s.sceneId, s]));
  const rejected = asList(revision?.sections).filter((s) => s.verdict === 'rejected');
  const ready = rejected.filter((s) => scenes.get(s.sceneId)?.[SLOT[s.kind]]).length;
  return { ready, total: rejected.length, rejected };
}

/**
 * The rows the "Needs attention" banner shows for `project`, in the order a
 * director would clear them. `live` names what THIS tab can already see
 * progressing, so healthy work is not flagged:
 * - `generatingSceneIds` — scenes with a frame/clip spinning on this board
 * - `draftRendering` — a draft excerpt render is attached to this tab
 * - `finalRenderAttached` — this tab already shows the final render's progress
 * - `readiness` — the server's production readiness, for approvals given on
 *   inputs that have changed since (#10141)
 * - `headerAction` — the header's next action (`{ id, runId }`); a parked run
 *   it already resumes drops its own Resume so one screen never offers two
 *   controls for the same run
 *
 * Row shape: `{ id, kind, tone, title, detail, … }` plus the ids the action
 * needs — `revisionId` + `canResume` (revision), `runId` (auto-review).
 */
export function deriveAttentionItems(project, { generatingSceneIds = null, draftRendering = false, finalRenderAttached = false, readiness = project?.productionReadiness, headerAction = null } = {}) {
  if (!project) return [];
  const items = [];
  const spinning = (sceneId) => !!generatingSceneIds?.has?.(sceneId);

  // A board-driven auto-review run owns the revision it opened (a production
  // run's is dispatched server-side), so the run — not the revision — is the
  // thing to continue or cancel.
  const liveReview = asList(project.autoReviews).find((run) => run.status === 'running' && !run.productionRunId) || null;
  const ownedRevisionId = liveReview ? liveReview.attempts?.at?.(-1)?.revisionId || null : null;
  const revisions = asList(project.revisions);

  const revision = openRevisionOf(project);
  if (revision && revision.id !== ownedRevisionId) {
    const { ready, total, rejected } = sectionProgress(project, revision);
    const progressing = (revision.status === 'rendering' && draftRendering) || rejected.some((s) => spinning(s.sceneId));
    if (!progressing) {
      const rendering = revision.status === 'rendering';
      items.push({
        id: `revision:${revision.id}`,
        kind: 'revision',
        tone: 'warn',
        title: rendering ? 'A revision is re-rendering its draft' : 'A section revision is open',
        detail: rendering
          ? 'Production and auto-review wait for it. If the render is not progressing, cancel the revision.'
          : `New takes: ${ready} of ${total}. Production and auto-review wait until it is resumed or cancelled.`,
        revisionId: revision.id,
        canResume: !rendering,
        projectId: project.id,
        scenes: rejected.map((s) => {
          const sc = (project.scenes || []).find((scene) => scene.sceneId === s.sceneId);
          return {
            sceneId: s.sceneId,
            order: sc?.order,
            label: sc ? (sc.sectionLabel || sc.label || `Scene ${(sc.order ?? 0) + 1}`) : s.sceneId,
          };
        }),
      });
    }
  }

  if (project.castAndSets?.interrupted) {
    items.push({
      id: 'cast-and-sets',
      kind: 'cast-and-sets',
      tone: 'warn',
      title: 'The Cast & Sets check-in was interrupted',
      detail: 'A restart stopped it before it reached a checkpoint. Resume to continue from where it left off.',
    });
  }

  if (liveReview && ownedRevisionId) {
    const owned = revisions.find((r) => r.id === ownedRevisionId);
    if (owned?.status === 'open') {
      const { rejected } = sectionProgress(project, owned);
      // The server generates a run's revised sections itself (#10014), so a
      // claimed section is in flight there even though no spinner on this
      // board shows it. Only a revision that was never handed out has stalled.
      if (!rejected.some((s) => spinning(s.sceneId) || s.claimedAt)) {
        items.push({
          id: `auto-review:${liveReview.id}`,
          kind: 'auto-review',
          tone: 'warn',
          title: 'Auto-review is waiting for its revised sections',
          detail: 'The server generates them as soon as the run reaches this step. If it stalled (for example across a restart), continue to hand them out again — nothing is generated beyond the limits you set for the run.',
          runId: liveReview.id,
        });
      }
    }
  }

  if (project.status === 'rendering' && !finalRenderAttached) {
    items.push({
      id: 'final-render',
      kind: 'final-render',
      tone: 'warn',
      title: 'A final render is in progress',
      detail: 'Reattach to watch its progress or cancel it.',
    });
  }
  const stale = staleApprovalItem(project, readiness);
  return [...items, ...parkedRunItems(project, headerAction), ...(stale ? [stale] : [])];
}

// Approvals in the order they are given, with the tab (and editor) each is re-given on.
// The animated proof is optional, so a proof approved on older inputs needs no attention.
const STALE_APPROVALS = [
  ['castAndSets', 'Cast & Sets check-in', 'cast-sets'],
  ['art', 'Art direction', 'cast-sets#mv-review-art'],
  ['storyboard', 'Timed storyboard', 'board#mv-review-storyboard'],
];

// One row for every approval given on inputs that have changed since (#10141),
// naming what changed per approval and opening the earliest one. A running
// production replaces takes as its job, so it does not flag its own progress.
function staleApprovalItem(project, readiness) {
  if (currentProductionRun(project)?.status === 'running') return null;
  const stale = STALE_APPROVALS.filter(([key]) => readiness?.[key]?.stale);
  if (!stale.length) return null;
  const describe = ([key, label]) => {
    const fields = readiness[key].stale.changedFields || [];
    return fields.length ? `${label} — changed since: ${changedFieldsText(fields, 3)}` : `${label} — its inputs changed`;
  };
  return {
    id: 'stale-approvals',
    kind: 'stale-approvals',
    tone: 'warn',
    title: stale.length === 1 ? `${stale[0][1]} was approved earlier and has changed since` : `${stale.length} approvals were given before later changes`,
    detail: `${stale.map(describe).join('. ')}. Keep the approval, or undo the change.`,
    projectId: project.id,
    openTo: stale[0][2],
    // Each approval settles right here: keep it on the current inputs (the Cast & Sets
    // check-in is re-stamped; a production approval is re-given when nothing else blocks it),
    // or put back a changed input whose approved value was kept.
    approvals: stale.map(([key, label]) => ({ stage: key, label,
      canKeep: key === 'castAndSets' || !(readiness[key].problems || []).length,
      revertible: readiness[key].stale.revertible || [] })),
  };
}

// Auto-review states that wait on the director (#10156): a limit, an unverifiable
// review, or a halted run. `running` is live work, not a request for the user.
const AUTO_REVIEW_PARKED = new Set(['needs-human', 'limit-reached', 'stopped']);
const PRODUCTION_PARKED = new Set(['limit-reached', 'needs-human', 'blocked', 'needs-replan']);
// The header next-action ids that resume the autonomous run (see deriveNextAction).
const RESUME_AUTONOMOUS_IDS = new Set(['resume-autonomous', 'retry-autonomous']);
const AUTONOMOUS_PARKED = new Set(['awaiting-approval', 'needs-human', 'stopped', 'failed']);

/** The newest board-driven auto-review run, when it is parked on the director. Older stopped runs are superseded. */
export function parkedAutoReview(project) {
  const run = asList(project?.autoReviews).filter((r) => !r.productionRunId).at(-1);
  return run && AUTO_REVIEW_PARKED.has(run.status) ? run : null;
}

/** Whether Final render's "Revision and automatic review tools" section should open on its own: a run is live or parked. */
export const autoReviewNeedsUser = (project) => asList(project?.autoReviews).some((r) => r.status === 'running' && !r.productionRunId) || !!parkedAutoReview(project);

// Rows for runs the server holds that nobody is watching: an autonomous run
// parked on the director, a production run stopped on a limit, an auto-review
// that halted. Each is derived from the saved record, so it survives a reload.
function parkedRunItems(project, headerAction) {
  const items = [];
  const auto = project.autonomousRun;
  const autoParked = auto && (AUTONOMOUS_PARKED.has(auto.status) || auto.interrupted);
  if (autoParked) {
    const interrupted = auto.interrupted && auto.status === 'running';
    const awaiting = auto.status === 'awaiting-approval';
    items.push({
      id: `autonomous:${auto.id}`,
      kind: 'autonomous',
      tone: 'warn',
      title: awaiting ? 'An autonomous run is waiting for your approval' : auto.status === 'failed' ? 'An autonomous run failed' : 'An autonomous run needs you',
      detail: interrupted ? 'A restart interrupted it. Resume to continue from where it left off.' : describeAutonomousWait(project.name || 'This video', auto),
      projectId: project.id,
      canResume: !awaiting && !RESUME_AUTONOMOUS_IDS.has(headerAction?.id),
      resumeLabel: auto.status === 'failed' ? 'Retry' : 'Resume',
      // The run's log and its checkpoint editor live in Project settings › Autopilot.
      openTo: `${auto.stage === 'produce' ? 'produce' : 'setup'}?mvPanel=autopilot${awaiting ? '#mv-auto-edit' : ''}`,
    });
  }
  const production = currentProductionRun(project);
  // An autonomous run parked on this production reports the stop itself.
  const ownedByAuto = autoParked && auto.output?.productionRunId === production?.id;
  if (production && PRODUCTION_PARKED.has(production.status) && !ownedByAuto) {
    const reason = production.stopReason || production.error;
    items.push({
      id: `production:${production.id}`,
      kind: 'production',
      tone: 'warn',
      title: production.status === 'limit-reached' ? 'Production stopped at its limit' : production.status === 'needs-human' ? 'Production needs you' : 'Production is paused',
      detail: reason || 'Open Autopilot to see what it is waiting on.',
      projectId: project.id,
      runId: production.id,
      // Same exits as the header's next action; the run's controls are in Project settings › Autopilot.
      canResume: RESUMABLE_RUN_STATUSES.has(production.status) && !(headerAction?.id === 'resume-production' && headerAction.runId === production.id),
      acceptBasis: production.status === 'needs-replan',
      openTo: 'produce?mvPanel=autopilot',
    });
  }
  const review = parkedAutoReview(project);
  if (review) {
    items.push({
      id: `auto-review-parked:${review.id}`,
      kind: 'auto-review-parked',
      tone: 'warn',
      title: review.status === 'limit-reached' ? 'Auto-review stopped at its limit' : review.status === 'stopped' ? 'Auto-review is stopped' : 'Auto-review needs you',
      detail: review.stopReason || review.error || 'Open Final render to resume it or take over.',
      projectId: project.id,
      runId: review.id,
      canResume: review.status !== 'limit-reached',
      openTo: 'review',
    });
  }
  return items;
}

/**
 * The scroll target a refusal toast ("Finish or cancel the open revision")
 * links to. Scrolls the banner into view and focuses its first control; a
 * missing banner (the revision is not in the local record yet) is a no-op.
 */
export function revealAttention() {
  if (typeof document === 'undefined') return false;
  const banner = document.getElementById(ATTENTION_ANCHOR_ID);
  if (!banner) return false;
  banner.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  banner.querySelector?.('button')?.focus?.({ preventScroll: true });
  return true;
}
