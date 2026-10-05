import { falSceneTake } from './musicVideoShotTiming.js';
import { getFalVideoModel } from './falVideoModels.js';
import { formatUsd } from '../utils/formatters.js';

/**
 * Pure helpers for the Music Video "generate the missing frames / clips"
 * batches (#10153): what a batch would submit, what it would cost, and the
 * running summary line. Nothing here touches the network.
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A scene's display name for a status line — the card's own heading. */
export const batchSceneName = (scene) => scene.sectionLabel || scene.label || `Scene ${(scene.order ?? 0) + 1}`;

/**
 * Footage scenes still waiting on a reference frame before a clip can be made.
 * They no longer block the Videos batch — only name themselves in its label.
 */
export const scenesWaitingForFrame = (footageScenes) =>
  footageScenes.filter((scene) => !scene.referenceImageId && !scene.videoHistoryId);

/** "Videos 9/10 (1 waiting for a frame: Chorus)" — the Videos button label. */
export function videosButtonLabel({ renderableCount, footageCount, waiting }) {
  const base = `Videos ${renderableCount}/${footageCount}`;
  if (waiting.length === 0) return base;
  const names = waiting.slice(0, 2).map(batchSceneName).join(', ');
  return `${base} (${waiting.length} waiting for a frame: ${names}${waiting.length > 2 ? ', …' : ''})`;
}

/**
 * The confirm line for a clip batch. fal takes are priced per scene with the
 * same `falSceneTake` the scene card shows; a scene it cannot price is counted
 * as unpriced. Local and Grok renders show the count only.
 */
export function videoBatchPreview({ scenes, backend, videoSettings, songDurationSec = null }) {
  const count = scenes.length;
  if (backend !== 'fal') return { count, backend, text: `Generate ${plural(count, 'clip')} on ${backend === 'grok' ? 'Grok' : 'the local renderer'}` };
  const takes = scenes.map((scene) => falSceneTake({ scene, videoSettings, songDurationSec }));
  const priced = takes.filter((take) => take.costUsd != null);
  const costUsd = priced.reduce((sum, take) => sum + take.costUsd, 0);
  const modelIds = [...new Set(takes.map((take) => take.modelId))];
  const model = modelIds.length === 1 ? (getFalVideoModel(modelIds[0])?.label || modelIds[0]) : `${modelIds.length} models`;
  const resolutions = [...new Set(takes.map((take) => take.resolution).filter(Boolean))];
  const unpriced = takes.length - priced.length;
  return {
    count, backend, costUsd, unpriced,
    text: `Generate ${plural(count, 'clip')} on fal / ${model}${resolutions.length === 1 ? ` ${resolutions[0]}` : ''}`
      + ` · est. ${formatUsd(costUsd)}${unpriced > 0 ? ` (${unpriced} unpriced)` : ''}`,
  };
}

/** "Videos: 6 of 14 done · 2 failed" plus the canceled tally once there is one. */
export function batchSummary(noun, state) {
  const parts = [`${noun}: ${state.done} of ${state.total} done`];
  if (state.failed > 0) parts.push(`${state.failed} failed`);
  if (state.canceled > 0) parts.push(`${state.canceled} canceled`);
  return parts.join(' · ');
}

/** True while at least one submitted scene has no outcome yet. */
export const batchActive = (state) => !!state && state.done + state.failed + state.canceled < state.total;
