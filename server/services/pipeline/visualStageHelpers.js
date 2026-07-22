/**
 * Pipeline — Visual stage shared prompt + enqueue helpers (#2531)
 *
 * Extracted from the former monolithic `visualStages.js` so the covers /
 * comicPages / storyboards feature modules can share ONE set of style + prompt
 * composers, the image-gen enqueue plumbing (`enqueueImageJob`,
 * `applyCharacterLorasToRender`), the proof/reference init-image resolvers, and
 * the LLM-refine context loaders. Pure move — no behavior change.
 */

import { enqueueJob } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import { getSeries, STYLE_PROMPT_OVERRIDE_MODE_DEFAULT } from './series.js';
import { getIssue } from './issues.js';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { getUniverse, joinInfluenceList } from '../universeBuilder.js';
import { ServerError } from '../../lib/errorHandler.js';
import { buildScenePrompt, buildPlaceByKey, matchScenePlace } from '../../lib/scenePrompt.js';
import { composeStyledPrompt } from '../../lib/composeStyledPrompt.js';
import { getImageModels } from '../../lib/mediaModels.js';
import { loraCompatKey } from '../../lib/runners.js';
import { resolveCharacterLoras } from '../characterLoraResolver.js';
import { pickCanon } from './seriesCanon.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';
import { pickUsableMode, resolveCloudProviderConfig } from '../imageGen/cloudProviderConfig.js';
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

// Resolution order for the image-gen mode on a pipeline visual stage — a
// candidate walk (first usable wins) rather than a pairwise ladder, so a new
// cloud backend costs zero edits here:
//   1. Per-request override (`options.mode`) — set by the stage's persisted
//      `genConfig` or an explicit UI selection. A cloud mode is only honored
//      when its `imageGen.<mode>.enabled` toggle is on; a stale 'codex'
//      override from before the toggle was turned off falls through.
//   2. Saved dispatcher default (`settings.imageGen.mode`) — same usability
//      gate, and non-queueable modes (external SD-API, which this surface
//      doesn't proxy) never qualify.
//   3. Auto-default — prefer an enabled cloud backend, since cloud image gen
//      produces print-quality comic pages out of the box. Otherwise fall back
//      to local diffusion (flux-1) the way the original default behaved.
// `pickUsableMode` appends the cloud-then-local tail, so this only lists the
// two explicit candidates. (Sprite renders use the equivalent
// `resolveQueueImageMode` ladder in imageGen/modes.js — #2896 hoisted that
// one first; this is the wider param-assembly consolidation from #2881.)
const resolveMode = (options, settings) => pickUsableMode(settings, [options.mode, settings?.imageGen?.mode]);

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
  const cloud = resolveCloudProviderConfig(settings, mode);
  const params = cloud
    ? { ...cloud.jobParams, cleanC2PA, denoise, ...baseParams }
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



// Shared helpers consumed by covers / comicPages / storyboards. Exported here
// (rather than inline) so the split feature modules reach one implementation.
export {
  stackStyle, buildMastheadClause, buildAuthorClause, applyWorldStyle,
  loadBibleContext, resolveMode, resolveVariant, resolveProofInitImage,
  PROOF_AS_BASE_DEFAULT_STRENGTH, enqueueImageJob, formatBalloon,
  resolvePageReferenceImage, REFERENCE_PAGE_DEFAULT_STRENGTH,
  REFINE_RENDER_DEFAULT_STRENGTH, applyCharacterLorasToRender, loraRenderOptions,
  seriesBibleCtx, issueCtx, neighborText, loadRefineContext,
};
