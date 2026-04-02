/**
 * Time Capsule Service
 *
 * Creates versioned snapshots of digital twin data for historical preservation.
 * Supports creating, listing, viewing, comparing, and deleting snapshots.
 */

import { readFile, writeFile, unlink, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

const DIGITAL_TWIN_DIR = PATHS.digitalTwin;
const SNAPSHOTS_DIR = join(DIGITAL_TWIN_DIR, 'snapshots');
const INDEX_FILE = join(SNAPSHOTS_DIR, 'index.json');

async function ensureSnapshotsDir() {
  await ensureDir(SNAPSHOTS_DIR);
}

async function loadIndex() {
  await ensureSnapshotsDir();
  if (!existsSync(INDEX_FILE)) {
    return { snapshots: [] };
  }
  const raw = await readFile(INDEX_FILE, 'utf-8');
  return JSON.parse(raw);
}

async function saveIndex(index) {
  await ensureSnapshotsDir();
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

/**
 * Collect all digital twin data files into a single snapshot payload
 */
async function collectTwinData() {
  const files = {};
  const jsonFiles = ['meta.json', 'identity.json', 'goals.json', 'taste-profile.json',
    'feedback.json', 'genome.json', 'longevity.json', 'chronotype.json'];

  for (const filename of jsonFiles) {
    const filePath = join(DIGITAL_TWIN_DIR, filename);
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      files[filename] = JSON.parse(content);
    }
  }

  // Collect autobiography stories
  const storiesPath = join(DIGITAL_TWIN_DIR, 'autobiography', 'stories.json');
  if (existsSync(storiesPath)) {
    const content = await readFile(storiesPath, 'utf-8');
    files['autobiography/stories.json'] = JSON.parse(content);
  }

  // Collect all markdown documents
  const mdFiles = {};
  const entries = await readdir(DIGITAL_TWIN_DIR).catch(() => []);
  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      const filePath = join(DIGITAL_TWIN_DIR, entry);
      const info = await stat(filePath);
      if (info.isFile()) {
        mdFiles[entry] = await readFile(filePath, 'utf-8');
      }
    }
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

  // Save snapshot data
  const snapshotFile = join(SNAPSHOTS_DIR, `${snapshot.id}.json`);
  await writeFile(snapshotFile, JSON.stringify({ ...snapshot, data }, null, 2));

  // Update index
  const index = await loadIndex();
  index.snapshots.unshift(snapshot);
  await saveIndex(index);

  console.log(`📸 Time capsule created: "${label}" (${snapshot.id.slice(0, 8)})`);
  return snapshot;
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
  if (!existsSync(snapshotFile)) return null;
  const raw = await readFile(snapshotFile, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Delete a snapshot
 */
export async function deleteSnapshot(id) {
  const index = await loadIndex();
  const exists = index.snapshots.find(s => s.id === id);
  if (!exists) return false;

  const snapshotFile = join(SNAPSHOTS_DIR, `${id}.json`);
  if (existsSync(snapshotFile)) {
    await unlink(snapshotFile);
  }

  index.snapshots = index.snapshots.filter(s => s.id !== id);
  await saveIndex(index);

  console.log(`🗑️ Time capsule deleted: "${exists.label}" (${id.slice(0, 8)})`);
  return true;
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
