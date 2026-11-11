/**
 * Work-in-progress cuts of a Blender film: every shot's video at one quality
 * in film order with the master song, so the director can watch the whole
 * thing while shots are still missing (black) or out of date. A cut carries
 * the project's grade, timed shot effects and title card as the final render
 * does; it can also go through the project's film look, and be published as
 * the project's review draft: a new version of one "Blender cut" animatic artifact.
 *
 * Cuts are regenerable files under renders/cuts/, indexed by cuts.json; the
 * newest 8 per quality are kept.
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../../../lib/fileCore.js';
import { maintenance } from '../../../lib/maintenanceAdmission.js';
import { requireProject } from '../requireProject.js';
import { blenderRefusal, blenderRendersDir, blenderScratchDir, readBlenderJson } from './workspace.js';
import { blenderNotSynced, planBlenderCut, readBlenderFilm } from './film.js';
import { blenderFinishFilter } from './finishFilter.js';
import { assembleBlenderVideo } from './assemble.js';
import { withBlenderTitleCard } from './titleCard.js';
import { requireFfmpeg } from './encode.js';
import { activeBlenderJobs, createBlenderJob, updateBlenderJob } from './jobs.js';
import { openBlenderJobLog } from './logs.js';
import { announceBlenderState } from './record.js';
import { blenderCutsFile } from './state.js';

const KEPT_PER_QUALITY = 8;
export const BLENDER_CUT_ARTIFACT_TITLE = 'Blender cut';

const cutsDir = (projectId) => join(blenderRendersDir(projectId), 'cuts');

async function recordCut(projectId, cut) {
  const listed = await readBlenderJson(blenderCutsFile(projectId), []);
  const all = [cut, ...(Array.isArray(listed) ? listed : []).filter((entry) => entry?.id !== cut.id)];
  const kept = [];
  const seen = { preview: 0, final: 0 };
  for (const entry of all) {
    if (seen[entry.quality] === undefined) continue;
    seen[entry.quality] += 1;
    if (seen[entry.quality] <= KEPT_PER_QUALITY) kept.push(entry);
    else if (typeof entry.file === 'string' && /^(preview|final)-[0-9A-Za-z-]+\.mp4$/.test(entry.file)) await rm(join(cutsDir(projectId), entry.file), { force: true });
  }
  await atomicWrite(blenderCutsFile(projectId), kept);
}

// The review draft is the newest version of one animatic artifact, so each
// published cut replaces the last in Review instead of piling up beside it.
async function publishReviewDraft(projectId, cutPath) {
  const [{ importDevArtifact }, project] = await Promise.all([import('../devArtifactService.js'), requireProject(projectId)]);
  const existing = (project.devArtifacts || []).find((artifact) => !artifact.deleted && artifact.kind === 'animatic' && artifact.title === BLENDER_CUT_ARTIFACT_TITLE);
  // importDevArtifact consumes the file it is given, so it gets a copy.
  const upload = `${cutPath}.review.mp4`;
  await copyFile(cutPath, upload);
  await importDevArtifact(projectId, {
    tempPath: upload, originalName: 'blender-cut.mp4', kind: 'animatic', title: BLENDER_CUT_ARTIFACT_TITLE,
    ...(existing ? { artifactId: existing.id } : {}),
  });
}

async function runCut(entry, { projectId, quality, animatic, filmLook, audioPath }) {
  const { signal } = entry.abort;
  const log = await openBlenderJobLog(projectId, entry.job.id);
  updateBlenderJob(entry, { status: 'running', logFile: log.file });
  const work = async () => {
    const project = await requireProject(projectId);
    const film = await readBlenderFilm(project);
    if (!film.shots.length) throw new Error('Sync shots from scripts first');
    const plan = planBlenderCut(film, quality);
    const id = `${quality}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const output = join(cutsDir(projectId), `${id}.mp4`);
    await mkdir(cutsDir(projectId), { recursive: true });
    log.write(`PortOS: ${quality} cut of ${film.shots.length} shots (${plan.missing.length} black, ${plan.stale.length} out of date)`);
    const progress = (from, to) => (fraction) => updateBlenderJob(entry, { index: Math.round((from + (to - from) * fraction) * 100), total: 100 });
    const { finishNeeded, lookPass } = await filmLookPass(project, filmLook);
    const frame = { width: plan.width, height: plan.height, fps: plan.fps, startSec: 0, endSec: film.shots[film.shots.length - 1].end };
    const { durationSec } = await withBlenderTitleCard({ project, jobId: entry.job.id, ...frame, signal }, (overlays) => {
      if (overlays.length) log.write('PortOS: title card over the cut');
      return assembleBlenderVideo({
        segments: plan.segments, width: plan.width, height: plan.height, fps: plan.fps, quality, overlays,
        filter: blenderFinishFilter(project, frame),
        audio: { path: audioPath, startSec: 0 }, output, scratch: blenderScratchDir(projectId, entry.job.id), signal,
        onProgress: progress(0, finishNeeded ? 0.5 : 1),
      });
    });
    if (finishNeeded) {
      updateBlenderJob(entry, { status: 'encoding' });
      log.write('PortOS: film look pass');
      await lookPass({ project, path: output, jobId: entry.job.id, signal, label: 'Blender cut film look', onProgress: progress(0.5, 1) })
        .catch(async (error) => { await rm(output, { force: true }); throw error; });
    }
    await recordCut(projectId, {
      id, quality, file: `${id}.mp4`, createdAt: new Date().toISOString(), durationSec: Number(durationSec.toFixed(3)),
      missing: plan.missing, stale: plan.stale, filmLook: finishNeeded,
    });
    if (animatic) await publishReviewDraft(projectId, output);
    log.write(`PortOS: cut ${id} ready`);
  };
  return work().finally(() => log.close());
}

// The finishing pass is the footage renders' own (filmLookFinish.js); loaded only when asked for.
async function filmLookPass(project, wanted) {
  if (!wanted) return { finishNeeded: false, lookPass: null };
  const { applyFilmLookFinish, filmLookFinishNeeded } = await import('../filmLookFinish.js');
  return { finishNeeded: filmLookFinishNeeded(project), lookPass: applyFilmLookFinish };
}

/**
 * Start assembling a cut in the background. Resolves `{ job }` at once; the
 * job's progress and end arrive on the `music-video:blender` channel.
 */
