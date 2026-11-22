/**
 * The director's own word on whether a Music Video is finished: `project.completion`
 * (`{ state, markedAt }`), which decides over the final render's evidence.
 *
 * Set from Project settings or `PUT /api/music-video/:id/completion`. Without it, a project is complete when its
 * final render finished and that render's evidence is still current. With it, the
 * mark decides: a director can call a video done although an input moved after the
 * final (or put a finished one back in progress). A complete mark counts only while
 * the project holds a final render. It belongs to one record; a clone starts without it.
 */
export const MUSIC_VIDEO_COMPLETION_STATES = Object.freeze(['complete', 'in-progress']);

/** The stored mark, even one that does not count yet, or null. */
export function musicVideoCompletionMark(project) {
  const mark = project?.completion;
  return mark && MUSIC_VIDEO_COMPLETION_STATES.includes(mark.state) && typeof mark.markedAt === 'string' ? mark : null;
}

/** true or false when the director's mark decides completion; null when the evidence does. */
export function musicVideoCompletionOverride(project) {
  const mark = musicVideoCompletionMark(project);
  if (!mark) return null;
  if (mark.state === 'in-progress') return false;
  return project.renderHistoryId ? true : null;
}

/** Why `state` cannot be marked on `project` now, or null. */
export const musicVideoCompletionBlocker = (project, state) => (state === 'complete' && !project?.renderHistoryId
  ? 'Render the final video first; a project without a final render cannot be complete.'
  : null);
