/** Explicit piecewise audio revision. Preview never persists or calls a provider.
 * Receipts live on the existing db-primary project, under its write lock.
 */
import { sha256File as sourceHash } from '../../lib/fileCore.js';
import { basename } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { canonicalSnapshotChecksum as checksum } from '../../lib/snapshotChecksum.js';
import { presentMusicVideoDependencies } from '../../lib/musicVideoDependencies.js';
import { isPerformanceScene } from '../../lib/musicVideoShotTiming.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { applyProjectPatch } from './projectsLogic.js';

const refuse = (message, status = 409) => new ServerError(message, { status, code: 'AUDIO_TIMING_INVALID' });
const projectBasis = (project) => checksum(presentMusicVideoDependencies(project));
const time = (value) => Math.round(value * 1000) / 1000;

function mapWindow(intervals, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const pieces = intervals.filter((row) => row.oldStartSec < end && row.oldEndSec > start);
  if (!pieces.length || pieces[0].oldStartSec > start || pieces.at(-1).oldEndSec < end) return null;
  const offset = pieces[0].newStartSec - pieces[0].oldStartSec;
  for (let i = 0; i < pieces.length; i++) {
    if (Math.abs(pieces[i].newStartSec - pieces[i].oldStartSec - offset) > 0.0001
      || (i && pieces[i].oldStartSec !== pieces[i - 1].oldEndSec)) return null;
  }
  return { startSec: time(start + offset), endSec: time(end + offset) };
}

function mapTimed(items, intervals) {
  return (items || []).map((item) => {
    const mapped = mapWindow(intervals, item.startSec, item.endSec);
    return { ...item, ...(mapped || { startSec: null, endSec: null }),
      ...(item.words ? { words: mapped ? mapTimed(item.words, intervals).filter((word) => word.startSec != null) : [] } : {}),
      ...(!mapped && 'matched' in item ? { matched: 0 } : {}) };
  });
}

async function prepare(project, input) {
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { resolveMasterAudioPath } = await import('./render.js');
  const { analyzeAudioFile } = await import('./audioAnalysis.js');
  const oldPath = await resolveMasterAudioPath(project);
  const newPath = await resolveMasterAudioPath({ trackId: input.targetTrackId });
  if (oldPath === newPath) throw refuse('Choose a separate edited track so the original audio remains available.');
  const [oldHash, newHash, oldAnalysis, analysis] = await Promise.all([
    sourceHash(oldPath), sourceHash(newPath),
    analyzeAudioFile(oldPath), analyzeAudioFile(newPath),
  ]);
  const [oldAfter, newAfter] = await Promise.all([sourceHash(oldPath), sourceHash(newPath)]);
  if (oldHash !== oldAfter || newHash !== newAfter) throw refuse('Audio changed during analysis. Preview again.');
  if (!oldAnalysis?.durationSec || !analysis?.durationSec) throw refuse('Both source audio files must decode before timing can be mapped.');
  if (oldAnalysis.truncatedAtSec || analysis.truncatedAtSec) throw refuse('Full audio analysis is required; these files exceed the analyzer duration limit.');
  const intervals = input.intervals.map((row) => ({ ...row,
    newEndSec: time(row.newStartSec + row.oldEndSec - row.oldStartSec),
    status: row.newStartSec === row.oldStartSec ? 'unchanged' : 'moved',
  }));
  let oldEnd = 0;
  let newEnd = 0;
  const gaps = [];
  for (const row of intervals) {
    if (row.oldEndSec <= row.oldStartSec || row.oldStartSec < oldEnd || row.newStartSec < newEnd
      || row.oldEndSec > oldAnalysis.durationSec || row.newEndSec > analysis.durationSec) {
      throw refuse('Intervals must be ordered, non-overlapping, positive, and inside both audio files.', 400);
    }
    if (row.oldStartSec > oldEnd) gaps.push({ status: 'deleted', oldStartSec: oldEnd, oldEndSec: row.oldStartSec });
    if (row.newStartSec > newEnd) gaps.push({ status: 'inserted', newStartSec: newEnd, newEndSec: row.newStartSec });
    oldEnd = row.oldEndSec;
    newEnd = row.newEndSec;
  }
  if (oldEnd < oldAnalysis.durationSec) gaps.push({ status: 'deleted', oldStartSec: oldEnd, oldEndSec: oldAnalysis.durationSec });
  if (newEnd < analysis.durationSec) gaps.push({ status: 'inserted', newStartSec: newEnd, newEndSec: analysis.durationSec });
  const scenes = (project.scenes || []).map((scene) => {
    const mapped = mapWindow(intervals, scene.startSec, scene.endSec);
    return { ...scene, ...(mapped || {}) };
  });
  const { findStalePerformanceTakes } = await import('./performanceShot.js');
  const stale = await findStalePerformanceTakes({ ...project, scenes }, newPath);
  const affectedShots = (project.scenes || []).map((scene) => {
    const mapped = mapWindow(intervals, scene.startSec, scene.endSec);
    const performance = isPerformanceScene(scene);
    const moved = mapped && (mapped.startSec !== scene.startSec || mapped.endSec !== scene.endSec);
    const repair = stale.find((entry) => entry.sceneId === scene.sceneId);
    return { sceneId: scene.sceneId, label: scene.label, oldStartSec: scene.startSec, oldEndSec: scene.endSec,
      newStartSec: mapped?.startSec ?? null, newEndSec: mapped?.endSec ?? null,
      status: !mapped ? 'ambiguous' : moved ? 'moved' : 'unchanged',
      takeIds: (scene.takes || []).map((take) => take.takeId),
      selectedAssetId: scene.videoHistoryId || scene.referenceImageId || null,
      repairRequired: Boolean(performance && (moved || repair)),
      reason: !mapped ? 'Split or retime this shot before applying: its source window crosses an edit or has no timing.'
        : performance && moved ? 'Moved performance requires a supported source-audio repair; no footage will be stretched.'
          : repair?.reason || null };
  });
  const blockers = affectedShots.filter((shot) => shot.status === 'ambiguous').map((shot) => `${shot.label || shot.sceneId}: ${shot.reason}`);
  if (['code', 'document'].includes(project.composition?.mode)) blockers.push('Authored code/document compositions need manual timing revision.');
  if ((project.revisions || []).some((revision) => !['complete', 'completed', 'canceled', 'failed'].includes(revision.status))) blockers.push('Finish or cancel the active repair before changing audio timing.');
  if (project.status === 'rendering' || (project.productionRuns || []).some((run) => ['running', 'queued'].includes(run.status))) blockers.push('Wait for active production to finish.');
  if ((project.audioTimingRevisions || []).length >= 100) blockers.push('This project has reached 100 timing revisions; clone it to continue.');
  const basis = checksum({ project: projectBasis(project), input, oldHash, newHash });
  const repairs = affectedShots.filter((shot) => shot.repairRequired);
  return { basis, intervals, gaps, affectedShots, blockers, canApply: blockers.length === 0,
    estimate: { minGenerations: 0, maxGenerations: repairs.length, maxSeconds: time(repairs.reduce((sum, shot) => sum + (shot.newEndSec - shot.newStartSec || 0), 0)), costUsd: null },
    oldDurationSec: oldAnalysis.durationSec, newDurationSec: analysis.durationSec,
    analysis, scenes, oldAudioFilename: basename(oldPath) };
}

