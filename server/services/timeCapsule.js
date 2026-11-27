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
import { atomicWrite, ensureDir, PATHS, readJSONFileStrict, tryReadFile, unreadableStoreError } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const DIGITAL_TWIN_DIR = PATHS.digitalTwin;
const SNAPSHOTS_DIR = join(DIGITAL_TWIN_DIR, 'snapshots');
const INDEX_FILE = join(SNAPSHOTS_DIR, 'index.json');
const JSON_TWIN_FILES = [
  'meta.json', 'identity.json', 'goals.json', 'taste-profile.json',
  'feedback.json', 'longevity.json', 'chronotype.json',
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
        await readSnapshotFile(join(SNAPSHOTS_DIR, name))
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
  const { ok, value } = await readJSONFileStrict(INDEX_FILE, null, { logError: false });
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
 * Count saved markers across both legacy snapshot shapes (`savedMarkers` map,
 * `markers` array) and the aggregate snapshot summary (`markerCount`).
 */
function countGenomeMarkers(genome) {
  if (!isPlainObject(genome)) return 0;
  if (isPlainObject(genome.savedMarkers)) return Object.keys(genome.savedMarkers).length;
  if (Array.isArray(genome.markers)) return genome.markers.length;
  if (typeof genome.markerCount === 'number' && Number.isFinite(genome.markerCount)) {
    return genome.markerCount;
  }
  return 0;
}

/**
 * Project live genome metadata into aggregate summary counts only so newly
 * created snapshots never retain raw `savedMarkers`, genotypes, notes, or upload `filename`.
 */
function summarizeGenomeForSnapshot(genome) {
  if (!isPlainObject(genome)) return null;
  const markerList = isPlainObject(genome.savedMarkers)
    ? Object.values(genome.savedMarkers)
    : (Array.isArray(genome.markers) ? genome.markers : []);
  const statusCounts = { beneficial: 0, typical: 0, concern: 0, major_concern: 0, not_found: 0 };
  for (const marker of markerList) {
    if (marker && statusCounts[marker.status] !== undefined) {
      statusCounts[marker.status]++;
    }
  }
  return {
    uploaded: Boolean(genome.uploaded),
    uploadedAt: genome.uploadedAt ?? null,
    snpCount: typeof genome.snpCount === 'number' ? genome.snpCount : 0,
    build: genome.build ?? null,
    markerCount: countGenomeMarkers(genome),
    statusCounts,
    lastScanAt: genome.lastScanAt ?? null
  };
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
    // The genome store moved to the meatspace directory; the key stays 'genome.json' so older snapshots line up.
    { key: 'genome.json', path: join(PATHS.meatspace, 'genome.json') },
    { key: 'autobiography/stories.json', path: join(DIGITAL_TWIN_DIR, 'autobiography', 'stories.json') }
  ];
  await Promise.all(jsonTargets.map(async ({ key, path }) => {
    const { ok, value: parsed } = await readJSONFileStrict(path, null, { logError: false });
    if (!ok) console.warn(`⚠️ Time capsule skipped unreadable input: ${key}`);
    if (parsed == null) return;
    if (key === 'genome.json') {
      const summary = summarizeGenomeForSnapshot(parsed);
      if (summary) files[key] = summary;
      return;
    }
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
    genomeMarkers: countGenomeMarkers(genome),
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
  // Admit before the shared write tail: a cut drains the complete file/index pair,
  // and collecting inside the queue prevents racing a concurrent stripGenomeFromSnapshots().
  return withBackupAssetPublication(() => queueIndexWrite(async () => {
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

    // Load (and maybe rebuild) the index BEFORE writing this snapshot file so
    // a recovery scan cannot pick up the file we are about to add, then
    // unshift a duplicate of it.
    const index = await loadIndex();
    const snapshotFile = join(SNAPSHOTS_DIR, `${snapshot.id}.json`);
    await atomicWrite(snapshotFile, { ...snapshot, data });
    index.snapshots.unshift(snapshot);
    await saveIndex(index);
    console.log(`📸 Time capsule created: ${snapshot.id.slice(0, 8)}`);
    return snapshot;
  }));
}

function clearObjectFields(target, fields) {
  if (!isPlainObject(target)) return false;
  let changed = false;
  for (const field of fields) {
    if (!Object.hasOwn(target, field)) continue;
    const current = target[field];
    if (!isPlainObject(current) || Object.keys(current).length > 0) {
      target[field] = {};
      changed = true;
    }
  }
  return changed;
}

function clearNullFields(target, fields) {
  if (!isPlainObject(target)) return false;
  let changed = false;
  for (const field of fields) {
    if (Object.hasOwn(target, field) && target[field] !== null) {
      target[field] = null;
      changed = true;
    }
  }
  return changed;
}

function stripGenomeFromSnapshot(snapshot) {
  let changed = false;
  const data = isPlainObject(snapshot.data) ? structuredClone(snapshot.data) : null;

  if (data) {
    if (Object.hasOwn(data, 'genome.json')) {
      delete data['genome.json'];
      changed = true;
    }
    if (clearObjectFields(data['chronotype.json'], ['geneticMarkers', 'caffeineMarkers'])) {
      changed = true;
    }
    if (clearObjectFields(data['longevity.json'], ['longevityMarkers', 'cardiovascularMarkers'])) {
      changed = true;
    }
    if (clearNullFields(data['goals.json'], ['lifeExpectancy', 'timeHorizons'])) {
      changed = true;
    }
  }

  if (isPlainObject(snapshot.summary) && snapshot.summary.genomeMarkers !== 0) {
    changed = true;
  }

  if (!changed) return { changed: false, snapshot };

  const nextData = data ?? snapshot.data;
  const dataString = JSON.stringify(nextData ?? {});
  const dataHash = createHash('sha256').update(dataString).digest('hex').slice(0, 16);
  const sizeBytes = Buffer.byteLength(dataString, 'utf-8');
  const summary = isPlainObject(snapshot.summary)
    ? { ...snapshot.summary, genomeMarkers: 0 }
    : buildSummary(nextData ?? {});

  return {
    changed: true,
    snapshot: {
      ...snapshot,
      dataHash,
      sizeBytes,
      summary,
      ...(data ? { data } : {})
    }
  };
}

async function scrubSnapshotFiles() {
  let entries;
  try {
    entries = await readdir(SNAPSHOTS_DIR);
  } catch (error) {
    if (error.code === 'ENOENT') return { updated: 0 };
    throw error;
  }

  const snapshotFiles = entries.filter(name => name.endsWith('.json') && name !== 'index.json');
  const loaded = [];
  for (const name of snapshotFiles) {
    const filePath = join(SNAPSHOTS_DIR, name);
    const { ok, value } = await readJSONFileStrict(filePath, null, { logError: false });
    if (ok && value === null) continue;
    if (!ok || !isPlainObject(value)) throw unreadableStoreError('data/digital-twin/snapshots');
    loaded.push({ filePath, parsed: value });
  }

  const updatedSnapshots = [];
  const updatedMetaById = new Map();
  const allMetas = [];

  for (const { filePath, parsed } of loaded) {
    const { changed, snapshot } = stripGenomeFromSnapshot(parsed);
    if (changed) {
      updatedSnapshots.push({ filePath, snapshot });
      const meta = indexEntryFromSnapshotFile(snapshot);
      if (meta) updatedMetaById.set(meta.id, meta);
    }
    const meta = indexEntryFromSnapshotFile(snapshot);
    if (meta) allMetas.push(meta);
  }

  for (const { filePath, snapshot } of updatedSnapshots) {
    await atomicWrite(filePath, snapshot);
  }

  const { ok: indexOk, value: indexValue } = await readJSONFileStrict(INDEX_FILE, null, { logError: false });
  if (indexOk && isUsableIndex(indexValue)) {
    const metaById = new Map(allMetas.map(meta => [meta.id, meta]));
    let indexChanged = false;
    const nextSnapshots = indexValue.snapshots.map(entry => {
      if (entry && metaById.has(entry.id)) {
        const diskMeta = metaById.get(entry.id);
        const staleIndex = updatedMetaById.has(entry.id)
          || entry.summary?.genomeMarkers !== diskMeta.summary?.genomeMarkers
          || entry.dataHash !== diskMeta.dataHash
          || entry.sizeBytes !== diskMeta.sizeBytes;
        if (staleIndex) {
          indexChanged = true;
          return diskMeta;
        }
        return entry;
      }
      if (isPlainObject(entry?.summary) && entry.summary.genomeMarkers !== 0) {
        indexChanged = true;
        return { ...entry, summary: { ...entry.summary, genomeMarkers: 0 } };
      }
      return entry;
    });
    if (indexChanged) {
      await saveIndex({ snapshots: nextSnapshots });
    }
  } else if (updatedSnapshots.length > 0 || !indexOk) {
    allMetas.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    await saveIndex({ snapshots: allMetas });
  }

  if (updatedSnapshots.length > 0) {
    console.log(`🧬 Stripped genome data from ${updatedSnapshots.length} Time Capsule snapshot(s)`);
  }
  return { updated: updatedSnapshots.length };
}

/**
 * Scrub genome fields and refresh the index under the backup lease and snapshot
 * write queue. Keep the queue through source removal so the next snapshot
 * cannot collect the same genome metadata again.
 */
export async function stripGenomeFromSnapshots(removeGenomeSource) {
  return withBackupAssetPublication(() => queueIndexWrite(async () => {
    const result = await scrubSnapshotFiles();
    await removeGenomeSource?.();
    return result;
  }));
}

/**
 * List all snapshots (metadata only, no data)
 */
export async function listSnapshots() {
  const index = await loadIndex();
  return index.snapshots;
}

async function readSnapshotFile(filePath) {
  const { ok, value } = await readJSONFileStrict(filePath, null, { logError: false });
  if (!ok) console.warn('⚠️ Time capsule snapshot is unreadable or malformed');
  return value;
}

/**
 * Get a single snapshot with full data
 */
export async function getSnapshot(id) {
  const snapshotFile = join(SNAPSHOTS_DIR, `${id}.json`);
  return readSnapshotFile(snapshotFile);
}

/**
 * Delete a snapshot
 */
export async function deleteSnapshot(id) {
  return withBackupAssetPublication(() => queueIndexWrite(async () => {
    const index = await loadIndex();
    const exists = index.snapshots.find(s => s.id === id);
    if (!exists) return false;

    const snapshotFile = join(SNAPSHOTS_DIR, `${id}.json`);
    // Commit reference removal first: a failed index write must retain the
    // snapshot bytes. Restore the listing on unlink failure so deletion stays retryable.
    const previousSnapshots = index.snapshots;
    index.snapshots = index.snapshots.filter(s => s.id !== id);
    await saveIndex(index);
    await unlink(snapshotFile).catch(async err => {
      if (err.code === 'ENOENT') return;
      index.snapshots = previousSnapshots;
      await saveIndex(index);
      throw err;
    });

    console.log(`🗑️ Time capsule deleted: ${id.slice(0, 8)}`);
    return true;
  }));
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
