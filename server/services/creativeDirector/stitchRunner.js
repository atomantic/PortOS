/**
 * Creative Director — server-side stitch (final cut) orchestrator.
 *
 * The stitch step is purely mechanical: build a video-timeline project with
 * the accepted scenes' clips, kick off the timeline render, wait for the
 * resulting mp4 to land in `data/video-history.json` (the timeline service
 * appends to it on success), and update the CD project with the final
 * video id + status='complete'.
 *
 * No agent/LLM cognition needed at this stage — there's no decision to
 * make. We removed the previous `stitch` agent task entirely.
 */

import {
  createProject as createTimelineProject,
  updateProject as updateTimelineProject,
  renderProject as renderTimelineProject,
} from '../videoTimeline/local.js';
import { loadHistory } from '../videoGen/local.js';
import { addItem as addCollectionItem } from '../mediaCollections.js';
import { buildTimelineClips } from './orchestrator.js';
import { getProject, updateProject } from './local.js';

const FINAL_RENDER_POLL_MS = 3000;
const FINAL_RENDER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — concat is fast but be generous on big projects.

export async function runStitch(projectId) {
  const project = await getProject(projectId);
  if (!project) {
    console.log(`⚠️ CD stitch: project ${projectId} not found`);
    return;
  }
  const clips = buildTimelineClips(project);
  if (!clips.length) {
    console.log(`⚠️ CD stitch: project ${projectId} has no accepted scenes — marking failed`);
    await updateProject(projectId, { status: 'failed' }).catch(() => {});
    return;
  }

  await updateProject(projectId, { status: 'stitching' });
  console.log(`🎬 CD stitch starting: ${projectId} (${clips.length} clips)`);

  const timeline = await createTimelineProject(`${project.name} — Final Cut`);
  await updateTimelineProject(timeline.id, { clips });
  await updateProject(projectId, { timelineProjectId: timeline.id });

  const { jobId } = await renderTimelineProject(timeline.id);

  // Poll video-history.json for an entry tagged with our timelineProjectId.
  // The timeline service appends a history entry at the end of a successful
  // render with `timelineProjectId` set, so when we see it the mp4 is on
  // disk. (The timeline service doesn't expose a shared event emitter, so
  // polling is the simplest correct hand-off.)
  const deadline = Date.now() + FINAL_RENDER_TIMEOUT_MS;
  let finalEntry = null;
  while (Date.now() < deadline) {
    const history = await loadHistory().catch(() => []);
    finalEntry = history.find((h) => h.id === jobId || h.timelineProjectId === timeline.id);
    if (finalEntry) break;
    await sleep(FINAL_RENDER_POLL_MS);
  }
  if (!finalEntry) {
    console.log(`⚠️ CD stitch: timeline render for ${timeline.id} timed out`);
    await updateProject(projectId, { status: 'failed' }).catch(() => {});
    return;
  }

  await updateProject(projectId, {
    finalVideoId: finalEntry.id,
    status: 'complete',
  });
  // Best-effort: append the final cut to the project's collection so it sits
  // alongside the segment renders.
  if (project.collectionId) {
    await addCollectionItem(project.collectionId, { kind: 'video', ref: finalEntry.id })
      .catch((e) => console.log(`⚠️ CD stitch addCollectionItem failed: ${e.message}`));
  }
  console.log(`✅ CD stitch complete: ${projectId} → ${finalEntry.id.slice(0, 8)}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
