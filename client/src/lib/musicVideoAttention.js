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
 *
 * Row shape: `{ id, kind, tone, title, detail, … }` plus the ids the action
 * needs — `revisionId` + `canResume` (revision), `runId` (auto-review).
 */
export function deriveAttentionItems(project, { generatingSceneIds = null, draftRendering = false, finalRenderAttached = false } = {}) {
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
