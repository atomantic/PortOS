/**
 * What a Blender film's workspace takes on disk, and the frames it can give
 * back. Rendered frames are the bulk of it: a long film's final PNG frames
 * run to many gigabytes, and once a shot's video is encoded PortOS never
 * reads them again.
 *
 * Retention rule:
 *   - an unfinished render keeps its frames (the next render resumes them);
 *   - a finished render keeps its frames until they are cleared here, or until
 *     a re-render replaces them (renderJob.js removes frames it cannot resume);
 *   - a shot that left the film loses its frames at the next sync, and
 *     everything else it rendered when the frames are cleared.
 * Clearing preserves videos, stills and posters for shots still in the film,
 * plus every cut and log. Removed shots lose their whole render folder.
 */
import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MUSIC_VIDEO_BLENDER_SHOT_ID } from '../../lib/musicVideoBlender.js';
import { assertInsideWithoutSymlinks, blenderRefusal, blenderRendersDir, blenderSrcDir, blenderWorkspaceDir, readBlenderJson } from './workspace.js';
import { readBlenderManifest } from './manifest.js';
import { BLENDER_RENDER_QUALITIES, blenderCompositedHandlesDir, blenderFramesDir, blenderLayersRoot, blenderRenderFile, blenderShotVideo } from './renderIndex.js';
import { activeBlenderJobs } from './jobs.js';
import { announceBlenderState } from './record.js';
import { withBlenderRenderAdmission } from './queue.js';

const isFile = async (path) => (await lstat(path).catch(() => null))?.isFile() === true;
const SHOT_FRAME_FILE = /^frame_(?:m)?\d{6,}\.(?:jpg|png)$/;

/** `{ bytes, files }` of every regular file under `directory` (links are neither followed nor counted). */
async function measure(directory) {
  const total = { bytes: 0, files: 0 };
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const inner = await measure(path);
      total.bytes += inner.bytes;
      total.files += inner.files;
    } else if (entry.isFile()) {
      total.bytes += (await lstat(path).catch(() => null))?.size ?? 0;
      total.files += 1;
    }
  }
  return total;
}

/** The shot folders under renders/ (`cuts`, `logs` and scratch folders are not shots). */
async function renderedShotIds(owner) {
  const entries = await readdir(blenderRendersDir(owner), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !['cuts', 'logs'].includes(entry.name) && MUSIC_VIDEO_BLENDER_SHOT_ID.test(entry.name))
    .map((entry) => entry.name);
}

/**
 * What clearing would remove: the `frames` folder of every finished render,
 * and the whole folder of every shot the synced film no longer lists. Before
 * the first sync no shot counts as removed.
 */
async function clearableFolders(owner) {
  const manifest = await readBlenderManifest(owner);
  const listed = manifest ? new Set(manifest.shots.map((shot) => shot.id)) : null;
  const frames = [];
  const removedShots = [];
  for (const shotId of await renderedShotIds(owner)) {
    if (listed && !listed.has(shotId)) { removedShots.push(shotId); continue; }
    for (const quality of BLENDER_RENDER_QUALITIES) {
      const meta = await readBlenderJson(blenderRenderFile(owner, shotId, quality));
      // Finished means its video exists: those frames have nothing left to give PortOS.
      if (meta?.complete === true && await isFile(blenderShotVideo(owner, shotId, quality))) frames.push(blenderFramesDir(owner, shotId, quality));
    }
  }
  return { frames, removedShots };
}

async function clearableShotFrames(folder) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && SHOT_FRAME_FILE.test(entry.name)).map((entry) => join(folder, entry.name));
  let bytes = 0;
  for (const file of files) bytes += (await lstat(file).catch(() => null))?.size ?? 0;
  return { files, bytes };
}

/**
 * `{ sourceBytes, rendersBytes, frameBytes, frameFiles, clearableBytes, removedShots }`
 * for a project's Blender workspace. Walks the workspace: asked for on demand,
 * never part of the film state.
 */
