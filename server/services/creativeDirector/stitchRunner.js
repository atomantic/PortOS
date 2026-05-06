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
  getProject as getTimelineProject,
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
    // Reuse the previously-created timeline project if one exists. Without
    // this, a server crash or restart between createTimelineProject and the
    // final render's history landing would create a fresh timeline project
    // every recovery cycle, leaking orphaned entries into video-projects.json
    // and the Timeline UI. We still re-write the clips list (scenes may have
    // been re-rendered between attempts) before re-rendering. If the
    // persisted timelineProjectId points to a deleted/missing project, fall
    // through and create a new one.
    let timeline = null;
    if (project.timelineProjectId) {
      timeline = await getTimelineProject(project.timelineProjectId).catch(() => null);
      if (timeline) {
        console.log(`🔁 CD stitch: reusing timeline project ${timeline.id.slice(0, 8)} from prior attempt for ${projectId}`);
      } else {
        console.log(`🆕 CD stitch: persisted timelineProjectId for ${projectId} is missing — creating a fresh timeline project`);
      }
    }
    if (!timeline) {
      timeline = await createTimelineProject(`${project.name} — Final Cut`);
      await updateProject(projectId, { timelineProjectId: timeline.id });
    }
    await updateTimelineProject(timeline.id, { clips });

    const { jobId } = await renderTimelineProject(timeline.id);

    // Poll video-history.json for an entry whose id matches THIS render's
    // jobId. Match strictly on jobId — not on timelineProjectId — because
    // when we reuse an existing timeline project (recovery path), an older
    // successful render from a previous attempt could still be in history
    // tagged with the same timelineProjectId. Picking that up here would
    // mark the CD project complete with a stale finalVideoId while the
    // fresh render is still running. The timeline service writes its
    // history entry with `id: jobId` (videoTimeline/local.js), so jobId
    // alone uniquely identifies the current render's output.
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
      finalEntry = history.find((h) => h.id === jobId);
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
