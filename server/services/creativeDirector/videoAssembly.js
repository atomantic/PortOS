/** Video final-cut contract on the existing Timeline renderer and media history. */
import { join } from 'path';
import { PATHS, sleep } from '../../lib/fileUtils.js';
import { safeUnder, verifyVideoPlayable, probeVideoDuration, probeVideoStreamInfo, hasAudioStream } from '../../lib/ffmpeg.js';
import { canonicalSnapshotChecksum } from '../../lib/snapshotChecksum.js';
import { ServerError } from '../../lib/errorHandler.js';

const inFlight = new Set();
const fail = message => new ServerError(message, { status: 409, code: 'VIDEO_ASSEMBLY_BLOCKED' });

/** Check actual files, not render status or metadata claims. */
export async function validateVideoCut(project, entry) {
  if (!entry?.filename || !safeUnder(PATHS.videos, entry.filename)) throw fail('The assembled video file is missing. Open Timeline and render the cut again.');
  const path = join(PATHS.videos, entry.filename);
  const playable = await verifyVideoPlayable(path);
  if (!playable.ok) throw fail(`The assembled video is not playable: ${playable.reason}. Open Timeline to repair it.`);
  const [durationSeconds, stream, audio] = await Promise.all([probeVideoDuration(path), probeVideoStreamInfo(path), hasAudioStream(path)]);
  if (!(durationSeconds > 0 && stream.fps > 0 && stream.width > 0 && stream.height > 0)) throw fail('The final video stream could not be verified. Install working ffmpeg and ffprobe before retrying assembly.');
  const range = project.videoDraft.durationRange;
  const tolerance = 1 / stream.fps + 1e-6;
  if (durationSeconds < range.min - tolerance || durationSeconds > range.max + tolerance) throw fail(`The assembled duration (${durationSeconds.toFixed(2)} seconds) is outside the requested ${range.min}–${range.max} seconds. Revise shot timing or the requested range.`);
  if (Math.abs(durationSeconds - project.targetDurationSeconds) > tolerance) throw fail('The assembled cut does not match the saved exact duration target. Revise the shot timing before resuming.');
  const audioMode = project.videoExecution.choices.audio.mode || 'native';
  if (audioMode === 'silent' ? audio : !audio) throw fail(audioMode === 'silent' ? 'The silent cut still contains an audio stream.' : 'The final cut is missing its requested audio stream. Choose a soundtrack or a renderer that supplies native audio.');
  return { videoId: entry.id, filename: entry.filename, durationSeconds, fps: stream.fps, audioMode };
}

async function prepareClips(project, history) {
  const requested = project.directive && project.plan?.steps?.length
    ? project.plan.steps.map(step => {
      if (step.status !== 'done' || step.toolName !== 'media_enqueueVideoJob' || !step.result?.jobId) throw fail('Every planned clip must finish before assembly. Review the failed or incomplete steps.');
      return { clipId: step.result.jobId, outSec: step.args?.params?.durationSeconds };
    })
    : [...(project.treatment?.scenes || [])].sort((a, b) => a.order - b.order).map(scene => {
      if (scene.status !== 'accepted' || !scene.renderedJobId) throw fail('Every shot must be accepted before assembly. Partial clips remain available in Artifacts.');
      return { clipId: scene.renderedJobId, outSec: scene.durationSeconds, muteAudio: Boolean(scene.muteAudio) };
    });
  if (!requested.length) throw fail('No completed clips are available to assemble.');
  const segments = [];
  let remaining = project.targetDurationSeconds;
  for (const clip of requested) {
    const entry = history.find(row => row.id === clip.clipId);
    if (!entry?.filename || !safeUnder(PATHS.videos, entry.filename)) throw fail(`A required clip (${clip.clipId}) is missing from Media History.`);
    const path = join(PATHS.videos, entry.filename);
    const playable = await verifyVideoPlayable(path);
    if (!playable.ok) throw fail(`A required clip is not playable: ${playable.reason}. Revise or render that shot again.`);
    const [duration, stream, audio] = await Promise.all([probeVideoDuration(path), probeVideoStreamInfo(path), hasAudioStream(path)]);
    if (!(duration > 0 && stream.fps > 0)) throw fail('A source clip duration could not be verified. Check ffprobe and the source file.');
    if (project.videoExecution.choices.audio.mode === 'native' && !clip.muteAudio && !audio) throw fail('A source clip has no native audio. Select silent or a soundtrack before resuming.');
    if (!(clip.outSec > 0) || clip.outSec > duration + 1 / stream.fps + 1e-6) throw fail('A rendered clip is shorter than its planned shot. Revise the timing or render the shot again.');
    if (remaining <= 0) throw fail('The planned shots exceed the exact target before the last shot. Revise their timing so every shot fits the final cut.');
    const outSec = Math.min(clip.outSec, duration, remaining);
    const fadeSec = project.videoDraft.transition === 'fade' ? Math.min(0.25, outSec / 2) : 0;
    segments.push({ type: 'clip', clipId: clip.clipId, inSec: 0, outSec, fadeInSec: fadeSec, fadeOutSec: fadeSec, ...(clip.muteAudio ? { volume: 0 } : {}) });
    remaining -= outSec;
  }
  if (!segments.length) throw fail('The requested cut has no playable duration.');
  return segments;
}

