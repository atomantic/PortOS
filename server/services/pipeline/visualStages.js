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
import { getWorld } from '../worldBuilder.js';
import { buildScenePrompt, buildSettingByKey, matchSceneSetting } from '../../lib/scenePrompt.js';
import { composeStyledPrompt } from '../../lib/composeStyledPrompt.js';

const SUPPORTED_MODES = new Set(['local', 'codex']);

const stackStyle = (series, extraStyle) =>
  [series?.styleNotes, extraStyle].map((s) => (s || '').trim()).filter(Boolean).join(', ');

const applyWorldStyle = (prompt, world) => {
  if (!world) return prompt;
  return composeStyledPrompt(prompt, '', { prompt: world.stylePrompt, negativePrompt: '' }).prompt;
};

const resolveMode = (options, settings) =>
  SUPPORTED_MODES.has(options.mode) ? options.mode
    : (SUPPORTED_MODES.has(settings.imageGen?.mode) ? settings.imageGen.mode : 'local');

const loadBibleContext = async (issueId) => {
  const issueChain = (async () => {
    const issue = await getIssue(issueId);
    const series = await getSeries(issue.seriesId);
    const world = series.worldId ? await getWorld(series.worldId).catch(() => null) : null;
    return { issue, series, world };
  })();
  const [chain, settings] = await Promise.all([issueChain, getSettings()]);
  return { ...chain, settings };
};

const enqueueImageJob = ({ prompt, world, settings, options, mode, owner, logLine }) => {
  const negativePrompt = (options.negativePrompt || '').trim()
    || (world?.negativePrompt || '').trim()
    || undefined;
  const baseParams = {
    prompt,
    negativePrompt,
    width: options.width,
    height: options.height,
    steps: options.steps,
    guidance: options.guidance ?? options.cfgScale,
    cfgScale: options.cfgScale,
  };
  const params = mode === 'codex'
    ? { mode: 'codex', codexPath: settings.imageGen?.codex?.codexPath, model: settings.imageGen?.codex?.model, ...baseParams }
    : { pythonPath: settings.imageGen?.local?.pythonPath || null, modelId: options.modelId, ...baseParams };
  const { jobId } = enqueueJob({ kind: 'image', params, owner });
  console.log(`${logLine} mode=${mode} jobId=${jobId.slice(0, 8)}`);
  return jobId;
};

export function composeVisualPrompt({ series, description, slugline = '', extraStyle = '', settingByKey = null, matchedCharacters = [], world = null }) {
  const map = settingByKey || buildSettingByKey(series?.settings);
  const scenePrompt = buildScenePrompt(
    series?.name || '',
    { visualPrompt: description || '', slugline },
    matchedCharacters,
    stackStyle(series, extraStyle),
    matchSceneSetting(slugline, map),
  );
  return applyWorldStyle(scenePrompt, world);
}

export function composeComicPagePrompt({ series, world, page, pageNumber, extraStyle = '' }) {
  const panels = Array.isArray(page?.panels) ? page.panels : [];
  if (panels.length === 0) return '';

  const panelLines = panels.map((p, i) => {
    const idx = i + 1;
    const parts = [`Panel ${idx}: ${(p.description || '').trim() || 'continuation of previous beat'}.`];
    if (p.caption && p.caption.trim()) parts.push(`Caption: "${p.caption.trim()}".`);
    if (Array.isArray(p.dialogue) && p.dialogue.length > 0) {
      const dlg = p.dialogue
        .map((d) => `${(d.character || 'CHAR').trim()}: "${(d.line || '').trim()}"`)
        .filter((s) => s.includes(':'))
        .join(' / ');
      if (dlg) parts.push(`Dialogue: ${dlg}.`);
    }
    if (p.sfx && p.sfx.trim()) parts.push(`SFX: ${p.sfx.trim()}.`);
    return parts.join(' ');
  });

  const styleStack = stackStyle(series, extraStyle);
  const styleClause = styleStack ? ` Art style: ${styleStack}.` : '';
  const seriesClause = series?.name ? ` from the series "${series.name}"` : '';

  const layout = `A single full printable comic book page${seriesClause}, page ${pageNumber}. Render a balanced multi-panel comic page layout with ${panels.length} clearly bordered panel${panels.length === 1 ? '' : 's'} arranged for left-to-right, top-to-bottom reading. Include lettered speech balloons for dialogue, rectangular narration captions, and stylized SFX where indicated. Each panel must be visually distinct, with consistent character designs across panels.${styleClause}`;

  return applyWorldStyle(`${layout}\n\n${panelLines.join('\n\n')}`, world);
}

/**
 * Enqueue a full-comic-page image render. Builds a structured page-level
 * prompt from `issue.stages.comicPages.pages[pageIndex].panels[]` and hands
 * it to the image-gen queue. Caller records the returned jobId on
 * `pages[pageIndex].imageJobId`.
 *
 * Returns { jobId, mode, prompt, pageIndex }.
 */
export async function enqueueVisualComicPage(issueId, options = {}) {
  const pageIndex = Number(options.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error('enqueueVisualComicPage: pageIndex must be a non-negative integer');
  }
  const { issue, settings, series, world } = await loadBibleContext(issueId);
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? issue.stages.comicPages.pages : [];
  const page = pages[pageIndex];
  if (!page) throw new Error(`enqueueVisualComicPage: page index ${pageIndex} out of range (have ${pages.length})`);
  if (!Array.isArray(page.panels) || page.panels.length === 0) {
    throw new Error('enqueueVisualComicPage: page has no panels');
  }

  const mode = resolveMode(options, settings);
  const prompt = composeComicPagePrompt({
    series, world, page, pageNumber: pageIndex + 1, extraStyle: options.extraStyle,
  });
  if (!prompt) throw new Error('enqueueVisualComicPage: prompt is empty');

  const jobId = enqueueImageJob({
    prompt, world, settings, options, mode,
    owner: `pipeline:${issueId}:comicPages:page${pageIndex}`,
    logLine: `📄 Pipeline comic page — issue=${issueId.slice(0, 8)} page=${pageIndex + 1} panels=${page.panels.length}`,
  });
  return { jobId, mode, prompt, pageIndex };
}

/**
 * Enqueue one image render for a pipeline issue's visual stage. The caller
 * records the returned jobId on the issue's stage artifact list
 * (e.g. stages.comicPages.pages[i].panels[j].imageJobId).
 *
 * Returns { jobId, mode, prompt }.
 */
export async function enqueueVisualImage(issueId, stageId, options = {}) {
  if (!VISUAL_STAGE_IDS.includes(stageId)) {
    throw new Error(`enqueueVisualImage: not a visual stage: ${stageId}`);
  }
  const { settings, series, world } = await loadBibleContext(issueId);
  const mode = resolveMode(options, settings);
  const prompt = composeVisualPrompt({
    series,
    description: options.description,
    slugline: options.slugline,
    extraStyle: options.extraStyle,
    world,
  });
  if (!prompt) throw new Error('enqueueVisualImage: prompt is empty (no description, no style)');

  const jobId = enqueueImageJob({
    prompt, world, settings, options, mode,
    owner: `pipeline:${issueId}:${stageId}`,
    logLine: `🎬 Pipeline visual — issue=${issueId.slice(0, 8)} stage=${stageId}`,
  });
  return { jobId, mode, prompt };
}
