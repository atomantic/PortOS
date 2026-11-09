/**
 * Measure music-video takes and store the shot color match (lib/shotColorMatch.js).
 * The picture files stay as they are; a later segment render reads the numbers.
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { ServerError } from '../../lib/errorHandler.js';
import { FFMPEG_FRAME_TIMEOUT_MS, findFfmpeg, probeVideoDuration, runFfmpegProcess, safeUnder } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/fileUtils.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import {
  COLOR_MATCH_IDENTITY,
  averageColorStats,
  colorMatchGroupOf,
  measureRgbStats,
  solveProjectColorMatch,
} from '../../lib/shotColorMatch.js';
import { getHistoryItem } from '../videoGen/history.js';
import { mutateProjectRecord } from './projects.js';
import { ensureSceneTakes } from './takes.js';

const readImageStats = async (path) => {
  const { data, info } = await sharp(path).rotate().resize(160, 90, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return measureRgbStats(data, info.width, info.height, info.channels);
};

async function frameStats(ffmpeg, file, atSec) {
  const png = join(tmpdir(), `portos-shot-color-match-${randomUUID()}.png`);
  try {
    const result = await runFfmpegProcess({
      bin: ffmpeg,
      args: ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSec)), '-i', file, '-frames:v', '1', '-y', png],
      timeoutMs: FFMPEG_FRAME_TIMEOUT_MS,
    });
    if (!result.ok || !existsSync(png)) return null;
    return readImageStats(png);
  } finally {
    await rm(png, { force: true }).catch(() => {});
  }
}

async function readVideoStats(file, ffmpeg) {
  const duration = await probeVideoDuration(file);
  const times = duration ? [0, duration / 2, Math.max(0, duration - 0.05)] : [0];
  const frames = [];
  for (const at of times) {
    const stats = await frameStats(ffmpeg, file, at);
    if (stats) frames.push(stats);
  }
  return averageColorStats(frames);
}

function videoPath(item) {
  if (!item?.filename) return null;
  return safeUnder(PATHS.videos, item.filename);
}

function withMaterializedTakes(project) {
  let changed = false;
  const scenes = (project.scenes || []).map((scene) => {
    const takes = ensureSceneTakes(scene);
    if (takes === scene.takes) return scene;
    changed = true;
    return { ...scene, takes };
  });
  return changed ? { ...project, scenes } : project;
}

function measurableTakes(scene) {
  return (scene.takes || []).filter((take) => (take?.kind === 'image' || take?.kind === 'video')
    && take.use !== 'motion-reference' && take.assetId && take.takeId);
}

/**
 * Stats for the takes a measure pass should read. `readImage` / `readVideo`
 * replace the sharp and ffmpeg readers in tests. Returns the project (with a
 * take row for every selected still or clip) and `{ [takeId]: stats }`.
 */
export async function _collectColorMatchMeasurements(project, {
  sceneId, readImage = readImageStats, readVideo = null, ffmpeg = null,
  resolveImage = resolveGalleryImage, resolveVideo = null,
} = {}) {
  const ready = withMaterializedTakes(project);
  const measurements = {};
  let videoBin = ffmpeg;
  for (const scene of ready.scenes || []) {
    if (sceneId && scene.sceneId !== sceneId) continue;
    if (!colorMatchGroupOf(scene, ready.cameras || [])) continue;
    for (const take of measurableTakes(scene)) {
      if (take.kind === 'image') {
        const path = resolveImage(take.assetId);
        if (!path) continue;
        const stats = await readImage(path);
        if (stats) measurements[take.takeId] = stats;
        continue;
      }
      const path = resolveVideo ? await resolveVideo(take.assetId) : videoPath(await getHistoryItem(take.assetId));
      if (!path) continue;
      if (!readVideo && !videoBin) {
        videoBin = ffmpeg || await findFfmpeg();
        if (!videoBin) throw new ServerError('ffmpeg is not available, so shots cannot be measured', { status: 503, code: 'FFMPEG_UNAVAILABLE' });
      }
      const stats = readVideo ? await readVideo(path) : await readVideoStats(path, videoBin);
      if (stats) measurements[take.takeId] = stats;
    }
  }
  return { project: ready, measurements };
}

