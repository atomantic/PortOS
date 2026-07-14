/**
 * CoS Agent Index Module
 *
 * The date-bucket index + on-disk archive layout for CoS agents. Extracted from
 * the former monolithic cosAgents.js (issue #2530) so the index/migration/archive
 * concerns live in one focused module. Owns the lazy `agentIndex` singleton and
 * the directory-resolution helper the lifecycle/feedback/archive modules share.
 *
 * The public barrel `cosAgents.js` re-exports everything here.
 */

import { readFile, writeFile, rename, readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { AGENTS_DIR } from './cosState.js';
import { atomicWrite, ensureDir, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { repairCodexTaskSummary } from './codexSummaryRepair.js';

const INDEX_FILE = join(AGENTS_DIR, 'index.json');

// Lightweight index mapping agentId → YYYY-MM-DD date bucket (~50KB vs 16MB full cache)
// Lazy-loaded from data/cos/agents/index.json on first access
let agentIndex = null;
let agentIndexPromise = null;

// Load agent index from disk (lazy init, singleton promise prevents concurrent migrations)
export async function loadAgentIndex() {
  if (agentIndex) return agentIndex;
  if (agentIndexPromise) return agentIndexPromise;

  agentIndexPromise = (async () => {
    if (!existsSync(AGENTS_DIR)) {
      await ensureDir(AGENTS_DIR);
    }

    if (existsSync(INDEX_FILE)) {
      const content = await tryReadFile(INDEX_FILE);
      const parsed = safeJSONParse(content ?? '{}', {});
      agentIndex = new Map(Object.entries(parsed));
      console.log(`📂 Loaded agent index: ${agentIndex.size} entries`);
    } else {
      // No index yet — run migration from flat dirs to date buckets
      agentIndex = await migrateAgentsToDateBuckets();
    }

    return agentIndex;
  })().catch(err => {
    agentIndexPromise = null;
    throw err;
  });

  return agentIndexPromise;
}

// Persist agent index to disk via the shared atomicWrite helper (temp file + rename,
// with Windows backup-swap fallback). Without atomic semantics a mid-write crash
// truncates index.json and on next boot the date-bucket migration would silently
// re-run (or worse, drop already-archived agents from the lookup).
export async function saveAgentIndex() {
  if (!agentIndex) return;
  const obj = Object.fromEntries(agentIndex);
  await atomicWrite(INDEX_FILE, obj).catch(err => {
    console.error(`❌ Failed to save agent index: ${err.message}`);
  });
}

/**
 * Merge a batch of {agentId, date} pairs into the agent index. Used by the
 * peer-sync CoS-history receiver (#1650): after pulling a peer's completed-agent
 * archives onto local disk, the date-bucket index must learn the new agentIds so
 * the history UI lists them. Idempotent union — only valid YYYY-MM-DD-bucketed
 * pairs are accepted. Returns the number of NEW entries added.
 *
 * A pre-existing agentId is treated as already-owned and is NEVER overwritten,
 * even when the incoming `date` differs: agent ids are generated independently
 * per instance, so an id collision (or a restored local archive) must not be able
 * to repoint a local agent's bucket at a peer's date — that would make
 * `getAgent()` read the wrong (or non-existent) directory and hide the local
 * agent's own history. First write wins; the local entry is authoritative.
 */
export async function addAgentArchivesToIndex(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return 0;
  const idx = await loadAgentIndex();
  let added = 0;
  for (const pair of pairs) {
    const agentId = pair?.agentId;
    const date = pair?.date;
    if (typeof agentId !== 'string' || !agentId) continue;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (idx.has(agentId)) continue; // already owned — never overwrite (id is authoritative)
    idx.set(agentId, date);
    added += 1;
  }
  if (added > 0) await saveAgentIndex();
  return added;
}

// Resolve the correct directory for an agent (running = flat, completed = date bucket)
export function getAgentDir(agentId, dateString) {
  if (dateString) return join(AGENTS_DIR, dateString, agentId);
  // Check index for date bucket
  const date = agentIndex?.get(agentId);
  if (date) return join(AGENTS_DIR, date, agentId);
  // Fallback to flat dir (running agents or pre-migration)
  return join(AGENTS_DIR, agentId);
}

// Migrate flat agent-* directories into YYYY-MM-DD date buckets
// Runs once when index.json doesn't exist. Idempotent — no-op if already migrated.
async function migrateAgentsToDateBuckets() {
  const index = new Map();

  if (!existsSync(AGENTS_DIR)) {
    await ensureDir(AGENTS_DIR);
    await atomicWrite(INDEX_FILE, {});
    console.log('📂 Created empty agent index (no agents to migrate)');
    return index;
  }

  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });

  // Also scan existing date-bucket dirs to include them in the index
  const dateDirPattern = /^\d{4}-\d{2}-\d{2}$/;
  for (const entry of entries) {
    if (!entry.isDirectory() || !dateDirPattern.test(entry.name)) continue;
    const dateStr = entry.name;
    const dateDir = join(AGENTS_DIR, dateStr);
    const agentDirs = await readdir(dateDir, { withFileTypes: true }).catch(() => []);
    for (const agentEntry of agentDirs) {
      if (agentEntry.isDirectory() && agentEntry.name.startsWith('agent-')) {
        index.set(agentEntry.name, dateStr);
      }
    }
  }

  // Find flat agent-* dirs that need migration
  const flatAgentDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('agent-'));

  if (flatAgentDirs.length === 0) {
    await atomicWrite(INDEX_FILE, Object.fromEntries(index));
    console.log(`📂 Agent index built: ${index.size} entries (no flat dirs to migrate)`);
    return index;
  }

  console.log(`📦 Migrating ${flatAgentDirs.length} agents into date buckets...`);
  let migrated = 0;
  let skipped = 0;

  for (const entry of flatAgentDirs) {
    const agentId = entry.name;
    const agentDir = join(AGENTS_DIR, agentId);
    const metaPath = join(agentDir, 'metadata.json');

    let dateStr = null;

    // Try to get date from metadata
    if (existsSync(metaPath)) {
      const content = await tryReadFile(metaPath);
      if (content) {
        const raw = safeJSONParse(content, null);
        if (raw?.completedAt) {
          dateStr = raw.completedAt.slice(0, 10); // YYYY-MM-DD
        }
      }
    }

    // Fallback: directory mtime
    if (!dateStr) {
      const dirStat = await stat(agentDir).catch(() => null);
      if (dirStat?.mtime) {
        dateStr = dirStat.mtime.toISOString().slice(0, 10);
      }
    }

    if (!dateStr) {
      console.log(`⚠️ Cannot determine date for ${agentId}, skipping`);
      skipped++;
      continue;
    }

    // Move into date bucket
    const bucketDir = join(AGENTS_DIR, dateStr);
    await ensureDir(bucketDir);
    const targetDir = join(bucketDir, agentId);

    // If target already exists (partial previous migration), skip
    if (existsSync(targetDir)) {
      index.set(agentId, dateStr);
      migrated++;
      continue;
    }

    await rename(agentDir, targetDir).catch(async (renameErr) => {
      // rename can fail across filesystems — fall back to copy+delete
      console.log(`⚠️ Rename failed for ${agentId}, using copy: ${renameErr.message}`);
      try {
        await ensureDir(targetDir);
        const files = await readdir(agentDir);
        for (const file of files) {
          const content = await readFile(join(agentDir, file));
          await writeFile(join(targetDir, file), content);
        }
        await rm(agentDir, { recursive: true });
      } catch (copyErr) {
        console.error(`❌ Copy fallback failed for ${agentId}: ${copyErr.message}`);
        // Clean up partially-created target to avoid skipping on next startup
        await rm(targetDir, { recursive: true, force: true }).catch(() => {});
        throw copyErr;
      }
    });

    index.set(agentId, dateStr);
    migrated++;
  }

  // Persist index
  await atomicWrite(INDEX_FILE, Object.fromEntries(index));
  const uniqueDates = new Set(index.values()).size;
  const parts = [`📦 Migrated ${migrated} agents into date buckets (${uniqueDates} unique dates)`];
  if (skipped > 0) parts.push(`skipped ${skipped} undatable`);
  console.log(parts.join(', '));

  return index;
}

