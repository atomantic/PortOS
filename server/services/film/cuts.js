/** Shared cut queue and retention. Owners can wrap the join with finishing and draft publication. */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../lib/fileCore.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { blenderRefusal, blenderRendersDir, blenderScratchDir, readBlenderJson } from './workspace.js';
import { blenderNotSynced, planBlenderCut, readBlenderFilm } from './film.js';
import { assembleBlenderVideo } from './assemble.js';
import { requireFfmpeg } from './encode.js';
import { activeBlenderJobs, createBlenderJob, updateBlenderJob } from './jobs.js';
import { openBlenderJobLog } from './logs.js';
import { announceBlenderState } from './record.js';
import { blenderCutsFile } from './state.js';

const KEPT_PER_QUALITY = 8;

const cutsDir = (owner) => join(blenderRendersDir(owner), 'cuts');

async function recordCut(owner, cut) {
  const listed = await readBlenderJson(blenderCutsFile(owner), []);
  const all = [cut, ...(Array.isArray(listed) ? listed : []).filter((entry) => entry?.id !== cut.id)];
  const kept = [];
  const seen = { preview: 0, final: 0 };
  for (const entry of all) {
    if (seen[entry.quality] === undefined) continue;
    seen[entry.quality] += 1;
    if (seen[entry.quality] <= KEPT_PER_QUALITY) kept.push(entry);
    else if (typeof entry.file === 'string' && /^(preview|final)-[0-9A-Za-z-]+\.mp4$/.test(entry.file)) await rm(join(cutsDir(owner), entry.file), { force: true });
  }
  await atomicWrite(blenderCutsFile(owner), kept);
}

async function runCut(entry, { owner, quality, audioPath, finish, afterCut }) {
  const { signal } = entry.abort;
  const log = await openBlenderJobLog(owner, entry.job.id);
  updateBlenderJob(entry, { status: 'running', logFile: log.file });
  const work = async () => {
    const film = await readBlenderFilm(owner);
    if (!film.shots.length) throw new Error('Sync shots from scripts first');
    const plan = planBlenderCut(film, quality);
    const id = `${quality}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const output = join(cutsDir(owner), `${id}.mp4`);
    await mkdir(cutsDir(owner), { recursive: true });
    log.write(`PortOS: ${quality} cut of ${film.shots.length} shots (${plan.missing.length} black, ${plan.stale.length} out of date)`);
    const progress = (from, to) => (fraction) => updateBlenderJob(entry, { index: Math.round((from + (to - from) * fraction) * 100), total: 100 });
    const assemble = (extra = {}) => assembleBlenderVideo({
      segments: plan.segments, width: plan.width, height: plan.height, fps: plan.fps, quality,
      audio: audioPath ? { path: audioPath, startSec: 0 } : null,
      output, scratch: blenderScratchDir(owner, entry.job.id), signal, onProgress: progress(0, 1), ...extra,
    });
    const { durationSec, filmLook = false } = finish
      ? await finish({ entry, film, plan, output, signal, log, progress, assemble })
      : await assemble();
    await recordCut(owner, {
      id, quality, file: `${id}.mp4`, createdAt: new Date().toISOString(), durationSec: Number(durationSec.toFixed(3)),
      missing: plan.missing, stale: plan.stale, filmLook,
    });
    await afterCut?.(output);
    log.write(`PortOS: cut ${id} ready`);
  };
  return work().finally(() => log.close());
}

/**
 * Start assembling a cut in the background. Resolves `{ job }` at once; the
 * job's progress and end arrive on the `music-video:blender` channel.
 */
export async function startBlenderCut(owner, { quality, audioPath = null, finish = null, afterCut = null }) {
  await requireFfmpeg();
  if (!(await readBlenderFilm(owner)).shots.length) throw blenderNotSynced();
  if (activeBlenderJobs(owner).some(({ job }) => job.kind === 'cut')) {
    throw blenderRefusal('A cut is already being assembled for this project', 'MUSIC_VIDEO_BLENDER_CUT_IN_PROGRESS', 409);
  }
  const entry = createBlenderJob(owner, { kind: 'cut', quality });
  Promise.resolve()
    .then(() => maintenance.run('composition', 'Blender film cut', () => runCut(entry, { owner, quality, audioPath, finish, afterCut }), { continuation: true }))
    .then(() => updateBlenderJob(entry, { status: 'done', index: 100, total: 100 }), (error) => {
      if (entry.abort.signal.aborted) { updateBlenderJob(entry, { status: 'canceled' }); return; }
      console.error(`❌ Blender film ${quality} cut failed: ${error.message}`);
      updateBlenderJob(entry, { status: 'error', error: String(error.message || 'The cut failed').slice(0, 2000) });
    })
    .finally(() => announceBlenderState(owner))
    .catch((error) => console.error(`❌ Blender film cut ${entry.job.id} could not be settled: ${error.message}`));
  return { job: { ...entry.job } };
}
