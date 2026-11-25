/**
 * Creative Director — pure orchestration helpers.
 *
 * No HTTP, no I/O, no CoS coupling. These functions decide what comes next
 * given a project's state, so the routes + agentBridge can stay thin and
 * the logic stays unit-testable.
 */

/**
 * Pick the lowest-order scene that is `pending`, `rendering` or `evaluating`
 * (in-flight scenes included so a re-enqueue resumes them); null when all are terminal.
 */
export function nextPendingScene(project) {
  if (!project?.treatment?.scenes?.length) return null;
  const sorted = [...project.treatment.scenes].sort((a, b) => a.order - b.order);
  return sorted.find((s) => s.status === 'pending' || s.status === 'rendering' || s.status === 'evaluating') || null;
}

/** Build the timeline-project clip list from accepted scenes. */
export function buildTimelineClips(project) {
  return (project?.treatment?.scenes || [])
    .filter((s) => s.status === 'accepted' && s.renderedJobId)
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ clipId: s.renderedJobId, inSec: 0, outSec: s.durationSeconds }));
}