export async function previewAudioTiming(id, input) {
  const preview = await prepare(await getProject(id), input);
  const { analysis, scenes, oldAudioFilename, ...publicPreview } = preview;
  return publicPreview;
}

export async function applyAudioTiming(id, { basis, ...input }) {
  const before = await getProject(id);
  if (!before) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const receipt = (before.audioTimingRevisions || []).find((revision) => revision.basis === basis);
  if (receipt) {
    if (checksum(receipt.input) !== checksum(input)) throw refuse('The applied preview belongs to another mapping.');
    return { project: before, revision: receipt, alreadyApplied: true };
  }
  const preview = await prepare(before, input);
  if (preview.basis !== basis) throw refuse('Project or source audio changed. Preview this mapping again.');
  if (!preview.canApply) throw refuse(preview.blockers.join(' '));
  return mutateProjectRecord(id, (current) => {
    const existing = (current.audioTimingRevisions || []).find((revision) => revision.basis === basis);
    if (existing) return { project: current, revision: existing, alreadyApplied: true };
    if (projectBasis(current) !== projectBasis(before)) throw refuse('Project changed while preparing Apply. Preview again.');
    const revision = { version: 1, basis, input, appliedAt: new Date().toISOString(),
      before: { trackId: current.trackId, uploadedAudioFilename: current.uploadedAudioFilename,
        audioFilename: preview.oldAudioFilename, vocalStemFilename: current.vocalStemFilename,
        audioAnalysis: current.audioAnalysis, lyricCues: current.lyricCues, phrases: current.phrases,
        composition: current.composition ? { textCues: current.composition.textCues, posterSec: current.composition.posterSec } : null,
        renderHistoryId: current.renderHistoryId, midiTranscription: current.midiTranscription,
        scenes: (current.scenes || []).map(({ sceneId, startSec, endSec }) => ({ sceneId, startSec, endSec })) },
      affectedShots: preview.affectedShots };
    const next = applyProjectPatch(current, { trackId: input.targetTrackId, uploadedAudioFilename: null });
    return { project: { ...next, scenes: preview.scenes.map((scene) => ({ ...scene, beatAligned: false, sectionIndex: null })),
      audioAnalysis: preview.analysis, status: 'analyzed', renderHistoryId: null,
      midiTranscription: null, vocalStemFilename: null, performanceConditioningSource: 'master',
      lyricCues: mapTimed(current.lyricCues, preview.intervals), phrases: mapTimed(current.phrases, preview.intervals),
      ...(current.composition ? { composition: { ...next.composition, posterSec: null, textCues: mapTimed(current.composition.textCues, preview.intervals) } } : {}),
      audioTimingRevisions: [...(current.audioTimingRevisions || []), revision] }, revision, alreadyApplied: false };
  });
}
