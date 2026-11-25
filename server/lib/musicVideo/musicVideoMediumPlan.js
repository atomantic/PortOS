/**
 * Music video medium planning: `normalizeMusicVideoProductionPolicy`, `planMusicVideoMedia`,
 * `summarizeMusicVideoMediumPlan` and `codeFirstProductionAssets` for pinned shot media and preflight.
 *
 * `normalizeMusicVideoProductionPolicy`, `planMusicVideoMedia`, `summarizeMusicVideoMediumPlan`, and
 * `codeFirstProductionAssets`: pinned shot media, union-of-intervals video allowance, and
 * selected-asset preflight shared by planning and Board review. `musicVideoGenerationAllowance` is the
 * one answer to "may this project generate images or video" over its three stored fields (media mode,
 * production policy, brief tools); planning, direction, pooling and dispatch all read it.
 * `musicVideoToolPolicyConflict` explains the disagreement the setup panel warns about.
 */

import { musicVideoAllowsMedia } from './musicVideoMediaPolicy.js';
import { applyShotSheetMedium, isAutomaticLayerPin, VISUAL_LAYER_PIN_RATIONALE } from './musicVideoShotSheet.js';
import { performanceCapability } from './musicVideoShotTiming.js';
/**
 * Planning-only medium policy. Final-edit seconds are an interval union, not
 * provider clip lengths or a sum that double-counts overlapping footage.
 * Dependency-free so the Board and server Apply use the same accounting.
 */
export const MUSIC_VIDEO_MEDIA = ['procedural', 'still', 'existing-footage', 'generated-footage'];
export const MUSIC_VIDEO_MEDIUM_LABELS = {
  procedural: 'Procedural',
  still: 'Still',
  'existing-footage': 'Existing footage',
  'generated-footage': 'Generated footage',
};

export function normalizeMusicVideoProductionPolicy(patch, base = null) {
  const strategy = (patch?.strategy ?? base?.strategy) === 'code-first' ? 'code-first' : 'legacy';
  const defaultPercent = strategy === 'code-first' ? 0 : 100;
  const percent = patch?.maxGeneratedVideoPercent
    ?? (base?.strategy === strategy ? base.maxGeneratedVideoPercent : defaultPercent);
  return {
    strategy,
    maxGeneratedVideoPercent: typeof percent === 'number' && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent)) : defaultPercent,
  };
}

/** The brief's selected render tools (`image:*`, `video:*`, `code:render`); empty when the brief names none. */
export const musicVideoBriefTools = (project) => (Array.isArray(project?.automation?.tools) ? project.automation.tools.filter((t) => typeof t === 'string') : []);

/**
 * The one answer to "may this project generate images or video". Three stored fields each
 * restrict it and can be saved without the others: `mediaMode`, `productionPolicy` and the brief's
 * `automation.tools`, so every reader goes through here instead of re-checking one of them.
 *
 * - `video`: the media mode allows video AND the brief names no tools or names a video tool AND the
 *   policy is legacy or its generated-video allowance is above zero.
 * - `videoPercent`: the effective allowance, 0 whenever `video` is false (the stored percent is
 *   kept on the policy untouched).
 * - `image`: the media mode allows images AND the brief names no tools or names an image tool.
 * - `reason`: why `video` is false, first match of `MEDIA_MODE`, `NO_VIDEO_TOOL`, `ZERO_ALLOWANCE`
 *   (`null` when it is true).
 * - `policyAllowsVideo`: the policy alone still plans generated footage, so a false `video` with a
 *   `MEDIA_MODE`/`NO_VIDEO_TOOL` reason is a mismatch rather than a deliberate code-first choice.
 */
export function musicVideoGenerationAllowance(project) {
  const policy = normalizeMusicVideoProductionPolicy(project?.productionPolicy);
  const tools = musicVideoBriefTools(project);
  const policyAllowsVideo = policy.strategy === 'legacy' || policy.maxGeneratedVideoPercent > 0;
  const toolsAllowVideo = tools.length === 0 || tools.some((t) => t.startsWith('video:'));
  const modeAllowsVideo = musicVideoAllowsMedia(project, 'video');
  const video = modeAllowsVideo && toolsAllowVideo && policyAllowsVideo;
  let reason = null;
  if (!video) reason = !modeAllowsVideo ? 'MEDIA_MODE' : !toolsAllowVideo ? 'NO_VIDEO_TOOL' : 'ZERO_ALLOWANCE';
  return {
    image: musicVideoAllowsMedia(project, 'image') && (tools.length === 0 || tools.some((t) => t.startsWith('image:'))),
    video,
    videoPercent: video ? policy.maxGeneratedVideoPercent : 0,
    strategy: policy.strategy,
    reason,
    policyAllowsVideo,
  };
}

