/**
 * Migration 190 — seed the SongBook starter songs into existing installs.
 *
 * The SongBook feature ships three public-domain seed records ("House of the
 * Rising Sun" for guitar / piano / ukulele) in data.reference/brain/songs.json.
 * Fresh installs get them because scripts/setup-data.js copies the whole file —
 * but setup-data only copies MISSING files, so an existing install whose
 * data/brain/songs.json was already created (even empty, by the feature's
 * first boot) would never receive the seeds. This migration merges them in.
 *
 * Idempotent and non-destructive: a seed id already present in the live store
 * — a user-edited copy, a synced copy from a peer, or a tombstone from a
 * deliberate delete — is NEVER overwritten (so a deleted seed stays deleted).
 * The file is written only when at least one record was added, and NEVER when
 * the existing file is unreadable (corrupt JSON is possibly-recoverable user
 * data — seeds are not worth destroying it). The seeds carry a fixed
 * originInstanceId ('seed') so every install holds byte-identical records and
 * the brain reconcile checksum converges across peers.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

// Tagged read: 'missing' (ENOENT — safe to treat as an empty store) is NOT the
// same as 'invalid' (file exists but won't parse — possibly recoverable user
// data that a write here would irreversibly destroy). The migration runner
// executes before the service layer is wired, so no server/lib imports here.
async function readJsonTagged(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { state: 'missing' } : { state: 'invalid', error: err?.message };
  }
  try {
    return { state: 'ok', doc: JSON.parse(raw) };
  } catch (err) {
    return { state: 'invalid', error: err?.message };
  }
}

export async function up({ rootDir }) {
  const seedPath = join(rootDir, 'data.reference', 'brain', 'songs.json');
  const livePath = join(rootDir, 'data', 'brain', 'songs.json');

  const seedRead = await readJsonTagged(seedPath);
  const seed = seedRead.state === 'ok' ? seedRead.doc : null;
  const seedRecords = seed?.records && typeof seed.records === 'object' ? seed.records : {};
  const seedIds = Object.keys(seedRecords);
  if (seedIds.length === 0) {
    console.log('🎸 songbook-seed: no seed records in data.reference — no-op.');
    return { ok: true, reason: 'no-seeds' };
  }

  const liveRead = await readJsonTagged(livePath);
  if (liveRead.state === 'invalid') {
    // The live store exists but won't parse — writing seeds over it would turn
    // a recoverable corrupt file into permanent data loss. Leave it untouched;
    // the seeds are cosmetic starter content, not worth risking user data.
    console.error(`❌ songbook-seed: data/brain/songs.json exists but is unreadable (${liveRead.error}) — leaving it untouched; repair or remove it to receive the starter songs.`);
    return { ok: true, reason: 'live-store-unreadable' };
  }
  const live = liveRead.state === 'ok' ? liveRead.doc : { records: {} };
  if (!live.records || typeof live.records !== 'object') live.records = {};

  let added = 0;
  for (const id of seedIds) {
    // Never overwrite an existing id — a user-edited copy, a peer-synced copy,
    // or a tombstone (deleted seed) all stay untouched.
    if (live.records[id] !== undefined) continue;
    live.records[id] = seedRecords[id];
    added += 1;
  }

  if (added === 0) {
    console.log('🎸 songbook-seed: all seed songs already present — no-op.');
    return { ok: true, reason: 'already-present' };
  }

  await mkdir(dirname(livePath), { recursive: true });
  await writeFile(livePath, JSON.stringify(live, null, 2) + '\n');
  console.log(`🎸 songbook-seed: added ${added} public-domain starter song(s) to data/brain/songs.json.`);
  return { ok: true, reason: 'seeded', added };
}

export default { up };
