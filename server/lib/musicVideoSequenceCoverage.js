/**
 * Music Video sequence coverage (#14241) — one timed generation for a run of
 * cutaway footage shots that share a set and protagonist, instead of one clip
 * per shot (where identity, light and geography drift at every cut).
 *
 * A section opts in with `coverage: 'sequence'` (default `per-shot`; copied onto
 * its scenes as `scene.coverage`). This module is pure planning:
 *
 *   - `planSequenceCoverage` picks the runs that may share a request and says
 *     why any other shot stays per-shot (performance shots, a different set or
 *     protagonist, a gap, or a run longer than the model's longest clip);
 *   - `composeSequencePrompt` writes the shots as contiguous time ranges using
 *     the model's own reference naming ("Image 1" on H3, "@Image1" on Seedance);
 *   - `sequenceClipSpans` maps each scene back to its in/out point inside the
 *     returned clip — the existing scene cut times, never new ones.
 *
 * Only reference-to-video models are eligible. Kling's `multi_prompt` is not
 * represented: its schema has not been verified, so Kling stays per-shot rather
 * than sending a body the endpoint may not accept.
 */

import { getFalVideoModel } from './falVideoModels.js';
import { isPerformanceScene } from './musicVideoShotTiming.js';

const EPS = 1e-6;
const round3 = (n) => Math.round(n * 1000) / 1000;

/** MiniMax H3 rewrites a prompt under `balanced`; a sequence request sends its composed ranges as written. */
export const SEQUENCE_PROMPT_EXPANSION = 'disabled';

/** Why `model` cannot cover a sequence, or null when it can. */
function sequenceCoverageBlockedReason(modelId) {
  const model = getFalVideoModel(modelId);
  if (!model) return 'The selected model is not in the curated fal catalog';
  if (model.kind !== 'ref2v') {
    return `${model.label} has no verified multi-shot request body (Kling's multi_prompt is not represented), so it stays per-shot`;
  }
  return null;
}

/** The longest sequence one request of `modelId` can hold, in seconds (null when ineligible). */
const sequenceMaxSec = (modelId) => (sequenceCoverageBlockedReason(modelId) ? null : getFalVideoModel(modelId).duration.max);

const sceneKey = (scene) => scene.sceneId ?? scene.id;
const sameId = (a, b) => (a?.id ?? a ?? null) === (b?.id ?? b ?? null);

function ineligibleReason(scene) {
  if (isPerformanceScene(scene)) return 'performance shots depend on their own song slice and stay one take';
  if ((scene.visualLayer ?? 'footage') !== 'footage') return 'only footage shots are generated';
  if (typeof scene.startSec !== 'number' || typeof scene.endSec !== 'number' || scene.endSec <= scene.startSec) return 'shot has no timed span';
  return null;
}

/**
 * Group sequence-section scenes into single-request runs.
 *
 * @param {Array<object>} scenes — timeline-ordered scenes (`sceneId`, `sectionIndex`, `coverage`, `startSec`, `endSec`, `shotMode`, `visualLayer`, `set`, `protagonist`)
 * @param {{ modelId: string }} options
 * @returns {{ groups: Array<{ sectionIndex, sceneIds, startSec, endSec, durationSec }>, perShot: Array<{ sceneId, reason }> }}
 *   `perShot` lists only shots of a `coverage: 'sequence'` section that stayed per-shot, with the reason.
 */