/**
 * The dispatch refusal message for a project whose allowance has `video: false`. A media mode that
 * forbids video keeps the tool wording it has always had; `remedy` appends how to fix it.
 */
export function musicVideoNoVideoMessage(allowance, { remedy = false } = {}) {
  if (allowance.reason === 'ZERO_ALLOWANCE') {
    return `This project's production policy allows no generated video, so generated footage is not dispatched.${remedy ? ' Raise the generated-video allowance, or replan the project without generated video.' : ''}`;
  }
  return `No video tool is selected in this project's brief, so generated footage is not dispatched.${remedy ? ' Add a video tool, or replan the project without generated video.' : ''}`;
}

/**
 * The saved tools and production policy disagree: the media mode or the brief's tools rule out
 * video, while the policy still plans generated footage (legacy, or code-first with a non-zero
 * allowance). Describes the mismatch; never edits anything — an approved plan stays as saved
 * until the director replans.
 */
export function musicVideoToolPolicyConflict(project) {
  const { video, policyAllowsVideo } = musicVideoGenerationAllowance(project);
  if (video || !policyAllowsVideo) return null;
  return {
    code: 'NO_VIDEO_TOOL',
    message: 'No video tool is selected, but the production policy still allows generated footage. Replan as code-first with no generated video, or add a video tool to the brief.',
  };
}

function unionSeconds(intervals) {
  let end = 0;
  let total = 0;
  for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}

/** Read current scene timing on every call; retiming cannot retain an old allowance. */
export function summarizeMusicVideoMediumPlan(project, directions = project?.treatment?.shotDirections || []) {
  const policy = normalizeMusicVideoProductionPolicy(project?.productionPolicy);
  const allowance = musicVideoGenerationAllowance(project);
  const durationSec = project?.audioAnalysis?.durationSec;
  const validDuration = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0;
  const intervals = Object.fromEntries(MUSIC_VIDEO_MEDIA.map((medium) => [medium, []]));
  const byScene = new Map(directions.map((d) => [d.sceneId, d]));
  const unresolved = [];
  const exceptions = [];
  const codeFirst = policy.strategy === 'code-first';
  for (const scene of project?.scenes || []) {
    const d = byScene.get(scene.sceneId);
    if (d?.medium === 'still' && !musicVideoAllowsMedia(project, 'image') || ['generated-footage', 'existing-footage'].includes(d?.medium) && !musicVideoAllowsMedia(project, 'video')) unresolved.push({ sceneId: scene.sceneId, blocking: true, message: 'This shot medium conflicts with the project media mode.' });
    if (!d || !MUSIC_VIDEO_MEDIA.includes(d.medium)) {
      if (codeFirst) unresolved.push({ sceneId: scene.sceneId, blocking: true, message: 'Compile a medium plan for this shot.' });
      continue;
    }
    if (codeFirst && (typeof d.mediumRationale !== 'string' || !d.mediumRationale.trim())) {
      unresolved.push({ sceneId: scene.sceneId, blocking: true, message: 'Explain why this medium serves the shot before applying the plan.' });
    }
    const { startSec, endSec } = scene;
    const valid = validDuration && Number.isFinite(startSec) && Number.isFinite(endSec)
      && startSec >= 0 && endSec > startSec && endSec <= durationSec + 0.000001;
    if (!valid) {
      if (codeFirst) unresolved.push({ sceneId: scene.sceneId, blocking: true, message: 'This shot needs a valid final-edit interval within the song.' });
    } else {
      intervals[d.medium].push([startSec, Math.min(endSec, durationSec)]);
    }
    if (d.medium === 'generated-footage') exceptions.push({
      sceneId: scene.sceneId, startSec, endSec, rationale: d.mediumRationale || '',
    });
    if (codeFirst && d.medium === 'existing-footage' && !scene.videoHistoryId) {
      unresolved.push({ sceneId: scene.sceneId, blocking: false, message: 'Select existing footage before executing this plan.' });
    }
    if (codeFirst && d.mode === 'performance' && !['existing-footage', 'generated-footage'].includes(d.medium)) {
      unresolved.push({ sceneId: scene.sceneId, blocking: false, message: 'Visible performance is unresolved with this medium; supply footage or explicitly revise the plan and allowance.' });
    }
  }
  const secondsByMedium = Object.fromEntries(MUSIC_VIDEO_MEDIA.map((medium) => [medium, unionSeconds(intervals[medium])]));
  const generatedSec = secondsByMedium['generated-footage'];
  const allowedGeneratedSec = validDuration ? durationSec * allowance.videoPercent / 100 : 0;
  if (codeFirst && !validDuration) unresolved.push({ blocking: true, message: 'Analyze the song duration before applying a medium plan.' });
  if (codeFirst && generatedSec > allowedGeneratedSec + 0.000001) {
    unresolved.push({ blocking: true, message: allowance.reason === 'NO_VIDEO_TOOL'
      ? 'Generated footage needs a video tool, but the brief selected none. Change its medium, or add a video tool to the brief.'
      : 'Generated footage exceeds the final-edit allowance. Shorten its intervals, change its medium, or explicitly increase the allowance.' });
  }
  return {
    ...policy, maxGeneratedVideoPercent: allowance.videoPercent, durationSec: validDuration ? durationSec : null, allowedGeneratedSec,
    generatedSec, secondsByMedium, exceptions, unresolved,
    blocked: unresolved.some((item) => item.blocking),
  };
}

