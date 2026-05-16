/**
 * Pipeline — Episode Video stage handoff.
 *
 * The Pipeline's `episodeVideo` stage drives the full per-scene render +
 * stitch loop, but reuses the Creative Director machinery instead of
 * duplicating it. We create a CD project with `autoAcceptScenes: true` so
 * no LLM evaluator round-trip runs (the Pipeline already had the human
 * vetting the storyboard scenes), then call into CD's existing
 * `advanceAfterSceneSettled` to kick off the first render. CD's own
 * sceneRunner / completionHook / stitchRunner take it from there.
 *
 * The CD project id is persisted on the issue's `stages.episodeVideo` so
 * the UI can poll `/api/creative-director/:id` to render progress and
 * surface the final stitched video when complete.
 */
import { composeVisualPrompt } from './visualStages.js';
import { getIssue, updateStage } from './issues.js';
import { getSeries } from './series.js';
import { createProject as createCDProject, setTreatment as setCDTreatment } from '../creativeDirector/local.js';
import { startCreativeDirectorProject } from '../creativeDirector/completionHook.js';
import { getDefaultVideoModelId } from '../../lib/mediaModels.js';
import { buildSettingByKey } from '../../lib/scenePrompt.js';
import { getSettings } from '../settings.js';

export const ERR_NO_STORYBOARDS = 'PIPELINE_EPISODE_NO_STORYBOARDS';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const DEFAULT_SCENE_DURATION = 3;
const MAX_SCENES = 30;
const CD_NEGATIVE_PROMPT = 'text, watermark, blur, motion blur, low quality';

// Single source of truth for the CD-scene shape. `order` is stamped at flatten
// time so callers don't carry a placeholder. Duration is clamped to [1,10] for
// CD pacing — narrower than the sanitizer's [1,30] storage envelope on purpose.
function buildCdScene({ sceneId, intent, prompt, durationSecondsRaw, useContinuationFromPrior }) {
  return {
    sceneId,
    intent: intent.slice(0, 1000),
    prompt: prompt.slice(0, 8000),
    negativePrompt: CD_NEGATIVE_PROMPT,
    durationSeconds: Number.isFinite(durationSecondsRaw)
      ? Math.min(10, Math.max(1, durationSecondsRaw))
      : DEFAULT_SCENE_DURATION,
    useContinuationFromPrior,
    sourceImageFile: null,
  };
}

// Map one storyboard scene's shots[] to N CD scenes. Within-scene shots chain
// by default (natural i2v continuation); the LLM can also flag an explicit
// continuity ref to chain across a scene boundary (deliberate match cut).
function expandShotsToCdScenes(scene, sceneIdx, shortIssueId, baselinePrompt) {
  const shots = Array.isArray(scene.shots) ? scene.shots : [];
  return shots.map((shot, sIdx) => {
    const description = (shot.description || '').trim() || scene.description;
    const chainsWithinScene = sIdx > 0;
    const explicitContinuity = !!shot.continuityFromShotId;
    return buildCdScene({
      sceneId: `iss-${shortIssueId}-s${sceneIdx + 1}-sh${sIdx + 1}`,
      intent: scene.slugline
        ? `${scene.slugline} — shot ${sIdx + 1}`
        : `Scene ${sceneIdx + 1} Shot ${sIdx + 1}`,
      prompt: baselinePrompt(description, scene.slugline),
      durationSecondsRaw: shot.durationSeconds,
      useContinuationFromPrior: chainsWithinScene || explicitContinuity,
    });
  });
}

/**
 * Build the CD treatment from a pipeline issue's storyboards stage. The
 * mapping rules:
 *   - Scene with shots[] → N CD scenes (one per shot); shots chain within
 *     the scene, the first shot of each scene starts a fresh angle.
 *   - Scene without shots[] → one CD scene (legacy behavior); subsequent
 *     legacy scenes chain via useContinuationFromPrior=true.
 *
 * MAX_SCENES caps the flattened CD scene count so an issue with deep shot
 * decomposition can't push the CD render queue past its single-issue budget.
 */
