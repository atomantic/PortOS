/**
 * Pipeline issue routes — Issue/Episode CRUD plus stage operations: text-LLM
 * generation/restore, scene/page/canon extraction, per-page and per-panel
 * renders, prompt refinement, scene/episode video, and the auto-run text
 * chain.
 */

import { Router } from 'express';
import {
  issuePatchSchema,
  generateSchema,
  stageProgressParamsSchema,
  visualGenerateSchema,
  comicPageRenderSchema,
  comicPageRefineSchema,
  episodeVideoSchema,
  sceneVideoSchema,
  promptRefineSchema,
  imagePromptsSchema,
  extractScenesSchema,
  extractComicPagesSchema,
  extractCanonFromScriptSchema,
  describeCanonFromProseSchema,
  comicPagePatchSchema,
  autoRunSchema,
  restoreSchema,
} from '../../lib/pipelineValidation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import { generateStage } from '../../services/pipeline/textStages.js';
import * as textStageProgress from '../../services/pipeline/textStageProgress.js';
import * as autoRunner from '../../services/pipeline/autoRunner.js';
import {
  enqueueVisualImage,
  renderComicPage,
  enqueueStoryboardSceneVideo,
  enqueueStoryboardShotStartFrame,
  refineComicPanelPrompt,
  refineComicPageRender,
  refineStoryboardScenePrompt,
  generateComicPanelImagePrompts,
  generateStoryboardSceneImagePrompts,
} from '../../services/pipeline/visualStages.js';
import {
  extractCanonFromProse, summarizeCanonExtraction,
  describeCanonFromProse, summarizeDescribeGaps,
} from '../../services/universeCanon.js';
import { getSeriesCanon } from '../../services/pipeline/seriesCanon.js';
import { startEpisodeVideoForIssue } from '../../services/pipeline/episodeVideo.js';
import { extractScenes, scenesFromBeatSheet } from '../../services/sceneExtractor.js';
import { resolveSeriesLlmOverride } from '../../lib/seriesLlmOverride.js';
import { parseComicScript } from '../../lib/comicScriptParser.js';
import { ARC_ROLES } from '../../lib/storyArc.js';
import { mapServiceError, countExtractedCanon } from './shared.js';

import textStageRecoveryRouter from './textStageRecovery.js';

const router = Router();

// Stages whose `output` can be mined for canon. `prose` is the conventional
// source (auto-extracted post-generation); `comicScript`/`teleplay` let the
// writer pull characters introduced only in panel directions / dialogue cues.
const CANON_EXTRACT_STAGES = Object.freeze(['prose', 'comicScript', 'teleplay']);

// Per-issue truncation budget for canon extraction. Decoupled from the
// importer's source ceiling (which ingests a *whole book* — millions of
// chars): a pipeline issue's stage output is already hard-bounded at
// `STAGE_OUTPUT_MAX` (400KB), so this path operates at a fundamentally
// smaller scale. 200K clamps a long single-issue script before forwarding
// to the same `extractBible` machinery the importer uses, keeping the
// per-call corpus comfortably inside provider context windows.
const EXTRACT_CANON_CORPUS_MAX = 200_000;

// =====================
// Issue routes
// =====================

// Server-owned issue vocabulary keeps client pickers aligned with persisted
// validation and importer/Creative Director contracts.
router.get('/config', (_req, res) => {
  res.json({ arcRoles: [...ARC_ROLES] });
});

router.get('/issues/:id', asyncHandler(async (req, res) => {
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(issue);
}));

router.patch('/issues/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(issuePatchSchema, req.body ?? {});
  const issue = await issuesSvc.updateIssue(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  res.json(issue);
}));