export function planSequenceCoverage(scenes, { modelId } = {}) {
  const blocked = sequenceCoverageBlockedReason(modelId);
  const maxSec = sequenceMaxSec(modelId);
  const groups = [];
  const perShot = [];
  const requested = (Array.isArray(scenes) ? scenes : []).filter((s) => s?.coverage === 'sequence');
  const bySection = new Map();
  for (const scene of requested) {
    if (!bySection.has(scene.sectionIndex)) bySection.set(scene.sectionIndex, []);
    bySection.get(scene.sectionIndex).push(scene);
  }
  for (const [sectionIndex, list] of bySection) {
    const ordered = list.slice().sort((a, b) => a.startSec - b.startSec);
    if (blocked) { ordered.forEach((s) => perShot.push({ sceneId: sceneKey(s), reason: blocked })); continue; }
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const startSec = run[0].startSec;
        const endSec = run.at(-1).endSec;
        groups.push({ sectionIndex, sceneIds: run.map(sceneKey), startSec: round3(startSec), endSec: round3(endSec), durationSec: round3(endSec - startSec) });
      } else if (run.length === 1) {
        perShot.push({ sceneId: sceneKey(run[0]), reason: 'no neighbouring shot shares its set and protagonist' });
      }
      run = [];
    };
    for (const scene of ordered) {
      const why = ineligibleReason(scene);
      if (why) { flush(); perShot.push({ sceneId: sceneKey(scene), reason: why }); continue; }
      const prev = run.at(-1);
      const continues = prev
        && Math.abs(scene.startSec - prev.endSec) < EPS
        && sameId(scene.set, prev.set)
        && sameId(scene.protagonist, prev.protagonist);
      if (prev && !continues) flush();
      run.push(scene);
    }
    flush();
  }
  // A run longer than the model's longest clip cannot be covered by one request: the whole run stays per-shot.
  const fits = [];
  for (const group of groups) {
    if (group.durationSec > maxSec + EPS) {
      group.sceneIds.forEach((sceneId) => perShot.push({ sceneId, reason: `the run is ${group.durationSec}s; the model's longest clip is ${maxSec}s` }));
    } else fits.push(group);
  }
  return { groups: fits, perShot };
}

/** The model's spelling of its nth reference image ("Image 2" / "@Image2"), or null when it takes none. */
function referenceImageName(modelId, n) {
  const name = getFalVideoModel(modelId)?.referenceImages?.promptName ?? (getFalVideoModel(modelId)?.referenceImages ? 'Image 1' : null);
  return name ? name.replace(/1$/, String(n)) : null;
}

const fmtSec = (n) => `${round3(n)}`;

/**
 * Compose the one prompt for a group: each shot as a contiguous `start-end s`
 * range, offset from the clip's first frame, optionally naming a reference image.
 * `shots` are `[{ prompt, startSec, endSec, imageIndex? }]` in timeline order.
 */
export function composeSequencePrompt({ modelId, shots }) {
  if (!Array.isArray(shots) || shots.length === 0) return '';
  const origin = shots[0].startSec;
  return shots.map((shot) => {
    const ref = Number.isInteger(shot.imageIndex) ? referenceImageName(modelId, shot.imageIndex) : null;
    const text = String(shot.prompt ?? '').trim();
    return `${fmtSec(shot.startSec - origin)}-${fmtSec(shot.endSec - origin)}s: ${ref ? `${ref}. ` : ''}${text}`;
  }).join('\n');
}

/**
 * Where each scene sits inside the generated clip: `clipStartSec`/`clipEndSec`
 * are the scene's existing in/out points relative to the group's first frame.
 * A clip shorter than the group (the provider returned less) refuses the split
 * rather than desyncing the song.
 */
export function sequenceClipSpans(group, scenes, { clipDurationSec = null } = {}) {
  const byId = new Map((scenes || []).map((s) => [sceneKey(s), s]));
  const spans = group.sceneIds.map((sceneId) => {
    const scene = byId.get(sceneId);
    return { sceneId, clipStartSec: round3(scene.startSec - group.startSec), clipEndSec: round3(scene.endSec - group.startSec) };
  });
  if (clipDurationSec != null && clipDurationSec + EPS < group.durationSec) {
    return { ok: false, reason: `the generated clip is ${round3(clipDurationSec)}s but the sequence needs ${group.durationSec}s` };
  }
  return { ok: true, spans };
}
