/**
 * Rename each sprite character's native animation-run storage from the
 * vendor-named `grok/<runId>/` layout to the vendor-NEUTRAL `runs/<runId>/`
 * layout, and rewrite every path that referenced it.
 *
 * Why:
 *   PortOS's own walk generations were stored under `data/sprites/<id>/grok/`
 *   — baking one provider (grok) into the on-disk contract. As other agent
 *   services / generation methods come online, the storage layout must be
 *   vendor-neutral: runs live under `runs/`, and the provider is recorded as
 *   the run record's `provider` field, not encoded in the path. (The importer
 *   already used `runs/` for source-pipeline runs; this unifies both.)
 *
 * What moves on disk (per character record):
 *
 *     before:                              after:
 *     data/sprites/<id>/                   data/sprites/<id>/
 *     └── grok/<runId>/…                   └── runs/<runId>/…
 *
 * What is rewritten (the embedded `grok/…` path strings become `runs/…`):
 *   - runs/<runId>/animation-run.json        (run records — not sha-pinned)
 *   - runs/<runId>/generated/*-manifest.json (postprocess manifests)
 *   - walk/<id>-walk-selection-v1.json       (per-direction runPath/runManifest)
 *   - walk/<id>-walk-set-v1.json             (finalized selection copy)
 *   - runtime/vN/ atlas manifests            (compiled-atlas provenance)
 *
 * Content-sha CASCADE (the delicate part): image-byte shas never change (a
 * frame PNG is byte-identical after a directory move), but the JSON manifests
 * that EMBED paths do change, and several are sha-pinned. So after rewriting we
 * recompute, in dependency order:
 *   - each rewritten postprocess manifest → its selection/walk-set entry's
 *     `runManifestSha256`
 *   - the rewritten selection file        → the walk-set's `selectionSha256`
 *   - the rewritten walk-set file         → the runtime pointer's `walkSetSha256`
 *   - the rewritten current atlas manifest → the pointer's `manifestSha256`
 * atlas.js's compile idempotency keys on `walkSetSha256`, so updating the
 * pointer keeps a post-migration recompile a no-op (it never re-reads the
 * immutable atlas PNG, whose bytes are unchanged).
 *
 * NOT touched: imported/redraw records (their paths are `runs/`, `art-source/`,
 * or `imagegen/`, never `grok/`); the atlas PNGs; publications.json (its paths
 * are `runtime/…`, no `grok/`); reference anchors (`reference/…`).
 *
 * Idempotency: gated per record on the presence of a `grok/` directory OR any
 * residual `grok/` string in the selection/walk-set (crash-recovery of a run
 * that moved the dirs but not the strings). A second run finds neither and
 * skips. A move-target collision (`runs/<runId>` already exists) throws for
 * that record — the run is left in `grok/` (still readable via the layout-
 * agnostic reader) and the migration stays PENDING for a retry, mirroring
 * migration 200's per-record aggregate-throw.
 */

import { readdir, readFile, writeFile, rename, rm, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const LEGACY_DIR = 'grok';
const NEUTRAL_DIR = 'runs';

const exists = (abs) => stat(abs).then(() => true, () => false);
const sha256File = async (abs) => createHash('sha256').update(await readFile(abs)).digest('hex');
const readJson = async (abs) => { try { return JSON.parse(await readFile(abs, 'utf8')); } catch { return null; } };
const writeJson = (abs, obj) => writeFile(abs, `${JSON.stringify(obj, null, 2)}\n`);

// Rewrite a record-relative path VALUE that starts with `grok/`. Only the
// path prefix is matched, so provenance strings that merely CONTAIN "grok"
// (e.g. the run kind `grok-game-animation-frames-run`) are left intact.
const neutralize = (s) => (typeof s === 'string' && s.startsWith(`${LEGACY_DIR}/`) ? `${NEUTRAL_DIR}/${s.slice(LEGACY_DIR.length + 1)}` : s);
const deepNeutralize = (v) => {
  if (typeof v === 'string') return neutralize(v);
  if (Array.isArray(v)) return v.map(deepNeutralize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepNeutralize(v[k]);
    return out;
  }
  return v;
};

// Recursively collect *.json files under `dir` (absolute paths). Missing dir → [].
async function listJsonFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listJsonFiles(abs));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(abs);
  }
  return out;
}

// Rewrite `grok/`→`runs/` in one JSON file, writing only when it changed.
async function neutralizeJsonFile(abs) {
  const obj = await readJson(abs);
  if (!obj) return;
  const neu = deepNeutralize(obj);
  if (JSON.stringify(neu) !== JSON.stringify(obj)) await writeJson(abs, neu);
}