export async function runVideoAssembly(projectId) {
  if (inFlight.has(projectId)) return;
  inFlight.add(projectId);
  const { getProject, mutateVideoProject } = await import('./local.js');
  const { videoReviewAllowsDispatch } = await import('./videoReview.js');
  const { videoConfigurationRevision } = await import('./videoExecution.js');
  let project;
  const matches = current => current?.videoExecution?.authorized && ['rendering', 'stitching'].includes(current.status)
    && (current.videoWorkRevision || 0) === (project?.videoWorkRevision || 0)
    && current.videoExecution.inputRevision === videoConfigurationRevision(current);
  const isCurrent = async () => matches(await getProject(projectId));
  const save = patch => mutateVideoProject(projectId, current => matches(current)
    ? { project: { ...current, ...patch, updatedAt: new Date().toISOString() }, result: true }
    : { project: current, result: false, skipPersist: true });
  try {
    if (!await videoReviewAllowsDispatch(projectId, ['script-shot-plan', 'references'])) return;
    project = await getProject(projectId);
    if (!matches(project)) return;
    const timeline = await import('../videoTimeline/local.js');
    const { loadHistory } = await import('../videoGen/local.js');
    const { prepareVideoSoundtrack } = await import('./videoAudio.js');
    const { muxStripAudio, resolveMusicTrackPath } = await import('../pipeline/audioMux.js');
    const history = await loadHistory();
    const segments = await prepareClips(project, history);
    const contentRevision = canonicalSnapshotChecksum({ segments, audio: project.videoExecution.choices.audio,
      input: project.videoExecution.inputRevision, revision: project.videoWorkRevision || 0 });
    let entry = project.videoRoughCut?.contentRevision === contentRevision
      ? history.find(row => row.id === project.videoRoughCut.videoId) : null;
    if (!entry) {
      await save({ status: 'stitching', failureReason: null });
      const soundtrack = await prepareVideoSoundtrack(project, isCurrent);
      if (!await isCurrent()) return;
      if (['imported', 'generated'].includes(project.videoExecution.choices.audio.mode) && !soundtrack) return;
      let timelineProject = project.timelineProjectId ? await timeline.getProject(project.timelineProjectId).catch(() => null) : null;
      if (!timelineProject) timelineProject = await timeline.createProject(`${project.name} — Final Cut`);
      if (!await isCurrent()) return;
      await save({ timelineProjectId: timelineProject.id });
      // Replace all lanes deliberately: reused timelines must not retain unrelated overlays or beds.
      const tracks = [];
      const audioMode = project.videoExecution.choices.audio.mode;
      if (soundtrack) {
        const audioPath = await resolveMusicTrackPath(soundtrack.filename);
        const duration = audioPath && await probeVideoDuration(audioPath);
        if (!(duration > 0) || !await hasAudioStream(audioPath)) throw fail('The soundtrack is not playable. Repair it in Music before resuming.');
        const total = segments.reduce((sum, clip) => sum + clip.outSec - clip.inSec, 0);
        const { MAX_AUDIO_TRACKS } = await import('../videoTimeline/segments.js');
        if (Math.ceil(total / duration) > MAX_AUDIO_TRACKS) throw fail('The soundtrack is too short for this cut. Choose a longer track before resuming.');
        for (let startSec = 0; startSec < total; startSec += duration) tracks.push({ assetKind: 'music', assetFile: soundtrack.filename, startSec, offsetSec: 0, durationSec: Math.min(duration, total - startSec), volume: 1 });
      }
      await timeline.updateProject(timelineProject.id, { segments, overlays: [], audio: { clipVolume: audioMode === 'native' ? 1 : 0, tracks } });
      const prior = project.videoExecution.assembly;
      let jobId = prior?.contentRevision === contentRevision ? prior.jobId : null;
      entry = jobId ? history.find(row => row.id === jobId) : null;
      if (!entry && !['running', 'pending'].includes(timeline.getRenderJobStatus(jobId)?.status)) {
        if (!await isCurrent()) return;
        ({ jobId } = await timeline.renderProject(timelineProject.id));
        await mutateVideoProject(projectId, current => matches(current)
          ? { project: { ...current, videoExecution: { ...current.videoExecution, assembly: { jobId, contentRevision, timelineProjectId: timelineProject.id } } }, result: true }
          : { project: current, result: false, skipPersist: true });
      }
      const deadline = Date.now() + 30 * 60 * 1000;
      while (!entry && Date.now() < deadline) {
        if (!await isCurrent()) { timeline.cancelRender(jobId); return; }
        const status = timeline.getRenderJobStatus(jobId);
        if (['error', 'canceled'].includes(status?.status)) throw fail(`Timeline assembly ${status.status}: ${status.error || 'Open Timeline to inspect the cut.'}`);
        entry = (await loadHistory()).find(row => row.id === jobId);
        if (!entry) await sleep(1000);
      }
      if (!entry) { timeline.cancelRender(jobId); throw fail('Timeline assembly timed out. Partial clips remain available; inspect Timeline and Resume.'); }
      if (!await isCurrent()) return;
      const path = safeUnder(PATHS.videos, entry.filename) ? join(PATHS.videos, entry.filename) : null;
      if (!path) throw fail('Timeline returned an invalid output path.');
      const mode = project.videoExecution.choices.audio.mode;
      const muxed = mode === 'silent' ? await muxStripAudio(path) : { ok: true };
      if (!muxed.ok) throw fail(`Could not apply the selected audio: ${muxed.reason}. Repair the soundtrack before resuming.`);
    }
    if (!await isCurrent()) return;
    const artifact = { ...await validateVideoCut(project, entry), contentRevision };
    if (!(await save({ videoRoughCut: artifact })).result) return;
    if (!await videoReviewAllowsDispatch(projectId, ['rough-cut'])) return;
    if (!(await save({ videoFinalCut: artifact })).result) return;
    if (!await videoReviewAllowsDispatch(projectId, ['final-cut'])) return;
    // Revalidate at delivery, including a resume after the file was reviewed or removed.
    await validateVideoCut(project, entry);
    if (project.collectionId) {
      const { addItem } = await import('../mediaCollections.js');
      await addItem(project.collectionId, { kind: 'video', ref: entry.id });
    }
    await save({ finalVideoId: entry.id, status: 'complete', failureReason: null });
  } catch (error) {
    if (project) {
      const { retainVideoCuts } = await import('../../lib/creativeDirectorVideoReview.js');
      await mutateVideoProject(projectId, current => matches(current)
        ? { project: { ...current, status: 'paused', failureReason: `${error.message} Review Artifacts, Timeline, or production settings, then Resume.`,
          videoCutHistory: retainVideoCuts(current), videoRoughCut: null, videoFinalCut: null, finalVideoId: null,
          videoExecution: { ...current.videoExecution, assembly: null }, updatedAt: new Date().toISOString() }, result: true }
        : { project: current, result: false, skipPersist: true });
    }
  } finally {
    inFlight.delete(projectId);
  }
}
