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

const SUPPORTED_MODES = new Set(['local', 'codex']);

/**
 * Build an image-gen prompt for a pipeline visual element by combining a
 * caller-supplied scene/panel description with the series' style notes.
 * Keeps the style fragment short — the description provides the subject.
 */
export function composeVisualPrompt({ series, description, extraStyle = '' }) {
  const style = [series?.styleNotes, extraStyle].map((s) => (s || '').trim()).filter(Boolean).join(', ');
  const subject = (description || '').trim();
  return [style, subject].filter(Boolean).join(', ');
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
  const issue = await getIssue(issueId);
  const series = await getSeries(issue.seriesId);
  const settings = await getSettings();

  const mode = SUPPORTED_MODES.has(options.mode) ? options.mode
    : (SUPPORTED_MODES.has(settings.imageGen?.mode) ? settings.imageGen.mode : 'local');

  const prompt = composeVisualPrompt({
    series,
    description: options.description,
    extraStyle: options.extraStyle || '',
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