/**
 * Execution preflight for an approved code-first plan. This describes work,
 * never dispatches it: an existing selected asset wins over generation, and
 * procedural scenes need neither a reference frame nor a video provider.
 * Imported-footage gaps are conflicts, not permission to generate a take.
 */
export function codeFirstProductionAssets(project) {
  const plan = summarizeMusicVideoMediumPlan(project);
  if (plan.strategy !== 'code-first') return null;
  const directions = new Map((project?.treatment?.shotDirections || []).map((d) => [d.sceneId, d]));
  const steps = [];
  // Without a lip-sync lane a performance direction is planned as a non-sync shot, so the shot mode cannot (and need not) become Performance.
  const lipSync = !!performanceCapability(project?.videoSettings?.backend || null);
  const scenes = new Map((project?.scenes || []).map((scene) => [scene.sceneId, scene]));
  const conflicts = plan.unresolved.filter((item) => item.blocking || item.message.startsWith('Visible performance'))
    .map((item) => {
      const label = scenes.get(item.sceneId)?.label;
      const shot = label ? `${label} (${item.sceneId})` : item.sceneId;
      return shot ? `${shot}: ${item.message}` : item.message;
    });
  if (!Number.isInteger(project.treatment?.revision) || project.treatment.appliedRevision !== project.treatment.revision) {
    conflicts.push('Apply the current medium plan to approve it before production.');
  }
  for (const scene of project?.scenes || []) {
    const direction = directions.get(scene.sceneId);
    const medium = direction?.medium;
    if (!MUSIC_VIDEO_MEDIA.includes(medium)) continue;
    if (scene.shotMode === 'performance' && !['existing-footage', 'generated-footage'].includes(medium)) conflicts.push(`Performance shot ${scene.label || scene.sceneId} requires selected footage; revise its shot mode or medium explicitly.`);
    if (((direction?.mode === 'performance' && lipSync) || scene.shotMode === 'performance')
      && ['existing-footage', 'generated-footage'].includes(medium)
      && (scene.shotMode !== 'performance' || (scene.visualLayer != null && scene.visualLayer !== 'footage'))) {
      conflicts.push(`Set ${scene.label || scene.sceneId} to a Performance footage shot before production; its approved performance must retain source-audio timing.`);
    }
    if (medium === 'procedural') {
      steps.push({ sceneId: scene.sceneId, medium, action: 'code' });
    } else if (medium === 'still') {
      steps.push({ sceneId: scene.sceneId, medium, action: scene.referenceImageId ? 'reuse-image' : 'generate-image' });
    } else if (medium === 'existing-footage') {
      if (scene.videoHistoryId) steps.push({ sceneId: scene.sceneId, medium, action: 'reuse-video' });
      else conflicts.push(`Select an existing take for ${scene.label || scene.sceneId} before production.`);
    } else if (scene.videoHistoryId) {
      steps.push({ sceneId: scene.sceneId, medium, action: 'reuse-video' });
    } else {
      if (!scene.referenceImageId) steps.push({ sceneId: scene.sceneId, medium, action: 'generate-image' });
      steps.push({ sceneId: scene.sceneId, medium, action: 'generate-video' });
    }
  }
  // Deduplicate project-wide conflicts while retaining each affected shot in scene-specific messages.
  return { steps, conflicts: [...new Set(conflicts)],
    requiredRoutes: {
      image: steps.some((step) => step.action === 'generate-image'),
      video: steps.some((step) => step.action === 'generate-video'),
    } };
}

