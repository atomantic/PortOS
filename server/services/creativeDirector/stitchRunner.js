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

import { join } from 'path';
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
import { getIssue, sanitizeAudioMode } from '../pipeline/issues.js';
import { muxMusicBed, muxVoLines, muxCueBed, muxStripAudio, resolveMusicTrackPath, selectPlacedVoLines, selectPlacedCues } from '../pipeline/audioMux.js';
import { placeCuesOnTimeline } from '../pipeline/audioCuePlacement.js';
import { PATHS, sleep } from '../../lib/fileUtils.js';
import { probeVideoDuration } from '../../lib/ffmpeg.js';

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
      if (jobStatus && (jobStatus.status === 'error' || jobStatus.status === 'canceled')) {
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

    // Best-effort music-bed overlay (Phase 4d) — must not block the stitch.
    await maybeMuxPipelineAudio(project, finalEntry);

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

async function maybeMuxPipelineAudio(project, finalEntry) {
  if (!project?.sourceIssueId) return;
  const issue = await getIssue(project.sourceIssueId).catch(() => null);
  if (!issue) {
    console.log(`⚠️ CD stitch mux: source issue ${project.sourceIssueId.slice(0, 8)} not found — skipping`);
    return;
  }

  const videoPath = join(PATHS.videos, finalEntry.filename);
  // Whole-episode audio strategy (issue #863). Absent / unknown audioMode reads
  // as 'per-clip' (the sanitizer already defaults it), so existing issues keep
  // today's behavior. Placed VO lines are muxable in every non-silent mode.
  const audioMode = sanitizeAudioMode(issue.stages?.audio?.audioMode);
  const voLines = selectPlacedVoLines(issue.stages?.audio?.lines);

  // 'generated' — assemble the arc-driven cues[] onto the timeline. Cue timing
  // is derived HERE from the rendered episode's duration (the design defers
  // placement to stitch time). Falls back to the music-bed path only if there
  // are no placed+rendered cues.
  if (audioMode === 'generated') {
    const cues = Array.isArray(issue.stages?.audio?.cues) ? issue.stages.audio.cues : [];
    const hasRendered = cues.some((c) => c?.trackFilename);
    if (hasRendered) {
      const totalSec = await probeVideoDuration(videoPath);
      // Place the FULL ordered cue list first so each cue keeps its own arc slot,
      // THEN drop the un-rendered ones (selectPlacedCues filters on trackFilename).
      // Placing only the rendered subset would collapse the timeline onto it — a
      // single rendered "climax" cue would stretch across the whole episode
      // instead of staying in its slot, leaving the un-rendered slots as silence.
      const placed = selectPlacedCues(placeCuesOnTimeline(cues, totalSec));
      if (placed.length) {
        console.log(`🎼 CD stitch mux: laying ${placed.length} generated cue(s)${voLines.length ? ` + ${voLines.length} VO line(s)` : ''} onto ${finalEntry.filename}`);
        const result = await muxCueBed(videoPath, { cues: placed, voLines });
        if (result.ok) {
          console.log(`✅ CD stitch mux: cue bed applied to ${finalEntry.filename} (${result.cueCount} cue(s)${result.ducked ? ', VO ducked' : ''}${result.clipAudio ? ', clip audio preserved' : ''})`);
          return;
        }
        console.log(`⚠️ CD stitch mux: cue bed skipped (${result.reason}) — keeping clip audio`);
      } else {
        console.log(`⚠️ CD stitch mux: generated mode but no placeable cues (episode duration unknown?) — keeping clip audio`);
      }
    } else {
      console.log(`⚠️ CD stitch mux: generated mode but no rendered cues — keeping clip audio`);
    }
    // No cue bed landed. If VO lines are placed, still overlay them (no music
    // bed) so dialogue isn't lost; otherwise leave the clip audio as-is.
    if (voLines.length) {
      const result = await muxVoLines(videoPath, { voLines, musicPath: null });
      if (result.ok) console.log(`✅ CD stitch mux: VO-only overlay applied to ${finalEntry.filename}`);
    }
    return;
  }

  // 'silent' — strip the clip's own soundtrack (the design mutes the bed AND the
  // clip audio). Strip first, then overlay any placed VO over the now-silent
  // video: the VO mux re-probes and finds no audio stream, so dialogue plays
  // with no clip bed underneath — "ducked over silence" per the design table.
  if (audioMode === 'silent') {
    console.log(`🔇 CD stitch mux: silent mode — stripping clip audio${voLines.length ? ` + overlaying ${voLines.length} VO line(s)` : ''} on ${finalEntry.filename}`);
    const stripped = await muxStripAudio(videoPath);
    if (!stripped.ok) {
      console.log(`⚠️ CD stitch mux: silent strip skipped (${stripped.reason}) — keeping output`);
      return;
    }
    if (voLines.length) {
      const result = await muxVoLines(videoPath, { voLines, musicPath: null });
      if (result.ok) console.log(`✅ CD stitch mux: VO applied over silence to ${finalEntry.filename}`);
      else console.log(`⚠️ CD stitch mux: VO skipped (${result.reason}) — silent video kept`);
    } else {
      console.log(`✅ CD stitch mux: silent episode (clip audio stripped) for ${finalEntry.filename}`);
    }
    return;
  }

  // 'per-clip' — preserve each stitched clip's OWN soundtrack; never lay an
  // episode-level bed, even if a leftover music pointer exists (an issue may
  // have been switched to per-clip with a stale music.trackFilename). Overlay
  // placed VO (ducked over the clip audio, which muxVoLines preserves) with NO
  // music bed; with no VO, leave the stitch untouched.
  if (audioMode === 'per-clip') {
    if (voLines.length) {
      console.log(`🎙️ CD stitch mux: per-clip mode — overlaying ${voLines.length} VO line(s) (no bed) onto ${finalEntry.filename}`);
      const result = await muxVoLines(videoPath, { voLines, musicPath: null });
      if (result.ok) console.log(`✅ CD stitch mux: VO applied (per-clip) to ${finalEntry.filename}${result.clipAudio ? ', clip audio preserved' : ''}`);
      else console.log(`⚠️ CD stitch mux: VO skipped (${result.reason}) — keeping clip audio`);
    }
    return;
  }

  // 'uploaded-track' — loop the single music pointer under the whole episode
  // (today's bed path). VO, when placed, ducks the bed under dialogue.
  const musicFilename = issue.stages?.audio?.music?.trackFilename;
  const musicPath = await resolveMusicTrackPath(musicFilename);

  // Nothing to overlay — no placed VO and no music. Leave the stitch as-is.
  if (!voLines.length && !musicPath) return;

  if (voLines.length) {
    console.log(`🎙️ CD stitch mux: overlaying ${voLines.length} VO line(s)${musicPath ? ' + ducked music bed' : ''} onto ${finalEntry.filename}`);
    const result = await muxVoLines(videoPath, { voLines, musicPath });
    if (result.ok) {
      console.log(`✅ CD stitch mux: VO mux applied to ${finalEntry.filename} (${result.lineCount} line(s)${result.ducked ? ', music ducked' : ''}${result.clipAudio ? ', clip audio preserved' : ''})`);
      return;
    }
    // VO mux failed — fall through to a plain music bed if we have one, so a
    // graph error doesn't strip the music too.
    console.log(`⚠️ CD stitch mux: VO mux skipped (${result.reason})${musicPath ? ' — falling back to music bed' : ''}`);
  }

  if (!musicPath) return;
  console.log(`🎵 CD stitch mux: overlaying ${musicFilename} onto ${finalEntry.filename}`);
  const result = await muxMusicBed(videoPath, { musicPath });
  if (result.ok) {
    console.log(`✅ CD stitch mux: music bed applied to ${finalEntry.filename}`);
  } else {
    console.log(`⚠️ CD stitch mux: music bed skipped (${result.reason}) — keeping silent output`);
  }
}
