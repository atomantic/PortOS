/** One deterministic pacing preview, applied to the same revision under the store's write lock. */
import { createHash } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { isPreMusicShot } from '../../lib/musicVideoColdOpen.js';
import { planPacingSplit } from '../../lib/musicVideoShotTiming.js';
import { applySceneSplit } from './projectsLogic.js';

const revisionOf = (project) => createHash('sha256').update(JSON.stringify(project)).digest('hex');

export function previewPacingRecut(project) {
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (['code', 'document', 'eidoverse'].includes(project.composition?.mode)) {
    throw new ServerError('This video renders from a composition source. Edit its shot timing in that source instead of re-cutting board records.', { status: 400, code: 'MUSIC_VIDEO_PACING_COMPOSITION' });
  }
  const minSec = project.pacing?.minShotSec ?? 1;
  const maxSec = project.pacing?.maxShotSec;
  if (!Number.isFinite(minSec) || !Number.isFinite(maxSec) || minSec <= 0 || maxSec < minSec) {
    throw new ServerError('Set a pacing maximum at least as long as the minimum on the Plan step.', { status: 400, code: 'MUSIC_VIDEO_PACING_REQUIRED' });
  }
  const changes = [];
  const skipped = [];
  for (const scene of project.scenes || []) {
    if (isPreMusicShot(scene)) continue;
    if (!Number.isFinite(scene.startSec) || !Number.isFinite(scene.endSec) || scene.endSec <= scene.startSec) {
      skipped.push({ sceneId: scene.sceneId, label: scene.label, reason: 'No time span' });
      continue;
    }
    if (scene.endSec - scene.startSec <= maxSec + 1e-6) continue;
    const plan = planPacingSplit({ startSec: scene.startSec, endSec: scene.endSec, minSec, maxSec,
      lyricCues: project.lyricCues || [], downbeats: project.audioAnalysis?.downbeats || [], beats: project.audioAnalysis?.beats || [] });
    if (!plan.ok) throw new ServerError(`${scene.label || 'Shot'}: ${plan.message}`, { status: 400, code: plan.code });
    changes.push({ sceneId: scene.sceneId, label: scene.label, pieces: plan.pieces });
  }
  return { revision: revisionOf(project), updatedAt: project.updatedAt, minSec, maxSec, changes, skipped,
    added: changes.reduce((sum, change) => sum + change.pieces.length - 1, 0), total: (project.scenes || []).length };
}

export function applyPacingRecut(project, revision) {
  if (revisionOf(project) !== revision) {
    throw new ServerError('The project changed. Preview the pacing cuts again before applying them.', { status: 409, code: 'MUSIC_VIDEO_PACING_CHANGED' });
  }
  const preview = previewPacingRecut(project);
  let next = project;
  const from = {};
  for (const change of preview.changes) {
    const result = applySceneSplit(next, change.sceneId, change.pieces, { preserveClip: true, needsBeat: true });
    for (const piece of result.scenes.slice(1)) from[piece.sceneId] = change.sceneId;
    next = result.project;
  }
  return { project: next, added: preview.added, from };
}
