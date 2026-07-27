/**
 * Migration 209 — seed the SongBook drum example groove into existing installs.
 *
 * The `drums` instrument / `drum` content format (#3115) ships one invented
 * example chart ("Example Rock Beat" by The Placeholders) in
 * data.reference/brain/songs.json — it doubles as the format's worked example,
 * so a drummer opening `/songbook` on an upgraded install has something to read,
 * play along with, and copy from. Fresh installs get it because
 * scripts/setup-data.js copies data.reference wholesale, but setup-data only
 * copies MISSING files, so every existing install would never receive it.
 *
 * Since migration 200, brain stores live per-record at
 * `data/brain/<type>/<id>/index.json` (collectionStore layout) rather than in a
 * monolithic `data/brain/<type>.json` — so unlike migration 190 (the pre-split
 * SongBook seed), this writes one record directory. The legacy monolithic file is
 * ALSO topped up when it's still present, so an install that hasn't run 200 yet
 * (migrations apply in filename order, but a repaired/pending 200 can lag) still
 * picks the seed up when its split finally runs.
 *
 * Idempotent and non-destructive: an id already present — a user-edited copy, a
 * peer-synced copy, or a tombstone from a deliberate delete — is NEVER
 * overwritten, so a deleted seed stays deleted. Nothing is written when the
 * existing record (or the legacy file) is unreadable: possibly-recoverable user
 * data beats a cosmetic starter chart. The seed carries a fixed
 * originInstanceId ('seed') so every install holds a byte-identical record and
 * the brain reconcile checksum still converges across peers.
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';

// Only THIS seed id — a later seed addition gets its own migration rather than
// silently riding along on a re-run of this one.
const SEED_IDS = ['song-seed-example-rock-beat'];

// Tagged read: 'missing' (ENOENT — nothing there, safe to create) is NOT the
// same as 'invalid' (exists but won't parse — user data a write would destroy).
// The migration runner executes before the service layer is wired, so no
// server/lib imports here.
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

const exists = async (path) => access(path).then(() => true, () => false);

export async function up({ rootDir }) {
  const seedPath = join(rootDir, 'data.reference', 'brain', 'songs.json');
  const perRecordDir = join(rootDir, 'data', 'brain', 'songs');
  const legacyPath = join(rootDir, 'data', 'brain', 'songs.json');

  const seedRead = await readJsonTagged(seedPath);
  const seedRecords = seedRead.state === 'ok' && seedRead.doc?.records && typeof seedRead.doc.records === 'object'
    ? seedRead.doc.records
    : {};
  const present = SEED_IDS.filter((id) => seedRecords[id] !== undefined);
  if (present.length === 0) {
    console.log('🥁 drum-seed: no drum seed record in data.reference — no-op.');
    return { ok: true, reason: 'no-seeds' };
  }

  // --- Per-record store (the post-migration-200 layout) ---------------------
  let added = 0;
  let skipped = 0;
  for (const id of present) {
    const recordPath = join(perRecordDir, id, 'index.json');
    const read = await readJsonTagged(recordPath);
    if (read.state !== 'missing') {
      // Present (a user-edited copy / peer copy / tombstone) or unreadable —
      // either way, leave it alone.
      if (read.state === 'invalid') {
        console.error(`❌ drum-seed: ${id}/index.json is unreadable (${read.error}) — leaving it untouched.`);
      }
      skipped += 1;
      continue;
    }
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify(seedRecords[id], null, 2) + '\n');
    added += 1;
  }

  // --- Legacy monolithic file (only when it still exists) -------------------
  // An install whose migration-200 split hasn't run yet still reads
  // data/brain/songs.json, so top that up too. We never CREATE the legacy file —
  // doing so on a split install would resurrect a shape nothing reads.
  let legacyAdded = 0;
  if (await exists(legacyPath)) {
    const legacyRead = await readJsonTagged(legacyPath);
    if (legacyRead.state === 'invalid') {
      console.error(`❌ drum-seed: data/brain/songs.json exists but is unreadable (${legacyRead.error}) — leaving it untouched.`);
    } else {
      const live = legacyRead.doc && typeof legacyRead.doc === 'object' ? legacyRead.doc : {};
      if (!live.records || typeof live.records !== 'object') live.records = {};
      for (const id of present) {
        if (live.records[id] !== undefined) continue;
        live.records[id] = seedRecords[id];
        legacyAdded += 1;
      }
      if (legacyAdded > 0) await writeFile(legacyPath, JSON.stringify(live, null, 2) + '\n');
    }
  }

  if (added === 0 && legacyAdded === 0) {
    console.log('🥁 drum-seed: drum example already present — no-op.');
    return { ok: true, reason: 'already-present', added: 0, legacyAdded: 0, skipped };
  }

  console.log(`🥁 drum-seed: added the drum example groove (${added} per-record, ${legacyAdded} legacy) to the SongBook.`);
  return { ok: true, reason: 'seeded', added, legacyAdded, skipped };
}

export default { up };
