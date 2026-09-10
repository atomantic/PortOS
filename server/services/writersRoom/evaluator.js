/**
 * Writers Room — manual AI passes against a draft (evaluate / format / script).
 * Snapshots persist immutably under data/writers-room/works/<id>/analysis/ and
 * pin the source draft's contentHash so the UI can flag stale results.
 */

import { join } from 'path';
import { readFile, readdir } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, safeJSONParse, tryReadFile, rmGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { runStagedLLM } from '../stageRunner.js';
import { extractJson as extractJsonShared } from '../../lib/jsonExtract.js';
import { extractBible } from '../bibleExtractor.js';
import { extractScenes, SOURCE_KIND } from '../sceneExtractor.js';
import { BIBLE_KIND } from '../../lib/storyBible.js';
import { ANALYSIS_KINDS } from '../../lib/writersRoomPresets.js';
import { CUT_TYPES } from '../../lib/editorial/cutApplier.js';
import {
  getWorkWithBody, ensureWorkMediaCollection, buildSegmentIndex, renderWorkCharacterEvolutions,
} from './local.js';
import { addItem as addCollectionItem, ERR_DUPLICATE } from '../mediaCollections.js';
import { pickCastFramework } from '../../lib/characterFramework.js';
import { listCharacters, mergeExtractedCharacters } from './characters.js';
import { listPlaces, mergeExtractedPlaces } from './places.js';
import { listObjects, mergeExtractedObjects } from './objects.js';
import { nowIso, badRequest, notFound, assertValidWorkId } from './_shared.js';

export { ANALYSIS_KINDS };

// `cuts` and `revise` are the two Polish-loop pass kinds (#2173). They are NOT
// in ANALYSIS_KINDS — they never run as standalone user analyses (no snapshot
// row in the analysis history); the multi-pass Polish runner (polish.js) drives
// them against the work body directly. They live here so the stage-name +
// returnsJson mapping stays single-sourced.
export const KIND_META = {
  evaluate:   { stage: 'writers-room-evaluate',   returnsJson: true },
  format:     { stage: 'writers-room-format',     returnsJson: false },
  script:     { stage: 'writers-room-script',     returnsJson: true },
  characters: { stage: 'writers-room-characters', returnsJson: true },
  places:     { stage: 'writers-room-places',     returnsJson: true },
  objects:    { stage: 'writers-room-objects',    returnsJson: true },
  cuts:       { stage: 'writers-room-cuts',       returnsJson: true },
  revise:     { stage: 'writers-room-revise',     returnsJson: false },
};

// Analysis id == kind. Each work keeps at most one snapshot per kind on disk
// (re-running a kind overwrites the previous snapshot via atomicWrite).
const isValidAnalysisId = (id) => typeof id === 'string' && ANALYSIS_KINDS.includes(id);
const LEGACY_ANALYSIS_ID_RE = /^wr-analysis-[0-9a-f-]+$/i;

const root = () => join(PATHS.data, 'writers-room');
const analysisDir = (workId) => {
  // Defense-in-depth: refuse path-traversal-shaped workIds before
  // interpolating them into the on-disk path. Mirrors the guard in
  // characters.js / places.js.
  assertValidWorkId(workId);
  return join(root(), 'works', workId, 'analysis');
};
const analysisPath = (workId, id) => join(analysisDir(workId), `${id}.json`);

// ---------- response parsing ----------

function extractJsonResponse(text, shapePredicate) {
  // runStagedLLM parses returnsJson stages before handing the result to the
  // shaper. Keep that object boundary accepted so the shared extractor only
  // handles raw strings from direct callers; otherwise every JSON Writers
  // Room pass would fail with "Empty AI response" after the migration.
  if (text && typeof text === 'object') return text;
  if (!text || typeof text !== 'string') throw new Error('Empty AI response');
  const { value, lastError } = extractJsonShared(text, {
    // Writers Room prompts include fenced JSON schemas. Walk every candidate
    // so a provider's echoed schema cannot become the analysis.
    skipInnerFence: true,
    shapePredicate,
  });
  if (value === undefined) {
    throw new Error(`Failed to parse AI response${lastError ? `: ${lastError.message}` : ''}`);
  }
  return value;
}

