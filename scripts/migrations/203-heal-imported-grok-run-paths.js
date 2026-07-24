/**
 * Migration 203 — heal the `grok/` path residue that migration 202 left behind
 * on IMPORTED sprite records.
 *
 * Background:
 *   Migration 202 renamed each character's native run storage from the
 *   vendor-named `grok/<runId>/` layout to the neutral `runs/<runId>/` layout
 *   and rewrote every embedded `grok/…` path string. Its `neutralize()` only
 *   matched path VALUES that START with `grok/` — correct for PortOS-native
 *   runs, whose embedded paths are record-relative (`grok/<runId>/…`).
 *
 *   But source-pipeline IMPORTS (#2895) embed their paths anchored at the
 *   source repo root — `art-source/sprites/<id>/grok/<runId>/…` — and the
 *   importer copies those manifests byte-for-byte. When 202 ran on an install
 *   that had already imported such a record, it PHYSICALLY moved the run
 *   directories (`grok/` → `runs/`, gated on the `grok/` dir existing) but its
 *   `startsWith('grok/')` neutralizer never matched the repo-anchored strings,
 *   so every `art-source/sprites/<id>/grok/…` reference was left dangling.
 *
 *   Result on such a record: the run bytes live under `runs/…`, but the
 *   selection / walk-set / run-record / postprocess-manifest all still point at
 *   `…/grok/…`. The read layer (`toRecordRelativeAssetPath`) strips the
 *   `art-source/sprites/<id>/` prefix and yields `grok/…`, which no longer
 *   exists — so `getWalkState` can't resolve the run behind each direction and
 *   the strip-loop preview URL 404s. Every imported walk direction renders its
 *   "approved" badge over an empty (transparent) cell. (Observed: the `pioneer`
 *   character — 7 grok-run directions blank, only the imagegen-redraw `east`
 *   direction, which never carried a `grok/` segment, animated.)
 *
 * What this migration does (per affected record):
 *   Rewrite the leftover `sprites/<id>/grok/` segment → `sprites/<id>/runs/`
 *   (preserving the `art-source/…` provenance prefix, exactly as 202 preserved
 *   record-relative anchoring — only the vendor dir that 202 relocated is
 *   corrected) across the selection, walk-set, every JSON under `runs/`, and
 *   the compiled-atlas manifests, then recompute the same content-sha cascade
 *   202 does so the post-migration state is internally consistent.
 *
 * Scope gate (per record): the record has a `runs/` dir, NO `grok/` dir (i.e.
 * 202 already performed the physical move), AND a residual `sprites/<id>/grok/`
 * reference. A record still holding a `grok/` dir is 202's unfinished business
 * — where the dir and the strings agree, the layout is self-consistent and must
 * NOT be touched — so 203 skips it and lets 202 own the move.
 *
 * NOT touched: image-byte shas (a moved PNG is byte-identical — never
 * re-hashed); the `art-source/sprites/<id>/walk/…` selectionPath and other
 * non-`grok/` provenance; strings that merely CONTAIN "grok" but aren't run
 * paths (`grok-game-animation-frames-run`, `grokResponsibility`,
 * `local-postprocess-of-existing-grok-session-video` — none contain the
 * `sprites/<id>/grok/` or leading `grok/` path forms this rewrites).
 *
 * Idempotency: after a successful pass no `sprites/<id>/grok/` reference
 * survives and the `runs/` dir is present with no `grok/` dir, so the gate
 * skips the record on every subsequent boot. A new import onto an install where
 * 202 has already applied leaves its runs under `grok/` (202 never re-runs), a
 * self-consistent layout the read layer serves directly — so 203's gate
 * correctly skips it too.
 */