export async function getBlenderDiskUsage(owner) {
  await owner.readRecord();
  const [source, renders, clearable] = await Promise.all([measure(blenderSrcDir(owner)), measure(blenderRendersDir(owner)), clearableFolders(owner)]);
  const frames = { bytes: 0, files: 0 };
  for (const shotId of await renderedShotIds(owner)) {
    for (const quality of BLENDER_RENDER_QUALITIES) {
      const held = await measure(blenderFramesDir(owner, shotId, quality));
      const layers = await measure(blenderLayersRoot(owner, shotId, quality));
      const handles = await measure(blenderCompositedHandlesDir(owner, shotId, quality));
      frames.bytes += held.bytes + layers.bytes + handles.bytes;
      frames.files += held.files + layers.files + handles.files;
    }
  }
  let clearableBytes = 0;
  for (const folder of clearable.frames) clearableBytes += (await clearableShotFrames(folder)).bytes;
  for (const shotId of clearable.removedShots) clearableBytes += (await measure(join(blenderRendersDir(owner), shotId))).bytes;
  return {
    sourceBytes: source.bytes, rendersBytes: renders.bytes, frameBytes: frames.bytes, frameFiles: frames.files,
    clearableBytes, removedShots: clearable.removedShots,
  };
}

/**
 * Remove the frames of every finished render and everything rendered for
 * shots the film no longer lists. Resolves `{ freedBytes, usage }`.
 */
export const clearBlenderFrames = (owner) => withBlenderRenderAdmission(owner, () => clearFrames(owner));

async function clearFrames(owner) {
  // A render in flight is writing the frames this would judge: finished ones could go mid-encode.
  if (activeBlenderJobs(owner).some(({ job }) => job.kind === 'render')) {
    throw blenderRefusal('Renders are running for this film. Wait for them to finish, or cancel them, before clearing frames.', 'MUSIC_VIDEO_BLENDER_RENDERS_ACTIVE', 409);
  }
  const before = await getBlenderDiskUsage(owner);
  const { frames, removedShots } = await clearableFolders(owner);
  for (const folder of frames) {
    await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), folder);
    const layers = join(dirname(folder), 'layers');
    await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), layers);
    const { files } = await clearableShotFrames(folder);
    for (const file of files) await rm(file, { force: true });
    await rm(layers, { recursive: true, force: true });
    // Remove the now-empty frames folder; handle frames stay for cuts and the final render.
    await rmdir(folder).catch(() => {});
  }
  for (const shotId of removedShots) {
    const folder = join(blenderRendersDir(owner), shotId);
    await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), folder);
    await rm(folder, { recursive: true, force: true });
  }
  const usage = await getBlenderDiskUsage(owner);
  console.log(`🧹 Blender film ${owner.id.slice(0, 11)}: cleared rendered frames (${frames.length} renders, ${removedShots.length} removed shots)`);
  // A poster that fell back to a frame, and a removed shot's stills, are gone from the state.
  announceBlenderState(owner);
  return { freedBytes: Math.max(0, before.rendersBytes - usage.rendersBytes), usage };
}

/** After a sync: drop the frames (never the videos) of every rendered shot not in `shotIds`. */
export async function dropBlenderFramesOutside(owner, shotIds) {
  const kept = new Set(shotIds);
  for (const shotId of await renderedShotIds(owner)) {
    if (kept.has(shotId)) continue;
    for (const quality of BLENDER_RENDER_QUALITIES) {
      const frames = blenderFramesDir(owner, shotId, quality);
      await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), frames);
      await rm(frames, { recursive: true, force: true });
      const layers = blenderLayersRoot(owner, shotId, quality);
      await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), layers);
      await rm(layers, { recursive: true, force: true });
      const handles = blenderCompositedHandlesDir(owner, shotId, quality);
      await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), handles);
      await rm(handles, { recursive: true, force: true });
    }
  }
}
