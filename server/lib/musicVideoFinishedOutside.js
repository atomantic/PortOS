/**
 * A project finished outside PortOS: the song, look, storyboard and footage were
 * made elsewhere and only the final video (and its posts) came back in, so the
 * revision-bound approvals those steps gate on were never recorded here.
 *
 * The director says so explicitly (`project.finishedOutside`) instead of PortOS
 * forging review evidence it never saw: the marker counts those four steps as
 * done, while Final render and Publish still read the real render and posts.
 * It records nothing in `productionReview`, so clearing it restores the gates.
 */
export const FINISHED_OUTSIDE_STAGE_IDS = Object.freeze(['setup', 'cast-sets', 'board', 'produce']);

/** The marker (`{ markedAt, note? }`) when the project was finished outside PortOS, else null. */
export const finishedOutside = (project) => {
  const marker = project?.finishedOutside;
  return marker && typeof marker.markedAt === 'string' && marker.markedAt ? marker : null;
};

/** Whether the marker covers `stageId`. */
export const finishedOutsideCovers = (project, stageId) => !!finishedOutside(project) && FINISHED_OUTSIDE_STAGE_IDS.includes(stageId);