router.delete('/issues/:id', asyncHandler(async (req, res) => {
  const r = await issuesSvc.deleteIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

// =====================
// Stage operations
// =====================

router.use(textStageRecoveryRouter);

router.post('/issues/:id/stages/:stageId/generate', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (!issuesSvc.TEXT_STAGE_IDS.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" is not generatable via text-LLM. Use the /visual endpoint for image stages.`,
      { status: 400, code: 'PIPELINE_NON_TEXT_STAGE' },
    );
  }
  const body = validateRequest(generateSchema, req.body ?? {});
  const result = await generateStage(id, stageId, body).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Live progress for the POST above (#3393). Subscribe-then-trigger: attaching
// OPENS the channel, so the client can connect before (or concurrently with)
// the generate POST without racing it — and generation runs unchanged when
// nobody is listening. See services/pipeline/textStageProgress.js.
router.get('/issues/:id/stages/:stageId/generate/progress', (req, res) => {
  const { id, stageId } = validateRequest(stageProgressParamsSchema, req.params);
  textStageProgress.attachClient(id, stageId, res);
});

// Restore a prior text-stage version from history. See
// issuesSvc.restoreStageFromHistory for the reversibility semantics.
router.post('/issues/:id/stages/:stageId/restore', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (!issuesSvc.TEXT_STAGE_IDS.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" does not support history restore`,
      { status: 400, code: 'PIPELINE_NON_TEXT_STAGE' },
    );
  }
  const body = validateRequest(restoreSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, stageId);
  const result = await issuesSvc.restoreStageFromHistory(id, stageId, body.runId)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Auto-fill stages.storyboards.scenes[] from a text stage. Reads the issue's
// prose (paragraph-grain) or teleplay (slugline-grain) output, runs the
// shared scene extractor, and replaces stages.storyboards.scenes with the
// result mapped to the storyboards UI shape (visualPrompt → description).
router.post('/issues/:id/stages/storyboards/extract-scenes', asyncHandler(async (req, res) => {
  const body = validateRequest(extractScenesSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'storyboards');

  const existing = Array.isArray(issue.stages?.storyboards?.scenes) ? issue.stages.storyboards.scenes : [];
  if (existing.length > 0 && !body.force) {
    throw new ServerError(
      `Storyboards already has ${existing.length} scene${existing.length === 1 ? '' : 's'} — pass { force: true } to replace`,
      { status: 409, code: 'PIPELINE_STORYBOARDS_NOT_EMPTY' },
    );
  }

  // Adapt a canonical scene to the pipeline storyboards UI shape: alias
  // `visualPrompt → description` (the textarea binding) and reset the per-scene
  // image-gen job fields. Rich fields (heading/summary/dialogue/...) ride along.
  // Fall back to the scene `summary` when there's no visualPrompt so a scene
  // that only carries the beats clause (the canonical-only case below) still
  // seeds a non-empty description — the refine/image/video paths require one.
  const toStoryboardScene = (s) => ({ ...s, description: s.visualPrompt || s.summary || '', imageJobId: null, prompt: null });

  // The beat sheet's canonical `## Scenes` list (#1552) is the single source of
  // truth for scene numbers + sluglines across every adaptation, so when it
  // exists we use it to ALIGN the storyboards scenes — guaranteeing their
  // numbers/sluglines match the comic pages'. But the list is sparse (no
  // dialogue / visual prompts / shots), and downstream stages need that rich
  // data — audio voice-over is built from `storyboards.scenes[].dialogue`. So
  // we still run the LLM extraction over the source text to get the rich fields,
  // then OVERLAY the canonical numbering/sluglines onto it (hybrid). Only when
  // there's no source text to extract from do we fall back to the canonical list
  // alone (deterministic, no dialogue — but there's nothing to extract it from).
  const canonicalScenes = scenesFromBeatSheet(issue.stages?.idea?.output || '');
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });

  const sourceKind = body.from;
  const source = (issue.stages?.[sourceKind]?.output || '').trim();
  if (!source && canonicalScenes.length === 0) {
    throw new ServerError(
      `Cannot extract scenes — issue's ${sourceKind} stage is empty`,
      { status: 400, code: 'PIPELINE_NO_SOURCE_FOR_SCENE_EXTRACT' },
    );
  }

  let extractedScenes = [];
  let runId = null;
  let providerId = null;
  let model = null;
  if (source) {
    // Fall back to the series' configured LLM when the client doesn't pass an
    // explicit override — every Pipeline LLM action should honor the
    // provider/model picked in the issue header (which mirrors series.llm).
    // Canon lives on the linked universe (Phase B.4). Orphan series render
    // with empty canon — extractScenes can still produce scenes from the
    // source text alone, just without character/place/object grounding.
    const canon = await getSeriesCanon(series);
    // A model id is provider-specific, so only inherit the series model when the
    // effective provider is still the series provider — otherwise an override
    // provider would be paired with a foreign model id and fail (same guard as
    // the extract-canon route). When the override switches providers without
    // naming a model, leave it blank so the new provider's default resolves.
    const { provider, model: resolvedModel } = resolveSeriesLlmOverride(series, {
      overrideProvider: body.providerOverride,
      overrideModel: body.modelOverride,
    });
    const result = await extractScenes({
      source,
      sourceKind,
      characters: canon.characters,
      places: canon.places,
      objects: canon.objects,
      work: { title: issue.title, kind: 'tv-episode' },
      series: { name: series.name, styleNotes: series.styleNotes },
      issue: { number: issue.number, title: issue.title },
      providerOverride: provider,
      modelOverride: resolvedModel,
      tag: `pipeline-storyboards-extract-${sourceKind}`,
    });
    extractedScenes = result.extracted.scenes;
    runId = result.runId;
    providerId = result.providerId;
    model = result.model;
  }

  // Overlay the canonical numbering/sluglines/headings onto the extracted scenes
  // (matched by position) when a canonical list exists — the canonical list wins
  // on identity/ordering while the LLM scene contributes dialogue/visualPrompt/
  // shots/characters. Extracted scenes beyond the canonical count are dropped so
  // the storyboards scene count matches the canonical (and comic-page) scene
  // count; canonical scenes beyond the extracted count carry no dialogue (there
  // was no matching extracted scene), seeding their description from the summary.
  const usedCanonicalList = canonicalScenes.length > 0;
  const finalScenes = usedCanonicalList
    ? canonicalScenes.map((c, i) => {
        // Base on the canonical scene `c` (full sanitized shape with empty
        // dialogue/shots/characters), overlay the LLM scene's rich fields, then
        // re-assert canonical identity (id/heading/slugline) so the canonical
        // numbering always wins. When there's no matching extracted scene
        // (`ext` is {}), the result is just `c` — empty dialogue, summary-seeded
        // description.
        const ext = extractedScenes[i] || {};
        return { ...c, ...ext, id: c.id, heading: c.heading, slugline: c.slugline, summary: ext.summary || c.summary };
      })
    : extractedScenes;

  const storyboardScenes = finalScenes.map(toStoryboardScene);
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(issue.id, 'storyboards', {
    status: storyboardScenes.length ? 'ready' : 'empty',
    scenes: storyboardScenes,
    lastRunId: runId,
    errorMessage: '',
  });

  res.json({
    issue: updatedIssue,
    stage,
    runId,
    providerId,
    model,
    sceneCount: storyboardScenes.length,
    // 'beat-sheet' when the response is purely the canonical list (no source to
    // extract from); otherwise the LLM source stage the rich fields came from.
    sourceKind: source ? sourceKind : 'beat-sheet',
    usedCanonicalList,
  });
}));

router.post('/issues/:id/stages/comicPages/extract-pages', asyncHandler(async (req, res) => {
  const body = validateRequest(extractComicPagesSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'comicPages');

  const source = (issue.stages?.comicScript?.output || '').trim();
  if (!source) {
    throw new ServerError(
      `Cannot extract pages — issue's comicScript stage is empty`,
      { status: 400, code: 'PIPELINE_NO_SOURCE_FOR_PAGE_EXTRACT' },
    );
  }

  const existing = Array.isArray(issue.stages?.comicPages?.pages) ? issue.stages.comicPages.pages : [];
  if (existing.length > 0 && !body.force) {
    throw new ServerError(
      `Comic pages already has ${existing.length} page${existing.length === 1 ? '' : 's'} — pass { force: true } to replace`,
      { status: 409, code: 'PIPELINE_COMIC_PAGES_NOT_EMPTY' },
    );
  }

  const { pages, coverConcept, backCoverConcept } = parseComicScript(source);

  // Preserve a user-edited cover / back-cover script if one is already set —
  // only seed from the parsed concept when the slot is currently blank.
  // Otherwise an extract re-run would clobber a hand-curated cover/back. When
  // we DO seed, also clear any prior imageJobId / prompt — they were
  // rendered against the old (likely placeholder / fallback) script, so
  // leaving them would show a rendered image that doesn't match the new
  // concept text.
  //
  // The decision is made inside updateStageWithLatest so it reads the
  // freshest persisted cover/back, not the stale snapshot from the
  // getIssue read above. A concurrent cover/render call that writes
  // imageJobId between the two awaits would otherwise be silently
  // overwritten.
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    issue.id,
    'comicPages',
    (currentStage) => {
      const currentCoverScript = currentStage?.cover?.script || '';
      const nextCover = coverConcept && !currentCoverScript
        ? { script: coverConcept, imageJobId: null, prompt: null }
        : currentStage?.cover ?? null;
      const currentBackScript = currentStage?.backCover?.script || '';
      const nextBackCover = backCoverConcept && !currentBackScript
        ? { script: backCoverConcept, imageJobId: null, prompt: null }
        : currentStage?.backCover ?? null;
      return {
        status: pages.length ? 'ready' : 'empty',
        pages,
        cover: nextCover,
        backCover: nextBackCover,
        errorMessage: '',
      };
    },
  );

  const panelCount = pages.reduce((n, p) => n + (p.panels?.length || 0), 0);
  res.json({
    issue: updatedIssue,
    stage,
    pageCount: pages.length,
    panelCount,
  });
}));

// Auto-extract runs only after `prose` (textStages.js:233); this endpoint
// lets the writer pull canon from a script stage on demand so characters
// introduced only in panel directions or dialogue cues land in the bible.
// Same autoLock + sourceSeriesId stamping as prose extraction so script-
// derived entries survive later AI refines.
router.post('/issues/:id/stages/:stageId/extract-canon', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (!CANON_EXTRACT_STAGES.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" does not support canon extraction — supported: ${CANON_EXTRACT_STAGES.join(', ')}`,
      { status: 400, code: 'PIPELINE_CANON_EXTRACT_BAD_STAGE' },
    );
  }
  const body = validateRequest(extractCanonFromScriptSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(id).catch((err) => { throw mapServiceError(err); });
  const rawCorpus = (issue.stages?.[stageId]?.output || '').trim();
  if (!rawCorpus) {
    throw new ServerError(
      `Cannot extract canon — issue's ${stageId} stage is empty`,
      { status: 400, code: 'PIPELINE_CANON_EXTRACT_NO_CORPUS' },
    );
  }
  const truncated = rawCorpus.length > EXTRACT_CANON_CORPUS_MAX;
  const corpus = truncated ? rawCorpus.slice(0, EXTRACT_CANON_CORPUS_MAX) : rawCorpus;
  if (truncated) {
    console.warn(`⚠️ Pipeline canon extract — issue=${id.slice(0, 8)} stage=${stageId} corpus truncated ${rawCorpus.length}→${EXTRACT_CANON_CORPUS_MAX}`);
  }
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });
  if (!series.universeId) {
    throw new ServerError(
      `Cannot extract canon — series has no linked universe. Link a universe in the series settings first.`,
      { status: 400, code: 'PIPELINE_CANON_EXTRACT_NO_UNIVERSE' },
    );
  }
  // Fall back to the series' configured LLM when the client doesn't pass an
  // explicit override — matches every other Pipeline LLM action (e.g.
  // storyboards/extract-scenes) so a manual extract honors the provider/model
  // picked in the series header instead of the global default.
  // A model id is provider-specific. Only inherit the series model when the
  // EFFECTIVE provider is still the series provider — otherwise the retry
  // picker's whole point (switch provider, keep "Default model") would forward
  // e.g. `providerOverride: anthropic` paired with a Codex/OpenAI model id and
  // fail. When the user overrode to a different provider without naming a
  // model, leave it blank so the extractor resolves that provider's default.
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: body.providerOverride,
    overrideModel: body.model,
  });

  // Stamp the outcome on the stage so the Nouns UI can persist a
  // failure/partial banner and the user can retry with a different
  // provider/model. A hard failure (every kind threw) still records `failed`
  // before re-throwing so the banner survives even when the request 5xxes.
  let result;
  try {
    result = await extractCanonFromProse(series.universeId, {
      corpus,
      providerOverride: provider,
      modelOverride: model,
      parallel: true,
      autoLock: true,
      sourceSeriesId: series.id,
    });
  } catch (err) {
    const marker = summarizeCanonExtraction({ error: err, provider, model });
    await issuesSvc.updateStage(id, stageId, { canonExtraction: marker })
      .catch((e) => console.warn(`⚠️ Failed to record canon-extraction status for issue ${id.slice(0, 8)}: ${e.message}`));
    throw mapServiceError(err);
  }

  const marker = summarizeCanonExtraction({ results: result.results, failures: result.failures, provider, model });
  const { issue: stampedIssue } = await issuesSvc.updateStage(id, stageId, { canonExtraction: marker })
    .catch((err) => { throw mapServiceError(err); });

  res.json({
    universe: result.universe,
    issue: stampedIssue,
    canonExtraction: marker,
    failures: result.failures,
    extracted: countExtractedCanon(result.results),
    sourceStage: stageId,
    truncated,
  });
}));