export function buildTreatmentFromStoryboards({ issue, series }) {
  const storyboards = issue.stages?.storyboards;
  const rawScenes = Array.isArray(storyboards?.scenes) ? storyboards.scenes : [];
  const usable = rawScenes.filter((s) => (s?.description || '').trim().length > 0);
  if (!usable.length) {
    throw makeErr(
      'Storyboards stage has no scenes with descriptions. Add scenes on the Storyboards stage first.',
      ERR_NO_STORYBOARDS,
    );
  }
  const shortIssueId = issue.id.slice(-8);
  const settingByKey = buildSettingByKey(series?.settings);
  const baselinePrompt = (description, slugline) =>
    composeVisualPrompt({ series, description, slugline: slugline || '', settingByKey });

  const flattened = [];
  for (let idx = 0; idx < usable.length; idx += 1) {
    const scene = usable[idx];
    const expanded = (Array.isArray(scene.shots) && scene.shots.length > 0)
      ? expandShotsToCdScenes(scene, idx, shortIssueId, baselinePrompt)
      : [buildCdScene({
        sceneId: `iss-${shortIssueId}-s${idx + 1}`,
        intent: scene.slugline || `Scene ${idx + 1}`,
        prompt: baselinePrompt(scene.description, scene.slugline),
        durationSecondsRaw: scene.durationSeconds,
        // First entry overall is fresh; every legacy scene after it chains
        // from its predecessor — matches the pre-shots behavior exactly.
        useContinuationFromPrior: flattened.length > 0,
      })];
    const room = MAX_SCENES - flattened.length;
    if (room <= 0) break;
    flattened.push(...expanded.slice(0, room));
  }
  // Stamp final order indices after truncation so the CD project sees a
  // contiguous [0..N) sequence regardless of where the cap kicked in.
  const scenes = flattened.map((cd, i) => ({ ...cd, order: i }));
  const logline = (series?.logline || issue.title || 'Episode video').slice(0, 500);
  const synopsis = ((issue.stages?.idea?.output || issue.title || 'Pipeline episode') + '').slice(0, 5000);
  return { logline, synopsis, scenes };
}

/**
 * Create a CD project from a pipeline issue's storyboards stage and kick
 * off the render → stitch loop. Persists `cdProjectId` on the issue's
 * `stages.episodeVideo` so subsequent polls find the running CD project.
 *
 * Idempotent in spirit: if the stage already has a `cdProjectId` and
 * `options.force` is not set, returns the existing id instead of creating
 * a duplicate. The route layer can call this again to reuse an in-flight
 * run safely.
 */
export async function startEpisodeVideoForIssue(issueId, options = {}) {
  const [issue, settings] = await Promise.all([getIssue(issueId), getSettings()]);

  const existing = issue.stages?.episodeVideo?.cdProjectId;
  const series = await getSeries(issue.seriesId);
  const treatment = buildTreatmentFromStoryboards({ issue, series });
  if (existing && !options.force) {
    // SSE / UI status messaging stays consistent between fresh-start and
    // reuse paths by reusing the treatment builder for the scene count —
    // shot expansion + MAX_SCENES truncation produce the same number both
    // times, so the user sees "N scenes" matching what was actually queued.
    return { cdProjectId: existing, reused: true, scenes: treatment.scenes.length };
  }
  const aspectRatio = options.aspectRatio || '16:9';
  const quality = options.quality || 'standard';
  const modelId = options.modelId || settings?.videoGen?.defaultModelId || getDefaultVideoModelId();

  const project = await createCDProject({
    name: `Pipeline: ${(series?.name || 'Series').slice(0, 60)} — ${(issue.title || issueId).slice(0, 60)}`,
    aspectRatio,
    quality,
    modelId,
    targetDurationSeconds: Math.min(600, treatment.scenes.reduce((sum, s) => sum + s.durationSeconds, 0)),
    styleSpec: series?.styleNotes || '',
    startingImageFile: null,
    userStory: issue.stages?.prose?.output || null,
    disableAudio: true,
    autoAcceptScenes: true,
    sourceIssueId: issueId,
  });
  await setCDTreatment(project.id, treatment);

  await updateStage(issueId, 'episodeVideo', {
    status: 'generating',
    cdProjectId: project.id,
    // Persist the chosen render settings so a page reload restores the
    // pickers — otherwise restart from a fresh tab would silently fall back
    // to defaults that the user can't see or adjust.
    aspectRatio,
    quality,
    output: '',
    errorMessage: '',
  });

  // Kick off the orchestrator — fire-and-forget so the route can return
  // immediately. Failures land on the CD project's `failureReason` field
  // and surface via the UI's CD project poll, not via this Promise.
  startCreativeDirectorProject(project.id).catch((err) =>
    console.log(`⚠️ Pipeline episode CD start failed for ${project.id}: ${err.message}`),
  );

  console.log(`🎬 Pipeline episode video — issue=${issueId.slice(0, 8)} cdProject=${project.id.slice(0, 8)} scenes=${treatment.scenes.length}`);
  return { cdProjectId: project.id, scenes: treatment.scenes.length, reused: false };
}
