/**
 * Pipeline — Visual stage handoff helpers
 *
 * Responsibilities, in order of how they evolved:
 *
 * 1. **Image enqueue** (`enqueueVisualImage`, `enqueueVisualComicPage`) —
 *    build the right diffusion params for a comicPages panel / page or a
 *    storyboards scene and hand off to `mediaJobQueue`. The route layer
 *    persists the returned jobId into the issue's stage record.
 *
 * 2. **Single-scene video enqueue** (`enqueueStoryboardSceneVideo`) —
 *    render one storyboard scene as a t2v clip without committing to the
 *    full episode-video stitch. Persists `sceneVideoJobId` on the scene
 *    so a reload still surfaces the in-flight render.
 *
 * 3. **LLM-driven prompt refinement** (`refineComicPanelPrompt`,
 *    `refineStoryboardScenePrompt`) — elaborate a panel/scene description
 *    into a richer image-gen prompt via `runStagedLLM`, then persist the
 *    refined text back on the source record. Shared `runPromptRefine`
 *    helper + slim `loadRefineContext` keep the two surfaces DRY.
 *
 * Full episode-video stitching still lives in `episodeVideo.js` — that
 * path drives the Creative Director scene runner end-to-end.
 */

import { enqueueJob } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import { getSeries } from './series.js';
import { getIssue, updateStage, VISUAL_STAGE_IDS } from './issues.js';
import { getWorld } from '../worldBuilder.js';
import { ServerError } from '../../lib/errorHandler.js';
import { buildScenePrompt, buildSettingByKey, matchSceneSetting } from '../../lib/scenePrompt.js';
import { composeStyledPrompt } from '../../lib/composeStyledPrompt.js';
import { getDefaultVideoModelId, getVideoModels } from '../../lib/mediaModels.js';
import { runStagedLLM } from '../../lib/stageRunner.js';
import { ASPECT_PRESETS } from '../../lib/creativeDirectorPresets.js';

const SUPPORTED_MODES = new Set(['local', 'codex']);

const stackStyle = (series, extraStyle) =>
  [series?.styleNotes, extraStyle].map((s) => (s || '').trim()).filter(Boolean).join(', ');

const applyWorldStyle = (prompt, world) => {
  if (!world) return prompt;
  return composeStyledPrompt(prompt, '', { prompt: world.stylePrompt, negativePrompt: '' }).prompt;
};