import { readdir, readFile, writeFile, rename, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const LEGACY_DIR = 'grok';
const NEUTRAL_DIR = 'runs';

const exists = (abs) => stat(abs).then(() => true, () => false);
const sha256File = async (abs) => createHash('sha256').update(await readFile(abs)).digest('hex');
const readJson = async (abs) => { try { return JSON.parse(await readFile(abs, 'utf8')); } catch { return null; } };
// Atomic write (temp + rename) so a crash mid-migration can't leave a torn,
// unparseable state file behind — mirrors migration 202's writer.
const writeJson = async (abs, obj) => {
  const tmp = `${abs}.203.tmp`;
  await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  await rename(tmp, abs);
};

// Rewrite the leftover run-directory segment in one path VALUE. Two forms:
//   - repo-anchored:  …/sprites/<id>/grok/…  → …/sprites/<id>/runs/…
//   - record-relative bare prefix: grok/…    → runs/…  (belt-and-suspenders;
//     202 already handled this form, but a crash-recovered record could retain
//     a stray one).
// Both are path-shaped: they can only appear in a real asset/run path, never in
// the `grok-…` / `…-grok-…` provenance/kind/skill strings the record also holds.
const neutralize = (id, s) => {
  if (typeof s !== 'string') return s;
  let out = s.split(`sprites/${id}/${LEGACY_DIR}/`).join(`sprites/${id}/${NEUTRAL_DIR}/`);
  if (out.startsWith(`${LEGACY_DIR}/`)) out = `${NEUTRAL_DIR}/${out.slice(LEGACY_DIR.length + 1)}`;
  return out;
};
const deepNeutralize = (id, v) => {
  if (typeof v === 'string') return neutralize(id, v);
  if (Array.isArray(v)) return v.map((x) => deepNeutralize(id, x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepNeutralize(id, v[k]);
    return out;
  }
  return v;
};

// Resolve a possibly repo-anchored path VALUE to the record-relative form used
// to locate the file on disk (mirrors server's toRecordRelativeAssetPath, kept
// inline so the migration keeps its minimal fs+crypto surface). Returns null
// for a value that doesn't resolve inside this record.
const recordRelative = (id, p) => {
  if (typeof p !== 'string' || !p) return null;
  const marker = `art-source/sprites/${id}/`;
  const idx = p.indexOf(marker);
  const rel = idx >= 0 ? p.slice(idx + marker.length) : p.replace(/^\/+/, '');
  if (!rel || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '')) return null;
  return rel;
};

// Recursively collect *.json files under `dir` (absolute paths). Missing → [].
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

async function neutralizeJsonFile(id, abs) {
  const obj = await readJson(abs);
  if (!obj) return;
  const neu = deepNeutralize(id, obj);
  if (JSON.stringify(neu) !== JSON.stringify(obj)) await writeJson(abs, neu);
}

// Rewrite the per-direction entries of a selection/walk-set object in place,
// recomputing `runManifestSha256` for every entry whose runManifest we moved
// (the file bytes changed when its embedded paths were rewritten). Resolves the
// (repo-anchored) runManifest to a record-relative disk path first; a manifest
// missing on disk keeps its old sha rather than throwing — the imported set is
// frozen/immutable and nothing verifies these pins at read time, so a best-
// effort recompute is strictly safer than aborting the whole heal.
async function neutralizeDirectionEntries(recDir, id, directions) {
  for (const entry of Object.values(directions || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.runPath === 'string') entry.runPath = neutralize(id, entry.runPath);
    if (typeof entry.runManifest === 'string') {
      entry.runManifest = neutralize(id, entry.runManifest);
      const rel = recordRelative(id, entry.runManifest);
      // eslint-disable-next-line no-await-in-loop -- sequential per-direction is fine (≤8 entries)
      if (rel && await exists(join(recDir, rel))) entry.runManifestSha256 = await sha256File(join(recDir, rel));
    }
  }
}

// True when any JSON state under the record still names `sprites/<id>/grok/`.
async function hasGrokResidue(recDir, id) {
  const selAbs = join(recDir, 'walk', `${id}-walk-selection-v1.json`);
  const wsAbs = join(recDir, 'walk', `${id}-walk-set-v1.json`);
  const marker = `sprites/${id}/${LEGACY_DIR}/`;
  const sel = await readFile(selAbs, 'utf8').catch(() => '');
  if (sel.includes(marker)) return true;
  const ws = await readFile(wsAbs, 'utf8').catch(() => '');
  if (ws.includes(marker)) return true;
  for (const abs of await listJsonFiles(join(recDir, NEUTRAL_DIR))) {
    // eslint-disable-next-line no-await-in-loop -- short-circuits on first hit
    if ((await readFile(abs, 'utf8').catch(() => '')).includes(marker)) return true;
  }
  return false;
}

async function migrateRecord(recDir, recordId) {
  const hasRunsDir = await exists(join(recDir, NEUTRAL_DIR));
  const hasGrokDir = await exists(join(recDir, LEGACY_DIR));
  // Only heal records 202 already MOVED (runs/ present, grok/ gone) that still
  // carry the repo-anchored grok/ residue. A record still holding a grok/ dir
  // is self-consistent (or 202's pending work) — leave it to 202.
  if (!hasRunsDir || hasGrokDir) return false;
  if (!await hasGrokResidue(recDir, recordId)) return false;

  const selAbs = join(recDir, 'walk', `${recordId}-walk-selection-v1.json`);
  const wsAbs = join(recDir, 'walk', `${recordId}-walk-set-v1.json`);
  const ptrAbs = join(recDir, 'runtime', 'current.json');
  const runtimeDir = join(recDir, 'runtime');

  // 1. Rewrite every run record + postprocess manifest now under runs/.
  for (const abs of await listJsonFiles(join(recDir, NEUTRAL_DIR))) await neutralizeJsonFile(recordId, abs);

  // 2. Selection → recompute per-entry runManifestSha256 from the rewritten runs.
  const selection = await readJson(selAbs);
  if (selection?.directions) {
    await neutralizeDirectionEntries(recDir, recordId, selection.directions);
    await writeJson(selAbs, selection);
  }
  const newSelectionSha = await exists(selAbs) ? await sha256File(selAbs) : null;

  // 3. Walk-set → same per-entry recompute, plus the selection-content sha.
  const walkSet = await readJson(wsAbs);
  if (walkSet) {
    if (walkSet.directions) await neutralizeDirectionEntries(recDir, recordId, walkSet.directions);
    if (newSelectionSha && typeof walkSet.selectionSha256 === 'string') walkSet.selectionSha256 = newSelectionSha;
    await writeJson(wsAbs, walkSet);
  }
  const newWalkSetSha = await exists(wsAbs) ? await sha256File(wsAbs) : null;

  // 4. Compiled-atlas manifests (provenance) + the runtime pointer's shas.
  for (const vDir of await readdir(runtimeDir, { withFileTypes: true }).catch(() => [])) {
    if (!vDir.isDirectory() || !/^v\d+$/.test(vDir.name)) continue;
    for (const abs of await listJsonFiles(join(runtimeDir, vDir.name))) await neutralizeJsonFile(recordId, abs);
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
    for (const rec of records) {
      if (!rec.isDirectory()) continue;
      try {
        if (await migrateRecord(join(spritesDir, rec.name), rec.name)) {
          migrated++;
          console.log(`🧭 migration 203: healed imported grok/ run paths for sprite ${rec.name}`);
        }
      } catch (err) {
        failures.push(rec.name);
        console.error(`❌ migration 203 (${rec.name}): ${err.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`migration 203: ${failures.length} sprite record(s) failed to heal (${failures.join(', ')}) — the rest healed; reboot to retry.`);
    }
    return { ok: true, migrated };
  },
};
