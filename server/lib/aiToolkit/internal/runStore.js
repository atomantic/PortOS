/** Manage persisted run directories, metadata, and cached history. */
import { mkdir, readFile, readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { atomicWrite } from './atomicWrite.js';

export function safeJsonParse(str, fallback = {}) {
  if (typeof str !== 'string' || !str.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(str);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function createRunStore({ runsPath, withAssetPublication }) {
  // A run id arrives from an HTTP route param (`DELETE /api/runs/:id`), and
  // Express decodes `%2F`, so `..%2Fbrain` would otherwise `join` out of
  // runsPath and `rm -r` a sibling data directory. Minted ids are UUIDs; accept
  // only a single plain segment and treat anything else as "no such run".
  const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  const existingRunDir = (runId) => {
    if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) return null;
    const runDir = join(runsPath, runId);
    return existsSync(runDir) ? runDir : null;
  };

  async function ensureRunsDir() {
    if (!existsSync(runsPath)) {
      await mkdir(runsPath, { recursive: true });
    }
  }

  // Parsed run records keyed by id, each tagged with the stat signature of the
  // metadata.json it came from. The run store is unbounded, so listing re-reads
  // only records whose file changed since the last scan. Validation is by
  // stat, not by "terminal records never change": host services outside this
  // toolkit (usage reconcile, agent run tracking, migrations in another
  // process) patch finished records, and a cache that trusted them would serve
  // stale fields. atomicWrite renames a new file into place, so every rewrite
  // changes the inode as well as the mtime.
  const runRecordCache = new Map();
  const RUN_SCAN_CONCURRENCY = 64;
  const statSignature = (info) => `${info.ino}:${info.size}:${info.mtimeNs}`;

  async function readRunRecord(runId) {
    const metadataPath = join(runsPath, runId, 'metadata.json');
    const info = await stat(metadataPath, { bigint: true }).catch(() => null);
    if (!info) {
      runRecordCache.delete(runId);
      return null;
    }
    const signature = statSignature(info);
    const cached = runRecordCache.get(runId);
    if (cached?.signature === signature) return cached.metadata;
    const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
    // A record caught mid-write parses as {} and is not cached, so the next
    // scan reads it again instead of hiding the run until its next rewrite.
    if (!metadata.id) {
      runRecordCache.delete(runId);
      return null;
    }
    runRecordCache.set(runId, { signature, metadata });
    return metadata;
  }

  // Every run record on disk as { runId, metadata }, in directory order. One
  // readdir per call picks up directories created by other processes; ids that
  // vanished are evicted.
  async function scanRunRecords() {
    await ensureRunsDir();
    const entries = await readdir(runsPath, { withFileTypes: true });
    const runIds = entries.filter(e => e.isDirectory()).map(e => e.name);
    const present = new Set(runIds);
    for (const runId of runRecordCache.keys()) if (!present.has(runId)) runRecordCache.delete(runId);
    const records = [];
    for (let i = 0; i < runIds.length; i += RUN_SCAN_CONCURRENCY) {
      const batch = runIds.slice(i, i + RUN_SCAN_CONCURRENCY);
      const parsed = await Promise.all(batch.map(readRunRecord));
      parsed.forEach((metadata, j) => { if (metadata) records.push({ runId: batch[j], metadata }); });
    }
    return records;
  }

  // Execution ownership is best-effort tracking, like the host's metadata patch.
  async function patchRunMetadata(runId, patch) {
    return withAssetPublication(async () => {
      const metadataPath = join(runsPath, runId, 'metadata.json');
      const metadata = safeJsonParse(await readFile(metadataPath, 'utf8').catch(() => null), null);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
      await atomicWrite(metadataPath, { ...metadata, ...patch }).catch(() => {});
    });
  }

  return {
    ensureRunsDir,
    patchRunMetadata,
    async getRun(runId) {
      const runDir = existingRunDir(runId);
      if (!runDir) return null;

      const metadata = safeJsonParse(await readFile(join(runDir, 'metadata.json'), 'utf-8').catch(() => '{}'));
      return metadata;
    },

    async getRunOutput(runId) {
      const runDir = existingRunDir(runId);
      if (!runDir) return null;

      return readFile(join(runDir, 'output.txt'), 'utf-8');
    },

    async getRunPrompt(runId) {
      const runDir = existingRunDir(runId);
      if (!runDir) return null;

      return readFile(join(runDir, 'prompt.txt'), 'utf-8');
    },

    async listRuns(limit = 50, offset = 0, source = 'all') {
      const runs = (await scanRunRecords()).map(({ metadata }) => metadata);

      let filteredRuns = runs;
      if (source !== 'all') {
        filteredRuns = runs.filter(run => {
          const runSource = run.source || 'devtools';
          return runSource === source;
        });
      }

      filteredRuns.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

      // Copies, so a caller that decorates a page cannot edit the cached records.
      return {
        total: filteredRuns.length,
        runs: filteredRuns.slice(offset, offset + limit).map(run => structuredClone(run))
      };
    },

    async removeRun(runId) {
      const runDir = existingRunDir(runId);
      if (!runDir) return false;

      // A live run's finalizer can still be flushing a file into the directory
      // when the recursive remove lists it; ENOTEMPTY then means "retry", not
      // "the delete failed" (flaked the live-delete cancellation test, #16657).
      await withAssetPublication(() => rm(runDir, { recursive: true, maxRetries: 5, retryDelay: 20 }));
      runRecordCache.delete(runId);
      return true;
    },

    async deleteFailedRuns() {
      let deletedCount = 0;
      for (const { runId, metadata } of await scanRunRecords()) {
        if (metadata.success !== false) continue;
        await withAssetPublication(() => rm(join(runsPath, runId), { recursive: true }));
        runRecordCache.delete(runId);
        deletedCount++;
      }

      return deletedCount;
    },
  };
}