export async function startBlenderCut(projectId, { quality, animatic = false, filmLook = false }) {
  const project = await requireProject(projectId);
  await requireFfmpeg();
  if (!(await readBlenderFilm(project)).shots.length) throw blenderNotSynced();
  const { resolveProjectAudioPath } = await import('../projectAudio.js');
  const audioPath = await resolveProjectAudioPath(project);
  if (!existsSync(audioPath)) throw blenderRefusal('The project\'s song file is missing', 'AUDIO_MISSING', 404);
  if (activeBlenderJobs(projectId).some(({ job }) => job.kind === 'cut')) {
    throw blenderRefusal('A cut is already being assembled for this project', 'MUSIC_VIDEO_BLENDER_CUT_IN_PROGRESS', 409);
  }
  const entry = createBlenderJob(projectId, { kind: 'cut', quality });
  Promise.resolve()
    .then(() => maintenance.run('composition', 'Blender film cut', () => runCut(entry, { projectId, quality, animatic, filmLook, audioPath }), { continuation: true }))
    .then(() => updateBlenderJob(entry, { status: 'done', index: 100, total: 100 }), (error) => {
      if (entry.abort.signal.aborted) { updateBlenderJob(entry, { status: 'canceled' }); return; }
      console.error(`❌ Blender film ${quality} cut failed: ${error.message}`);
      updateBlenderJob(entry, { status: 'error', error: String(error.message || 'The cut failed').slice(0, 2000) });
    })
    .finally(() => announceBlenderState(projectId))
    .catch((error) => console.error(`❌ Blender film cut ${entry.job.id} could not be settled: ${error.message}`));
  return { job: { ...entry.job } };
}
