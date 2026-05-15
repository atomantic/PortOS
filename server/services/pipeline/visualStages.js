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
import { getUniverse } from '../universeBuilder.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  buildScenePrompt, buildSettingByKey, matchSceneSetting,
  buildCharByKey, matchSceneCharacters, matchCharactersInText,
  matchSettingsInText, matchObjectsInText,
} from '../../lib/scenePrompt.js';
import { composeStyledPrompt } from '../../lib/composeStyledPrompt.js';
import { getDefaultVideoModelId, getVideoModels } from '../../lib/mediaModels.js';
import { runStagedLLM } from '../../lib/stageRunner.js';
import { runPromptRefine } from './refineHelpers.js';
import { resolveSeriesCanonSync } from './seriesCanon.js';
import { ASPECT_PRESETS } from '../../lib/creativeDirectorPresets.js';

const stackStyle = (series, extraStyle) =>
  [series?.styleNotes, extraStyle].map((s) => (s || '').trim()).filter(Boolean).join(', ');

const applyWorldStyle = (prompt, world) => {
  if (!world) return prompt;
  return composeStyledPrompt(prompt, '', { prompt: world.stylePrompt, negativePrompt: '' }).prompt;
};

// Resolution order for the image-gen mode on a pipeline visual stage:
//   1. Per-request override (`options.mode`) — set by the stage's persisted
//      `genConfig` or an explicit UI selection. Codex is only honored when
//      `imageGen.codex.enabled` is true; a stale 'codex' override from
//      before the toggle was turned off falls through to the next step.
//   2. Saved dispatcher default (`settings.imageGen.mode`) — but only when
//      it names a mode this surface supports (visual pipeline doesn't
//      proxy the external SD-API path) AND, for 'codex', Codex is enabled.
//   3. Auto-default — prefer Codex when the user has enabled it
//      (`imageGen.codex.enabled`), since cloud image gen produces
//      print-quality comic pages out of the box. Otherwise fall back to
//      local diffusion (flux-1) the way the original default behaved.
const resolveMode = (options, settings) => {
  const codexEnabled = settings?.imageGen?.codex?.enabled === true;
  if (options.mode === 'codex' && codexEnabled) return 'codex';
  if (options.mode === 'local') return 'local';
  const settingsMode = settings?.imageGen?.mode;
  if (settingsMode === 'codex' && codexEnabled) return 'codex';
  if (settingsMode === 'local') return 'local';
  if (codexEnabled) return 'codex';
  return 'local';
};