// Prune agent archive date buckets older than retentionDays (default 90).
// Removes directories + their index entries. Runs after migration on startup.
export async function pruneOldAgentArchives(retentionDays = 90) {
  const idx = await loadAgentIndex();
  if (!idx || idx.size === 0) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const dateDirPattern = /^\d{4}-\d{2}-\d{2}$/;
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true }).catch(() => []);
  const oldDates = entries
    .filter(e => e.isDirectory() && dateDirPattern.test(e.name) && e.name < cutoffStr)
    .map(e => e.name);

  if (oldDates.length === 0) return;

  for (const dateStr of oldDates) {
    await rm(join(AGENTS_DIR, dateStr), { recursive: true }).catch(() => {});
  }

  // Remove index entries for all old dates in a single pass
  const oldDateSet = new Set(oldDates);
  let pruned = 0;
  for (const [agentId, date] of idx.entries()) {
    if (oldDateSet.has(date)) { idx.delete(agentId); pruned++; }
  }

  await saveAgentIndex();
  console.log(`🗑️ Pruned ${pruned} archived agents older than ${retentionDays} days (${oldDates.length} date buckets)`);
}

// Get available agent date buckets with counts, sorted descending
export async function getAgentDates() {
  const idx = await loadAgentIndex();
  const dateCounts = {};
  for (const date of idx.values()) {
    dateCounts[date] = (dateCounts[date] || 0) + 1;
  }
  return Object.entries(dateCounts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Get completed agents for a specific date bucket
export async function getAgentsByDate(date) {
  const dateDir = join(AGENTS_DIR, date);
  if (!existsSync(dateDir)) return [];

  const entries = await readdir(dateDir, { withFileTypes: true });
  const agentDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('agent-'));
  const agents = [];

  // Batch reads in chunks of 50 to avoid fd exhaustion on large date buckets
  const BATCH_SIZE = 50;
  for (let i = 0; i < agentDirs.length; i += BATCH_SIZE) {
    const batch = agentDirs.slice(i, i + BATCH_SIZE);
    const reads = batch.map(async (entry) => {
      const metaPath = join(dateDir, entry.name, 'metadata.json');
      const content = await tryReadFile(metaPath);
      if (!content) return;
      const raw = safeJSONParse(content, null);
      if (!raw) return;
      const id = raw.id || raw.agentId || entry.name;
      const { output, ...rest } = raw;
      const agent = { ...rest, id, status: raw.status || 'completed' };
      const repaired = await repairCodexTaskSummary(join(dateDir, entry.name), agent);
      if (repaired) agent.metadata = { ...agent.metadata, taskSummary: repaired };
      agents.push(agent);
    });
    await Promise.allSettled(reads);
  }

  return agents.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
}