const resolveMode = (options, settings) => {
  if (SUPPORTED_MODES.has(options.mode)) return options.mode;
  const settingsMode = settings?.imageGen?.mode;
  return SUPPORTED_MODES.has(settingsMode) ? settingsMode : 'local';
};

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
  // Merge user + world negatives — mirrors composeStyledPrompt's preset
  // negative handling so the world's global negative-prompt terms stay in
  // effect even when the caller supplies their own additions. Deduplicated
  // by token so a user repeating a world negative doesn't double-weight it.
  const userNeg = (options.negativePrompt || '').trim();
  const worldNeg = (world?.negativePrompt || '').trim();
  const negativeTokens = [userNeg, worldNeg]
    .flatMap((s) => s.split(',').map((t) => t.trim()).filter(Boolean));
  const negativePrompt = [...new Set(negativeTokens)].join(', ') || undefined;
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

  // Append a sentence-terminator unless the source text already ends in one —
  // prose extracted from a script often carries its own `.`, `!`, or `?`, and
  // double-punctuating like "...sunstreaming in.." is noisy in prompts. The
  // optional trailing `"` covers the dialogue/caption case where we wrap the
  // text in quotes — `KESSA: "...away."` should NOT become `KESSA: "...away.".`.
  const endPunct = (s) => /[.!?]"?$/.test(s) ? s : `${s}.`;

  const panelLines = panels.map((p, i) => {
    const idx = i + 1;
    const desc = (p.description || '').trim() || 'continuation of previous beat';
    const parts = [`Panel ${idx}: ${endPunct(desc)}`];
    if (p.caption && p.caption.trim()) parts.push(`Caption: "${endPunct(p.caption.trim())}"`);
    if (Array.isArray(p.dialogue) && p.dialogue.length > 0) {
      // Trim first so whitespace-only character / line fields don't pass the
      // truthy guard and emit malformed `: ""` entries. Drop dialogue rows
      // whose line is empty — they have nothing for the artist to render.
      const dlg = p.dialogue
        .map((d) => {
          const character = (d.character || '').trim() || 'CHAR';
          const line = (d.line || '').trim();
          return line ? `${character}: "${line}"` : null;
        })
        .filter(Boolean)
        .join(' / ');
      if (dlg) parts.push(`Dialogue: ${endPunct(dlg)}`);
    }
    if (p.sfx && p.sfx.trim()) parts.push(`SFX: ${endPunct(p.sfx.trim())}`);
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
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const { issue, settings, series, world } = await loadBibleContext(issueId);
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? issue.stages.comicPages.pages : [];
  const page = pages[pageIndex];
  if (!page) {
    throw new ServerError(`page index ${pageIndex} out of range (have ${pages.length})`, {
      status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND',
    });
  }
  if (!Array.isArray(page.panels) || page.panels.length === 0) {
    throw new ServerError('page has no panels — add at least one panel description before rendering', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_NO_PANELS',
    });
  }

  const mode = resolveMode(options, settings);
  // composeComicPagePrompt only returns '' when panels.length === 0, which is
  // already rejected above. The "(continuation of previous beat)" placeholder
  // covers panels with no description, so the prompt is non-empty by here.
  const prompt = composeComicPagePrompt({
    series, world, page, pageNumber: pageIndex + 1, extraStyle: options.extraStyle,
  });

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
    throw new ServerError(`not a visual stage: ${stageId}`, {
      status: 400, code: 'PIPELINE_VISUAL_BAD_STAGE',
    });
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
  if (!prompt) {
    throw new ServerError('visual prompt is empty (no description, no style)', {
      status: 400, code: 'PIPELINE_VISUAL_EMPTY_PROMPT',
    });
  }

  const jobId = enqueueImageJob({
    prompt, world, settings, options, mode,
    owner: `pipeline:${issueId}:${stageId}`,
    logLine: `🎬 Pipeline visual — issue=${issueId.slice(0, 8)} stage=${stageId}`,
  });
  return { jobId, mode, prompt };
}

/**
 * Enqueue a single-scene video render for a storyboard scene. Builds the
 * same prompt the episode-video CD treatment would build for this scene
 * (composeVisualPrompt with style notes + world style), then enqueues a
 * video job through the shared mediaJobQueue.
 *
 * Persists the resulting jobId on `stages.storyboards.scenes[index]
 * .sceneVideoJobId` so the UI can reflect it on reload.
 *
 * Returns { jobId, prompt, sceneIndex }.
 */
export async function enqueueStoryboardSceneVideo(issueId, sceneIndex, options = {}) {
  const idx = Number(sceneIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new ServerError('sceneIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_SCENE_BAD_INDEX',
    });
  }
  const { issue, settings, series, world } = await loadBibleContext(issueId);
  const pythonPath = settings.imageGen?.local?.pythonPath || null;
  if (!pythonPath) {
    throw new ServerError(
      'Local video generation is not configured (settings.imageGen.local.pythonPath is missing).',
      { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' },
    );
  }
  const scenes = Array.isArray(issue.stages?.storyboards?.scenes)
    ? [...issue.stages.storyboards.scenes]
    : [];
  const scene = scenes[idx];
  if (!scene) {
    throw new ServerError(`sceneIndex ${idx} out of range (have ${scenes.length})`, {
      status: 404, code: 'PIPELINE_SCENE_NOT_FOUND',
    });
  }
  if (!(scene.description || '').trim()) {
    throw new ServerError('scene has no description — add a description before rendering', {
      status: 400, code: 'PIPELINE_SCENE_EMPTY_DESCRIPTION',
    });
  }

  const prompt = composeVisualPrompt({
    series,
    description: scene.description,
    slugline: scene.slugline || '',
    extraStyle: options.extraStyle,
    world,
  });

  const aspectRatio = ASPECT_PRESETS[options.aspectRatio] ? options.aspectRatio : '16:9';
  const { width, height } = ASPECT_PRESETS[aspectRatio];
  const modelId = options.modelId || settings.videoGen?.defaultModelId || getDefaultVideoModelId();
  // Validate the model exists for this platform before enqueueing — otherwise
  // the worker will fail with "Unknown video model" and leave a persisted
  // doomed entry in the queue. Mirrors the same fail-fast pattern as
  // /api/video-gen's route validation.
  if (!getVideoModels().some((m) => m.id === modelId)) {
    throw new ServerError(`Unknown video model "${modelId}"`, {
      status: 400, code: 'PIPELINE_UNKNOWN_VIDEO_MODEL',
    });
  }
  const negativePrompt = options.negativePrompt || 'text, watermark, blur, motion blur, low quality';

  const { jobId } = enqueueJob({
    kind: 'video',
    params: {
      pythonPath,
      prompt,
      negativePrompt,
      modelId,
      width,
      height,
      mode: 't2v',
      disableAudio: true,
      tiling: 'auto',
      chunks: 1,
    },
    owner: `pipeline:${issueId}:storyboards:scene${idx}`,
  });

  scenes[idx] = { ...scene, sceneVideoJobId: jobId };
  const { issue: updatedIssue, stage } = await updateStage(issueId, 'storyboards', {
    status: 'edited',
    scenes,
  });
  console.log(`🎥 Pipeline scene video — issue=${issueId.slice(0, 8)} scene=${idx + 1} jobId=${jobId.slice(0, 8)}`);
  return { jobId, prompt, sceneIndex: idx, issue: updatedIssue, stage };
}

