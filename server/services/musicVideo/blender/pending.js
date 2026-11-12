/** Machine-local preview/final batch intent. Callers serialize via the project queue. */
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../../lib/fileCore.js';
import { readJSONFileStrict } from '../../../lib/jsonIo.js';
import { MUSIC_VIDEO_BLENDER_SHOT_ID } from '../../../lib/musicVideoBlender.js';
import { assertInsideWithoutSymlinks, blenderRendersDir, blenderWorkspaceDir } from './workspace.js';

async function pendingFile(projectId) {
  const file = join(blenderRendersDir(projectId), 'pending.json');
  await assertInsideWithoutSymlinks(blenderWorkspaceDir(projectId), file);
  return file;
}

export async function readPendingBlenderRenders(projectId) {
  const { ok, value } = await readJSONFileStrict(await pendingFile(projectId));
  if (!ok) throw new Error('Blender pending renders could not be read');
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => !['preview', 'final'].includes(entry?.quality)
    || !Array.isArray(entry.shotIds) || entry.shotIds.some((id) => typeof id !== 'string' || !MUSIC_VIDEO_BLENDER_SHOT_ID.test(id))
    || !Number.isInteger(entry.attempt) || entry.attempt < 0)
    || new Set(value.map((entry) => entry.quality)).size !== value.length) {
    throw new Error('Blender pending renders are malformed');
  }
  return value;
}

export async function writePendingBlenderRenders(projectId, entries) {
  const file = await pendingFile(projectId);
  const pending = entries.filter((entry) => entry.shotIds.length);
  if (!pending.length) {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    return;
  }
  await mkdir(blenderRendersDir(projectId), { recursive: true });
  await atomicWrite(file, JSON.stringify(pending));
}

export async function removePendingBlenderShots(projectId, quality, shotIds) {
  if (quality === 'still') return;
  const removed = new Set(shotIds);
  const entries = await readPendingBlenderRenders(projectId);
  await writePendingBlenderRenders(projectId, entries.map((entry) => entry.quality === quality
    ? { ...entry, shotIds: entry.shotIds.filter((id) => !removed.has(id)) } : entry));
}
