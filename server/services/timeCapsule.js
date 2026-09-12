/**
 * Time Capsule Service
 *
 * Creates versioned snapshots of digital twin data for historical preservation.
 * Supports creating, listing, viewing, comparing, and deleting snapshots.
 */

import { unlink, readdir } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { atomicWrite, ensureDir, PATHS, readJSONFile, readJSONFileStrict, tryReadFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const DIGITAL_TWIN_DIR = PATHS.digitalTwin;
const SNAPSHOTS_DIR = join(DIGITAL_TWIN_DIR, 'snapshots');
const INDEX_FILE = join(SNAPSHOTS_DIR, 'index.json');
const JSON_TWIN_FILES = [
  'meta.json', 'identity.json', 'goals.json', 'taste-profile.json',
  'feedback.json', 'genome.json', 'longevity.json', 'chronotype.json',
];

// One tail for every index.json read-modify-write so two snapshot creates or
// deletes cannot load the same pre-image and clobber each other on save.
const queueIndexWrite = createFileWriteQueue();

async function ensureSnapshotsDir() {
  await ensureDir(SNAPSHOTS_DIR);
}

function indexEntryFromSnapshotFile(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.id) return null;
  const meta = { ...parsed };
  delete meta.data;
  return meta;
}

async function recoverIndexFromSnapshotFiles(reason) {
  const entries = await readdir(SNAPSHOTS_DIR).catch(() => []);
  const metas = await Promise.all(
    entries
      .filter(name => name.endsWith('.json') && name !== 'index.json')
      .map(async name => indexEntryFromSnapshotFile(
        await readJSONFile(join(SNAPSHOTS_DIR, name), null)
      ))
  );
  const snapshots = metas
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (reason || snapshots.length > 0) {
    console.warn(`⚠️ Time-capsule index ${reason || 'missing'} — rebuilt listing of ${snapshots.length} snapshot file(s)`);
  }
  return { snapshots };
}

function isUsableIndex(parsed) {
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.snapshots);
}

async function loadIndex() {
  await ensureSnapshotsDir();
  const { ok, value } = await readJSONFileStrict(INDEX_FILE, null);
  if (ok && isUsableIndex(value)) return { snapshots: value.snapshots };
  // Missing, empty, corrupt, or wrong-shaped index must not throw (that used
  // to disable every snapshot op). Rebuild from on-disk snapshot files so a
  // later save does not orphan listings that the bytes still hold.
  return recoverIndexFromSnapshotFiles(ok ? (value == null ? null : 'malformed') : 'unreadable');
}

async function saveIndex(index) {
  await ensureSnapshotsDir();
  await atomicWrite(INDEX_FILE, index);
}

/**
 * Collect all digital twin data files into a single snapshot payload
 */
async function collectTwinData() {
  const files = {};

  // Read the fixed JSON set plus the autobiography stories concurrently — they
  // are independent files, so a sequential loop just serialized disk latency on
  // snapshot creation. Each file is optional: missing, unreadable, or malformed
  // JSON is omitted so one bad twin file cannot abort the whole snapshot.
  const jsonTargets = [
    ...JSON_TWIN_FILES.map(filename => ({ key: filename, path: join(DIGITAL_TWIN_DIR, filename) })),
    { key: 'autobiography/stories.json', path: join(DIGITAL_TWIN_DIR, 'autobiography', 'stories.json') }
  ];
  await Promise.all(jsonTargets.map(async ({ key, path }) => {
    const parsed = await readJSONFile(path, null);
    if (parsed == null) return;
    files[key] = parsed;
  }));

  // Collect markdown documents in parallel. tryReadFile collapses the TOCTOU
  // window of exists/stat-then-read (a vanished or non-file entry is skipped).
  const entries = await readdir(DIGITAL_TWIN_DIR).catch(() => []);
  const mdEntries = await Promise.all(
    entries
      .filter(entry => entry.endsWith('.md'))
      .map(async entry => {
        const content = await tryReadFile(join(DIGITAL_TWIN_DIR, entry));
        if (content == null) return null;
        return { entry, content };
      })
  );
  const mdFiles = {};
  for (const md of mdEntries) {
    if (md) mdFiles[md.entry] = md.content;
  }
  if (Object.keys(mdFiles).length > 0) {
    files.documents = mdFiles;
  }

  return files;
}

/**
 * Build summary metadata from collected data
 */
