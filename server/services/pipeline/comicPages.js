/**
 * Pipeline — Comic page renders + panel prompt refine (#2531)
 *
 * Comic-page prompt composition, page/panel image enqueue + persist, the
 * per-page image-to-image refine, the generic visual-image enqueue, and the
 * consistency-reference resolvers. Extracted from the former monolithic
 * `visualStages.js`; shares plumbing via `./visualStageHelpers.js`.
 */

import { updateStage, updateStageWithLatest, assertStageUnlocked, VISUAL_STAGE_IDS } from './issues.js';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { buildComicPagesOwner, slotKeyForVariant } from './owners.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  buildCharByKey, matchSceneCharacters, matchCharactersInText,
  matchPlacesInText, matchObjectsInText,
} from '../../lib/scenePrompt.js';
import { flattenCanonDescriptorFragments, richCanonDescriptorFragments } from '../../lib/canonPrompt.js';
import { sameComicScene } from '../../lib/comicScriptParser.js';
import { runPromptRefine, runImagePromptCandidates } from './refineHelpers.js';
import {
  applyWorldStyle, stackStyle, formatBalloon, loadBibleContext, resolveMode,
  resolveVariant, resolveProofInitImage, resolvePageReferenceImage,
  REFERENCE_PAGE_DEFAULT_STRENGTH, PROOF_AS_BASE_DEFAULT_STRENGTH,
  REFINE_RENDER_DEFAULT_STRENGTH, applyCharacterLorasToRender, loraRenderOptions,
  enqueueImageJob, buildRenderSlot, composeVisualPrompt, seriesBibleCtx,
  issueCtx, neighborText, loadRefineContext, assertCharacterAppearancesResolve,
} from './visualStageHelpers.js';

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
 * Splice an in-flight render slot onto
 * `stages.comicPages.pages[pageIndex].{proofImage|finalImage}` through
 * `updateStageWithLatest` (the serialized issue write tail) so a concurrent
 * page edit or sibling render that wrote between the enqueue and this persist
 * can't be reverted by a stale snapshot. Shared by `renderComicPage` and
 * `refineComicPageRender` — the filename hook only attaches the completed
 * image when the target slot already carries the returned jobId (the reason
 * this write must live behind the shared entry points, not only in the route).
 *
 * Returns { issue, stage } from the write tail.
 */
async function persistComicPageSlot(issueId, pageIndex, { variant, jobId, prompt, width, height, fromProof }) {
  const slotKey = slotKeyForVariant(variant);
  const slotRecord = buildRenderSlot({ slotKey, jobId, prompt, width, height, fromProof });
  return updateStageWithLatest(issueId, 'comicPages', (currentStage) => {
    const currentPages = Array.isArray(currentStage?.pages) ? currentStage.pages : [];
    if (!currentPages[pageIndex]) {
      throw new ServerError(
        `pageIndex ${pageIndex} out of range — comicPages has ${currentPages.length} page${currentPages.length === 1 ? '' : 's'}`,
        { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
      );
    }
    const nextPages = [...currentPages];
    nextPages[pageIndex] = { ...currentPages[pageIndex], [slotKey]: slotRecord };
    return { status: 'edited', pages: nextPages };
  });
}

/**
 * Enqueue + persist a full comic-page render in ONE service call — the shared
 * entry point behind both the route handler and the CDO orchestrator tool
 * (#2241, mirroring the #2234 cover treatment). The bare `enqueueVisualComicPage`
 * only queues the job; the filename hook attaches the completed render ONLY if
 * `pages[pageIndex]`'s active variant slot already carries the returned jobId,
 * and that slot write used to live in the route handler. Extracting it here
 * means the orchestrator gets orchestrated pages instead of silently dropping
 * them. `options` mirrors the route body (target/useProofAsBase/referencePage,
 * width/height, mode, …).
 *
 * Returns the enqueue result plus the persisted { issue, stage }.
 */
export async function renderComicPage(issueId, options = {}) {
  const result = await enqueueVisualComicPage(issueId, options);
  const { issue, stage } = await persistComicPageSlot(issueId, result.pageIndex, {
    variant: result.variant, jobId: result.jobId, prompt: result.prompt,
    width: options.width, height: options.height, fromProof: result.fromProof,
  });
  return { ...result, issue, stage };
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
  const { issue: persistedIssue, stage } = await persistComicPageSlot(issueId, pageIndex, {
    variant, jobId, prompt: refined, width: options.width, height: options.height,
  });
  return { jobId, mode, prompt: refined, pageIndex, variant, changes, runId, providerId, issue: persistedIssue, stage };
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

