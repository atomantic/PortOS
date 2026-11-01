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
 *     lead, a gap, or a run longer than the model's longest clip);
 *   - `_composeSequencePrompt` writes the shots as contiguous time ranges using
 *     the model's own reference naming ("Image 1" on H3, "@Image1" on Seedance);
 *   - `_sequenceClipSpans` maps each scene back to its in/out point inside the
 *     returned clip — the existing scene cut times, never new ones.
 *
 * Only reference-to-video models are eligible. Kling v3 Pro image-to-video does
 * take `multi_prompt` (fal schema read 2026-10-31), but each element's `duration`
 * is a whole-second enum ("1"-"15") beside one start image, so its shot changes
 * cannot land on a scene's own in/out point; rounding them would invent cut
 * times. Kling stays per-shot.
 */

import { falReferenceImageName } from './storyboardGuidance.js';
import {
  FAL_DEFAULT_IMAGE_VIDEO_MODEL, falPromptExpansionAddition, falPromptExpansionMode, getFalVideoModel,
} from './falVideoModels.js';
import { authoredShotPrompt } from './musicVideoShotPrompt.js';
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
    return model.family === 'kling-v3'
      ? `${model.label} times multi-shot prompts in whole seconds, which cannot hold this section's cut points, so it stays per-shot`
      : `${model.label} renders one shot per request, so it stays per-shot`;
  }
  return null;
}

/** The longest sequence one request of `modelId` can hold, in seconds (null when ineligible). */
const sequenceMaxSec = (modelId) => (sequenceCoverageBlockedReason(modelId) ? null : getFalVideoModel(modelId).duration.max);

const sceneKey = (scene) => scene.sceneId ?? scene.id;
const idOf = (v) => v?.id ?? v ?? null;
// Two shots may share a run unless both name an identity and the names differ:
// a project that never recorded one keeps the director's explicit opt-in.
const sameIdentity = (a, b) => { const x = idOf(a); const y = idOf(b); return x == null || y == null || x === y; };

/**
 * The set and lead a stored scene implies. Scenes carry no `set`/`protagonist`
 * field; the set is the shot's picked `setReference.subjectId` or else its
 * section's set in the cast-and-sets song map, the lead its `characterVariant`.
 */
function sequenceShotIdentity(project, scene) {
  const songMap = project?.castAndSets?.direction?.songMap;
  const mapped = Number.isInteger(scene?.sectionIndex) && Array.isArray(songMap)
    ? songMap.find((entry) => entry?.section === scene.sectionIndex)?.setId : null;
  return {
    set: scene?.setReference?.subjectId || mapped || null,
    protagonist: scene?.characterVariant?.ingredientId || null,
  };
}

/** `planSequenceCoverage` over a project's stored scenes, with each shot's set and lead resolved. */
export function planProjectSequenceCoverage(project, { modelId } = {}) {
  const scenes = (Array.isArray(project?.scenes) ? project.scenes : []).map((scene) => ({ ...scene, ...sequenceShotIdentity(project, scene) }));
  return planSequenceCoverage(scenes, { modelId });
}

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
        perShot.push({ sceneId: sceneKey(run[0]), reason: 'no adjoining shot in the same set with the same lead' });
      }
      run = [];
    };
    for (const scene of ordered) {
      const why = ineligibleReason(scene);
      if (why) { flush(); perShot.push({ sceneId: sceneKey(scene), reason: why }); continue; }
      const prev = run.at(-1);
      const continues = prev
        && Math.abs(scene.startSec - prev.endSec) < EPS
        && sameIdentity(scene.set, prev.set)
        && sameIdentity(scene.protagonist, prev.protagonist);
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
const referenceImageName = (modelId, n) => falReferenceImageName(getFalVideoModel(modelId), n - 1);

const fmtSec = (n) => `${round3(n)}`;

/**
 * Compose the one prompt for a group: each shot as a contiguous `start-end s`
 * range, offset from the clip's first frame, optionally naming a reference image.
 * `shots` are `[{ prompt, startSec, endSec, imageIndex? }]` in timeline order.
 */
export function _composeSequencePrompt({ modelId, shots }) {
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
export function _sequenceClipSpans(group, scenes, { clipDurationSec = null } = {}) {
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

/** The fal model a project's sequence runs render on, or null off the fal backend. */
export const sequenceModelId = (project) => {
  const settings = project?.videoSettings || {};
  return settings.backend === 'fal' ? settings.falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL : null;
};

/**
 * What one planned run sends: shot n is "Image n" and its frame the nth
 * reference, the timed prompt, the labeled prompt-expansion value, and each
 * scene's cut inside the clip. The server submit and the shot card both read
 * this, so the card shows the request that is sent.
 */
export function sequenceGroupInput(project, group) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const modelId = sequenceModelId(project);
  const byId = new Map(scenes.map((s) => [sceneKey(s), s]));
  const members = group.sceneIds.map((id) => byId.get(id));
  const prompt = _composeSequencePrompt({
    modelId,
    shots: members.map((s, i) => ({ prompt: authoredShotPrompt(s), startSec: s.startSec, endSec: s.endSec, imageIndex: i + 1 })),
  });
  const expansion = falPromptExpansionMode(getFalVideoModel(modelId), SEQUENCE_PROMPT_EXPANSION);
  return {
    modelId, members, prompt, resolution: project?.videoSettings?.falResolution,
    promptAdditions: [falPromptExpansionAddition(expansion)].filter(Boolean),
    spans: _sequenceClipSpans(group, scenes).spans,
  };
}