// Strip a leading/trailing markdown code fence from a prose response — some
// providers wrap returned prose in a ```markdown … ``` block.
function stripProseFence(raw) {
  let text = String(raw ?? '').trim();
  const fence = text.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)```$/);
  if (fence) text = fence[1].trim();
  return text;
}

export const SHAPERS = {
  format: (raw) => ({ formattedBody: stripProseFence(raw) }),
  evaluate: (raw) => {
    const parsed = extractJsonResponse(raw, (value) => value && typeof value === 'object'
      && !Array.isArray(value)
      && ['logline', 'summary', 'themes', 'strengths', 'issues', 'suggestions']
        .some((key) => key in value));
    return {
      logline: typeof parsed.logline === 'string' ? parsed.logline : null,
      summary: typeof parsed.summary === 'string' ? parsed.summary : null,
      themes: Array.isArray(parsed.themes) ? parsed.themes.filter((t) => typeof t === 'string') : [],
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.filter((s) => typeof s === 'string') : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i) => i && typeof i === 'object') : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s) => s && typeof s === 'object') : [],
    };
  },
  // Adversarial-cut pass (#2173). Shapes the ruthless-editor JSON into typed cut
  // findings the mechanical applier can consume (anchorQuote + cutType), plus the
  // health signals (fat %, protected passage). Findings without a usable anchor
  // quote or a recognized cut type are dropped — the applier can't act on them.
  cuts: (raw) => {
    const parsed = extractJsonResponse(raw, (value) => value && typeof value === 'object'
      && !Array.isArray(value) && (Array.isArray(value.findings)
        || typeof value.fat_percentage === 'number'));
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return {
      fatPercentage: typeof parsed.fat_percentage === 'number' ? parsed.fat_percentage : null,
      tightestPassage: typeof parsed.tightest_passage === 'string' ? parsed.tightest_passage : null,
      loosestPassage: typeof parsed.loosest_passage === 'string' ? parsed.loosest_passage : null,
      oneSentenceVerdict: typeof parsed.one_sentence_verdict === 'string' ? parsed.one_sentence_verdict : null,
      findings: rawFindings
        .filter((f) => f && typeof f === 'object')
        .map((f) => ({
          severity: typeof f.severity === 'string' ? f.severity : 'low',
          location: typeof f.location === 'string' ? f.location : null,
          problem: typeof f.problem === 'string' ? f.problem : '',
          suggestion: typeof f.suggestion === 'string' ? f.suggestion : '',
          anchorQuote: typeof f.anchorQuote === 'string' ? f.anchorQuote : '',
          cutType: CUT_TYPES.includes(f.cutType) ? f.cutType : null,
        }))
        .filter((f) => f.anchorQuote && f.cutType),
    };
  },
  // Brief-driven rewrite (#2173) returns prose only (returnsJson:false).
  revise: (raw) => ({ revisedBody: stripProseFence(raw) }),
  // characters / places / objects route through `extractBible`,
  // and `script` routes through `extractScenes` — no per-kind shaper here.
};

const BIBLE_ANALYSIS = Object.freeze({
  characters: { kind: BIBLE_KIND.CHARACTER, list: listCharacters,  merge: mergeExtractedCharacters },
  places:     { kind: BIBLE_KIND.PLACE,     list: listPlaces,      merge: mergeExtractedPlaces },
  objects:    { kind: BIBLE_KIND.OBJECT,    list: listObjects,     merge: mergeExtractedObjects },
});

const isBibleKind = (k) => k in BIBLE_ANALYSIS;

// ---------- storage ----------

async function listAnalysisIds(workId) {
  const dir = analysisDir(workId);
  await ensureDir(dir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .filter(isValidAnalysisId);
}

async function loadAnalysis(workId, id) {
  const content = await readFile(analysisPath(workId, id), 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (content === null) return null;
  const parsed = safeJSONParse(content, null, { allowArray: false, logError: true, context: analysisPath(workId, id) });
  // `allowArray: false` only rejects a root array — a bare JSON scalar
  // (corrupted analysis) still parses, and callers spread this into a
  // response object, so guard for a genuine object here.
  return parsed && typeof parsed === 'object' ? parsed : null;
}

async function saveAnalysis(workId, snapshot) {
  await ensureDir(analysisDir(workId));
  await atomicWrite(analysisPath(workId, snapshot.id), snapshot);
}

function summarize(a) {
  return {
    id: a.id,
    workId: a.workId,
    kind: a.kind,
    status: a.status,
    draftVersionId: a.draftVersionId,
    sourceContentHash: a.sourceContentHash,
    providerId: a.providerId,
    model: a.model,
    error: a.error || null,
    createdAt: a.createdAt,
    completedAt: a.completedAt,
  };
}

export async function listAnalyses(workId) {
  const ids = await listAnalysisIds(workId);
  const all = await Promise.all(ids.map((id) => loadAnalysis(workId, id)));
  return all
    .filter(Boolean)
    .map(summarize)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function getAnalysis(workId, id) {
  if (!isValidAnalysisId(id)) throw badRequest('Invalid analysis id');
  const a = await loadAnalysis(workId, id);
  if (!a) throw notFound('Analysis');
  return a;
}

// Persist the per-scene generated-image reference on the analysis snapshot so
// the UI can re-show the image after navigation/reload. Scenes are keyed by
// their `result.scenes[i].id`; we don't validate the id against the scene
// list because the LLM occasionally drifts (regenerated analyses can have
// different scene ids) and overwriting an old key is harmless.
export async function attachSceneImage(workId, id, { sceneId, filename, jobId, prompt }) {
  if (!isValidAnalysisId(id)) throw badRequest('Invalid analysis id');
  if (typeof sceneId !== 'string' || !sceneId.trim()) throw badRequest('sceneId required');
  if (typeof filename !== 'string' || !filename.trim()) throw badRequest('filename required');
  const a = await loadAnalysis(workId, id);
  if (!a) throw notFound('Analysis');
  const next = {
    ...a,
    sceneImages: {
      ...(a.sceneImages || {}),
      [sceneId]: {
        filename: filename.trim(),
        jobId: typeof jobId === 'string' ? jobId : null,
        prompt: typeof prompt === 'string' ? prompt : null,
        generatedAt: nowIso(),
      },
    },
  };
  await saveAnalysis(workId, next);
  return next;
}

// Persist a scene→generated-image link on the analysis snapshot AND mirror the
// image into the work's auto-collection (so it appears in MediaGen's
// Collections view). Shared by the HTTP `scene-image` route and the image-job
// completion hook (#1363) so the render-then-attach flow converges on one
// durable path — neither caller can drift on what "file this render" means.
// Best-effort collection mirror: a duplicate (same render already filed) is a
// no-op, not an error. Returns `{ analysis, collectionId }`.
export async function persistSceneImage(workId, id, { sceneId, filename, jobId, prompt }) {
  const analysis = await attachSceneImage(workId, id, { sceneId, filename, jobId, prompt });
  const collection = await ensureWorkMediaCollection(workId);
  await addCollectionItem(collection.id, { kind: 'image', ref: filename }).catch((err) => {
    if (err?.code !== ERR_DUPLICATE) throw err;
  });
  return { analysis, collectionId: collection.id };
}

// ---------- startup recovery ----------

// Walk every wr-analysis-<uuid>.json file in a work's analysis dir, group by
// kind, keep the latest per kind (by completedAt|createdAt), rewrite as
// <kind>.json, and delete the legacy files. Idempotent — once a work has
// been migrated the dir contains only <kind>.json so this is a noop.
async function migrateLegacyAnalyses(workId) {
  const dir = analysisDir(workId);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const legacy = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .filter((id) => LEGACY_ANALYSIS_ID_RE.test(id));
  if (legacy.length === 0) return 0;
  const loaded = (await Promise.all(legacy.map(async (id) => {
    const path = join(dir, `${id}.json`);
    const content = await tryReadFile(path);
    if (content === null) return null;
    const parsed = safeJSONParse(content, null, { allowArray: false, logError: true, context: path });
    // `allowArray: false` only rejects a root array — a bare JSON scalar
    // (corrupted legacy file) still parses, so also guard the shape here.
    return parsed && typeof parsed === 'object' ? { id, snapshot: parsed } : null;
  }))).filter(Boolean);

  const latestPerKind = new Map();
  for (const { snapshot } of loaded) {
    if (!ANALYSIS_KINDS.includes(snapshot.kind)) continue;
    const ts = snapshot.completedAt || snapshot.createdAt || '';
    const prev = latestPerKind.get(snapshot.kind);
    if (!prev || ts > prev.ts) latestPerKind.set(snapshot.kind, { snapshot, ts });
  }

  for (const [kind, { snapshot }] of latestPerKind) {
    await saveAnalysis(workId, { ...snapshot, id: kind });
  }
  await Promise.all(legacy.map((id) => rmGuarded(join(dir, `${id}.json`)).catch(() => {})));
  return legacy.length;
}

/**
 * Boot-time housekeeping for analyses:
 *   1. Migrate any legacy wr-analysis-<uuid>.json snapshots into the per-kind
 *      layout (one snapshot per kind, file named <kind>.json).
 *   2. Mark any `running` snapshots as `failed` — a server restart kills
 *      in-flight LLM calls but the pre-call snapshot is already on disk, so
 *      without this the UI would spin forever on a phantom row.
 * Idempotent; called fire-and-forget at boot.
 */
export async function recoverStuckAnalyses() {
  const worksRoot = join(root(), 'works');
  const workEntries = await readdir(worksRoot, { withFileTypes: true }).catch(() => []);
  let migrated = 0;
  let recovered = 0;
  await Promise.all(
    workEntries
      .filter((e) => e.isDirectory())
      .map(async (entry) => {
        migrated += await migrateLegacyAnalyses(entry.name).catch(() => 0);
        const ids = await listAnalysisIds(entry.name).catch(() => []);
        await Promise.all(ids.map(async (id) => {
          const a = await loadAnalysis(entry.name, id);
          if (a?.status !== 'running') return;
          await saveAnalysis(entry.name, {
            ...a,
            status: 'failed',
            error: 'Server restarted while this analysis was running',
            completedAt: nowIso(),
          });
          recovered += 1;
        }));
      })
  );
  if (migrated > 0) console.log(`📝 wr: migrated ${migrated} legacy analysis file(s) to per-kind layout`);
  if (recovered > 0) console.log(`📝 wr: recovered ${recovered} stuck analysis snapshot(s) on boot`);
}

// ---------- shared pass runner (used by runAnalysis + the Polish loop) ----------

/**
 * Run one LLM prose pass for a KIND_META kind against an already-loaded work
 * body, returning the shaped result plus provider/model. Thin wrapper over
 * runStagedLLM + the per-kind SHAPER so the Polish loop (polish.js) drives the
 * `evaluate` / `cuts` / `revise` passes through the same single code path as
 * the standalone analysis runner — no duplicated plumbing.
 *
 * Only the template-driven kinds (evaluate/format/cuts/revise) route here; the
 * bible/script kinds have their own extraction paths in runAnalysis.
 *
 * @param {string} kind - A KIND_META key with a template stage.
 * @param {object} variables - Extra prompt variables (work, draftBody, brief, …).
 * @param {{ source?: string }} [opts]
 * @returns {Promise<{ result: any, content: string, providerId: string, model: string }>}
 */
export async function runProsePass(kind, variables, { source } = {}) {
  const meta = KIND_META[kind];
  if (!meta) throw badRequest(`Unknown prose pass kind: ${kind}`);
  const { stage, returnsJson } = meta;
  const { content, model, providerId } = await runStagedLLM(
    stage,
    { ...variables, returnsJson },
    { source: source || `writers-room-${kind}` },
  );
  const shaper = SHAPERS[kind];
  return { result: shaper ? shaper(content) : content, content, providerId, model };
}

// ---------- run ----------

export async function runAnalysis(workId, { kind } = {}) {
  if (!ANALYSIS_KINDS.includes(kind)) {
    throw badRequest(`Invalid analysis kind: ${kind}. Expected one of ${ANALYSIS_KINDS.join(', ')}`);
  }
  const { stage, returnsJson } = KIND_META[kind];
  const { manifest, body } = await getWorkWithBody(workId);
  if (!body || !body.trim()) {
    throw badRequest('Cannot analyze an empty draft — write some prose first');
  }
  const draft = (manifest.drafts || []).find((d) => d.id === manifest.activeDraftVersionId);
  const id = kind;
  const baseSnapshot = {
    id,
    workId,
    kind,
    status: 'running',
    draftVersionId: manifest.activeDraftVersionId,
    sourceContentHash: draft?.contentHash || null,
    providerId: null,
    model: null,
    result: null,
    error: null,
    createdAt: nowIso(),
    completedAt: null,
  };
  await saveAnalysis(workId, baseSnapshot);

  // Awaited synchronously by the route — the client gets the finished record
  // back in one round-trip. A failure mid-call is persisted as a `failed`
  // snapshot so partial work never silently disappears.
  try {
    const workCtx = {
      id: manifest.id,
      title: manifest.title,
      kind: manifest.kind,
      status: manifest.status,
      wordCount: draft?.wordCount || 0,
    };

    if (isBibleKind(kind)) {
      const { kind: bibleKind, list, merge } = BIBLE_ANALYSIS[kind];
      const existing = await list(workId);
      const { extracted, runId, providerId, model } = await extractBible({
        kind: bibleKind,
        corpus: body,
        existing,
        context: { work: workCtx, returnsJson },
        source: `writers-room-${kind}`,
      });
      const mergedProfiles = await merge(workId, extracted);
      const finished = {
        ...baseSnapshot,
        status: 'succeeded',
        providerId, model,
        result: { [kind]: extracted, mergedProfiles },
        rawResponse: JSON.stringify({ [kind]: extracted }),
        runId,
        completedAt: nowIso(),
      };
      await saveAnalysis(workId, finished);
      return finished;
    }

    if (kind === 'script') {
      const [characters, places, objects] = await Promise.all([
        listCharacters(workId), listPlaces(workId), listObjects(workId),
      ]);
      const { extracted, runId, providerId, model } = await extractScenes({
        source: body,
        sourceKind: SOURCE_KIND.PROSE,
        characters, places, objects,
        work: workCtx,
        tag: 'writers-room-script',
      });
      const finished = {
        ...baseSnapshot,
        status: 'succeeded',
        providerId, model,
        result: extracted,
        rawResponse: JSON.stringify(extracted),
        runId,
        completedAt: nowIso(),
      };
      await saveAnalysis(workId, finished);
      return finished;
    }

    const variables = { work: workCtx, draftBody: body, returnsJson };
    // Author-side review (#6417): hand the editorial pass the cast's AUTHORED
    // framework so it reports delivery against the plan instead of inferring
    // the plan and the delivery from the same prose. Deliberately scoped to
    // `evaluate` — the bible extractors and the script pass are cold reads
    // that must derive everything from the text alone, and `extractBible`
    // already sends existing profiles under its own no-clobber contract. This
    // is a local file read, not an LLM call: nothing here fires until the user
    // asks for an analysis.
    if (kind === 'evaluate') {
      const characters = await listCharacters(workId);
      const cast = pickCastFramework(characters);
      if (cast.length) variables.castFrameworkJson = JSON.stringify(cast, null, 2);
      // Retrospective five-stage lens (#6445). Rendered alongside the framework
      // block above, anchored to THIS draft's segment index — so a stage whose
      // `segmentId` no longer resolves, or whose `anchorQuote` has drifted off
      // the passage it names, reaches the model annotated `[stale]` instead of
      // as proof. `null` when nobody authored a lens, which leaves `variables`
      // (and therefore the prompt and the snapshot) exactly as they were before
      // this feature existed. Still a local read: no promotion to Pipeline, and
      // no extra provider call.
      const evolution = renderWorkCharacterEvolutions(characters, {
        segmentIndex: draft?.segmentIndex || buildSegmentIndex(body),
        text: body,
      });
      if (evolution) variables.characterEvolution = evolution;
    }
    const { content, model: usedModel, providerId: usedProvider } = await runStagedLLM(stage, variables, {
      source: `writers-room-${kind}`,
    });
    const result = SHAPERS[kind](content);
    const finished = {
      ...baseSnapshot,
      status: 'succeeded',
      providerId: usedProvider,
      model: usedModel,
      result,
      rawResponse: content,
      completedAt: nowIso(),
    };
    await saveAnalysis(workId, finished);
    return finished;
  } catch (err) {
    const failed = {
      ...baseSnapshot,
      status: 'failed',
      error: err.message || String(err),
      completedAt: nowIso(),
    };
    await saveAnalysis(workId, failed);
    return failed;
  }
}
