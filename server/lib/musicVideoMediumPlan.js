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

/** False when the brief names tools and none of them makes video. A brief naming no tools restricts nothing. */
export function musicVideoBriefAllowsVideo(project) {
  const tools = musicVideoBriefTools(project);
  return tools.length === 0 || tools.some((t) => t.startsWith('video:'));
}

/**
 * The saved tools and production policy disagree: the brief selected tools but
 * no video tool, while the policy still plans generated footage (legacy, or
 * code-first with a non-zero allowance). Describes the mismatch; never edits
 * anything — an approved plan stays as saved until the director replans.
 */
export function musicVideoToolPolicyConflict(project) {
  if (musicVideoBriefAllowsVideo(project)) return null;
  const policy = normalizeMusicVideoProductionPolicy(project?.productionPolicy);
  if (policy.strategy === 'code-first' && policy.maxGeneratedVideoPercent <= 0) return null;
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
  const durationSec = project?.audioAnalysis?.durationSec;
  const validDuration = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0;
  const intervals = Object.fromEntries(MUSIC_VIDEO_MEDIA.map((medium) => [medium, []]));
  const byScene = new Map(directions.map((d) => [d.sceneId, d]));
  const unresolved = [];
  const exceptions = [];
  const codeFirst = policy.strategy === 'code-first';
  for (const scene of project?.scenes || []) {
    const d = byScene.get(scene.sceneId);
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
  const allowedGeneratedSec = validDuration ? durationSec * policy.maxGeneratedVideoPercent / 100 : 0;
  if (codeFirst && !validDuration) unresolved.push({ blocking: true, message: 'Analyze the song duration before applying a medium plan.' });
  if (codeFirst && generatedSec > allowedGeneratedSec + 0.000001) {
    unresolved.push({ blocking: true, message: 'Generated footage exceeds the final-edit allowance. Shorten its intervals, change its medium, or explicitly increase the allowance.' });
  }
  return {
    ...policy, durationSec: validDuration ? durationSec : null, allowedGeneratedSec,
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
  const conflicts = plan.unresolved.filter((item) => item.blocking || item.message.startsWith('Visible performance')).map((item) => item.message);
  if (!Number.isInteger(project.treatment?.revision) || project.treatment.appliedRevision !== project.treatment.revision) {
    conflicts.push('Apply the current medium plan to approve it before production.');
  }
  for (const scene of project?.scenes || []) {
    const direction = directions.get(scene.sceneId);
    const medium = direction?.medium;
    if (!MUSIC_VIDEO_MEDIA.includes(medium)) continue;
    if (scene.shotMode === 'performance' && !['existing-footage', 'generated-footage'].includes(medium)) conflicts.push(`Performance shot ${scene.label || scene.sceneId} requires selected footage; revise its shot mode or medium explicitly.`);
    if ((direction?.mode === 'performance' || scene.shotMode === 'performance')
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
  return { steps, conflicts,
    requiredRoutes: {
      image: steps.some((step) => step.action === 'generate-image'),
      video: steps.some((step) => step.action === 'generate-video'),
    } };
}

/** Retain director pins; allocate optional generated shots only within the union budget. */
export function planMusicVideoMedia(project, directions) {
  const policy = normalizeMusicVideoProductionPolicy(project.productionPolicy);
  const codeFirst = policy.strategy === 'code-first';
  const scenes = new Map((project.scenes || []).map((s) => [s.sceneId, s]));
  const previous = new Map((project.treatment?.shotDirections || []).map((d) => [d.sceneId, d]));
  const planned = directions.map((d) => {
    const scene = scenes.get(d.sceneId);
    const prior = previous.has(d.sceneId) ? previous.get(d.sceneId) : scene?.direction;
    if (prior?.mediumPinned && MUSIC_VIDEO_MEDIA.includes(prior.medium)) {
      return { ...d, medium: prior.medium, mediumRationale: prior.mediumRationale, mediumPinned: true };
    }
    let medium = d.medium;
    let rationale = d.mediumRationale;
    const manualLayer = scene?.visualLayer === 'still' || scene?.visualLayer === 'card';
    if (manualLayer) {
      medium = scene.visualLayer === 'still' ? 'still' : 'procedural';
      rationale = 'Retain the director-selected visual layer.';
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
    return { ...d, medium, mediumRationale: rationale || d.rationale || 'Director-selected medium.', mediumPinned: manualLayer };
  });
  // Reserve pinned exceptions first. Automatic suggestions never displace a pin.
  const accepted = planned.map((d) => codeFirst && d.medium === 'generated-footage' && !d.mediumPinned
    ? { ...d, medium: 'procedural' } : d);
  for (let i = 0; codeFirst && i < planned.length; i++) {
    if (planned[i].medium !== 'generated-footage' || planned[i].mediumPinned) continue;
    const candidate = [...accepted];
    candidate[i] = planned[i];
    const summary = summarizeMusicVideoMediumPlan(project, candidate);
    if (!summary.blocked && policy.maxGeneratedVideoPercent > 0) accepted[i] = planned[i];
    else accepted[i] = { ...accepted[i], mediumRationale: 'Use procedural visuals to stay within the generated-video allowance; any visible performance remains unresolved.' };
  }
  return codeFirst ? accepted : planned;
}
