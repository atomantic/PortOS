/**
 * Pipeline — Comic + volume cover renders (#2531)
 *
 * Front/back covers for issues and volumes (seasons): prompt composers,
 * enqueue helpers, and the enqueue+persist entry points behind the route and
 * the CDO orchestrator. Extracted from the former monolithic `visualStages.js`;
 * shares style/prompt/enqueue plumbing via `./visualStageHelpers.js`.
 */

import { getSettings } from '../settings.js';
import { getSeries, updateSeasonOnSeries } from './series.js';
import { getUniverse } from '../universeBuilder.js';
import { ServerError } from '../../lib/errorHandler.js';
import { assertStageUnlocked, updateStageWithLatest } from './issues.js';
import { buildComicPagesOwner, buildSeasonCoverOwner, slotKeyForVariant } from './owners.js';
import {
  stackStyle, buildMastheadClause, buildAuthorClause, applyWorldStyle,
  loadBibleContext, resolveMode, resolveVariant, resolveProofInitImage,
  PROOF_AS_BASE_DEFAULT_STRENGTH, enqueueImageJob, buildRenderSlot,
} from './visualStageHelpers.js';

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
  const issueNumber = Number.isFinite(issue?.number) ? Math.max(1, Math.floor(issue.number)) : 1;
  const issueTitle = (issue?.title || '').trim();
  const concept = (coverScript || '').trim();

  const styleStack = stackStyle(series, extraStyle);
  const styleClause = styleStack ? ` Art style: ${styleStack}.` : '';

  // Title-block requirements get spelled out explicitly because cover-art
  // typography is the part image-gen models get most wrong on the first
  // pass — without a hard cue the model often emits panels instead of
  // a cover, or skips the issue-number tag.
  const titleBlock = buildMastheadClause(series);
  const numberBlock = `Include a clearly legible issue-number tag reading "#${issueNumber}" in the top-left corner — small but readable.`;
  const titleLine = issueTitle
    ? ` Include the issue title "${issueTitle}" as a secondary banner below the masthead.`
    : '';
  const authorLine = buildAuthorClause(series);

  // Fall back to the issue title so a one-click render against a fresh cover
  // still produces something thematically on-target instead of a blank canvas.
  const sceneDescription = concept
    || (issueTitle ? `A single dramatic hero image evoking "${issueTitle}".` : 'A single dramatic hero image of the protagonist mid-action.');

  const layout = `A single full printable comic-book front cover for a serialized issue. ${titleBlock} ${numberBlock}${titleLine}${authorLine} The rest of the cover is one bold hero image (no panel borders, no multi-panel layout — this is the cover, not an interior page).${styleClause}`;
  const body = `Cover concept: ${sceneDescription}`;
  return applyWorldStyle(`${layout}\n\n${body}`, world, series);
}

/**
 * Compose a TV episode title-screen prompt. Reuses the same masthead/logo
 * cue the comic covers do — `series.titleLogo` describes the letterform +
 * finish, the series name is lettered verbatim, and `series.author` lands as
 * a small byline. The episode's number + title appear as secondary
 * typography so the screen identifies the specific episode, not just the
 * series. Returns the full prompt with world style baked in when present.
 *
 * Caller decides where to render the result — there is no auto-prepend into
 * the episode video pipeline today. Future title-card stages can call this
 * directly; for now it is the single source of truth for "what should the TV
 * title card for this episode look like."
 */
export function composeTitleScreenPrompt({
  series, world, issue, extraStyle = '',
}) {
  const seriesName = (series?.name || '').trim();
  const issueNumber = Number.isFinite(issue?.number) ? Math.max(1, Math.floor(issue.number)) : null;
  const issueTitle = (issue?.title || '').trim();

  const styleStack = stackStyle(series, extraStyle);
  const styleClause = styleStack ? ` Art style: ${styleStack}.` : '';

  const titleBlock = buildMastheadClause(series);
  const numberLine = issueNumber
    ? ` Render an "EPISODE ${issueNumber}" tag in restrained smaller typography, positioned above the masthead.`
    : '';
  const titleLine = issueTitle
    ? ` Render the episode title "${issueTitle}" as a secondary banner below the masthead in a complementary but lighter weight.`
    : '';
  const authorLine = buildAuthorClause(series);

  const layout = `A single TV episode title screen — a static title card meant to hold on-screen for a few seconds, NOT a story panel. Centered hero typography, generous negative space, cinematic 16:9 framing. ${titleBlock}${numberLine}${titleLine}${authorLine} Subtle background imagery only — atmospheric texture, signature color of the universe, no characters, no narrative scene.${styleClause}`;
  return applyWorldStyle(layout, world, series);
}