/** Retain director pins; allocate optional generated shots only within the union budget. */
export function planMusicVideoMedia(project, directions) {
  const allowance = musicVideoGenerationAllowance(project);
  const codeFirst = allowance.strategy === 'code-first';
  // A brief that explicitly selected a video tool expects footage; the allowance below trims it.
  const footageSeeded = codeFirst && allowance.video && musicVideoBriefTools(project).some((t) => t.startsWith('video:'));
  const scenes = new Map((project.scenes || []).map((s) => [s.sceneId, s]));
  const previous = new Map((project.treatment?.shotDirections || []).map((d) => [d.sceneId, d]));
  const planned = directions.map((d) => {
    const scene = scenes.get(d.sceneId);
    const prior = previous.has(d.sceneId) ? previous.get(d.sceneId) : scene?.direction;
    const priorPinned = prior?.mediumPinned === true && MUSIC_VIDEO_MEDIA.includes(prior.medium);
    // A pin the director chose wins over the shot sheet. The automatic layer pin does not.
    if (priorPinned && !isAutomaticLayerPin(scene, prior)) {
      return { ...d, medium: prior.medium, mediumRationale: prior.mediumRationale, mediumPinned: true };
    }
    const sheeted = applyShotSheetMedium(project, scene, priorPinned
      ? { ...d, medium: prior.medium, mediumRationale: prior.mediumRationale, mediumPinned: true }
      : d);
    // fromSheet stays on the in-memory plan so the allowance loop below cannot demote it.
    if (sheeted.fromSheet) return sheeted;
    if (priorPinned) {
      return { ...d, medium: prior.medium, mediumRationale: prior.mediumRationale, mediumPinned: true };
    }
    let medium = d.medium;
    let rationale = d.mediumRationale;
    const manualLayer = ['still', 'card', 'code'].includes(scene?.visualLayer);
    if (manualLayer) {
      medium = scene.visualLayer === 'still' ? 'still' : 'procedural';
      rationale = VISUAL_LAYER_PIN_RATIONALE;
    } else if (scene?.videoHistoryId) {
      medium = 'existing-footage';
      rationale = 'Reuse the selected footage without a new video request.';
    } else if (!MUSIC_VIDEO_MEDIA.includes(medium)) {
      medium = codeFirst ? (scene?.referenceImageId ? 'still' : 'procedural')
        : d.route === 'code-2d' ? (scene?.lyricText ? 'procedural' : 'still')
          : d.route === 'supplied-asset' ? 'existing-footage' : 'generated-footage';
      rationale = codeFirst ? 'Carry the section motif and transitions with code or available images.'
        : 'Retain the legacy treatment route.';
    }
    if (codeFirst && footageSeeded && !manualLayer && medium === 'procedural' && !scene?.referenceImageId && !scene?.videoHistoryId && d.route !== 'code-2d') {
      medium = 'generated-footage';
      rationale = 'The brief selected video tools; plan generated footage for this shot, within the generated-video allowance.';
    }
    if (!manualLayer && !scene?.referenceImageId && !scene?.videoHistoryId && (medium === 'still' && !musicVideoAllowsMedia(project, 'image') || ['existing-footage', 'generated-footage'].includes(medium) && !musicVideoAllowsMedia(project, 'video'))) {
      medium = 'procedural'; rationale = 'Author the full scene in code within the selected media mode.';
    }
    return { ...d, medium, mediumRationale: rationale || d.rationale || 'Director-selected medium.', mediumPinned: manualLayer };
  });
  // Reserve pinned exceptions first. Automatic suggestions never displace a pin.
  // A sheet camera's generated footage is not a suggestion: over-allowance blocks Apply.
  const sheetSourced = (d) => d.fromSheet === true;
  const accepted = planned.map((d) => codeFirst && d.medium === 'generated-footage' && !d.mediumPinned && !sheetSourced(d)
    ? { ...d, medium: 'procedural' } : d);
  for (let i = 0; codeFirst && i < planned.length; i++) {
    if (planned[i].medium !== 'generated-footage' || planned[i].mediumPinned || sheetSourced(planned[i])) continue;
    const candidate = [...accepted];
    candidate[i] = planned[i];
    const summary = summarizeMusicVideoMediumPlan(project, candidate);
    if (!summary.blocked && allowance.video) accepted[i] = planned[i];
    else accepted[i] = { ...accepted[i], mediumRationale: 'Use procedural visuals to stay within the generated-video allowance; any visible performance remains unresolved.' };
  }
  return (codeFirst ? accepted : planned).map(({ fromSheet, ...rest }) => rest);
}
