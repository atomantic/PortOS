/**
 * "Where does this Creative Director project stand, and what is the user's next
 * move" — the one status line under the project title (#9949), derived from the
 * project record alone so it can be tested without rendering the page.
 *
 * Returns `{ headline, tone, facts, next }`. `tone` is `warn` while the project
 * waits on the user, `error` when it failed, `ok` when done, else `muted`
 * (the director is working). `next` is `{ id, label, reason, tab? }` or null:
 * `start` / `resume` run the project, `edit-draft` opens the video draft,
 * `goto` opens `tab`, `open-final` opens the delivered video. A `goto` into the
 * tab already on screen is dropped — the work is already in front of the user.
 */

const sceneProgress = (project) => {
  const scenes = project.treatment?.scenes || [];
  if (!scenes.length) return null;
  return `${scenes.filter((scene) => scene.status === 'accepted').length} of ${scenes.length} scenes accepted`;
};

const videoNext = (project, { cut, activeTab }) => {
  const { status } = project;
  if (status === 'draft') return { id: 'edit-draft', label: 'Edit draft', reason: 'Review the brief and production limits, then start from the Overview' };
  if (status === 'paused' || status === 'failed') return { id: 'edit-draft', label: 'Edit production settings', reason: 'Adjust the saved choices before restarting' };
  if (status === 'complete') return null;
  if (cut?.filename && activeTab !== 'review') return { id: 'goto', tab: 'review', label: 'Review the cut', reason: 'Approve or request changes to the assembled cut' };
  return null;
};

const standardNext = (project) => {
  switch (project.status) {
    case 'draft': return { id: 'start', label: 'Start', reason: 'Start the director on this project' };
    case 'paused': return { id: 'resume', label: 'Resume', reason: 'Continue where the director paused' };
    case 'failed': return { id: 'start', label: 'Retry', reason: 'Start the director again from the saved state' };
    case 'complete': return project.finalVideoId ? { id: 'open-final', label: 'Open final video', reason: 'View the delivered video in Media History' } : null;
    default: return null;
  }
};

export function describeCreativeDirectorStatus(project, { activeAgents = 0, activeTab = null } = {}) {
  if (!project) return null;
  const isVideo = project.workspace === 'video';
  const cut = project.videoFinalCut || project.videoRoughCut;
  const cutAwaitingReview = isVideo && !!cut?.filename && !['draft', 'failed', 'complete'].includes(project.status);
  const progress = sceneProgress(project);

  let headline;
  let tone = 'muted';
  switch (project.status) {
    case 'draft': headline = 'Draft · waiting for you to start'; tone = 'warn'; break;
    case 'planning': headline = 'Planning · the director is writing the treatment and plan'; break;
    case 'rendering': headline = progress ? `Rendering · ${progress}` : 'Rendering · the director is generating scenes'; break;
    case 'stitching': headline = 'Stitching · assembling the final video'; break;
    case 'paused': headline = 'Paused · waiting for you to resume'; tone = 'warn'; break;
    case 'failed': headline = `Failed${project.failureReason ? ` · ${project.failureReason}` : ''}`; tone = 'error'; break;
    case 'complete': headline = 'Complete · final video ready'; tone = 'ok'; break;
    default: headline = `Status: ${project.status}`;
  }
  if (cutAwaitingReview) {
    headline = 'Cut ready · waiting for your review';
    tone = 'warn';
  }

  const facts = [];
  if (activeAgents > 0) facts.push({ id: 'agents', label: `${activeAgents} ${activeAgents === 1 ? 'agent' : 'agents'} working`, tone: 'muted' });
  if (progress && project.status !== 'rendering') facts.push({ id: 'scenes', label: progress, tone: 'muted' });

  let next = isVideo ? videoNext(project, { cut, activeTab }) : standardNext(project);
  if (next?.id === 'goto' && next.tab === activeTab) next = null;
  return { headline, tone, facts, next };
}
