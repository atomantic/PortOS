/**
 * Pipeline — Visual stage handoff helpers
 *
 * Thin wrappers that enqueue image-gen jobs on behalf of the Pipeline's
 * comicPages and storyboards stages. The route layer is responsible for
 * persisting the returned jobIds into the issue's stage record — this module
 * just owns the "build the right params, hand to mediaJobQueue" mechanic so
 * the pipeline doesn't have to duplicate Image-Gen's mode-resolution code.
 *
 * MVP scope: image jobs only. Scene video / episode-video stitching is
 * deferred — the storyboards and episodeVideo stages currently expose
 * read/write of their structured fields but don't yet drive the Creative
 * Director scene runner. See PLAN.md "Pipeline — Deferred" for the follow-up.
 */

import { enqueueJob } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import { getSeries } from './series.js';
import { getIssue, VISUAL_STAGE_IDS } from './issues.js';
import { buildScenePrompt, buildSettingByKey, matchSceneSetting } from '../../lib/scenePrompt.js';

const SUPPORTED_MODES = new Set(['local', 'codex']);

// Build a pipeline image-gen prompt; delegates to the shared `buildScenePrompt`
// so Pipeline + Writers Room renders agree byte-for-byte.
//
// Pipeline storyboard scenes don't yet carry a per-scene `characters[]`
// list — once the scene extractor (PLAN item 5) populates it, callers will
// pass `matchedCharacters` to selectively inject the cast. Until then we
// inject none, so a 30-character series doesn't pollute every render with
// the entire bible.
export function composeVisualPrompt({ series, description, slugline = '', extraStyle = '', settingByKey = null, matchedCharacters = [] }) {
  const worldStyle = [series?.styleNotes, extraStyle].map((s) => (s || '').trim()).filter(Boolean).join(', ');
  const map = settingByKey || buildSettingByKey(series?.settings);
  return buildScenePrompt(
    series?.name || '',
    { visualPrompt: description || '', slugline },
    matchedCharacters,
    worldStyle,
    matchSceneSetting(slugline, map),
  );
}

/**
 * Enqueue one image render for a pipeline issue's visual stage. The caller
 * is responsible for recording the returned jobId on the issue's stage
 * artifact list (e.g. stages.comicPages.pages[i].panels[j].imageJobId).
 *
 * `options.description` — required, the panel/scene subject text.
 * `options.modelId`, `options.width`, `options.height`, `options.steps`,
 * `options.guidance`, `options.negativePrompt` — optional overrides.
 *
 * Returns { jobId, mode, prompt }.
 */
export async function enqueueVisualImage(issueId, stageId, options = {}) {
  if (!VISUAL_STAGE_IDS.includes(stageId)) {
    throw new Error(`enqueueVisualImage: not a visual stage: ${stageId}`);
  }
  const [issue, settings] = await Promise.all([getIssue(issueId), getSettings()]);
  const series = await getSeries(issue.seriesId);

  const mode = SUPPORTED_MODES.has(options.mode) ? options.mode
    : (SUPPORTED_MODES.has(settings.imageGen?.mode) ? settings.imageGen.mode : 'local');

  const prompt = composeVisualPrompt({
    series,
    description: options.description,
    slugline: options.slugline,
    extraStyle: options.extraStyle,
  });
  if (!prompt) throw new Error('enqueueVisualImage: prompt is empty (no description, no style)');

  const baseParams = {
    prompt,
    negativePrompt: options.negativePrompt || undefined,
    width: options.width,
    height: options.height,
    steps: options.steps,
    guidance: options.guidance ?? options.cfgScale,
    cfgScale: options.cfgScale,
  };

  const owner = `pipeline:${issueId}:${stageId}`;

  if (mode === 'codex') {
    const c = settings.imageGen?.codex || {};
    const { jobId } = enqueueJob({
      kind: 'image',
      params: { mode: 'codex', codexPath: c.codexPath, model: c.model, ...baseParams },
      owner,
    });
    console.log(`🎬 Pipeline visual — issue=${issueId.slice(0, 8)} stage=${stageId} mode=codex jobId=${jobId.slice(0, 8)}`);
    return { jobId, mode, prompt };
  }

  // mode === 'local'
  const pythonPath = settings.imageGen?.local?.pythonPath || null;
  const { jobId } = enqueueJob({
    kind: 'image',
    params: { pythonPath, modelId: options.modelId, ...baseParams },
    owner,
  });
  console.log(`🎬 Pipeline visual — issue=${issueId.slice(0, 8)} stage=${stageId} mode=local jobId=${jobId.slice(0, 8)}`);
  return { jobId, mode, prompt };
}
