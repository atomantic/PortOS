/**
 * "Sync shots from scripts": run the film's `describe(ctx)` in Blender, check
 * the shot list and options it returns against the film contract and the song,
 * save them as the workspace's manifest.json, and mirror the shots onto the
 * Board. The scripts are the source of truth for the shot list; a film whose
 * list is refused changes nothing.
 *
 * `describe` is the operator's own code and may take as long as it likes (up
 * to the describe limit), so a sync is a background job like a render: the
 * request answers with the job, its end arrives on the `music-video:blender`
 * channel, and it can be cancelled.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { blenderEffectiveOptions, blenderValidOptionValues, normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { blenderRefusal, blenderSrcDir } from './workspace.js';
import { blenderManifestHash, hashBlenderSources } from './hashing.js';
import { readBlenderManifest, validateBlenderManifest, writeBlenderManifest } from './manifest.js';
import { writeBlenderSong } from './song.js';
import { blenderJobBase, requireBlenderFilmTool, runBlenderDriver } from './driver.js';
import { describeNeedsBlender, requirePythonDescribe, runPythonDescribe } from './describeRun.js';
import { activeBlenderJobs, createBlenderJob, reserveBlenderSync, updateBlenderJob } from './jobs.js';
import { openBlenderJobLog } from './logs.js';
import { announceBlenderState } from './record.js';
import { dropBlenderFramesOutside } from './usage.js';

async function describeFilm(entry, { owner, settings, options, tool }) {
  const log = await openBlenderJobLog(owner, entry.job.id);
  updateBlenderJob(entry, { status: 'running', logFile: log.file });
  const describe = async () => {
    const song = await writeBlenderSong(owner, settings);
    const job = { ...blenderJobBase(owner, { settings, options }), mode: 'describe', quality: 'describe', scale: 1, samples: settings.previewSamples, jobId: entry.job.id };
    const result = tool
      ? await runBlenderDriver({ tool, song, signal: entry.abort.signal, onLog: log.write, job })
      : await runPythonDescribe({ owner, song, signal: entry.abort.signal, onLog: log.write, job });
    if (result.canceled) throw blenderRefusal('The sync was canceled', 'MUSIC_VIDEO_BLENDER_SYNC_CANCELED', 409);
    if (!result.ok) log.write(result.traceback || result.error);
    if (!result.ok) throw blenderRefusal(`The film could not list its shots: ${result.error}`, 'MUSIC_VIDEO_BLENDER_DESCRIBE_FAILED', 422);
    const checked = validateBlenderManifest(result.manifest, { durationSec: (await owner.timeline()).durationSec, fps: settings.fps });
    if (checked.errors.length) {
      for (const error of checked.errors) log.write(`PortOS: ${error}`);
      throw blenderRefusal(`The film's shot list was refused: ${checked.errors[0]}${checked.errors.length > 1 ? ` (and ${checked.errors.length - 1} more)` : ''}`,
        'MUSIC_VIDEO_BLENDER_MANIFEST_INVALID', 422, { errors: checked.errors });
    }
    return checked.manifest;
  };
  return describe().finally(() => log.close());
}

/**
 * Start syncing the project's film. Refuses at once what is known before
 * Blender starts (no analysis, no film, Blender not ready, a sync already
 * running, Board scenes the film did not make); otherwise resolves `{ job }`
 * and the sync runs in the background. The job ends `done` once the manifest
 * is saved and the Board mirrors it, or `error` with `error`, `code` and, for a
 * refused shot list, every problem in `problems`.
 */
export async function startBlenderSync(owner, options = {}) {
  const release = reserveBlenderSync(owner);
  if (!release) throw blenderRefusal('A sync is already running for this project', 'MUSIC_VIDEO_BLENDER_SYNC_IN_PROGRESS', 409);
  return prepareBlenderSync(owner, options).finally(release);
}