/**
 * Compose a comic-book BACK-cover prompt. Distinguishing constraints vs.
 * front cover: no masthead, no issue-number tag, no title banner — back
 * covers are pure illustration in this app. The negative clause forbids
 * typography explicitly because diffusion models default to "helpfully"
 * re-adding logos/UPC blocks/credits typography when the canvas reads as
 * a comic back cover.
 *
 * Returns the full prompt string (with world style baked in when present).
 */
export function composeComicBackCoverPrompt({
  series, world, issue, backCoverScript = '', extraStyle = '',
}) {
  const issueTitle = (issue?.title || '').trim();
  const concept = (backCoverScript || '').trim();

  const styleStack = stackStyle(series, extraStyle);
  const styleClause = styleStack ? ` Art style: ${styleStack}.` : '';

  // Fallback when the user hasn't written a back-cover script yet — keep
  // it thematically on-target so a one-click render still produces
  // something meaningful instead of a blank canvas.
  const sceneDescription = concept
    || (issueTitle ? `A quiet companion image evoking "${issueTitle}" — atmospheric, single subject.` : 'A quiet companion image — atmospheric, single subject.');

  const layout = `A single full printable comic-book BACK cover for a serialized issue. NO text of any kind — no masthead, no logo, no title, no issue-number tag, no UPC, no credits, no typography, no captions, no panel borders, no multi-panel layout. The entire cover is one bold illustrated hero image, edge-to-edge.${styleClause}`;
  const body = `Back-cover concept: ${sceneDescription}`;
  return applyWorldStyle(`${layout}\n\n${body}`, world, series);
}

/**
 * Shared enqueue path for issue covers and back covers — front/back share
 * 95% of the plumbing (variant resolution, proof-as-base init image,
 * owner + job + log). Only the script-field name, slot location on the
 * stage, and prompt composer differ; those are passed in by the caller.
 *
 * Returns { jobId, mode, prompt, script, variant, fromProof } — the
 * `script` field is the resolved text (option override or persisted),
 * named neutrally because the caller knows whether it's a coverScript or
 * a backCoverScript.
 */
async function enqueueComicCoverLike(issueId, target, options = {}) {
  if (target !== 'cover' && target !== 'backCover') {
    throw new Error(`enqueueComicCoverLike: unknown target "${target}"`);
  }
  const { issue, settings, series, world } = await loadBibleContext(issueId);
  assertStageUnlocked(issue, 'comicPages');
  const record = issue.stages?.comicPages?.[target] || null;
  const scriptOptionKey = target === 'cover' ? 'coverScript' : 'backCoverScript';
  const script = typeof options[scriptOptionKey] === 'string'
    ? options[scriptOptionKey]
    : (record?.script || '');
  const mode = resolveMode(options, settings);
  const variant = resolveVariant(options.target);
  const fromProof = variant === 'final' && options.useProofAsBase === true;
  const initImagePath = fromProof
    ? resolveProofInitImage(record?.proofImage, target)
    : null;
  const initImageStrength = fromProof
    ? (Number.isFinite(options.initImageStrength) ? options.initImageStrength : PROOF_AS_BASE_DEFAULT_STRENGTH)
    : undefined;
  const extraStyle = options.extraStyle || '';
  const prompt = target === 'cover'
    ? composeComicCoverPrompt({ series, world, issue, coverScript: script, extraStyle })
    : composeComicBackCoverPrompt({ series, world, issue, backCoverScript: script, extraStyle });
  const logTarget = target === 'cover' ? 'cover' : 'back cover';
  const jobId = enqueueImageJob({
    prompt, world, settings, mode,
    options: { ...options, initImagePath, initImageStrength },
    owner: buildComicPagesOwner({ issueId, target, variant }),
    logLine: `🎨 Pipeline comic ${logTarget} — issue=${issueId.slice(0, 8)} number=${issue.number || 1} variant=${variant}${fromProof ? ' (from proof)' : ''}`,
  });
  return { jobId, mode, prompt, script, variant, fromProof };
}

