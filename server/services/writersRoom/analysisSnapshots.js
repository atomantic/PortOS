import { join } from 'path';
import { readFile, readdir } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, safeJSONParse, tryReadFile, rmGuarded } from '../../lib/fileUtils.js';
import { ANALYSIS_KINDS } from '../../lib/writersRoomPresets.js';
import { createRecordWriteQueue } from '../../lib/fileWriteQueue.js';
import { assertValidWorkId, nowIso } from './_shared.js';

// Analysis id == kind. Each work keeps at most one snapshot per kind on disk
// (re-running a kind overwrites the previous snapshot via atomicWrite).
export const isValidAnalysisId = (id) => typeof id === 'string' && ANALYSIS_KINDS.includes(id);
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

// ---------- storage ----------

export async function listAnalysisIds(workId) {
  const dir = analysisDir(workId);
  await ensureDir(dir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .filter(isValidAnalysisId);
}

export async function loadAnalysis(workId, id) {
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

// Serializes load→modify→save cycles per analysis FILE (`workId:analysisId`) so concurrent
// read-modify-write callers (HTTP route, media-job hook) can't clobber each other's edits.
export const withAnalysisLock = createRecordWriteQueue();

export async function saveAnalysis(workId, snapshot) {
  await ensureDir(analysisDir(workId));
  await atomicWrite(analysisPath(workId, snapshot.id), snapshot);
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