async function prepareBlenderSync(owner, { replaceScenes = false }) {
  if (activeBlenderJobs(owner).some(({ job }) => job.kind === 'render')) {
    throw blenderRefusal('Renders are running for this film. Wait for them to finish, or cancel them, before syncing shots.', 'MUSIC_VIDEO_BLENDER_RENDERS_ACTIVE', 409);
  }
  const timeline = await owner.timeline();
  if (!(timeline.durationSec > 0)) {
    throw blenderRefusal('Analyze the song first: shots are checked against its length', 'NOT_ANALYZED', 409);
  }
  // No film yet stays on the Blender gate, so contained mode still refuses before "no film".
  // A code film (no bpy, bmesh or mathutils) lists its shots with system Python.
  const hasFilm = (await lstat(join(blenderSrcDir(owner), 'film.py')).catch(() => null))?.isFile() === true;
  const needsBlender = await describeNeedsBlender(owner);
  const tool = needsBlender ? await requireBlenderFilmTool() : null;
  if (!hasFilm) {
    throw blenderRefusal('The workspace has no film yet (src/film.py). Create the starter workspace or add your own film.', 'MUSIC_VIDEO_BLENDER_NO_FILM', 409);
  }
  if (!needsBlender) await requirePythonDescribe();
  // Known before Blender starts: fail fast rather than after the describe run.
  await owner.beforeSync?.({ replaceScenes });

  const { settings } = normalizeBlenderRecord(await owner.readRecord());
  // describe reads the options the last sync declared; on the first sync nothing
  // is declared yet, so it gets whatever values are saved.
  const previous = await readBlenderManifest(owner);
  const options = previous ? blenderEffectiveOptions(previous.options, settings.options) : settings.options;
  // Hashed before Blender reads the scripts: an edit made during the run shows as "changed since sync".
  const srcHash = (await hashBlenderSources(owner)).tree;
  const entry = createBlenderJob(owner, { kind: 'sync' });
  const sync = async () => {
    const described = await maintenance.run('composition', 'Blender film sync', () => describeFilm(entry, { owner, settings, options, tool }), { continuation: true });
    const syncedAt = new Date().toISOString();
    const manifestHash = blenderManifestHash(described.shots);
    const manifest = {
      version: 1, title: described.title, fps: settings.fps, durationSec: timeline.durationSec,
      syncedAt, srcHash, shots: described.shots, options: described.options,
    };
    const shotIds = new Set(described.shots.map((shot) => shot.id));
    const change = (record) => {
      const blender = normalizeBlenderRecord(record);
      return { syncedAt, manifestHash,
        settings: { ...blender.settings, options: blenderValidOptionValues(described.options, blender.settings.options) },
        notes: Object.fromEntries(Object.entries(blender.notes).filter(([shotId]) => shotIds.has(shotId))),
      };
    };
    if (entry.abort.signal.aborted) throw blenderRefusal('The sync was canceled', 'MUSIC_VIDEO_BLENDER_SYNC_CANCELED', 409);
    // Cancellation is accepted until commit starts; afterward the sync completes normally.
    entry.committing = true;
    // The owner commits its mirror and record together before replacing the manifest.
    if (owner.onSynced) await owner.onSynced(manifest, { replaceScenes, change });
    else await owner.writeRecord(change);
    await writeBlenderManifest(owner, manifest);
    // A shot that left the film keeps its videos (it may come back) but not its frames.
    await dropBlenderFramesOutside(owner, described.shots.map((shot) => shot.id))
      .catch((error) => console.error(`❌ Blender film ${owner.id.slice(0, 11)}: frames of removed shots were not cleared: ${error.message}`));
    return described.shots.length;
  };
  Promise.resolve().then(sync).then((shots) => {
    updateBlenderJob(entry, { status: 'done' });
    console.log(`🎬 Blender film synced for ${owner.id.slice(0, 11)}: ${shots} shots`);
  }, (error) => {
    if (entry.abort.signal.aborted) { updateBlenderJob(entry, { status: 'canceled' }); return; }
    // A refused film is the director's to fix, not a server fault; anything else is.
    if (!error.code?.startsWith('MUSIC_VIDEO_BLENDER_')) console.error(`❌ Blender film sync for ${owner.id.slice(0, 11)} failed: ${error.message}`);
    updateBlenderJob(entry, {
      status: 'error', error: String(error.message || 'Sync failed').slice(0, 2000),
      ...(error.code ? { code: error.code } : {}),
      ...(Array.isArray(error.context?.errors) ? { problems: error.context.errors } : {}),
    });
  }).finally(() => announceBlenderState(owner))
    .catch((error) => console.error(`❌ Blender film sync ${entry.job.id} could not be settled: ${error.message}`));
  return { job: { ...entry.job } };
}