// Backfill descriptions for canon nouns that have none, using ONLY what this
// stage's prose establishes. Distinct from extract-canon: extraction invents +
// flags missing renderable axes (so it never leaves a blank), while this pass
// is strictly prose-grounded — a noun the prose never describes comes back in
// the `descGaps` marker so the Nouns UI can flag the manuscript as thin instead
// of fabricating a description that the prose can't support.
router.post('/issues/:id/stages/:stageId/describe-canon', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (!CANON_EXTRACT_STAGES.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" does not support canon description — supported: ${CANON_EXTRACT_STAGES.join(', ')}`,
      { status: 400, code: 'PIPELINE_CANON_DESCRIBE_BAD_STAGE' },
    );
  }
  const body = validateRequest(describeCanonFromProseSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(id).catch((err) => { throw mapServiceError(err); });
  const rawCorpus = (issue.stages?.[stageId]?.output || '').trim();
  if (!rawCorpus) {
    throw new ServerError(
      `Cannot describe canon — issue's ${stageId} stage is empty`,
      { status: 400, code: 'PIPELINE_CANON_DESCRIBE_NO_CORPUS' },
    );
  }
  const corpus = rawCorpus.length > EXTRACT_CANON_CORPUS_MAX
    ? rawCorpus.slice(0, EXTRACT_CANON_CORPUS_MAX)
    : rawCorpus;
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });
  if (!series.universeId) {
    throw new ServerError(
      `Cannot describe canon — series has no linked universe. Link a universe in the series settings first.`,
      { status: 400, code: 'PIPELINE_CANON_DESCRIBE_NO_UNIVERSE' },
    );
  }
  // Same provider/model resolution as extract-canon so a manual describe honors
  // the series-header LLM (or the per-attempt picker override).
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: body.providerOverride,
    overrideModel: body.model,
  });

  const result = await describeCanonFromProse(series.universeId, {
    corpus,
    targets: body.targets,
    providerOverride: provider,
    modelOverride: model,
  }).catch((err) => { throw mapServiceError(err); });

  const marker = summarizeDescribeGaps({ report: result.report, provider, model });
  const { issue: stampedIssue } = await issuesSvc.updateStage(id, stageId, { descGaps: marker })
    .catch((err) => { throw mapServiceError(err); });

  res.json({
    universe: result.universe,
    issue: stampedIssue,
    descGaps: marker,
    report: result.report,
    sourceStage: stageId,
  });
}));

