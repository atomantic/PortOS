import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS, UUID_RE } from '../../lib/fileUtils.js';

const ownedInProcess = new Set();
const stagingDir = () => join(PATHS.videos, '.topaz-staging');
export const topazPreparedPath = id => join(stagingDir(), `${id}.mp4`);
export const topazOutputPath = id => join(stagingDir(), `${id}.output.mp4`);
export const topazFinalPath = id => join(stagingDir(), `${id}.final.mp4`);
const markerPath = id => join(stagingDir(), `${id}.json`);
export async function hasTopazStaging(id) {
  if (!UUID_RE.test(id || '')) return false;
  const marker = await readFile(markerPath(id), 'utf8').then(JSON.parse).catch(() => null);
  return marker?.version === 1 && marker.id === id;
}
export async function registerStaging(id) {
  ownedInProcess.add(id);
  await mkdir(stagingDir(), { recursive: true, mode: 0o700 })
    .then(() => chmod(stagingDir(), 0o700))
    .then(() => writeFile(markerPath(id), JSON.stringify({ version: 1, id }), { flag: 'wx', mode: 0o600 }))
    .catch(error => { ownedInProcess.delete(id); throw error; });
}
export async function cleanupTopazStaging(id) {
  if (!UUID_RE.test(id || '')) return;
  const raw = await readFile(markerPath(id), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (raw === null) return;
  const marker = JSON.parse(raw);
  if (marker?.version !== 1 || marker.id !== id) throw new Error('Invalid Topaz staging ownership marker');
  for (const path of [topazPreparedPath(id), topazOutputPath(id), topazFinalPath(id)]) {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await unlink(markerPath(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  ownedInProcess.delete(id);
}
export function releaseTopazStaging(id) { ownedInProcess.delete(id); }
export async function cleanupOrphanTopazStaging(jobs) {
  const retained = new Set(jobs.filter(job => job.kind === 'video-upscale' && job.params?.mode === 'topaz' && ['queued', 'running'].includes(job.status)).map(job => job.params.preparedId));
  const names = await readdir(stagingDir()).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names) {
    const match = /^([0-9a-f-]{36})\.json$/i.exec(name);
    if (match && UUID_RE.test(match[1]) && !retained.has(match[1]) && !ownedInProcess.has(match[1])) await cleanupTopazStaging(match[1]);
  }
}
