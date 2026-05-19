/**
 * Writers Room — manual AI passes against a draft (evaluate / format / script).
 * Snapshots persist immutably under data/writers-room/works/<id>/analysis/ and
 * pin the source draft's contentHash so the UI can flag stale results.
 */

import { join } from 'path';
import { readFile, readdir, rm } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, safeJSONParse, tryReadFile } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { stripCodeFences } from '../../lib/aiProvider.js';
import { runStagedLLM } from '../../lib/stageRunner.js';
import { extractBible } from '../../lib/bibleExtractor.js';
import { extractScenes, SOURCE_KIND } from '../../lib/sceneExtractor.js';
import { BIBLE_KIND } from '../../lib/storyBible.js';
import { ANALYSIS_KINDS } from '../../lib/writersRoomPresets.js';
import { getWorkWithBody } from './local.js';
import { listCharacters, mergeExtractedCharacters } from './characters.js';
import { listPlaces, mergeExtractedPlaces } from './places.js';
import { listObjects, mergeExtractedObjects } from './objects.js';
import { nowIso, badRequest, notFound, assertValidWorkId } from './_shared.js';

export { ANALYSIS_KINDS };

const KIND_META = {
  evaluate:   { stage: 'writers-room-evaluate',   returnsJson: true },
  format:     { stage: 'writers-room-format',     returnsJson: false },
  script:     { stage: 'writers-room-script',     returnsJson: true },
  characters: { stage: 'writers-room-characters', returnsJson: true },
  places:     { stage: 'writers-room-places',     returnsJson: true },
  objects:    { stage: 'writers-room-objects',    returnsJson: true },
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

function extractJson(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty AI response');
  let str = stripCodeFences(text);
  // Some providers prepend explanation text; pull the first balanced object/array.
  const objMatch = str.match(/[{[][\s\S]*[\]}]/);
  if (objMatch) str = objMatch[0];
  return JSON.parse(str);
}

const SHAPERS = {
  format: (raw) => {
    let text = raw.trim();
    const fence = text.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)```$/);
    if (fence) text = fence[1].trim();
    return { formattedBody: text };
  },
  evaluate: (raw) => {
    const parsed = extractJson(raw);
    return {
      logline: typeof parsed.logline === 'string' ? parsed.logline : null,
      summary: typeof parsed.summary === 'string' ? parsed.summary : null,
      themes: Array.isArray(parsed.themes) ? parsed.themes.filter((t) => typeof t === 'string') : [],
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.filter((s) => typeof s === 'string') : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i) => i && typeof i === 'object') : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s) => s && typeof s === 'object') : [],
    };
  },
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
  return safeJSONParse(content, null, { allowArray: false, logError: true, context: analysisPath(workId, id) });
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
    return parsed ? { id, snapshot: parsed } : null;
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
  await Promise.all(legacy.map((id) => rm(join(dir, `${id}.json`)).catch(() => {})));
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
