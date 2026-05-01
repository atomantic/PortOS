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
  getRenderJobStatus,
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
    await updateProject(projectId, { status: 'failed', failureReason: 'No accepted scenes to stitch' }).catch(() => {});
    return;
  }

  await updateProject(projectId, { status: 'stitching', failureReason: null });
  console.log(`🎬 CD stitch starting: ${projectId} (${clips.length} clips)`);

  try {
    const timeline = await createTimelineProject(`${project.name} — Final Cut`);
    await updateTimelineProject(timeline.id, { clips });
    await updateProject(projectId, { timelineProjectId: timeline.id });

    const { jobId } = await renderTimelineProject(timeline.id);

    // Poll video-history.json for an entry tagged with our timelineProjectId.
    // The timeline service appends a history entry at the end of a successful
    // render with `timelineProjectId` set, so when we see it the mp4 is on
    // disk. In parallel, check the job's in-memory status so an ffmpeg failure
    // breaks out of the loop within seconds instead of waiting 30 minutes.
    const deadline = Date.now() + FINAL_RENDER_TIMEOUT_MS;
    let finalEntry = null;
    while (Date.now() < deadline) {
      // Fast-fail: if the render job itself has entered an error/cancelled
      // state, there will never be a history entry — bail immediately.
      const jobStatus = getRenderJobStatus(jobId);
      if (jobStatus && (jobStatus.status === 'error' || jobStatus.status === 'cancelled')) {
        const reason = jobStatus.error ?? `Render ${jobStatus.status}`;
        console.log(`❌ CD stitch: timeline render ${jobStatus.status} for ${timeline.id}: ${reason}`);
        await updateProject(projectId, { status: 'failed', failureReason: reason });
        return;
      }

      const history = await loadHistory().catch(() => []);
      finalEntry = history.find((h) => h.id === jobId || h.timelineProjectId === timeline.id);
      if (finalEntry) break;
      await sleep(FINAL_RENDER_POLL_MS);
    }

    if (!finalEntry) {
      const reason = 'Timeline render timed out';
      console.log(`⚠️ CD stitch: ${reason} for ${timeline.id}`);
      await updateProject(projectId, { status: 'failed', failureReason: reason });
      return;
    }

    await updateProject(projectId, {
      finalVideoId: finalEntry.id,
      status: 'complete',
      failureReason: null,
    });
    // Best-effort: append the final cut to the project's collection so it sits
    // alongside the segment renders.
    if (project.collectionId) {
      await addCollectionItem(project.collectionId, { kind: 'video', ref: finalEntry.id })
        .catch((e) => console.log(`⚠️ CD stitch addCollectionItem failed: ${e.message}`));
    }
    console.log(`✅ CD stitch complete: ${projectId} → ${finalEntry.id.slice(0, 8)}`);
  } catch (err) {
    const reason = err?.message ?? String(err);
    console.log(`❌ CD stitch error for ${projectId}: ${reason}`);
    await updateProject(projectId, { status: 'failed', failureReason: reason }).catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
