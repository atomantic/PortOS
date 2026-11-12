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
import { maintenance } from '../../../lib/maintenanceAdmission.js';
import { blenderEffectiveOptions, blenderValidOptionValues, normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { requireProject } from '../requireProject.js';
import { mutateProjectRecord } from '../projects.js';
import { blenderRefusal, blenderSrcDir } from './workspace.js';
import { blenderManifestHash, hashBlenderSources } from './hashing.js';
import { readBlenderManifest, validateBlenderManifest, writeBlenderManifest } from './manifest.js';
import { writeBlenderSong } from './song.js';
import { blenderJobBase, requireBlenderFilmTool, runBlenderDriver } from './driver.js';
import { activeBlenderJobs, createBlenderJob, reserveBlenderSync, updateBlenderJob } from './jobs.js';
import { openBlenderJobLog } from './logs.js';
import { announceBlenderState } from './record.js';
import { mirrorBlenderScenes, scenesConflict, unmirroredScenes } from './sceneMirror.js';
import { dropBlenderFramesOutside } from './usage.js';

async function describeFilm(entry, { project, settings, options, tool }) {
  const log = await openBlenderJobLog(project.id, entry.job.id);
  updateBlenderJob(entry, { status: 'running', logFile: log.file });
  const describe = async () => {
    const song = await writeBlenderSong(project, settings);
    const result = await runBlenderDriver({
      tool, song, signal: entry.abort.signal, onLog: log.write,
      job: { ...blenderJobBase(project.id, { settings, options }), mode: 'describe', quality: 'describe', scale: 1, samples: settings.previewSamples },
    });
    if (result.canceled) throw blenderRefusal('The sync was canceled', 'MUSIC_VIDEO_BLENDER_SYNC_CANCELED', 409);
    if (!result.ok) log.write(result.traceback || result.error);
    if (!result.ok) throw blenderRefusal(`The film could not list its shots: ${result.error}`, 'MUSIC_VIDEO_BLENDER_DESCRIBE_FAILED', 422);
    const checked = validateBlenderManifest(result.manifest, { durationSec: project.audioAnalysis.durationSec, fps: settings.fps });
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
export async function startBlenderSync(projectId, options = {}) {
  const release = reserveBlenderSync(projectId);
  if (!release) throw blenderRefusal('A sync is already running for this project', 'MUSIC_VIDEO_BLENDER_SYNC_IN_PROGRESS', 409);
  return prepareBlenderSync(projectId, options).finally(release);
}

async function prepareBlenderSync(projectId, { replaceScenes = false }) {
  if (activeBlenderJobs(projectId).some(({ job }) => job.kind === 'render')) {
    throw blenderRefusal('Renders are running for this film. Wait for them to finish, or cancel them, before syncing shots.', 'MUSIC_VIDEO_BLENDER_RENDERS_ACTIVE', 409);
  }
  const project = await requireProject(projectId);
  if (!(project.audioAnalysis?.durationSec > 0)) {
    throw blenderRefusal('Analyze the song first: shots are checked against its length', 'NOT_ANALYZED', 409);
  }
  const tool = await requireBlenderFilmTool();
  if (!(await lstat(join(blenderSrcDir(projectId), 'film.py')).catch(() => null))?.isFile()) {
    throw blenderRefusal('The workspace has no film yet (src/film.py). Create the starter workspace or add your own film.', 'MUSIC_VIDEO_BLENDER_NO_FILM', 409);
  }
  // Known before Blender starts: fail fast rather than after the describe run.
  const strangers = unmirroredScenes(project);
  if (strangers.length && !replaceScenes) throw scenesConflict(strangers);

  const { settings } = normalizeBlenderRecord(project.blender);
  // describe reads the options the last sync declared; on the first sync nothing
  // is declared yet, so it gets whatever values are saved.
  const previous = await readBlenderManifest(projectId);
  const options = previous ? blenderEffectiveOptions(previous.options, settings.options) : settings.options;
  // Hashed before Blender reads the scripts: an edit made during the run shows as "changed since sync".
  const srcHash = (await hashBlenderSources(projectId)).tree;
  const entry = createBlenderJob(projectId, { kind: 'sync' });
  const sync = async () => {
    const described = await maintenance.run('composition', 'Blender film sync', () => describeFilm(entry, { project, settings, options, tool }), { continuation: true });
    const syncedAt = new Date().toISOString();
    const manifestHash = blenderManifestHash(described.shots);
    // Mirror first: a Board conflict leaves the previous manifest in place.
    await mutateProjectRecord(projectId, (current) => {
      const mirrored = mirrorBlenderScenes(current, described.shots, { replaceScenes });
      const blender = normalizeBlenderRecord(mirrored.project.blender);
      const shotIds = new Set(described.shots.map((shot) => shot.id));
      return { project: { ...mirrored.project, updatedAt: syncedAt, blender: {
        ...blender, sceneMap: mirrored.sceneMap, syncedAt, manifestHash,
        // A saved value the film no longer declares (or no longer accepts) leaves with its option.
        settings: { ...blender.settings, options: blenderValidOptionValues(described.options, blender.settings.options) },
        // A note belongs to a shot; it leaves with it.
        notes: Object.fromEntries(Object.entries(blender.notes).filter(([shotId]) => shotIds.has(shotId))),
      } } };
    });
    await writeBlenderManifest(projectId, {
      version: 1, title: described.title, fps: settings.fps, durationSec: project.audioAnalysis.durationSec,
      syncedAt, srcHash, shots: described.shots, options: described.options,
    });
    // A shot that left the film keeps its videos (it may come back) but not its frames.
    await dropBlenderFramesOutside(projectId, described.shots.map((shot) => shot.id))
      .catch((error) => console.error(`❌ Blender film ${projectId.slice(0, 11)}: frames of removed shots were not cleared: ${error.message}`));
    return described.shots.length;
  };
  Promise.resolve().then(sync).then((shots) => {
    updateBlenderJob(entry, { status: 'done' });
    console.log(`🎬 Blender film synced for ${projectId.slice(0, 11)}: ${shots} shots`);
  }, (error) => {
    if (entry.abort.signal.aborted) { updateBlenderJob(entry, { status: 'canceled' }); return; }
    // A refused film is the director's to fix, not a server fault; anything else is.
    if (!error.code?.startsWith('MUSIC_VIDEO_BLENDER_')) console.error(`❌ Blender film sync for ${projectId.slice(0, 11)} failed: ${error.message}`);
    updateBlenderJob(entry, {
      status: 'error', error: String(error.message || 'Sync failed').slice(0, 2000),
      ...(error.code ? { code: error.code } : {}),
      ...(Array.isArray(error.context?.errors) ? { problems: error.context.errors } : {}),
    });
  }).finally(() => announceBlenderState(projectId))
    .catch((error) => console.error(`❌ Blender film sync ${entry.job.id} could not be settled: ${error.message}`));
  return { job: { ...entry.job } };
}