/**
 * Enqueue a comic-issue front-cover image render. Builds a cover-art
 * prompt (series masthead + issue-number tag + user's cover concept) and
 * hands it to the image-gen queue. Caller records the returned jobId on
 * the appropriate variant slot (cover.proofImage / cover.finalImage)
 * based on `options.target` ('proof' | 'final', default 'proof').
 *
 * When `options.useProofAsBase` is set and target='final', resolves the
 * existing proof image to an absolute path under PATHS.images and passes
 * it through as `initImagePath` so the local i2i runner can preserve
 * the proof's composition while rendering at the larger size.
 *
 * Returns { jobId, mode, prompt, coverScript, variant, fromProof } so the
 * route can construct the slot record without re-reading the issue file.
 */
export async function enqueueComicCover(issueId, options = {}) {
  const { script, ...rest } = await enqueueComicCoverLike(issueId, 'cover', options);
  return { ...rest, coverScript: script };
}

/**
 * Enqueue a comic-issue back-cover image render. Same flow as
 * `enqueueComicCover` but with a back-cover-specific prompt (no
 * masthead / issue-number / title; explicit no-text negative) and the
 * job lands on `stages.comicPages.backCover.{proofImage|finalImage}`.
 *
 * Returns { jobId, mode, prompt, backCoverScript, variant, fromProof }.
 */
export async function enqueueComicBackCover(issueId, options = {}) {
  const { script, ...rest } = await enqueueComicCoverLike(issueId, 'backCover', options);
  return { ...rest, backCoverScript: script };
}

/**
 * Enqueue + persist a comic-issue cover render (front or back) in ONE service
 * call — the shared entry point behind both the route handler and the CDO
 * orchestrator tool (#2220). The bare `enqueueComicCover*` only queues the job;
 * the filename hook attaches the completed render ONLY if the active cover slot
 * already carries the returned jobId, and that slot write used to live in the
 * route factory. Extracting it here means the orchestrator gets orchestrated
 * covers instead of silently dropping them.
 *
 * Persists the in-flight render slot onto
 * `stages.comicPages.{cover|backCover}.{proofImage|finalImage}` through
 * `updateStageWithLatest` (the series write tail) so it serializes against a
 * concurrent blur-save of the script field — the script-gate mirrors the route:
 * only overwrite `script` when the option is a string (absent preserves, empty
 * clears). `options` mirrors the route body (coverScript/backCoverScript,
 * width/height, target, useProofAsBase, mode, …).
 *
 * Returns { jobId, mode, prompt, variant, fromProof, coverScript|backCoverScript,
 * issue, stage } — the enqueue result plus the persisted issue + comicPages stage.
 */
async function renderComicCoverLike(issueId, target, options = {}) {
  const scriptField = target === 'cover' ? 'coverScript' : 'backCoverScript';
  const { script, ...rest } = await enqueueComicCoverLike(issueId, target, options);
  const slotKey = slotKeyForVariant(rest.variant);
  const slotRecord = buildRenderSlot({
    slotKey, jobId: rest.jobId, prompt: rest.prompt,
    width: options.width, height: options.height, fromProof: rest.fromProof,
  });
  const { issue, stage } = await updateStageWithLatest(issueId, 'comicPages', (current) => {
    const currentSlot = current?.[target] || {};
    const nextSlot = { ...currentSlot, [slotKey]: slotRecord };
    if (typeof options[scriptField] === 'string') nextSlot.script = options[scriptField];
    return { [target]: nextSlot };
  });
  return { ...rest, [scriptField]: script, issue, stage };
}

/**
 * Enqueue + persist a comic-issue FRONT cover render. Wraps `enqueueComicCover`
 * plus the slot persist the filename hook depends on. See `renderComicCoverLike`.
 */
export const renderComicCover = (issueId, options = {}) =>
  renderComicCoverLike(issueId, 'cover', options);

/**
 * Enqueue + persist a comic-issue BACK cover render. Lands on
 * `stages.comicPages.backCover`. See `renderComicCoverLike`.
 */
export const renderComicBackCover = (issueId, options = {}) =>
  renderComicCoverLike(issueId, 'backCover', options);

