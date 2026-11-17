/**
 * Helpers for a director's explicit finished-outside declaration: `finishedOutside`, `finishedOutsideCovers`, `finishedOutsideBlocker`, `FINISHED_OUTSIDE_STAGE_IDS`, `FINISHED_OUTSIDE_RERENDER_NOTE`.
 *
 * The marker counts Song through Shots as done without recording any approval, only while the project holds a final render; read by the client's stage derivation and `musicVideoSummary.js`.
 */

/**
 * A project finished outside PortOS (song, look, storyboard and footage made elsewhere, only the final video and posts came back), so the revision-bound approvals those steps gate on were never recorded here. The director says so explicitly (`project.finishedOutside`) instead of PortOS forging review evidence it never saw: the marker counts those four steps as done while Final render and Publish still read the real render and posts, and records nothing in `productionReview`, so clearing it restores the gates.
 * It counts only while the project holds a final render (without one, Final render is unreachable since rendering here needs the approvals the marker skips, so the prompts stay). It belongs to one record; a clone starts without it.
 */
export const FINISHED_OUTSIDE_STAGE_IDS = Object.freeze(['setup', 'cast-sets', 'board', 'produce']);

export const finishedOutside = (project) => {
  const marker = project?.finishedOutside;
  return marker && typeof marker.markedAt === 'string' && marker.markedAt && project.renderHistoryId ? marker : null;
};

export const finishedOutsideBlocker = (project) => (project?.renderHistoryId
  ? null : 'Bring the finished video in as the final render first; rendering here needs the step approvals.');

export const FINISHED_OUTSIDE_RERENDER_NOTE = 'Re-rendering here needs the Song through Shots approvals; unmark Finished outside PortOS in Project settings to bring them back.';

export const finishedOutsideCovers = (project, stageId) => !!finishedOutside(project) && FINISHED_OUTSIDE_STAGE_IDS.includes(stageId);
