/**
 * Shared scene-status presentation helpers for the Creative Director scene
 * runner and any consumer that polls it (Pipeline EpisodeVideoStage).
 *
 * The CD scene runner uses ~five terminal scene statuses (`pending`,
 * `rendering`, `evaluating`, `accepted`, `failed`). Lifting them into a
 * shared module keeps the badge palette in sync between the CD detail page
 * and the Pipeline issue page so a "rendering" badge looks identical in
 * both surfaces.
 */

export const SCENE_STATUS = Object.freeze({
  PENDING: 'pending',
  RENDERING: 'rendering',
  EVALUATING: 'evaluating',
  ACCEPTED: 'accepted',
  FAILED: 'failed',
});

// Tailwind class map keyed by scene.status. `evaluating` reuses warning
// because the runner is waiting on the evaluator's accept/reject decision;
// it's not yet "done" but not actively rendering either.
export const SCENE_STATUS_BADGE = Object.freeze({
  pending: 'bg-port-border text-port-text-muted',
  rendering: 'bg-port-accent/30 text-port-accent',
  evaluating: 'bg-port-warning/30 text-port-warning',
  accepted: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
});

// Short user-facing label per scene status. Pipeline EpisodeVideoStage
// previously rolled its own ('done', 'checking') — collapsed here so
// terminology stays consistent across the two surfaces.
export const SCENE_STATUS_LABEL = Object.freeze({
  pending: 'pending',
  rendering: 'rendering',
  evaluating: 'checking',
  accepted: 'done',
  failed: 'failed',
});

export function getSceneStatusBadge(status) {
  return {
    cls: SCENE_STATUS_BADGE[status] || SCENE_STATUS_BADGE.pending,
    text: SCENE_STATUS_LABEL[status] || status || 'pending',
  };
}

// Top-level CD project statuses. Used by EpisodeVideoStage to render a
// "Preparing / Rendering / Complete / Failed" pill on the issue page.
export const PROJECT_STATUS_LABEL = Object.freeze({
  draft: 'Preparing',
  pending: 'Preparing',
  treatment_ready: 'Ready',
  rendering: 'Rendering',
  evaluating: 'Reviewing',
  complete: 'Complete',
  failed: 'Failed',
});