// ---- Volume (season) covers ---------------------------------------------

const loadSeasonContext = async (seriesId, seasonId) => {
  const seriesChain = (async () => {
    const series = await getSeries(seriesId);
    const world = await getUniverse(series.universeId).catch(() => null);
    return { series, world };
  })();
  const [chain, settings] = await Promise.all([seriesChain, getSettings()]);
  const season = (chain.series.seasons || []).find((s) => s.id === seasonId);
  if (!season) {
    throw new ServerError(`Season not found: ${seasonId}`, {
      status: 404, code: 'PIPELINE_SEASON_NOT_FOUND',
    });
  }
  return { ...chain, season, settings };
};

export function composeVolumeCoverPrompt({
  series, world, season, coverScript = '', extraStyle = '',
}) {
  const volumeNumber = Number.isFinite(season?.number) ? Math.max(1, Math.floor(season.number)) : 1;
  const volumeTitle = (season?.title || '').trim();
  const concept = (coverScript || '').trim();

  const styleStack = stackStyle(series, extraStyle);
  const styleClause = styleStack ? ` Art style: ${styleStack}.` : '';

  const titleBlock = buildMastheadClause(series);
  const numberBlock = `Include a clearly legible volume tag reading "VOL. ${volumeNumber}" in the top-left corner — small but readable.`;
  const titleLine = volumeTitle
    ? ` Include the volume title "${volumeTitle}" as a secondary banner below the masthead.`
    : '';
  const authorLine = buildAuthorClause(series);

  const sceneDescription = concept
    || (volumeTitle
      ? `A single dramatic hero image evoking the volume "${volumeTitle}" — the collected arc, not any single issue.`
      : 'A single dramatic hero image of the protagonist that embodies the collected arc.');

  const layout = `A single full printable comic-book trade-paperback FRONT cover collecting an entire volume of issues. ${titleBlock} ${numberBlock}${titleLine}${authorLine} The rest of the cover is one bold hero image — bigger and more iconic than any single-issue cover (no panel borders, no multi-panel layout — this is a collected-edition cover).${styleClause}`;
  const body = `Volume cover concept: ${sceneDescription}`;
  return applyWorldStyle(`${layout}\n\n${body}`, world, series);
}

export function composeVolumeBackCoverPrompt({
  series, world, season, backCoverScript = '', extraStyle = '',
}) {
  const volumeTitle = (season?.title || '').trim();
  const concept = (backCoverScript || '').trim();

  const styleStack = stackStyle(series, extraStyle);
  const styleClause = styleStack ? ` Art style: ${styleStack}.` : '';

  const sceneDescription = concept
    || (volumeTitle
      ? `A quiet companion image evoking the volume "${volumeTitle}" — atmospheric, single subject.`
      : 'A quiet companion image — atmospheric, single subject.');

  const layout = `A single full printable comic-book trade-paperback BACK cover. NO text of any kind — no masthead, no logo, no title, no volume tag, no UPC, no credits, no typography, no captions, no panel borders, no multi-panel layout. The entire cover is one bold illustrated hero image, edge-to-edge.${styleClause}`;
  const body = `Volume back-cover concept: ${sceneDescription}`;
  return applyWorldStyle(`${layout}\n\n${body}`, world, series);
}

/**
 * Shared volume-cover enqueue helper — front + back covers share variant
 * resolution, proof-as-base i2i path, owner build, and job enqueue. Only the
 * prompt composer + script field name differ.
 *
 * Returns { jobId, mode, prompt, script, variant, fromProof } — `script`
 * is the resolved text (option override or persisted); caller renames to
 * `coverScript` / `backCoverScript` for its public API symmetry.
 */
