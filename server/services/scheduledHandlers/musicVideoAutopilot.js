/**
 * Scheduled handler `music-video-autopilot` — turn one Brain idea into a fully
 * autonomous music video per run.
 *
 * PROGRAMMATIC: no agent is spawned. Each run picks the OLDEST active Brain idea
 * no earlier autonomous run used (optionally limited to ideas carrying one of
 * `ideaTags`), then starts the same autonomous run the Music Video page's
 * "Autonomous" entry point starts: creative brief → lyrics → mood board → Suno
 * song → analysis → production. The task's `taskMetadata.musicVideoAutopilot`
 * carries the run settings (tools, per-tool models, budget, limits, checkpoints,
 * LLM) — see `normalizeAutopilotParams` in `lib/musicVideoAutonomous.js`.
 *
 * It declines (never queues a second one) while a previous autonomous run is
 * still live, so a slow Suno login or a long production cannot pile up videos.
 * An idea only counts as used once its run is live or finished; a failed or
 * canceled run leaves the idea available for the next fire.
 *
 * `countPending` is side-effect free and makes no provider call.
 */

import { getIdeas } from '../brainStorage.js';
import { listProjects } from '../musicVideo/projects.js';
import { AUTONOMOUS_LIVE_STATUSES, ideaToPrompt, normalizeAutopilotParams, pickBrainIdea } from '../../lib/musicVideoAutonomous.js';

const USED_STATUSES = new Set([...AUTONOMOUS_LIVE_STATUSES, 'completed']);

/** Brain ideas an earlier run already turned into a video, and whether a run is still live. */
function priorRuns(projects) {
  const usedIdeaIds = [];
  let live = null;
  for (const project of projects || []) {
    const run = project?.autonomousRun;
    if (!run || project.deleted) continue;
    if (run.brief?.origin?.ideaId && USED_STATUSES.has(run.status)) usedIdeaIds.push(run.brief.origin.ideaId);
    if (run.brief?.origin?.kind === 'schedule' && AUTONOMOUS_LIVE_STATUSES.includes(run.status)) live = project;
  }
  return { usedIdeaIds, live };
}

async function inspect(params) {
  const settings = normalizeAutopilotParams(params?.musicVideoAutopilot) || normalizeAutopilotParams({});
  const [ideas, projects] = await Promise.all([getIdeas(), listProjects()]);
  const { usedIdeaIds, live } = priorRuns(projects);
  const idea = pickBrainIdea(ideas, { usedIdeaIds, tags: settings.ideaTags });
  return { settings, idea, live };
}

export async function countPending({ params } = {}) {
  const { idea, live } = await inspect(params);
  if (live) return { count: 0, detail: `"${live.name}" is still in progress` };
  return { count: idea ? 1 : 0, detail: idea ? `Next idea: ${idea.title}` : 'No unused active Brain ideas' };
}

export async function run({ params } = {}) {
  const { settings, idea, live } = await inspect(params);
  if (live) return { dispatched: false, reason: `a previous autonomous music video ("${live.name}") is still in progress` };
  if (!idea) return { dispatched: false, reason: 'no unused active Brain ideas to turn into a music video' };
  const { ideaTags: _ideaTags, ...runSettings } = settings;
  const { startAutonomousVideo } = await import('../musicVideo/autonomousService.js');
  const { project } = await startAutonomousVideo({
    ...runSettings,
    // The LLM pin is stored as `llm` on the normalized settings; the start
    // request takes it as providerId/model.
    providerId: settings.llm?.providerId,
    model: settings.llm?.model || undefined,
    prompt: ideaToPrompt(idea),
    origin: { kind: 'schedule', ideaId: idea.id, ideaTitle: idea.title },
  });
  return { dispatched: true, summary: `Started music video "${project.name}" from Brain idea "${idea.title}"` };
}
