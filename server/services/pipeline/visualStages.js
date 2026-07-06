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
import { getSeries, updateSeasonOnSeries } from './series.js';
import { getIssue, updateStage, updateStageWithLatest, assertStageUnlocked, VISUAL_STAGE_IDS } from './issues.js';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { buildComicPagesOwner, buildSeasonCoverOwner, buildStoryboardsShotOwner, slotKeyForVariant } from './owners.js';
import { getUniverse, joinInfluenceList } from '../universeBuilder.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  buildScenePrompt, buildPlaceByKey, matchScenePlace,
  buildCharByKey, matchSceneCharacters, matchCharactersInText,
  matchPlacesInText, matchObjectsInText,
} from '../../lib/scenePrompt.js';
import { flattenCanonDescriptorFragments, richCanonDescriptorFragments } from '../../lib/canonPrompt.js';
import { composeStyledPrompt } from '../../lib/composeStyledPrompt.js';
import { getDefaultVideoModelId, getVideoModels, getImageModels } from '../../lib/mediaModels.js';
import { loraCompatKey } from '../../lib/runners.js';
import { resolveCharacterLoras } from '../characterLoraResolver.js';
import { runStagedLLM } from '../../lib/stageRunner.js';
import { runPromptRefine, runImagePromptCandidates } from './refineHelpers.js';
import { pickCanon } from './seriesCanon.js';
import { STYLE_PROMPT_OVERRIDE_MODE_DEFAULT } from './series.js';
import { ASPECT_PRESETS } from '../../lib/creativeDirectorPresets.js';
import { sameComicScene } from '../../lib/comicScriptParser.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';
import { resolveImageCleaners } from '../imageGen/index.js';

const joinStyleParts = (...parts) =>
  parts.map((s) => (s || '').trim()).filter(Boolean).join(', ');

const joinStyleSentences = (...parts) =>
  parts.map((s) => (s || '').trim()).filter(Boolean).join('. ');

const stackStyle = (series, extraStyle) => joinStyleParts(series?.styleNotes, extraStyle);

// Composes `series.stylePromptOverride` against the universe's embrace
// influences. The mode (prepend/append/override) is documented next to the
// `STYLE_PROMPT_OVERRIDE_MODES` constant in series.js — it's the single
// source of truth.
const buildStyleClause = (world, series) => {
  const override = (series?.stylePromptOverride || '').trim();
  const mode = series?.stylePromptOverrideMode || STYLE_PROMPT_OVERRIDE_MODE_DEFAULT;
  if (override && mode === 'override') return override;
  const universeStyle = joinInfluenceList(world?.influences?.embrace);
  return mode === 'append'
    ? joinStyleSentences(universeStyle, override)
    : joinStyleSentences(override, universeStyle);
};