function buildSummary(data) {
  const meta = data['meta.json'] || {};
  const docs = meta.documents || [];
  const goals = data['goals.json'];
  const stories = data['autobiography/stories.json'];
  const genome = data['genome.json'];
  const identity = data['identity.json'];
  const mdDocs = data.documents || {};

  return {
    documentCount: docs.length,
    enabledDocuments: docs.filter(d => d.enabled).length,
    markdownFiles: Object.keys(mdDocs).length,
    goalsCount: Array.isArray(goals?.goals) ? goals.goals.length : 0,
    storiesCount: Array.isArray(stories) ? stories.length : 0,
    genomeMarkers: Array.isArray(genome?.markers) ? genome.markers.length : 0,
    hasIdentity: !!identity,
    testHistoryCount: Array.isArray(meta.testHistory) ? meta.testHistory.length : 0,
    traits: meta.traits || null,
    confidenceScores: meta.confidenceScores || null
  };
}

/**
 * Create a new time capsule snapshot
 */
export async function createSnapshot(label, description = '') {
  const data = await collectTwinData();
  const dataString = JSON.stringify(data);
  const dataHash = createHash('sha256').update(dataString).digest('hex').slice(0, 16);

  const snapshot = {
    id: uuidv4(),
    label,
    description,
    createdAt: new Date().toISOString(),
    dataHash,
    sizeBytes: Buffer.byteLength(dataString, 'utf-8'),
    summary: buildSummary(data)
  };

  return queueIndexWrite(async () => {
    // Load (and maybe rebuild) the index BEFORE writing this snapshot file so
    // a recovery scan cannot pick up the file we are about to add, then
    // unshift a duplicate of it.
    const index = await loadIndex();
    const snapshotFile = join(SNAPSHOTS_DIR, `${snapshot.id}.json`);
    await atomicWrite(snapshotFile, { ...snapshot, data });
    index.snapshots.unshift(snapshot);
    await saveIndex(index);
    console.log(`📸 Time capsule created: "${label}" (${snapshot.id.slice(0, 8)})`);
    return snapshot;
  });
}

/**
 * List all snapshots (metadata only, no data)
 */
export async function listSnapshots() {
  const index = await loadIndex();
  return index.snapshots;
}

/**
 * Get a single snapshot with full data
 */
export async function getSnapshot(id) {
  const snapshotFile = join(SNAPSHOTS_DIR, `${id}.json`);
  const { value } = await readJSONFileStrict(snapshotFile, null);
  return value;
}

/**
 * Delete a snapshot
 */
export async function deleteSnapshot(id) {
  return queueIndexWrite(async () => {
    const index = await loadIndex();
    const exists = index.snapshots.find(s => s.id === id);
    if (!exists) return false;

    const snapshotFile = join(SNAPSHOTS_DIR, `${id}.json`);
    await unlink(snapshotFile).catch(() => {});

    index.snapshots = index.snapshots.filter(s => s.id !== id);
    await saveIndex(index);

    console.log(`🗑️ Time capsule deleted: "${exists.label}" (${id.slice(0, 8)})`);
    return true;
  });
}

/**
 * Compare two snapshots and return differences
 */
export async function compareSnapshots(id1, id2) {
  const [snap1, snap2] = await Promise.all([getSnapshot(id1), getSnapshot(id2)]);
  if (!snap1 || !snap2) return null;

  const diff = {
    snapshot1: { id: snap1.id, label: snap1.label, createdAt: snap1.createdAt },
    snapshot2: { id: snap2.id, label: snap2.label, createdAt: snap2.createdAt },
    changes: []
  };

  // Compare document counts
  const s1 = snap1.summary;
  const s2 = snap2.summary;

  const fields = [
    ['documentCount', 'Documents'],
    ['enabledDocuments', 'Enabled documents'],
    ['markdownFiles', 'Markdown files'],
    ['goalsCount', 'Goals'],
    ['storiesCount', 'Autobiography stories'],
    ['genomeMarkers', 'Genome markers'],
    ['testHistoryCount', 'Test runs']
  ];

  for (const [key, label] of fields) {
    if (s1[key] !== s2[key]) {
      diff.changes.push({ field: label, before: s1[key], after: s2[key] });
    }
  }

  // Compare markdown document lists
  const docs1 = Object.keys(snap1.data?.documents || {}).sort();
  const docs2 = Object.keys(snap2.data?.documents || {}).sort();
  const added = docs2.filter(d => !docs1.includes(d));
  const removed = docs1.filter(d => !docs2.includes(d));
  const modified = docs1.filter(d => docs2.includes(d) && snap1.data.documents[d] !== snap2.data.documents[d]);

  if (added.length > 0) diff.changes.push({ field: 'Documents added', value: added });
  if (removed.length > 0) diff.changes.push({ field: 'Documents removed', value: removed });
  if (modified.length > 0) diff.changes.push({ field: 'Documents modified', value: modified });

  // Compare traits
  if (JSON.stringify(s1.traits) !== JSON.stringify(s2.traits)) {
    diff.changes.push({ field: 'Traits', before: s1.traits, after: s2.traits });
  }

  return diff;
}
