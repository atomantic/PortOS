/**
 * A project finished outside PortOS: the song, look, storyboard and footage were
 * made elsewhere and only the final video (and its posts) came back in, so the
 * revision-bound approvals those steps gate on were never recorded here.
 *
 * The director says so explicitly (`project.finishedOutside`) instead of PortOS
 * forging review evidence it never saw: the marker counts those four steps as
 * done, while Final render and Publish still read the real render and posts.
 * It records nothing in `productionReview`, so clearing it restores the gates.
 *
 * The marker stands for "the finished video already exists", so it only counts
 * while the project holds a final render: without one, Final render could never
 * be reached (rendering here needs the approvals the marker skips), so the
 * approval prompts stay. It belongs to one record; a clone starts without it.
 */
export const FINISHED_OUTSIDE_STAGE_IDS = Object.freeze(['setup', 'cast-sets', 'board', 'produce']);

/** The marker (`{ markedAt, note? }`) when the project was finished outside PortOS and holds its final render, else null. */
export const finishedOutside = (project) => {
  const marker = project?.finishedOutside;
  return marker && typeof marker.markedAt === 'string' && marker.markedAt && project.renderHistoryId ? marker : null;
};

/** Why the marker can't be set yet, or null when it can. */
export const finishedOutsideBlocker = (project) => (project?.renderHistoryId
  ? null : 'Bring the finished video in as the final render first; rendering here needs the step approvals.');

/** The Final render note for a marked project whose render went out of date: re-rendering here needs the approvals. */
export const FINISHED_OUTSIDE_RERENDER_NOTE = 'Re-rendering here needs the Song through Make approvals; unmark Finished outside PortOS in Project settings to bring them back.';

/** Whether the marker covers `stageId`. */
export const finishedOutsideCovers = (project, stageId) => !!finishedOutside(project) && FINISHED_OUTSIDE_STAGE_IDS.includes(stageId);