const seriesBibleCtx = (series) => ({
  name: series.name || '',
  styleNotes: series.styleNotes || '',
  logline: series.logline || '',
  premise: series.premise || '',
});

const issueCtx = (issue) => ({ number: issue.number || 0, title: issue.title || '' });

const neighborText = (item) => (item?.description || '').trim().slice(0, 240) || '(empty)';

// Refine path needs issue + series only — skip the settings + world reads
// that loadBibleContext does for the image/video enqueue path.
async function loadRefineContext(issueId) {
  const issue = await getIssue(issueId);
  const series = await getSeries(issue.seriesId);
  return { issue, series };
}

// Shared scaffolding for both the comic-panel and storyboard-scene refine
// paths. The caller supplies the per-stage variables/persist details; this
// helper owns the runStagedLLM call + result parsing + empty-prompt guard +
// changes shaping.
async function runPromptRefine({ templateName, variables, options, source, logTag }) {
  const result = await runStagedLLM(templateName, variables, {
    providerOverride: options.providerId,
    modelOverride: options.model,
    returnsJson: true,
    source,
  });
  const refined = (result.content?.prompt || '').trim();
  if (!refined) {
    throw new ServerError('LLM returned an empty refined prompt', {
      status: 502, code: 'PIPELINE_PROMPT_REFINE_EMPTY',
    });
  }
  const changes = Array.isArray(result.content?.changes)
    ? result.content.changes.map((c) => String(c).slice(0, 240)).filter(Boolean).slice(0, 8)
    : [];
  console.log(`✨ ${logTag} runId=${(result.runId || '').slice(0, 8)}`);
  return { refined, changes, runId: result.runId, providerId: result.providerId };
}

/**
 * Run the `pipeline-comic-panel-image-prompt` template against the current
 * panel + surrounding context, then persist the refined description on the
 * panel. Returns { panel, page, issue, stage, runId, changes, providerId }.
 */
