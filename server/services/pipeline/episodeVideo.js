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

/**
 * Build the CD treatment from a pipeline issue's storyboards stage. Each
 * storyboard scene becomes one CD scene; the series styleNotes are
 * prepended into each prompt so the renders share visual identity. After
 * the first scene we set `useContinuationFromPrior: true` so i2v chaining
 * carries the seed forward — same trick as the smoke fixture, applied to
 * narrative content.
 */
export function buildTreatmentFromStoryboards({ issue, series }) {
  const storyboards = issue.stages?.storyboards;
  const rawScenes = Array.isArray(storyboards?.scenes) ? storyboards.scenes : [];
  const usable = rawScenes
    .filter((s) => (s?.description || '').trim().length > 0)
    .slice(0, MAX_SCENES);
  if (!usable.length) {
    throw makeErr(
      'Storyboards stage has no scenes with descriptions. Add scenes on the Storyboards stage first.',
      ERR_NO_STORYBOARDS,
    );
  }
  const settingByKey = buildSettingByKey(series?.settings);
  const scenes = usable.map((s, idx) => ({
    sceneId: `iss-${issue.id.slice(-8)}-s${idx + 1}`,
    order: idx,
    intent: (s.slugline || `Scene ${idx + 1}`).slice(0, 1000),
    prompt: composeVisualPrompt({ series, description: s.description, slugline: s.slugline || '', settingByKey }).slice(0, 8000),
    negativePrompt: 'text, watermark, blur, motion blur, low quality',
    durationSeconds: Number.isFinite(s.durationSeconds) ? Math.min(10, Math.max(1, s.durationSeconds)) : DEFAULT_SCENE_DURATION,
    useContinuationFromPrior: idx > 0,
    sourceImageFile: null,
  }));
  const logline = (series?.logline || issue.title || 'Episode video').slice(0, 500);
  const synopsis = ((issue.stages?.idea?.output || issue.title || 'Pipeline episode') + '').slice(0, 5000);
  return {
    logline,
    synopsis,
    scenes,
  };
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
  if (existing && !options.force) {
    // Mirror buildTreatmentFromStoryboards exactly so the reuse-path scenes
    // count matches what the existing CD treatment actually holds: filter
    // empty descriptions AND cap at MAX_SCENES. SSE / UI status messaging
    // stays consistent between fresh-start and reuse paths.
    const scenes = (issue.stages?.storyboards?.scenes || [])
      .filter((s) => (s?.description || '').trim().length > 0)
      .slice(0, MAX_SCENES).length;
    return { cdProjectId: existing, reused: true, scenes };
  }

  const series = await getSeries(issue.seriesId);
  const treatment = buildTreatmentFromStoryboards({ issue, series });
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