const applyWorldStyle = (prompt, world, series = null) => {
  const stylePrompt = buildStyleClause(world, series);
  if (!stylePrompt) return prompt;
  return composeStyledPrompt(prompt, '', { prompt: stylePrompt, negativePrompt: '' }).prompt;
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
  if (options.mode === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (options.mode === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  const settingsMode = settings?.imageGen?.mode;
  if (settingsMode === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (settingsMode === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  if (codexEnabled) return IMAGE_GEN_MODE.CODEX;
  return IMAGE_GEN_MODE.LOCAL;
};

/**
 * Resolve trained character LoRAs for a pipeline render. Local mode only —
 * codex has no LoRA support, so resolution is skipped there with one log
 * line. `options.applyCharacterLoras === false` is the per-render opt-out
 * (default on). The compat key comes from the model the local render will
 * actually use (request override → saved local model → first registered),
 * mirroring resolveSheetModelId's order; an unresolvable model just means
 * no compat filtering.
 *
 * Returns `{ loras, triggerByKey }` — `triggerByKey` maps canon
 * entryId/ingredientId → trigger word for prompt weaving.
 */
async function applyCharacterLorasToRender({ matchedCharacters, mode, options, settings }) {
  const none = { loras: [], triggerByKey: new Map() };
  if (options.applyCharacterLoras === false || !matchedCharacters?.length) return none;
  if (mode !== IMAGE_GEN_MODE.LOCAL) {
    console.log(`⚠️ character LoRA skipped — ${mode} mode has no LoRA support`);
    return none;
  }
  const allModels = getImageModels();
  const model = allModels.find((m) => m.id === options.modelId)
    || allModels.find((m) => m.id === settings?.imageGen?.local?.modelId)
    || allModels[0]
    || null;
  const compatKey = model ? loraCompatKey(model) : null;
  const loras = await resolveCharacterLoras(matchedCharacters, { compatKey }).catch((err) => {
    console.error(`❌ character LoRA resolution failed: ${err?.message}`);
    return [];
  });
  if (!loras.length) return none;
  const triggerByKey = new Map();
  for (const lora of loras) {
    if (!lora.triggerWord || !lora.character) continue;
    if (lora.character.entryId) triggerByKey.set(lora.character.entryId, lora.triggerWord);
    if (lora.character.ingredientId) triggerByKey.set(lora.character.ingredientId, lora.triggerWord);
  }
  console.log(`🧬 character LoRA auto-apply — ${loras.map((l) => `${l.character?.name || '?'}→${l.filename}`).join(', ')}`);
  return { loras, triggerByKey };
}

const loraRenderOptions = (loras) => (loras.length
  ? { loraFilenames: loras.map((l) => l.filename), loraScales: loras.map((l) => l.scale) }
  : {});

// Defensive fallback — an unrecognized value must never land in the final
// slot, even if a future client bypasses the route schema.
const resolveVariant = (target) => (target === 'final' ? 'final' : 'proof');

// `buildRenderSlot` moved to server/lib/renderSlot.js so season-cover
// render paths (which don't import from visualStages.js) can share the
// shape. Imported for the shared cover-render persist path below and
// re-exported for back-compat with route-level callers that still import it
// from this module.
import { buildRenderSlot } from '../../lib/renderSlot.js';

export { buildRenderSlot };

// Default denoise strength for the "use proof as base" upscale path. Low
// enough to preserve composition (panel layout, character placement),
// high enough to let the model add the extra detail the larger canvas
// affords. Tweakable per-call via options.initImageStrength.
const PROOF_AS_BASE_DEFAULT_STRENGTH = 0.25;

// Resolve a stored proof filename (e.g. "abc123.png") to an absolute path
// under PATHS.images, enforcing the gallery prefix. `mustExist:false` skips
// the existsSync check — the downstream image-gen runner reads the path and
// will surface a clear error if the file vanished between enqueue and exec;
// an existsSync here would add a TOCTOU race for no real benefit.
const resolveProofInitImage = (proofImage, label) => {
  const name = proofImage?.filename;
  if (typeof name !== 'string' || !name) {
    throw new ServerError(
      `Cannot use proof as base for ${label}: no proof render available yet — render the proof first.`,
      { status: 400, code: 'PIPELINE_COMIC_PROOF_MISSING' },
    );
  }
  const resolved = resolveGalleryImage(name, { mustExist: false });
  if (!resolved) {
    throw new ServerError(
      `Proof image path escaped the gallery for ${label}: ${name}`,
      { status: 400, code: 'PIPELINE_COMIC_PROOF_NOT_FOUND' },
    );
  }
  return resolved;
};

// Consistency-reference denoise: when an ADJACENT page is passed as a reference
// (continuing the same scene so incidental, un-described characters and the
// environment stay consistent), we want the NEW page's composition to come from
// its own prompt while only borrowing identity/style from the reference. So this
// is a HIGH denoise (mostly follow the prompt) — the opposite of proof-as-base's
// 0.25 (preserve layout for an upscale). Local i2i honors it; codex passes the
// reference as an `-i` attachment (reference mode), where strength is moot.
const REFERENCE_PAGE_DEFAULT_STRENGTH = 0.8;

// Default denoise for the per-page "Refine" image-to-image correction (issue
// #1534). The page is re-rendered FROM ITS OWN existing image, so this is a
// low strength: preserve the panel layout / composition / lettering and move
// only enough pixels to honor the small requested change. Higher than
// proof-as-base's 0.25 (which merely upscales) because a refine must actually
// apply an edit; far below the reference path's 0.8 (which mostly follows a
// fresh prompt). Tweakable per-call via options.initImageStrength.
const REFINE_RENDER_DEFAULT_STRENGTH = 0.35;

// Resolve an adjacent page's rendered image to a gallery path for use as a
// consistency reference. Prefers the final render, falls back to the proof.
// Throws a clear 400 when that page hasn't been rendered yet.
const resolvePageReferenceImage = (refPage, label) => {
  const name = refPage?.finalImage?.filename || refPage?.proofImage?.filename;
  if (typeof name !== 'string' || !name) {
    throw new ServerError(
      `Cannot use ${label} as a consistency reference: it has no rendered image yet — render that page first.`,
      { status: 400, code: 'PIPELINE_COMIC_REFERENCE_MISSING' },
    );
  }
  const resolved = resolveGalleryImage(name, { mustExist: false });
  if (!resolved) {
    throw new ServerError(
      `Reference image path escaped the gallery for ${label}: ${name}`,
      { status: 400, code: 'PIPELINE_COMIC_REFERENCE_NOT_FOUND' },
    );
  }
  return resolved;
};

// Resolve the `referencePage` option ('prior' | 'next' | <0-based index>) to a
// concrete page index, or null when unset. Pure + bounds-checked against the
// page count; throws a clear 400 for an out-of-range request (prior on page 1,
// next on the last page, or an explicit index that doesn't exist).
export function resolveReferencePageIndex(referencePage, pageIndex, pageCount) {
  if (referencePage == null) return null;
  let target;
  if (referencePage === 'prior') target = pageIndex - 1;
  else if (referencePage === 'next') target = pageIndex + 1;
  else if (Number.isInteger(referencePage)) target = referencePage;
  else throw new ServerError(`Invalid referencePage: ${referencePage}`, { status: 400, code: 'PIPELINE_COMIC_REFERENCE_BAD' });
  if (target === pageIndex) {
    throw new ServerError('A page cannot be its own consistency reference', { status: 400, code: 'PIPELINE_COMIC_REFERENCE_SELF' });
  }
  if (target < 0 || target >= pageCount) {
    throw new ServerError(
      `Consistency reference page ${target + 1} is out of range (have ${pageCount} page${pageCount === 1 ? '' : 's'})`,
      { status: 400, code: 'PIPELINE_COMIC_REFERENCE_RANGE' },
    );
  }
  return target;
}

// Auto-pick a consistency reference for a fresh page render: the immediately
// prior page, but ONLY when it shares this page's scene AND has already been
// rendered. This is the default when the caller doesn't name an explicit
// `referencePage` — so a continuing scene keeps its incidental characters and
// environment consistent page-to-page, while a scene boundary renders fresh
// (the "don't reference the prior page across a scene cut" rule). Pure +
// soft: returns null (rather than throwing) when there's no prior page, the
// scenes differ, scene markers are absent (legacy scripts → no auto-chain), or
// the prior page has no image yet — auto-chaining is a best-effort nicety, not
// a hard requirement like an explicitly requested reference.
export function resolveAutoReferenceIndex(pages, pageIndex) {
  const cur = pages?.[pageIndex];
  const prior = pages?.[pageIndex - 1];
  if (!cur || !prior) return null;
  if (!sameComicScene(prior, cur)) return null;
  const hasImage = !!(prior.finalImage?.filename || prior.proofImage?.filename);
  return hasImage ? pageIndex - 1 : null;
}

// Resolve which init image (if any) a comic-page render should use, applying
// the three precedence tiers in order:
//   1. EXPLICIT `referencePage` ('prior' | 'next' | <index>) — strongest
//      intent; bounds-checked (throws on an out-of-range request). `'none'`
//      opts out of the AUTO tier (no cross-page reference, even mid-scene).
//   2. PROOF-AS-BASE — a final-variant upscale off this page's own proof. Beats
//      auto so "Final from proof" still preserves panel layout. Orthogonal to
//      `'none'` (it's a self-upscale, not a sibling reference), so it still
//      applies when the user picked 'none' but left the proof-as-base box on.
//   3. AUTO — chain off the prior page when it shares this page's scene and is
//      already rendered; a scene boundary (or absent scene markers) skips it.
// Pure; returns the chosen tier so the caller picks the init image + strength
// and logs it. `autoReference` is true only when the AUTO tier supplied the
// page (so callers can distinguish it from an explicit reference).
export function resolveComicPageReference({ referencePage, useProofAsBase, variant, pages, pageIndex }) {
  const explicitOff = referencePage === 'none';
  const wantsExplicit = !explicitOff && referencePage != null && referencePage !== 'auto';
  const explicitIndex = wantsExplicit
    ? resolveReferencePageIndex(referencePage, pageIndex, pages.length)
    : null;
  const fromProof = explicitIndex == null && variant === 'final' && useProofAsBase === true;
  const autoIndex = (explicitIndex == null && !fromProof && !explicitOff)
    ? resolveAutoReferenceIndex(pages, pageIndex)
    : null;
  const referencePageIndex = explicitIndex != null ? explicitIndex : autoIndex;
  return {
    referencePageIndex,
    fromReference: referencePageIndex != null,
    autoReference: referencePageIndex != null && explicitIndex == null,
    fromProof,
  };
}

const loadBibleContext = async (issueId) => {
  const issueChain = (async () => {
    const issue = await getIssue(issueId);
    const series = await getSeries(issue.seriesId);
    // `.catch(() => null)` covers a dangling universe reference. Empty
    // canon still lets scene description flow through; downstream stages
    // just lose character / place / object metadata.
    const world = await getUniverse(series.universeId).catch(() => null);
    return { issue, series, world, canon: pickCanon(world) };
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
  const worldNeg = joinInfluenceList(world?.influences?.avoid);
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
    // i2i upscale path: when the caller passes an init image (e.g.
    // "use proof as base" for a final render) we forward it to the active
    // backend. Local mflux uses it as `--image-path`; codex attaches it via
    // the CLI's `-i` flag and routes it to gpt-image-2's image-edit mode.
    // The external SD-API backend has no i2i wiring and drops both fields
    // at the dispatcher.
    ...(options.initImagePath ? { initImagePath: options.initImagePath } : {}),
    ...(Number.isFinite(options.initImageStrength) ? { initImageStrength: options.initImageStrength } : {}),
    // Character LoRAs resolved by applyCharacterLorasToRender — only the
    // local runner honors these (codex has no LoRA support; the resolver is
    // skipped there so the spread stays empty).
    ...(options.loraFilenames?.length ? { loraFilenames: options.loraFilenames, loraScales: options.loraScales } : {}),
  };
  // The queue dispatches directly to imageGen/{codex,local}.generateImage,
  // bypassing imageGen/index.js's dispatcher that resolves cleaners for
  // direct callers. The /api/image-gen/generate route resolves them at the
  // route layer; pipeline renders need the same resolution here, otherwise
  // the saved settings.imageGen[mode].{cleanC2PA,denoise} would have no
  // effect on storyboard, comic-panel, or cover renders.
  const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);
  const params = mode === IMAGE_GEN_MODE.CODEX
    ? { mode: IMAGE_GEN_MODE.CODEX, codexPath: settings.imageGen?.codex?.codexPath, model: settings.imageGen?.codex?.model, cleanC2PA, denoise, ...baseParams }
    : { pythonPath: settings.imageGen?.local?.pythonPath || null, modelId: options.modelId, cleanC2PA, denoise, ...baseParams };
  const { jobId } = enqueueJob({ kind: 'image', params, owner });
  console.log(`${logLine} mode=${mode} jobId=${jobId.slice(0, 8)}`);
  return jobId;
};

// Canon places now live on the linked universe (Phase B.4). Callers can
// either pass a pre-built `placeByKey` (when they've already computed it
// for reuse across many scenes — see episodeVideo) or pass `canon` and let
// us build the map here. `series?.places` is no longer read — that field
// was retired with the series-side canon teardown.
export function composeVisualPrompt({ series, description, slugline = '', extraStyle = '', placeByKey = null, matchedCharacters = [], world = null, canon = null, characterAppearances = [] }) {
  const map = placeByKey || buildPlaceByKey(canon?.places);
  const scenePrompt = buildScenePrompt(
    series?.name || '',
    { visualPrompt: description || '', slugline, characterAppearances },
    matchedCharacters,
    stackStyle(series, extraStyle),
    matchScenePlace(slugline, map),
  );
  return applyWorldStyle(scenePrompt, world, series);
}

// Marvel/DC scripts attach parentheticals to speakers — `ETTA (EARPIECE):`,
// `KESSA (WHISPERED):`, `LINA (THOUGHT):`. These tell a human artist HOW to
// draw the balloon (jagged for transmitted voices, dashed for whispers,
// cloud-outline for thoughts), but a diffusion model treats them as more text
// to letter. Map them to visual balloon-style hints so the artist still gets
// the cue without the label leaking into the lettering.
// `disembodied: true` marks a modifier whose SPEAKER is NOT physically in the
// panel — a station PA, a radio voice, an off-panel shout. Without an explicit
// cue the image model gives the line a normal tailed balloon and points it at
// whoever IS drawn (e.g. JUNO's `(SPEAKERS)` PA line got attributed to a
// visible newlywed). formatBalloon turns the flag into a "do NOT tail to any
// visible character" instruction. Order matters — first match wins, so the
// broadcast/PA rule precedes the generic transmission rule.
const BALLOON_STYLE_HINTS = [
  { test: /\b(SPEAKERS?|P\.?A\.?|BROADCAST|ANNOUNCE(?:D|S|MENT)?|ANNOUNCER|LOUDSPEAKER|OVERHEAD|INTERCOM|TANNOY|PAGING|STATIONWIDE|SHIPWIDE)\b/, hint: 'jagged electronic broadcast/PA balloon, no tail (disembodied announcement from an overhead source)', disembodied: true },
  // Transmission devices are AMBIGUOUS — the speaker may be a visible character
  // talking into the device, or a remote voice — so this gets the electronic
  // style WITHOUT the "not in panel" claim (that's reserved for unambiguous
  // broadcast/off-panel/V.O. above).
  { test: /\b(EARPIECE|RADIO|COMMS?|TRANSMISSION|PHONE|HOLO|HOLOGRAM|TV|MONITOR|VIDEO|COMLINK|CHANNEL)\b/, hint: 'jagged electronic/transmission balloon with bolt-shaped tail' },
  { test: /\b(OFF[\- ]?PANEL|OFF[\- ]?SCREEN|O\.?S\.?|O\.?P\.?)\b/, hint: 'off-panel balloon with the tail pointing past the panel border', disembodied: true },
  { test: /\b(NARRATION|VOICE[\- ]?OVER|V\.?O\.?)\b/, hint: 'rectangular narration caption rather than a speech balloon', disembodied: true },
  { test: /\b(WHISPER(?:ED|S|ING)?|SOTTO|HUSHED|QUIET)\b/, hint: 'dashed-outline whisper balloon' },
  { test: /\b(SHOUT(?:ED|S|ING)?|YELL(?:ED|S|ING)?|SCREAM(?:ED|S|ING)?|ANGRY|BURST)\b/, hint: 'spiked/burst-shaped balloon' },
  { test: /\b(THOUGHT|THINKING|INTERNAL)\b/, hint: 'cloud-outline thought balloon with chain-of-bubbles tail' },
  { test: /\b(SING(?:S|ING)?|SONG|MUSICAL)\b/, hint: 'wavy musical balloon with musical-note flourish' },
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
  const styleEntry = modifier
    ? BALLOON_STYLE_HINTS.find((h) => h.test.test(modifier.toUpperCase())) || null
    : null;
  // A disembodied speaker (PA, radio, off-panel, V.O.) is NOT in the panel, so
  // spell that out — otherwise the model letters a normal balloon and tails it
  // to whoever IS drawn, mis-attributing the line (the JUNO `(SPEAKERS)` bug).
  const attribution = styleEntry?.disembodied
    ? `(spoken by ${speaker}, who is NOT visible in this panel — render as a ${styleEntry.hint}; do NOT attach the balloon tail to any visible character)`
    : styleEntry
      ? `(spoken by ${speaker}; ${styleEntry.hint})`
      : `(spoken by ${speaker})`;
  // Terminator handled here so endPunct() at the call site doesn't have to
  // navigate the closing paren — we always end with `).`.
  return `Speech balloon reads: "${cleanText}" ${attribution}.`;
}

// Build the masthead clause for a front cover. When `series.titleLogo` is set,
// it replaces the generic "bold comic-book logo typography" fallback with the
// LLM-designed (or user-edited) design description so every cover renders a
// consistent logo. The series name is still rendered verbatim — the titleLogo
// describes HOW it looks (letterform, finish, color), not WHAT it says.
function buildMastheadClause(series) {
  const seriesName = (series?.name || '').trim();
  const logoDesign = (series?.titleLogo || '').trim();
  if (!seriesName) {
    return logoDesign
      ? `Render a bold comic-book series masthead near the top of the cover. Logo design: ${logoDesign}`
      : 'Render a bold comic-book series masthead as large logo typography near the top of the cover.';
  }
  return logoDesign
    ? `Render the series masthead "${seriesName}" as large comic-book logo typography near the top of the cover. Logo design: ${logoDesign}`
    : `Render the series masthead "${seriesName}" as bold, large comic-book logo typography near the top of the cover.`;
}

// Optional author byline injected near the bottom of front covers + trade
// paperback fronts. Skipped when the series has no author set so older series
// still render without an empty "By —" caption.
const buildAuthorClause = (series) => {
  const author = (series?.author || '').trim();
  return author
    ? ` Include a small author byline reading "By ${author}" near the bottom of the cover — restrained, lettered in a smaller weight than the masthead.`
    : '';
};

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

export function composeComicPagePrompt({
  series, world, page, pageNumber, extraStyle = '',
  matchedCharacters = [], matchedPlaces = [], matchedObjects = [],
  // entryId/ingredientId → trained-LoRA trigger word (see
  // applyCharacterLorasToRender). Passed as a map so this compose stays pure.
  loraTriggerByKey = null,
}) {
  const panels = Array.isArray(page?.panels) ? page.panels : [];
  if (panels.length === 0) return '';

  // Placed AFTER the layout clause: diffusion models weight earlier tokens
  // more heavily, and the page-shape instruction has to claim that position.
  // A character with a trained LoRA gets its trigger word parenthesized
  // after the name — the token the adapter binds the identity to.
  const featuring = (matchedCharacters || [])
    .map((c) => ({
      name: c.name,
      trigger: loraTriggerByKey?.get(c.id) || loraTriggerByKey?.get(c.ingredientId) || null,
      desc: (c.physicalDescription || c.description || '').trim(),
    }))
    .filter((c) => c.name && c.desc)
    .map((c) => `${c.name}${c.trigger ? ` (${c.trigger})` : ''}: ${c.desc}`)
    .join('; ');

  // Place baseline: pull the full RICH descriptor set per matched place
  // (description / Palette / Era / Weather / recurringDetails). Same shared
  // helper that drives buildScenePrompt's placeFrags + synthesizeCanonPrompt's
  // body, so comic-page renders pick up the same era/weather/atmosphere cues
  // diffusion models weight for lighting + period dress. Multi-place per page
  // is supported (a single page can span more than one location).
  const placesClause = (matchedPlaces || [])
    .map((p) => {
      const body = flattenCanonDescriptorFragments(richCanonDescriptorFragments('place', p));
      const head = p.name ? `${p.name}:` : '';
      return [head, body].filter(Boolean).join(' ');
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
  const placeClause = placesClause ? `\n\nSetting — ${placesClause}` : '';
  const notableClause = notable ? `\n\nNotable — ${notable}` : '';

  return applyWorldStyle(`${layout}${featuringClause}${placeClause}${notableClause}\n\n${panelLines.join('\n\n')}`, world, series);
}

/**
 * Enqueue a full-comic-page image render. Builds a structured page-level
 * prompt from `issue.stages.comicPages.pages[pageIndex].panels[]` and hands
 * it to the image-gen queue. Caller records the returned jobId on the
 * appropriate variant slot (`pages[pageIndex].proofImage` /
 * `pages[pageIndex].finalImage`) based on `options.target`.
 *
 * When `options.useProofAsBase` is set and target='final', resolves the
 * page's existing proof image and passes it as initImagePath so the local
 * i2i runner can preserve panel layout while upscaling.
 *
 * Returns { jobId, mode, prompt, pageIndex, variant, fromProof }.
 */
export async function enqueueVisualComicPage(issueId, options = {}) {
  const pageIndex = Number(options.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const { issue, settings, series, world, canon } = await loadBibleContext(issueId);
  assertStageUnlocked(issue, 'comicPages');
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
  const variant = resolveVariant(options.target);

  // Consistency reference: pass an already-rendered page as the init image so a
  // continuing scene keeps its incidental, un-described characters and
  // environment consistent (the "two newlyweds drift between pages" problem).
  // The three-tier precedence (explicit > proof-as-base > auto-within-scene)
  // lives in resolveComicPageReference.
  const { referencePageIndex, fromReference, autoReference, fromProof } = resolveComicPageReference({
    referencePage: options.referencePage,
    useProofAsBase: options.useProofAsBase,
    variant, pages, pageIndex,
  });
  const initImagePath = fromReference
    ? resolvePageReferenceImage(pages[referencePageIndex], `page ${referencePageIndex + 1}`)
    : fromProof
      ? resolveProofInitImage(page.proofImage, `page ${pageIndex + 1}`)
      : null;
  const initImageStrength = fromReference
    ? (Number.isFinite(options.initImageStrength) ? options.initImageStrength : REFERENCE_PAGE_DEFAULT_STRENGTH)
    : fromProof
      ? (Number.isFinite(options.initImageStrength) ? options.initImageStrength : PROOF_AS_BASE_DEFAULT_STRENGTH)
      : undefined;

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

  // Places + objects: text-match against the panel prose. Codex can't take
  // reference images, so rich text descriptions in the prompt are how we
  // keep environments and signature props visually consistent page-to-page.
  const matchedPlaces = matchPlacesInText(proseHaystack, canon.places);
  const matchedObjects = matchObjectsInText(proseHaystack, canon.objects);

  // composeComicPagePrompt only returns '' when panels.length === 0, which is
  // already rejected above. The "(continuation of previous beat)" placeholder
  // covers panels with no description, so the prompt is non-empty by here.
  const { loras: characterLoras, triggerByKey } = await applyCharacterLorasToRender({
    matchedCharacters, mode, options, settings,
  });

  const prompt = composeComicPagePrompt({
    series, world, page, pageNumber: pageIndex + 1,
    extraStyle: options.extraStyle || '',
    matchedCharacters, matchedPlaces, matchedObjects,
    loraTriggerByKey: triggerByKey,
  });

  const jobId = enqueueImageJob({
    prompt, world, settings, mode,
    options: { ...options, initImagePath, initImageStrength, ...loraRenderOptions(characterLoras) },
    owner: buildComicPagesOwner({ issueId, target: 'page', pageIndex, variant }),
    logLine: `📄 Pipeline comic page — issue=${issueId.slice(0, 8)} page=${pageIndex + 1} panels=${page.panels.length} variant=${variant}${fromProof ? ' (from proof)' : ''}${fromReference ? ` (${autoReference ? 'auto-ref' : 'ref'} page ${referencePageIndex + 1})` : ''}`,
  });
  return { jobId, mode, prompt, pageIndex, variant, fromProof, fromReference, autoReference, referencePageIndex };
}

/**
 * AI prompt-refine + image-to-image re-render for a SMALL correction to an
 * already-rendered comic page (issue #1534). Unlike `enqueueVisualComicPage`
 * (which composes a fresh prompt from the page's panels and re-renders from
 * source), this:
 *
 *   1. Takes the page's CURRENT render prompt (stored on the proof/final slot)
 *      plus the user's free-text instruction, and asks the LLM to ADJUST that
 *      prompt to reflect the instruction — never regenerating from the comic
 *      script. Everything not called out by the instruction is preserved.
 *   2. Re-renders image-to-image using the page's EXISTING output image as the
 *      init base at a low denoise, so the panel layout / composition / lettering
 *      survive and only the requested change moves.
 *
 * The base image (and the slot the refined render lands back on) is the page's
 * final render when present, else its proof; `options.target` forces a variant.
 * This is the common "page is mostly right, needs a tweak" case where a full
 * re-render from the script would throw away everything good about the current
 * output.
 *
 * Returns { jobId, mode, prompt, pageIndex, variant, changes, runId, providerId }.
 */
export async function refineComicPageRender(issueId, options = {}) {
  const pageIndex = Number(options.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const instruction = (options.instruction || '').trim();
  if (!instruction) {
    throw new ServerError('instruction is required — describe the small change to apply', {
      status: 400, code: 'PIPELINE_COMIC_REFINE_NO_INSTRUCTION',
    });
  }

  const { issue, settings, series, world } = await loadBibleContext(issueId);
  assertStageUnlocked(issue, 'comicPages');
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? issue.stages.comicPages.pages : [];
  const page = pages[pageIndex];
  if (!page) {
    throw new ServerError(`page index ${pageIndex} out of range (have ${pages.length})`, {
      status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND',
    });
  }

  // Mirror the client's getProofSlot: a legacy page (pre proof/final split)
  // stores its render at the record root (imageJobId/filename/prompt), and the
  // UI surfaces that as the proof slot — so it shows the Refine control. Resolve
  // the same legacy shape here, otherwise refining a page whose only render is
  // legacy would 400 with NO_RENDER even though the UI shows it as rendered. The
  // refined render lands on the proofImage slot, upgrading the record into the
  // new shape (same as a /render of a legacy page).
  const legacyProofSlot = (!page.proofImage?.filename && (page.imageJobId || page.filename))
    ? { filename: page.filename || null, prompt: page.prompt || null }
    : null;

  // Resolve which rendered variant to refine: an explicit target wins; else
  // prefer the final render, falling back to the proof. The refined render
  // lands back on that SAME slot (the user is correcting that image).
  const variant = options.target
    ? resolveVariant(options.target)
    : (page.finalImage?.filename ? 'final' : 'proof');
  const baseSlot = variant === 'final'
    ? page.finalImage
    : (page.proofImage?.filename ? page.proofImage : legacyProofSlot);
  const baseFilename = baseSlot?.filename;
  if (!baseFilename) {
    throw new ServerError(
      `Cannot refine page ${pageIndex + 1}'s ${variant} render: it has no rendered image yet — render the page first.`,
      { status: 400, code: 'PIPELINE_COMIC_REFINE_NO_RENDER' },
    );
  }
  // The stored slot prompt is what we adjust — refusing to fall back to a
  // recomposed-from-script prompt is the whole point (a surgical edit, not a
  // redraw). A legacy slot without a persisted prompt must be re-rendered once
  // through `/render` (which stamps the prompt) before it can be refined.
  const currentPrompt = (baseSlot.prompt || '').trim();
  if (!currentPrompt) {
    throw new ServerError(
      `Cannot refine page ${pageIndex + 1}'s ${variant} render: its stored render prompt is missing — re-render the page first.`,
      { status: 400, code: 'PIPELINE_COMIC_REFINE_NO_PROMPT' },
    );
  }
  const initImagePath = resolveGalleryImage(baseFilename, { mustExist: false });
  if (!initImagePath) {
    throw new ServerError(
      `Existing page image path escaped the gallery for page ${pageIndex + 1}: ${baseFilename}`,
      { status: 400, code: 'PIPELINE_COMIC_REFINE_NOT_FOUND' },
    );
  }

  // Ask the LLM to apply the instruction to the existing prompt. resultField
  // 'prompt' + runPromptRefine's validation guarantees a non-empty string back;
  // `changes` is the short "what I changed" bullet list the UI surfaces.
  const { refined, changes, runId, providerId } = await runPromptRefine({
    templateName: 'pipeline-comic-page-refine-render',
    variables: {
      series: seriesBibleCtx(series),
      issue: issueCtx(issue),
      pageNumber: pageIndex + 1,
      currentPrompt: currentPrompt.slice(0, 16_000),
      instruction: instruction.slice(0, 2000),
    },
    options,
    source: 'pipeline-comic-page-refine-render',
    logTag: `Pipeline comic page refine — issue=${issueId.slice(0, 8)} page=${pageIndex + 1} variant=${variant}`,
  });

  const mode = resolveMode(options, settings);
  const initImageStrength = Number.isFinite(options.initImageStrength)
    ? Math.min(Math.max(options.initImageStrength, 0), 1)
    : REFINE_RENDER_DEFAULT_STRENGTH;

  const jobId = enqueueImageJob({
    prompt: refined, world, settings, mode,
    options: { ...options, initImagePath, initImageStrength },
    owner: buildComicPagesOwner({ issueId, target: 'page', pageIndex, variant }),
    logLine: `🪄 Pipeline comic page refine — issue=${issueId.slice(0, 8)} page=${pageIndex + 1} variant=${variant} strength=${initImageStrength}`,
  });
  return { jobId, mode, prompt: refined, pageIndex, variant, changes, runId, providerId };
}

/**
 * Validate per-scene wardrobe picks at the request boundary. The generic
 * visual-image route accepts `characterAppearances` ([{ characterId,
 * wardrobeId? }]) threaded from the storyboards picker; the Zod schema only
 * checks shape (non-empty ids), so this is the first point that can confirm
 * the ids actually resolve to a canon character + one of its wardrobes.
 *
 * Throws a 400 ServerError on a dangling characterId/wardrobeId rather than
 * leaning on `buildScenePrompt`'s defensive read, which would silently drop
 * the pick. A dangling id is a client/state bug (stale picker, deleted
 * character) worth surfacing — not a no-op. A null/absent `wardrobeId` is
 * valid (the character renders on their canonical body description); only a
 * non-empty wardrobeId is resolved against the character's wardrobes.
 *
 * Scoped to the request boundary on purpose: the persisted-scene paths
 * (`enqueueStoryboardSceneVideo`, `enqueueStoryboardShotStartFrame`) and the
 * shared `composeVisualPrompt` primitive — also used by episode-video batch
 * stitching — keep `buildScenePrompt`'s resilient silent-drop convention so a
 * single dangling pick can't abort a whole batch render.
 */
export function assertCharacterAppearancesResolve(characterAppearances, characters) {
  const picks = Array.isArray(characterAppearances) ? characterAppearances : [];
  if (!picks.length) return;
  const charById = new Map(
    (Array.isArray(characters) ? characters : [])
      .filter((c) => c && c.id)
      .map((c) => [c.id, c]),
  );
  for (const pick of picks) {
    if (!pick || !pick.characterId) continue;
    const character = charById.get(pick.characterId);
    if (!character) {
      throw new ServerError(
        `characterAppearances references unknown character id "${pick.characterId}"`,
        { status: 400, code: 'PIPELINE_VISUAL_BAD_CHARACTER' },
      );
    }
    if (pick.wardrobeId) {
      const wardrobe = (character.wardrobes || []).find((w) => w && w.id === pick.wardrobeId);
      if (!wardrobe) {
        throw new ServerError(
          `characterAppearances references unknown wardrobe id "${pick.wardrobeId}" for character "${character.name || pick.characterId}"`,
          { status: 400, code: 'PIPELINE_VISUAL_BAD_WARDROBE' },
        );
      }
    }
  }
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
  const { issue, settings, series, world, canon } = await loadBibleContext(issueId);
  assertStageUnlocked(issue, stageId);
  // Resolve wardrobe picks against canon at the request boundary — a dangling
  // characterId/wardrobeId is a client/state bug worth a 400, not the silent
  // drop buildScenePrompt would otherwise apply.
  assertCharacterAppearancesResolve(options.characterAppearances, canon.characters);
  const mode = resolveMode(options, settings);
  // Match on description + slugline so the featured-character set (and thus
  // which wardrobe picks apply) stays consistent with the scene-video / shot
  // paths and the storyboards picker UI — all of which match both fields.
  const matchedCharacters = matchCharactersInText(
    `${options.description || ''} ${options.slugline || ''}`,
    canon.characters,
  );
  const composedPrompt = composeVisualPrompt({
    series,
    description: options.description,
    slugline: options.slugline,
    extraStyle: options.extraStyle || '',
    matchedCharacters,
    world,
    canon,
    // Storyboard scene renders thread the scene's wardrobe picks through the
    // generic visual-image route, which has no scene index to look them up.
    characterAppearances: options.characterAppearances,
  });
  if (!composedPrompt) {
    throw new ServerError('visual prompt is empty (no description, no style)', {
      status: 400, code: 'PIPELINE_VISUAL_EMPTY_PROMPT',
    });
  }

  const { loras: characterLoras } = await applyCharacterLorasToRender({
    matchedCharacters, mode, options, settings,
  });
  // composeVisualPrompt is shared with the episode-video batch path, so the
  // trigger words append here rather than threading a new param through it.
  const triggerClause = characterLoras
    .filter((l) => l.triggerWord)
    .map((l) => `${l.character?.name || 'character'} (${l.triggerWord})`)
    .join(', ');
  const prompt = triggerClause ? `${composedPrompt}\n\nFeaturing ${triggerClause}.` : composedPrompt;

  const jobId = enqueueImageJob({
    prompt, world, settings, mode,
    options: { ...options, ...loraRenderOptions(characterLoras) },
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
  assertStageUnlocked(issue, 'storyboards');
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
    extraStyle: options.extraStyle || '',
    matchedCharacters,
    world,
    canon,
    characterAppearances: scene.characterAppearances,
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

/**
 * Enqueue an image render for a single shot inside a storyboard scene. Mirror
 * of enqueueStoryboardSceneVideo but for IMAGE (start-frame), at shot
 * granularity. Shot description is the primary anchor; falls back to the
 * parent scene's description when the shot is sparse so a fresh shot still
 * renders something coherent.
 */
export async function enqueueStoryboardShotStartFrame(issueId, sceneIndex, shotIndex, options = {}) {
  const sIdx = Number(sceneIndex);
  const tIdx = Number(shotIndex);
  if (!Number.isInteger(sIdx) || sIdx < 0 || !Number.isInteger(tIdx) || tIdx < 0) {
    throw new ServerError('sceneIndex and shotIndex must be non-negative integers', {
      status: 400, code: 'PIPELINE_SHOT_BAD_INDEX',
    });
  }
  const { issue, settings, series, world, canon } = await loadBibleContext(issueId);
  assertStageUnlocked(issue, 'storyboards');
  const scenes = Array.isArray(issue.stages?.storyboards?.scenes)
    ? [...issue.stages.storyboards.scenes]
    : [];
  const scene = scenes[sIdx];
  if (!scene) {
    throw new ServerError(`sceneIndex ${sIdx} out of range (have ${scenes.length})`, {
      status: 404, code: 'PIPELINE_SCENE_NOT_FOUND',
    });
  }
  const shots = Array.isArray(scene.shots) ? [...scene.shots] : [];
  const shot = shots[tIdx];
  if (!shot) {
    throw new ServerError(`shotIndex ${tIdx} out of range (have ${shots.length})`, {
      status: 404, code: 'PIPELINE_SHOT_NOT_FOUND',
    });
  }

  const shotDescription = (shot.description || '').trim();
  const description = shotDescription || (scene.description || '').trim();
  if (!description) {
    throw new ServerError('shot has no description (parent scene also empty) — add a description first', {
      status: 400, code: 'PIPELINE_SHOT_EMPTY_DESCRIPTION',
    });
  }

  const mode = resolveMode(options, settings);
  const matchedCharacters = matchCharactersInText(
    `${description} ${scene.slugline || ''}`,
    canon.characters,
  );
  const prompt = composeVisualPrompt({
    series,
    description,
    slugline: scene.slugline || '',
    extraStyle: options.extraStyle || '',
    matchedCharacters,
    world,
    canon,
    // A shot inherits its parent scene's wardrobe picks.
    characterAppearances: scene.characterAppearances,
  });

  const jobId = enqueueImageJob({
    prompt, world, settings, options, mode,
    owner: buildStoryboardsShotOwner({ issueId, sceneIndex: sIdx, shotIndex: tIdx }),
    logLine: `🎞️ Pipeline shot start-frame — issue=${issueId.slice(0, 8)} scene=${sIdx + 1} shot=${tIdx + 1}`,
  });

  shots[tIdx] = { ...shot, startFrameJobId: jobId };
  scenes[sIdx] = { ...scene, shots };
  const { issue: updatedIssue, stage } = await updateStage(issueId, 'storyboards', {
    status: 'edited',
    scenes,
  });
  return { jobId, mode, prompt, sceneIndex: sIdx, shotIndex: tIdx, issue: updatedIssue, stage };
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


// Validate the page/panel indices, lock, and non-empty description, then
// build the `pipeline-comic-panel-image-prompt` template variables. Shared by
// the 1:1 refine (replaces the description) and the N-candidate fan-out
// (non-destructive) so both feed the LLM identical context.
async function loadComicPanelPromptContext(issueId, pageIndex, panelIndex) {
  const pi = Number(pageIndex);
  const ni = Number(panelIndex);
  if (!Number.isInteger(pi) || pi < 0 || !Number.isInteger(ni) || ni < 0) {
    throw new ServerError('pageIndex and panelIndex must be non-negative integers', {
      status: 400, code: 'PIPELINE_PANEL_BAD_INDEX',
    });
  }
  const { issue, series } = await loadRefineContext(issueId);
  assertStageUnlocked(issue, 'comicPages');
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

  const variables = {
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
  };
  return { issue, pi, ni, pages, page, panels, panel, variables };
}

/**
 * Run the `pipeline-comic-panel-image-prompt` template against the current
 * panel + surrounding context, then persist the refined description on the
 * panel. Returns { panel, page, issue, stage, runId, changes, providerId }.
 */
export async function refineComicPanelPrompt(issueId, pageIndex, panelIndex, options = {}) {
  const { pi, ni, pages, page, panels, panel, variables } =
    await loadComicPanelPromptContext(issueId, pageIndex, panelIndex);

  const { refined, changes, runId, providerId } = await runPromptRefine({
    templateName: 'pipeline-comic-panel-image-prompt',
    variables,
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
 * Generate N candidate image-gen prompts for a single comic panel WITHOUT
 * mutating the panel (issue #904). The user copies one or applies it to the
 * description via the existing refine/edit paths. Returns
 * { candidates, requested, pageIndex, panelIndex }.
 */
export async function generateComicPanelImagePrompts(issueId, pageIndex, panelIndex, { count, ...options } = {}) {
  const { pi, ni, variables } = await loadComicPanelPromptContext(issueId, pageIndex, panelIndex);
  const { candidates, requested } = await runImagePromptCandidates({
    count,
    templateName: 'pipeline-comic-panel-image-prompt',
    variables,
    options,
    source: 'pipeline-comic-panel-image-prompts',
    logTag: `Pipeline comic panel image-prompts — issue=${issueId.slice(0, 8)} p=${pi + 1} panel=${ni + 1}`,
  });
  return { candidates, requested, pageIndex: pi, panelIndex: ni };
}

// Validate the scene index, lock, and non-empty description, then build the
// `pipeline-storyboard-image-prompt` template variables. Shared by the 1:1
// refine and the N-candidate fan-out so both feed the LLM identical context.
async function loadStoryboardScenePromptContext(issueId, sceneIndex) {
  const idx = Number(sceneIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new ServerError('sceneIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_SCENE_BAD_INDEX',
    });
  }
  const { issue, series } = await loadRefineContext(issueId);
  assertStageUnlocked(issue, 'storyboards');
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
  const variables = {
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
  };
  return { issue, idx, scenes, scene, variables };
}

/**
 * Run the `pipeline-storyboard-image-prompt` template against the current
 * storyboard scene + surrounding context, then persist the refined
 * description on the scene. Returns { scene, issue, stage, runId, changes, providerId }.
 */
export async function refineStoryboardScenePrompt(issueId, sceneIndex, options = {}) {
  const { idx, scenes, scene, variables } = await loadStoryboardScenePromptContext(issueId, sceneIndex);

  const { refined, changes, runId, providerId } = await runPromptRefine({
    templateName: 'pipeline-storyboard-image-prompt',
    variables,
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

/**
 * Generate N candidate image-gen prompts for a single storyboard scene
 * WITHOUT mutating the scene (issue #904). Returns
 * { candidates, requested, sceneIndex }.
 */
export async function generateStoryboardSceneImagePrompts(issueId, sceneIndex, { count, ...options } = {}) {
  const { idx, variables } = await loadStoryboardScenePromptContext(issueId, sceneIndex);
  const { candidates, requested } = await runImagePromptCandidates({
    count,
    templateName: 'pipeline-storyboard-image-prompt',
    variables,
    options,
    source: 'pipeline-storyboard-image-prompts',
    logTag: `Pipeline scene image-prompts — issue=${issueId.slice(0, 8)} scene=${idx + 1}`,
  });
  return { candidates, requested, sceneIndex: idx };
}