export async function refineComicPanelPrompt(issueId, pageIndex, panelIndex, options = {}) {
  const pi = Number(pageIndex);
  const ni = Number(panelIndex);
  if (!Number.isInteger(pi) || pi < 0 || !Number.isInteger(ni) || ni < 0) {
    throw new ServerError('pageIndex and panelIndex must be non-negative integers', {
      status: 400, code: 'PIPELINE_PANEL_BAD_INDEX',
    });
  }
  const { issue, series } = await loadRefineContext(issueId);
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? [...issue.stages.comicPages.pages] : [];
  const page = pages[pi];
  if (!page) {
    throw new ServerError(`pageIndex ${pi} out of range (have ${pages.length})`, {
      status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND',
    });
  }
  const panels = Array.isArray(page.panels) ? [...page.panels] : [];
  const panel = panels[ni];
  if (!panel) {
    throw new ServerError(`panelIndex ${ni} out of range (have ${panels.length})`, {
      status: 404, code: 'PIPELINE_COMIC_PANEL_NOT_FOUND',
    });
  }
  if (!(panel.description || '').trim()) {
    throw new ServerError('panel has no description to refine', {
      status: 400, code: 'PIPELINE_PANEL_EMPTY_DESCRIPTION',
    });
  }

  const prev = panels[ni - 1];
  const next = panels[ni + 1];
  const dialogue = Array.isArray(panel.dialogue) && panel.dialogue.length
    ? panel.dialogue.map((d) => `${(d.character || 'CHAR')}: "${(d.line || '').trim()}"`).join(' / ')
    : '';

  const { refined, changes, runId, providerId } = await runPromptRefine({
    templateName: 'pipeline-comic-panel-image-prompt',
    variables: {
      series: seriesBibleCtx(series),
      issue: issueCtx(issue),
      pageNumber: pi + 1,
      panelNumber: ni + 1,
      panelCount: panels.length,
      description: (panel.description || '').slice(0, 4000),
      caption: (panel.caption || '').slice(0, 1000),
      hasCaption: !!(panel.caption || '').trim(),
      dialogue,
      hasDialogue: !!dialogue,
      sfx: (panel.sfx || '').slice(0, 500),
      hasSfx: !!(panel.sfx || '').trim(),
      hasNeighbors: !!(prev || next),
      previousPanel: neighborText(prev),
      nextPanel: neighborText(next),
    },
    options,
    source: 'pipeline-comic-panel-prompt-refine',
    logTag: `Pipeline comic panel refine — issue=${issueId.slice(0, 8)} p=${pi + 1} panel=${ni + 1}`,
  });

  panels[ni] = { ...panel, description: refined };
  pages[pi] = { ...page, panels };
  const { issue: updatedIssue, stage } = await updateStage(issueId, 'comicPages', {
    status: 'edited',
    pages,
  });
  return { panel: panels[ni], page: pages[pi], issue: updatedIssue, stage, runId, changes, providerId };
}

/**
 * Run the `pipeline-storyboard-image-prompt` template against the current
 * storyboard scene + surrounding context, then persist the refined
 * description on the scene. Returns { scene, issue, stage, runId, changes, providerId }.
 */
export async function refineStoryboardScenePrompt(issueId, sceneIndex, options = {}) {
  const idx = Number(sceneIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new ServerError('sceneIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_SCENE_BAD_INDEX',
    });
  }
  const { issue, series } = await loadRefineContext(issueId);
  const scenes = Array.isArray(issue.stages?.storyboards?.scenes)
    ? [...issue.stages.storyboards.scenes]
    : [];
  const scene = scenes[idx];
  if (!scene) {
    throw new ServerError(`sceneIndex ${idx} out of range (have ${scenes.length})`, {
      status: 404, code: 'PIPELINE_SCENE_NOT_FOUND',
    });
  }
  if (!(scene.description || '').trim()) {
    throw new ServerError('scene has no description to refine', {
      status: 400, code: 'PIPELINE_SCENE_EMPTY_DESCRIPTION',
    });
  }

  const prev = scenes[idx - 1];
  const next = scenes[idx + 1];

  const { refined, changes, runId, providerId } = await runPromptRefine({
    templateName: 'pipeline-storyboard-image-prompt',
    variables: {
      series: seriesBibleCtx(series),
      issue: issueCtx(issue),
      sceneNumber: idx + 1,
      sceneCount: scenes.length,
      slugline: (scene.slugline || '').slice(0, 200),
      hasSlugline: !!(scene.slugline || '').trim(),
      description: (scene.description || '').slice(0, 4000),
      hasNeighbors: !!(prev || next),
      previousScene: neighborText(prev),
      nextScene: neighborText(next),
    },
    options,
    source: 'pipeline-storyboard-prompt-refine',
    logTag: `Pipeline scene refine — issue=${issueId.slice(0, 8)} scene=${idx + 1}`,
  });

  scenes[idx] = { ...scene, description: refined };
  const { issue: updatedIssue, stage } = await updateStage(issueId, 'storyboards', {
    status: 'edited',
    scenes,
  });
  return { scene: scenes[idx], issue: updatedIssue, stage, runId, changes, providerId };
}