function resultOf(outcome) {
  return {
    scenes: outcome.project.scenes,
    colorMatch: outcome.project.colorMatch || null,
    updatedAt: outcome.project.updatedAt,
  };
}

/** Measure takes and solve each group's corrections. One shot, or the whole video. */
export async function measureShotColorMatch(projectId, { sceneId } = {}) {
  const outcome = await mutateProjectRecord(projectId, async (project) => {
    const { project: ready, measurements } = await _collectColorMatchMeasurements(project, { sceneId });
    if (!Object.keys(measurements).length) {
      throw new ServerError('No shot in a color-match group has a still or clip to measure', { status: 422, code: 'COLOR_MATCH_NOTHING' });
    }
    const solved = solveProjectColorMatch(ready, measurements, new Date().toISOString());
    return { project: { ...ready, scenes: solved.scenes, colorMatch: solved.colorMatch } };
  });
  return resultOf(outcome);
}

function findTake(project, sceneId, takeId) {
  const scene = (project.scenes || []).find((entry) => entry.sceneId === sceneId);
  if (!scene) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const take = (scene.takes || []).find((entry) => entry.takeId === takeId);
  if (!take) throw new ServerError('Take not found', { status: 404, code: 'NOT_FOUND' });
  return { scene, take };
}

/** Edit one take's match: on/off, strength, or the numbers (which are then kept across a re-measure). */
export async function updateTakeColorMatch(projectId, sceneId, takeId, patch) {
  const outcome = await mutateProjectRecord(projectId, (project) => {
    findTake(project, sceneId, takeId);
    const scenes = project.scenes.map((scene) => {
      if (scene.sceneId !== sceneId) return scene;
      return {
        ...scene,
        takes: scene.takes.map((take) => {
          if (take.takeId !== takeId) return take;
          const prev = take.colorMatch || { enabled: true, strength: 1, correction: { ...COLOR_MATCH_IDENTITY }, outlier: false };
          const next = { ...prev };
          if ('enabled' in patch) next.enabled = patch.enabled;
          if ('strength' in patch) next.strength = patch.strength;
          if (patch.correction) {
            next.correction = { ...patch.correction };
            next.edited = true;
            next.outlier = false;
          }
          return { ...take, colorMatch: next };
        }),
      };
    });
    return { project: { ...project, scenes }, scene: scenes.find((scene) => scene.sceneId === sceneId) };
  });
  return { scene: outcome.scene, colorMatch: outcome.project.colorMatch || null, updatedAt: outcome.project.updatedAt };
}

function groupReference(project, sceneId, clear) {
  const scene = (project.scenes || []).find((entry) => entry.sceneId === sceneId);
  const group = colorMatchGroupOf(scene, project.cameras || []);
  if (!group) throw new ServerError('This shot is not in a color-match group', { status: 422, code: 'COLOR_MATCH_UNGROUPED' });
  const text = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
  const references = (project.colorMatch?.references || []).filter((reference) => !(reference.cameraId === group.cameraId
    && text(reference.location) === group.locationKey
    && text(reference.timeOfDay) === group.timeKey));
  if (!clear) references.push({ cameraId: group.cameraId, location: group.locationKey, timeOfDay: group.timeKey, sceneId });
  return references.length ? { references } : null;
}

/** Match a group to one shot, or back to the median, and re-solve from the stored stats. */
export async function setShotColorMatchReference(projectId, { sceneId, clear = false }) {
  const outcome = await mutateProjectRecord(projectId, (project) => {
    const ready = withMaterializedTakes(project);
    const colorMatch = groupReference(ready, sceneId, clear);
    const solved = solveProjectColorMatch({ ...ready, colorMatch }, {}, new Date().toISOString());
    return { project: { ...ready, scenes: solved.scenes, colorMatch } };
  });
  return resultOf(outcome);
}