// Rewrite the per-direction entries of a selection/walk-set object in place,
// recomputing `runManifestSha256` for every entry whose manifest we actually
// moved (a `grok/`-origin entry). Returns whether anything changed.
async function neutralizeDirectionEntries(recDir, directions) {
  let changed = false;
  for (const entry of Object.values(directions || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const movedManifest = typeof entry.runManifest === 'string' && entry.runManifest.startsWith(`${LEGACY_DIR}/`);
    const movedPath = typeof entry.runPath === 'string' && entry.runPath.startsWith(`${LEGACY_DIR}/`);
    if (movedPath) { entry.runPath = neutralize(entry.runPath); changed = true; }
    if (movedManifest) {
      entry.runManifest = neutralize(entry.runManifest);
      // The manifest file was already moved + rewritten, so hash the new bytes.
      entry.runManifestSha256 = await sha256File(join(recDir, entry.runManifest));
      changed = true;
    }
  }
  return changed;
}

async function migrateRecord(recDir, recordId) {
  const grokDir = join(recDir, LEGACY_DIR);
  const runsDir = join(recDir, NEUTRAL_DIR);
  const selAbs = join(recDir, 'walk', `${recordId}-walk-selection-v1.json`);
  const wsAbs = join(recDir, 'walk', `${recordId}-walk-set-v1.json`);
  const ptrAbs = join(recDir, 'runtime', 'current.json');
  const runtimeDir = join(recDir, 'runtime');

  const hasGrokDir = await exists(grokDir);
  const selText = await readFile(selAbs, 'utf8').catch(() => '');
  const wsText = await readFile(wsAbs, 'utf8').catch(() => '');
  if (!hasGrokDir && !selText.includes(`${LEGACY_DIR}/`) && !wsText.includes(`${LEGACY_DIR}/`)) {
    return false; // nothing native/grok here (imported/redraw-only, or already migrated)
  }

  // 1. Move every grok/<runId> directory to runs/<runId>. A collision means a
  //    runs/<runId> already exists — refuse rather than merge/overwrite.
  if (hasGrokDir) {
    await mkdir(runsDir, { recursive: true });
    for (const entry of await readdir(grokDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dest = join(runsDir, entry.name);
      if (await exists(dest)) {
        throw new Error(`run dir collision for ${recordId}: ${NEUTRAL_DIR}/${entry.name} already exists — left ${LEGACY_DIR}/${entry.name} in place`);
      }
      await rename(join(grokDir, entry.name), dest);
    }
    await rm(grokDir, { recursive: true, force: true }); // now empty
  }

  // 2. Rewrite every run record + postprocess manifest now under runs/.
  for (const abs of await listJsonFiles(runsDir)) await neutralizeJsonFile(abs);

  // 3. Selection → recompute per-entry runManifestSha256 from the moved manifests.
  const selection = await readJson(selAbs);
  if (selection?.directions) {
    await neutralizeDirectionEntries(recDir, selection.directions);
    await writeJson(selAbs, selection);
  }
  const newSelectionSha = await exists(selAbs) ? await sha256File(selAbs) : null;

  // 4. Walk-set → same per-entry recompute, plus the selection-content sha.
  const walkSet = await readJson(wsAbs);
  if (walkSet) {
    if (walkSet.directions) await neutralizeDirectionEntries(recDir, walkSet.directions);
    if (newSelectionSha && typeof walkSet.selectionSha256 === 'string') walkSet.selectionSha256 = newSelectionSha;
    await writeJson(wsAbs, walkSet);
  }
  const newWalkSetSha = await exists(wsAbs) ? await sha256File(wsAbs) : null;

  // 5. Compiled-atlas manifests (provenance) + the runtime pointer's shas.
  for (const vDir of await readdir(runtimeDir, { withFileTypes: true }).catch(() => [])) {
    if (!vDir.isDirectory() || !/^v\d+$/.test(vDir.name)) continue;
    for (const abs of await listJsonFiles(join(runtimeDir, vDir.name))) await neutralizeJsonFile(abs);
  }
  const pointer = await readJson(ptrAbs);
  if (pointer) {
    if (newWalkSetSha && typeof pointer.walkSetSha256 === 'string') pointer.walkSetSha256 = newWalkSetSha;
    if (typeof pointer.manifestPath === 'string' && await exists(join(recDir, pointer.manifestPath))) {
      pointer.manifestSha256 = await sha256File(join(recDir, pointer.manifestPath));
    }
    await writeJson(ptrAbs, pointer);
  }
  return true;
}

export default {
  up: async ({ rootDir }) => {
    const spritesDir = join(rootDir, 'data', 'sprites');
    let records;
    try {
      records = await readdir(spritesDir, { withFileTypes: true });
    } catch {
      return { ok: true, migrated: 0 }; // no sprites tree on this install
    }

    let migrated = 0;
    const failures = [];
    // Sequential + per-record try/catch: one record's collision must not abort
    // the rest, and an aggregate throw keeps the migration PENDING for retry
    // (the healthy records already migrated become gate no-ops next boot).
    for (const rec of records) {
      if (!rec.isDirectory()) continue;
      try {
        if (await migrateRecord(join(spritesDir, rec.name), rec.name)) {
          migrated++;
          console.log(`🧭 migration 202: sprite ${rec.name} → runs/ layout`);
        }
      } catch (err) {
        failures.push(rec.name);
        console.error(`❌ migration 202 (${rec.name}): ${err.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`migration 202: ${failures.length} sprite record(s) failed to migrate (${failures.join(', ')}) — resolve the collision(s) and reboot to retry; the rest migrated.`);
    }
    return { ok: true, migrated };
  },
};