// Per-page rawText patch — re-parses panels from the edited markdown so a
// subsequent render still gets a structured prompt. Page's `imageJobId` is
// preserved so the user doesn't lose an in-flight render after a save.
//
// The splice + per-panel imageJobId preservation runs inside
// updateStageWithLatest's computeFn so it reads the freshest persisted pages
// array. A concurrent page-level render that lands between a pre-queue read
// and our write would otherwise be reverted — including the imageJobId it
// just queued.
router.patch('/issues/:id/stages/comicPages/pages/:pageIndex', asyncHandler(async (req, res) => {
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const body = validateRequest(comicPagePatchSchema, req.body ?? {});
  const { pages: reparsed } = parseComicScript(body.rawText);
  const fresh = reparsed[0] || { panels: [], rawText: body.rawText };

  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'comicPages',
    (currentStage) => {
      const currentPages = Array.isArray(currentStage?.pages) ? currentStage.pages : [];
      if (!currentPages[pageIndex]) {
        throw new ServerError(
          `pageIndex ${pageIndex} out of range — comicPages has ${currentPages.length} page${currentPages.length === 1 ? '' : 's'}`,
          { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
        );
      }
      const nextPages = [...currentPages];
      nextPages[pageIndex] = {
        ...currentPages[pageIndex],
        rawText: fresh.rawText || body.rawText,
        // Re-derive the scene marker from the edited header so editing
        // `## Page N — Scene M: SLUGLINE` retags the page (and clears it when
        // the marker is removed). `?? null` normalizes the absent case.
        sceneNumber: fresh.sceneNumber ?? null,
        sceneHeading: fresh.sceneHeading ?? null,
        panels: fresh.panels.map((p, i) => ({
          ...p,
          // Preserve in-flight per-panel jobIds against the freshest panels.
          imageJobId: currentPages[pageIndex].panels?.[i]?.imageJobId ?? p.imageJobId ?? null,
        })),
      };
      return { status: 'edited', pages: nextPages };
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage, page: stage.pages[pageIndex] });
}));

