/**
 * Creative Director — pure orchestration helpers.
 *
 * No HTTP, no I/O, no CoS coupling. These functions decide what comes next
 * given a project's state, so the routes + agentBridge can stay thin and
 * the logic stays unit-testable.
 */

/**
 * Pick the next scene that needs rendering. Returns null when every scene
 * is in a terminal state (accepted or failed). Order is treatment.scenes
 * sorted by `order`.
 */
export function nextPendingScene(project) {
  if (!project?.treatment?.scenes?.length) return null;
  const sorted = [...project.treatment.scenes].sort((a, b) => a.order - b.order);
  return sorted.find((s) => s.status === 'pending' || s.status === 'rendering' || s.status === 'evaluating') || null;
}

/**
 * What kind of follow-up task should the server enqueue next?
 *  - 'treatment' — no treatment yet
 *  - 'scene'     — at least one scene still pending
 *  - 'stitch'    — every scene accepted, no final video yet
 *  - null        — project is fully done (or failed terminally)
 */
export function nextTaskKind(project) {
  if (!project) return null;
  if (project.status === 'failed' || project.status === 'paused') return null;
  if (!project.treatment) return 'treatment';
  const scenes = project.treatment.scenes || [];
  if (!scenes.length) return null;
  const remaining = scenes.find((s) => s.status === 'pending' || s.status === 'rendering' || s.status === 'evaluating');
  if (remaining) return 'scene';
  // All scenes terminal — if at least one accepted and no final video yet,
  // stitch. If none accepted, the project failed.
  const acceptedCount = scenes.filter((s) => s.status === 'accepted').length;
  if (!acceptedCount) return null;
  if (project.finalVideoId) return null;
  return 'stitch';
}

/**
 * Build the timeline-project clip list from accepted scenes. Used by the
 * stitch task prompt and could be used by a server-side auto-stitch path.
 */
export function buildTimelineClips(project) {
  return (project?.treatment?.scenes || [])
    .filter((s) => s.status === 'accepted' && s.renderedJobId)
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ clipId: s.renderedJobId, inSec: 0, outSec: s.durationSeconds }));
}
