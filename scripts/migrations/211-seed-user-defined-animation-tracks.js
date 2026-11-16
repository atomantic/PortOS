/**
 * Migration 211 — give existing installs an editable animation-track store.
 *
 * Until #3152 `scanner` and `ambient` were COMPILED rows in `server/services/sprites/animationTracks.js`; they are now user-defined rows in `data/sprites/animation-tracks.json`, seeded verbatim from `data.reference/sprites/animation-tracks.json`, so a user can retune or delete them without a release. `walk` stays the one mandatory built-in and is NOT in the store.
 * **The regression this prevents is silent:** an install holding an approved scanner set or ambient loop validates it by its exact `setKind`, and the runtime-contract Zod schema builds `scannerFrameCount` / `ambientFrameCount` from the effective registry; without the rows the compiler reports "unknown animation track 'scanner'" on a record that compiled yesterday and a publish binding would have that field silently stripped.
 * **This migration is a convenience, not a correctness dependency:** the store falls back to `data.reference/sprites/animation-tracks.json` when the user copy is absent (`animationTrackStore.js`), which keeps even a first boot safe (module load precedes migrations). Its job is to materialize an EDITABLE copy for the "Manage animation types" UI (#3153) and hand-editors.
 * Idempotent and non-destructive: an existing store file is NEVER touched (a user who deleted `scanner` must keep it deleted; a merge would resurrect it), and an unreadable one is left alone (possibly-recoverable user data beats a clean reseed).
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
// `atomicWrite` (ensureDir + temp + rename), as `_seedStageHelpers.js` and sibling migrations use: a truncated store would make this migration's existence check report `already-present` forever while the store throws "not valid JSON" at module load. It passes a string through unchanged, so the seed lands byte-for-byte.
import { atomicWrite, pathExists } from '../../server/lib/fileUtils.js';

const STORE_REL = join('sprites', 'animation-tracks.json');

export async function up({ rootDir }) {
  const seedPath = join(rootDir, 'data.reference', STORE_REL);
  const storePath = join(rootDir, 'data', STORE_REL);

  // Present in ANY state (valid, empty, corrupt) means the user owns this file —
  // stop. Checked by existence rather than by parsing, because a file that fails
  // to parse is exactly the case where overwriting would destroy user edits.
  if (await pathExists(storePath)) {
    console.log('🎬 animation-tracks: store already present — no-op.');
    return { ok: true, reason: 'already-present' };
  }

  let seed;
  try {
    seed = await readFile(seedPath, 'utf-8');
  } catch (err) {
    // A checkout missing the seed file is a packaging problem, not a data
    // problem: the store's data.reference fallback already covers the runtime, so
    // report and continue rather than failing the whole migration run.
    console.error(`❌ animation-tracks: no seed at data.reference/${STORE_REL} (${err.message}) — skipping.`);
    return { ok: true, reason: 'no-seed' };
  }
  // Parse before writing: shipping a corrupt seed into `data/` would turn the
  // store's "exists but unreadable" throw into a boot failure the user can only
  // fix by deleting a file they never created.
  let parsed;
  try {
    parsed = JSON.parse(seed);
  } catch (err) {
    console.error(`❌ animation-tracks: data.reference/${STORE_REL} is not valid JSON (${err.message}) — skipping.`);
    return { ok: true, reason: 'invalid-seed' };
  }

  await atomicWrite(storePath, seed.endsWith('\n') ? seed : `${seed}\n`);
  const count = Array.isArray(parsed?.tracks) ? parsed.tracks.length : 0;
  console.log(`🎬 animation-tracks: seeded ${count} editable animation ${count === 1 ? 'track' : 'tracks'} into data/${STORE_REL}.`);
  return { ok: true, reason: 'seeded', count };
}

export default { up };