// Render a full comic page (multi-panel layout in one image) — the
// recommended default for cloud-class image models (Codex, Google Imagen);
// local diffusion models can render this but tend to produce draft-quality
// pages, so the per-panel `/visual` endpoint remains the fallback.
//
// Persists the returned jobId on stages.comicPages.pages[pageIndex].imageJobId
// so the UI can show the page-level render alongside the per-panel renders.
router.post('/issues/:id/stages/comicPages/pages/:pageIndex/render', asyncHandler(async (req, res) => {
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const body = validateRequest(comicPageRenderSchema, req.body ?? {});

  // Validate the page exists up front so we skip the enqueue work entirely
  // when the index is bad. The service also throws ServerError(404) for the
  // same case (defense in depth — any other caller still gets a clean 404),
  // but checking here avoids loading the bible context just to error out.
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? issue.stages.comicPages.pages : [];
  if (!pages[pageIndex]) {
    throw new ServerError(
      `pageIndex ${pageIndex} out of range — comicPages has ${pages.length} page${pages.length === 1 ? '' : 's'}`,
      { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
    );
  }

  // renderComicPage enqueues AND persists the in-flight slot onto
  // pages[pageIndex].{proofImage|finalImage} through the serialized issue write
  // tail (#2241) — the same shared entry point the CDO orchestrator tool calls,
  // so an orchestrated page completes exactly like a user-driven one. The
  // persist runs inside updateStageWithLatest's computeFn so the slot lands on
  // the freshest persisted pages array (a concurrent page edit or sibling
  // render can't be reverted by a stale snapshot).
  const result = await renderComicPage(req.params.id, { pageIndex, ...body })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// AI prompt-refine + image-to-image re-render for a small correction to an
// already-rendered comic page (issue #1534). The service adjusts the page's
// stored render prompt per the user's instruction and re-renders i2i from the
// page's existing image; the new jobId + adjusted prompt land on the matching
// variant slot — same persist path as /render, so a concurrent edit or sibling
// render can't be reverted by a stale snapshot.
router.post('/issues/:id/stages/comicPages/pages/:pageIndex/refine-render', asyncHandler(async (req, res) => {
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const body = validateRequest(comicPageRefineSchema, req.body ?? {});

  // Validate the page exists up front so a bad index skips the bible load + LLM
  // refine entirely (mirrors the /render route's pre-flight). The service also
  // 404s before the LLM call — this just fails faster and more cheaply.
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? issue.stages.comicPages.pages : [];
  if (!pages[pageIndex]) {
    throw new ServerError(
      `pageIndex ${pageIndex} out of range — comicPages has ${pages.length} page${pages.length === 1 ? '' : 's'}`,
      { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
    );
  }

  // refineComicPageRender adjusts the page's stored render prompt (LLM),
  // re-renders i2i from the page's existing image, AND persists the new slot on
  // the matching variant through the serialized issue write tail (#2241) — same
  // shared code path the CDO orchestrator tool uses. A concurrent edit or
  // sibling render can't be reverted by a stale snapshot.
  const result = await refineComicPageRender(req.params.id, { pageIndex, ...body })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// AI-driven prompt refinement for a single comic panel. Uses
// pipeline-comic-panel-image-prompt stage to elaborate the panel's existing
// description into a richer image-gen prompt, then persists the result on
// the panel.
router.post('/issues/:id/stages/comicPages/pages/:pageIndex/panels/:panelIndex/refine-prompt',
  asyncHandler(async (req, res) => {
    const body = validateRequest(promptRefineSchema, req.body ?? {});
    const result = await refineComicPanelPrompt(
      req.params.id,
      Number(req.params.pageIndex),
      Number(req.params.panelIndex),
      body,
    ).catch((err) => { throw mapServiceError(err); });
    res.json(result);
  }),
);

// Non-destructive N-candidate variant: generate `count` alternative image-gen
// prompts for one comic panel without touching the panel description. The
// client lists them and lets the user copy or apply one (issue #904).
router.post('/issues/:id/stages/comicPages/pages/:pageIndex/panels/:panelIndex/image-prompts',
  asyncHandler(async (req, res) => {
    const body = validateRequest(imagePromptsSchema, req.body ?? {});
    const result = await generateComicPanelImagePrompts(
      req.params.id,
      Number(req.params.pageIndex),
      Number(req.params.panelIndex),
      body,
    ).catch((err) => { throw mapServiceError(err); });
    res.json(result);
  }),
);

// AI-driven prompt refinement for a single storyboard scene. Mirror of the
// comic-panel refine but uses pipeline-storyboard-image-prompt.
router.post('/issues/:id/stages/storyboards/scenes/:index/refine-prompt',
  asyncHandler(async (req, res) => {
    const body = validateRequest(promptRefineSchema, req.body ?? {});
    const result = await refineStoryboardScenePrompt(
      req.params.id,
      Number(req.params.index),
      body,
    ).catch((err) => { throw mapServiceError(err); });
    res.json(result);
  }),
);

// Non-destructive N-candidate variant for a storyboard scene (issue #904).
router.post('/issues/:id/stages/storyboards/scenes/:index/image-prompts',
  asyncHandler(async (req, res) => {
    const body = validateRequest(imagePromptsSchema, req.body ?? {});
    const result = await generateStoryboardSceneImagePrompts(
      req.params.id,
      Number(req.params.index),
      body,
    ).catch((err) => { throw mapServiceError(err); });
    res.json(result);
  }),
);

// Render the start-frame image for a single shot inside a storyboard scene.
// Shot-level granularity sits parallel to the existing scene-level image
// render: a scene either has shots[] (per-shot images) or doesn't (per-scene
// image). Caller persists the jobId on `scene.shots[shotIndex].startFrameJobId`;
// the storyboards filename hook later stamps `startFrameFilename` on
// completion.
router.post(
  '/issues/:id/stages/storyboards/scenes/:sceneIndex/shots/:shotIndex/render',
  asyncHandler(async (req, res) => {
    const sceneIndex = Number(req.params.sceneIndex);
    const shotIndex = Number(req.params.shotIndex);
    if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || !Number.isInteger(shotIndex) || shotIndex < 0) {
      throw new ServerError('sceneIndex and shotIndex must be non-negative integers', {
        status: 400, code: 'PIPELINE_SHOT_BAD_INDEX',
      });
    }
    const body = validateRequest(comicPageRenderSchema, req.body ?? {});
    const result = await enqueueStoryboardShotStartFrame(req.params.id, sceneIndex, shotIndex, body)
      .catch((err) => { throw mapServiceError(err); });
    res.json(result);
  }),
);

// Render a single storyboard scene as a video clip, independent of the
// full episode-video stitch. Persists the resulting jobId on the scene's
// `sceneVideoJobId` so a reload still shows the in-flight render.
router.post('/issues/:id/stages/storyboards/scenes/:index/video', asyncHandler(async (req, res) => {
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new ServerError('scene index must be a non-negative integer', {
      status: 400, code: 'PIPELINE_SCENE_BAD_INDEX',
    });
  }
  const body = validateRequest(sceneVideoSchema, req.body ?? {});
  const result = await enqueueStoryboardSceneVideo(req.params.id, idx, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.post('/issues/:id/stages/:stageId/visual', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (!issuesSvc.VISUAL_STAGE_IDS.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" is not a visual stage. Use /generate for text-LLM stages.`,
      { status: 400, code: 'PIPELINE_NON_VISUAL_STAGE' },
    );
  }
  if (stageId === 'episodeVideo') {
    const body = validateRequest(episodeVideoSchema, req.body ?? {});
    const result = await startEpisodeVideoForIssue(id, body).catch((err) => { throw mapServiceError(err); });
    res.json(result);
    return;
  }
  const body = validateRequest(visualGenerateSchema, req.body ?? {});
  const result = await enqueueVisualImage(id, stageId, body).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// =====================
// Auto-run text chain
// =====================

router.post('/issues/:id/auto-run-text', asyncHandler(async (req, res) => {
  const body = validateRequest(autoRunSchema, req.body ?? {});
  // Validate the issue exists before kicking off the runner so a bad id
  // returns 404 instead of a half-started run.
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const result = await autoRunner.startAutoRunTextStages(req.params.id, body);
  res.json({
    ...result,
    sseUrl: `/api/pipeline/issues/${req.params.id}/auto-run-text/progress`,
  });
}));

router.get('/issues/:id/auto-run-text/progress', (req, res) => {
  const attached = autoRunner.attachClient(req.params.id, res);
  if (!attached) {
    throw new ServerError('No active auto-run for this issue', { status: 404 });
  }
});

router.post('/issues/:id/auto-run-text/cancel', asyncHandler(async (req, res) => {
  const canceled = autoRunner.cancelAutoRun(req.params.id);
  res.json({ canceled });
}));

export default router;