async function enqueueVolumeCoverLike(seriesId, seasonId, target, options = {}) {
  if (target !== 'cover' && target !== 'backCover') {
    throw new Error(`enqueueVolumeCoverLike: unknown target "${target}"`);
  }
  const { series, world, season, settings } = await loadSeasonContext(seriesId, seasonId);
  const record = season[target] || null;
  const scriptOptionKey = target === 'cover' ? 'coverScript' : 'backCoverScript';
  const script = typeof options[scriptOptionKey] === 'string'
    ? options[scriptOptionKey]
    : (record?.script || '');
  const mode = resolveMode(options, settings);
  const variant = resolveVariant(options.target);
  const fromProof = variant === 'final' && options.useProofAsBase === true;
  const initImagePath = fromProof
    ? resolveProofInitImage(record?.proofImage, `volume ${target}`)
    : null;
  const initImageStrength = fromProof
    ? (Number.isFinite(options.initImageStrength) ? options.initImageStrength : PROOF_AS_BASE_DEFAULT_STRENGTH)
    : undefined;
  const extraStyle = options.extraStyle || '';
  const prompt = target === 'cover'
    ? composeVolumeCoverPrompt({ series, world, season, coverScript: script, extraStyle })
    : composeVolumeBackCoverPrompt({ series, world, season, backCoverScript: script, extraStyle });
  const logTarget = target === 'cover' ? 'cover' : 'back cover';
  const jobId = enqueueImageJob({
    prompt, world, settings, mode,
    options: { ...options, initImagePath, initImageStrength },
    owner: buildSeasonCoverOwner({ seriesId, seasonId, target, variant }),
    logLine: `🎨 Pipeline volume ${logTarget} — series=${seriesId.slice(0, 8)} season=${seasonId.slice(0, 8)} vol=${season.number || 1} variant=${variant}${fromProof ? ' (from proof)' : ''}`,
  });
  return { jobId, mode, prompt, script, variant, fromProof };
}

/**
 * Enqueue a volume (season) FRONT cover render. Returns
 * { jobId, mode, prompt, coverScript, variant, fromProof }.
 */
export async function enqueueVolumeCover(seriesId, seasonId, options = {}) {
  const { script, ...rest } = await enqueueVolumeCoverLike(seriesId, seasonId, 'cover', options);
  return { ...rest, coverScript: script };
}

/**
 * Enqueue a volume (season) BACK cover render. Returns
 * { jobId, mode, prompt, backCoverScript, variant, fromProof }.
 */
export async function enqueueVolumeBackCover(seriesId, seasonId, options = {}) {
  const { script, ...rest } = await enqueueVolumeCoverLike(seriesId, seasonId, 'backCover', options);
  return { ...rest, backCoverScript: script };
}

/**
 * Enqueue + persist a volume (season) cover render (front or back) in ONE
 * service call — the shared entry point behind both the route handler and the
 * CDO orchestrator (#2220). Mirrors `renderComicCoverLike` but persists the
 * in-flight slot onto `series.seasons[].{cover|backCover}` through
 * `updateSeasonOnSeries` (the per-series write tail) so the season-cover
 * filename hook can attach the completed render.
 *
 * Returns { jobId, mode, prompt, variant, fromProof, coverScript|backCoverScript,
 * season, series } — the enqueue result plus the updated season + series.
 */
async function renderVolumeCoverLike(seriesId, seasonId, target, options = {}) {
  const scriptField = target === 'cover' ? 'coverScript' : 'backCoverScript';
  const { script, ...rest } = await enqueueVolumeCoverLike(seriesId, seasonId, target, options);
  const slotKey = slotKeyForVariant(rest.variant);
  const slotRecord = buildRenderSlot({
    slotKey, jobId: rest.jobId, prompt: rest.prompt,
    width: options.width, height: options.height, fromProof: rest.fromProof,
  });
  const series = await updateSeasonOnSeries(seriesId, seasonId, (current) => {
    const currentSlot = current?.[target] || {};
    const nextSlot = { ...currentSlot, [slotKey]: slotRecord };
    if (typeof options[scriptField] === 'string') nextSlot.script = options[scriptField];
    return { [target]: nextSlot };
  });
  const season = (series.seasons || []).find((s) => s.id === seasonId);
  return { ...rest, [scriptField]: script, season, series };
}

/**
 * Enqueue + persist a volume (season) FRONT cover render. See
 * `renderVolumeCoverLike`.
 */
export const renderVolumeCover = (seriesId, seasonId, options = {}) =>
  renderVolumeCoverLike(seriesId, seasonId, 'cover', options);

/**
 * Enqueue + persist a volume (season) BACK cover render. See
 * `renderVolumeCoverLike`.
 */
export const renderVolumeBackCover = (seriesId, seasonId, options = {}) =>
  renderVolumeCoverLike(seriesId, seasonId, 'backCover', options);