const loadBibleContext = async (issueId) => {
  const issueChain = (async () => {
    const issue = await getIssue(issueId);
    const series = await getSeries(issue.seriesId);
    const world = series.universeId ? await getUniverse(series.universeId).catch(() => null) : null;
    // Canon prefers the linked universe (Phase B) and falls back to the
    // series's own arrays so pre-migration data still renders correctly.
    const canon = resolveSeriesCanonSync(series, world);
    return { issue, series, world, canon };
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
    // Honored by local mflux + diffusers runners; codex picks its own.
    ...(Number.isFinite(options.seed) ? { seed: options.seed } : {}),
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

// Marvel/DC scripts attach parentheticals to speakers — `ETTA (EARPIECE):`,
// `KESSA (WHISPERED):`, `LINA (THOUGHT):`. These tell a human artist HOW to
// draw the balloon (jagged for transmitted voices, dashed for whispers,
// cloud-outline for thoughts), but a diffusion model treats them as more text
// to letter. Map them to visual balloon-style hints so the artist still gets
// the cue without the label leaking into the lettering.
const BALLOON_STYLE_HINTS = [
  { test: /\b(EARPIECE|RADIO|COMM|TRANSMISSION|PHONE|HOLO|HOLOGRAM|INTERCOM|SPEAKER|TV|MONITOR|VIDEO)\b/, hint: 'jagged electronic/transmission balloon with bolt-shaped tail' },
  { test: /\b(WHISPER(?:ED|S|ING)?|SOTTO|HUSHED|QUIET)\b/, hint: 'dashed-outline whisper balloon' },
  { test: /\b(SHOUT(?:ED|S|ING)?|YELL(?:ED|S|ING)?|SCREAM(?:ED|S|ING)?|ANGRY|BURST)\b/, hint: 'spiked/burst-shaped balloon' },
  { test: /\b(THOUGHT|THINKING|INTERNAL)\b/, hint: 'cloud-outline thought balloon with chain-of-bubbles tail' },
  { test: /\b(SING(?:S|ING)?|SONG|MUSICAL)\b/, hint: 'wavy musical balloon with musical-note flourish' },
  { test: /\b(OFF[\- ]?PANEL|OFF[\- ]?SCREEN|O\.?S\.?|O\.?P\.?)\b/, hint: 'off-panel balloon with tail pointing past the panel border' },
  { test: /\b(NARRATION|VOICE[\- ]?OVER|V\.?O\.?)\b/, hint: 'rectangular narration caption rather than a speech balloon' },
];

/**
 * Build one balloon attribution string: `Speech balloon reads: "<text>" (spoken
 * by NAME[, <style hint>]).` Leads with the lettered text so the diffusion
 * model anchors on the balloon's contents; parses any parenthetical modifier
 * on the speaker into a visual styling hint (radio, whisper, thought, etc.).
 * Returns null if `line` is blank — the caller filters those out.
 */
function formatBalloon(character, line) {
  const text = (line || '').trim();
  if (!text) return null;
  const raw = (character || '').trim() || 'CHAR';
  // Split `NAME (MODIFIER)` → speaker base + modifier text. Tolerate stacked
  // parens (`NAME (EARPIECE, WHISPERED)`) by treating the whole inner-paren
  // blob as one modifier string for hint detection.
  const m = raw.match(/^([^(]+?)\s*\(([^)]*)\)\s*$/);
  const speaker = (m ? m[1] : raw).trim() || 'CHAR';
  const modifier = m ? m[2].trim() : '';
  const cleanText = text.replace(/^"+|"+$/g, '').trim();
  const styleHint = modifier
    ? BALLOON_STYLE_HINTS.find((h) => h.test.test(modifier.toUpperCase()))?.hint
    : null;
  const attribution = styleHint
    ? `(spoken by ${speaker}; ${styleHint})`
    : `(spoken by ${speaker})`;
  // Terminator handled here so endPunct() at the call site doesn't have to
  // navigate the closing paren — we always end with `).`.
  return `Speech balloon reads: "${cleanText}" ${attribution}.`;
}

/**
 * Compose a comic-book front-cover prompt. The cover always renders the
 * series masthead (logo-style title) and the issue number tag in the
 * canonical top-of-cover position, plus the user's cover concept as the
 * scene content. Falls back to the issue title when the user has not
 * written a cover concept yet.
 *
 * Returns the full prompt string (with world style baked in when present).
 */
export function composeComicCoverPrompt({
  series, world, issue, coverScript = '', extraStyle = '',
}) {
  const seriesName = (series?.name || '').trim();
  const issueNumber = Number.isFinite(issue?.number) ? Math.max(1, Math.floor(issue.number)) : 1;
  const issueTitle = (issue?.title || '').trim();
  const concept = (coverScript || '').trim();

  const styleStack = stackStyle(series, extraStyle);
  const styleClause = styleStack ? ` Art style: ${styleStack}.` : '';

  // Title-block requirements get spelled out explicitly because cover-art
  // typography is the part image-gen models get most wrong on the first
  // pass — without a hard cue the model often emits panels instead of
  // a cover, or skips the issue-number tag.
  const titleBlock = seriesName
    ? `Render the series masthead "${seriesName}" as bold, large comic-book logo typography near the top of the cover.`
    : 'Render a bold comic-book series masthead as large logo typography near the top of the cover.';
  const numberBlock = `Include a clearly legible issue-number tag reading "#${issueNumber}" in the top-left corner — small but readable.`;
  const titleLine = issueTitle
    ? ` Include the issue title "${issueTitle}" as a secondary banner below the masthead.`
    : '';

  // Fall back to the issue title so a one-click render against a fresh cover
  // still produces something thematically on-target instead of a blank canvas.
  const sceneDescription = concept
    || (issueTitle ? `A single dramatic hero image evoking "${issueTitle}".` : 'A single dramatic hero image of the protagonist mid-action.');

  const layout = `A single full printable comic-book front cover for a serialized issue. ${titleBlock} ${numberBlock}${titleLine} The rest of the cover is one bold hero image (no panel borders, no multi-panel layout — this is the cover, not an interior page).${styleClause}`;
  const body = `Cover concept: ${sceneDescription}`;
  return applyWorldStyle(`${layout}\n\n${body}`, world);
}

/**
 * Enqueue a comic-issue front-cover image render. Builds a cover-art
 * prompt (series masthead + issue-number tag + user's cover concept) and
 * hands it to the image-gen queue. Caller records the returned jobId on
 * `stages.comicPages.cover.imageJobId`.
 *
 * Returns the resolved coverScript alongside { jobId, mode, prompt } so
 * the route can persist it without a second read of the issue file.
 */
export async function enqueueComicCover(issueId, options = {}) {
  const { issue, settings, series, world } = await loadBibleContext(issueId);
  const cover = issue.stages?.comicPages?.cover || null;
  const coverScript = typeof options.coverScript === 'string'
    ? options.coverScript
    : (cover?.script || '');
  const mode = resolveMode(options, settings);
  const prompt = composeComicCoverPrompt({
    series, world, issue, coverScript, extraStyle: options.extraStyle,
  });
  const jobId = enqueueImageJob({
    prompt, world, settings, options, mode,
    owner: `pipeline:${issueId}:comicPages:cover`,
    logLine: `🎨 Pipeline comic cover — issue=${issueId.slice(0, 8)} number=${issue.number || 1}`,
  });
  return { jobId, mode, prompt, coverScript };
}

export function composeComicPagePrompt({
  series, world, page, pageNumber, extraStyle = '',
  matchedCharacters = [], matchedSettings = [], matchedObjects = [],
}) {
  const panels = Array.isArray(page?.panels) ? page.panels : [];
  if (panels.length === 0) return '';

  // Placed AFTER the layout clause: diffusion models weight earlier tokens
  // more heavily, and the page-shape instruction has to claim that position.
  const featuring = (matchedCharacters || [])
    .map((c) => ({ name: c.name, desc: (c.physicalDescription || c.description || '').trim() }))
    .filter((c) => c.name && c.desc)
    .map((c) => `${c.name}: ${c.desc}`)
    .join('; ');

  // Setting baseline: pull description + palette + recurringDetails per matched
  // setting. Same pattern as buildScenePrompt's settingFrags, but multi-setting
  // (a single comic page can span more than one location).
  const settingsClause = (matchedSettings || [])
    .map((s) => {
      const parts = [s.name && `${s.name}:`, (s.description || '').trim()].filter(Boolean);
      const head = parts.join(' ');
      const tail = [
        s.palette ? `palette: ${s.palette.trim()}` : '',
        (s.recurringDetails || '').trim(),
      ].filter(Boolean).join('; ');
      return [head, tail].filter(Boolean).join('. ');
    })
    .filter(Boolean)
    .join(' | ');

  // Notable objects/props/vehicles cited in the prose. Keeps signature props
  // (e.g. "the brass key", "Wren's sloop") visually canonical across pages.
  const notable = (matchedObjects || [])
    .map((o) => ({ name: o.name, desc: (o.description || '').trim() }))
    .filter((o) => o.name && o.desc)
    .map((o) => `${o.name}: ${o.desc}`)
    .join('; ');

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
    if (p.caption && p.caption.trim()) parts.push(`Narration caption box reads: "${endPunct(p.caption.trim())}"`);
    if (Array.isArray(p.dialogue) && p.dialogue.length > 0) {
      // Format each dialogue line as `Speech balloon reads: "<text>" (spoken
      // by NAME[, balloon style: <hint>])`. Lettered content (the quoted
      // text) leads so the diffusion model anchors on it; speaker + style
      // hints trail as attribution. The previous `NAME (MODIFIER): "text"`
      // shape (Marvel/DC script convention) was being lettered verbatim
      // INTO balloons by the image model — including the speaker name and
      // parentheticals like "(EARPIECE)". Dropping speaker into the
      // attribution slot and translating common parentheticals to balloon
      // styling hints (jagged for radio/earpiece, dashed for whisper, cloud
      // for thought) preserves the artistic intent without leaking labels
      // into the lettered text.
      const dlg = p.dialogue
        .map((d) => formatBalloon(d.character, d.line))
        .filter(Boolean)
        .join(' ');
      if (dlg) parts.push(dlg);
    }
    if (p.sfx && p.sfx.trim()) parts.push(`SFX lettering: ${endPunct(p.sfx.trim())}`);
    return parts.join(' ');
  });

  const styleStack = stackStyle(series, extraStyle);
  const styleClause = styleStack ? ` Art style: ${styleStack}.` : '';
  const seriesClause = series?.name ? ` from the series "${series.name}"` : '';

  const layout = `A single full printable comic book page${seriesClause}, page ${pageNumber}. Render a balanced multi-panel comic page layout with ${panels.length} clearly bordered panel${panels.length === 1 ? '' : 's'} arranged for left-to-right, top-to-bottom reading. Include lettered speech balloons for dialogue, rectangular narration boxes for captions, and stylized SFX where indicated. **Balloon lettering rule: each speech balloon contains ONLY the quoted text shown after "Speech balloon reads:". NEVER letter the speaker's name, role, or any parenthetical attribution (e.g. "(EARPIECE)", "(WHISPERED)", "(OFF-PANEL)") inside the balloon — those are tail-direction and balloon-styling cues for the artist, not lettered content.** Each panel must be visually distinct, with consistent character designs across panels.${styleClause}`;
  const featuringClause = featuring ? `\n\nFeaturing — ${featuring}` : '';
  const settingClause = settingsClause ? `\n\nSetting — ${settingsClause}` : '';
  const notableClause = notable ? `\n\nNotable — ${notable}` : '';

  return applyWorldStyle(`${layout}${featuringClause}${settingClause}${notableClause}\n\n${panelLines.join('\n\n')}`, world);
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
  const { issue, settings, series, world, canon } = await loadBibleContext(issueId);
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

  // Build a free-text haystack from every panel's prose (description +
  // caption + sfx). Dialogue lines feed character matching via CAPS names
  // separately because the parser already structures them.
  const proseHaystack = page.panels
    .flatMap((p) => [p.description, p.caption, p.sfx])
    .filter(Boolean)
    .join('\n');
  const dialogueNames = page.panels.flatMap((p) =>
    (p.dialogue || []).map((d) => d.character).filter(Boolean),
  );

  // Characters: union of (a) dialogue CAPS speakers and (b) anyone named in
  // panel prose. Deduplicates on id/name inside the matchers. Canon is read
  // from `canon` (Phase B helper) which prefers the linked universe and
  // falls back to series arrays for pre-migration data.
  const charByKey = buildCharByKey(canon.characters);
  const fromDialogue = matchSceneCharacters(dialogueNames, charByKey);
  const fromProse = matchCharactersInText(proseHaystack, canon.characters);
  const seenCharKeys = new Set();
  const matchedCharacters = [...fromDialogue, ...fromProse].filter((c) => {
    const k = c.id || c.name;
    if (seenCharKeys.has(k)) return false;
    seenCharKeys.add(k);
    return true;
  });

  // Settings + objects: text-match against the panel prose. Codex can't take
  // reference images, so rich text descriptions in the prompt are how we
  // keep environments and signature props visually consistent page-to-page.
  const matchedSettings = matchSettingsInText(proseHaystack, canon.settings);
  const matchedObjects = matchObjectsInText(proseHaystack, canon.objects);

  // composeComicPagePrompt only returns '' when panels.length === 0, which is
  // already rejected above. The "(continuation of previous beat)" placeholder
  // covers panels with no description, so the prompt is non-empty by here.
  const prompt = composeComicPagePrompt({
    series, world, page, pageNumber: pageIndex + 1, extraStyle: options.extraStyle,
    matchedCharacters, matchedSettings, matchedObjects,
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
  const { settings, series, world, canon } = await loadBibleContext(issueId);
  const mode = resolveMode(options, settings);
  const matchedCharacters = matchCharactersInText(options.description || '', canon.characters);
  const prompt = composeVisualPrompt({
    series,
    description: options.description,
    slugline: options.slugline,
    extraStyle: options.extraStyle,
    matchedCharacters,
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
  const { issue, settings, series, world, canon } = await loadBibleContext(issueId);
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

  const matchedCharacters = matchCharactersInText(
    `${scene.description || ''} ${scene.slugline || ''}`,
    canon.characters,
  );
  const prompt = composeVisualPrompt({
    series,
    description: scene.description,
    slugline: scene.slugline || '',
    extraStyle: options.extraStyle,
    matchedCharacters,
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
  // Drop dialogue rows whose line is empty/whitespace — matches the same
  // filter `composeComicPagePrompt` applies, so the refine template doesn't
  // get fed noisy `CHAR: ""` fragments that would confuse the LLM.
  const dialogue = Array.isArray(panel.dialogue) && panel.dialogue.length
    ? panel.dialogue
      .map((d) => {
        const character = (d.character || 'CHAR').trim() || 'CHAR';
        const line = (d.line || '').trim();
        return line ? `${character}: "${line}"` : null;
      })
      .filter(Boolean)
      .join(' / ')
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
