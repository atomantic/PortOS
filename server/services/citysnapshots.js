/**
 * CyberCity Snapshot Store
 *
 * Periodically captures a compact snapshot of the CyberCity's derived state
 * (per-app status, agent activity, landmark counts, system health) to a
 * rolling, capped JSONL store. This is the prerequisite slice for the roadmap
 * 3.6 "historical timeline scrubber" (issue #877): the city derives everything
 * live with no persistence of past state, so there is nothing to scrub to until
 * snapshots accumulate. A future scrubber UI loads this series and drives the
 * 3D scene from a past frame.
 *
 * Snapshots are local-only — each install records its own derived state and
 * never syncs to federated peers.
 *
 * Storage mirrors the proven rolling-JSONL pattern in `history.js`: append on
 * the hot path, compact (rewrite) only when the cap is exceeded, 2s read cache,
 * and a single write-queue tail so concurrent captures can't interleave.
 */

import { join } from 'path';
import {
  appendJSONLine,
  ensureDir,
  PATHS,
  readJSONLines,
  writeJSONLines,
} from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { getSettings } from './settings.js';
import * as apps from './apps.js';
import * as cos from './cos.js';
import { getSelf, getPeers } from './instances.js';
import * as backup from './backup.js';
import { getCountsByType } from './notifications.js';
import { getCharacter } from './character.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import os from 'os';

const DATA_DIR = PATHS.data;
const SNAPSHOTS_FILE = join(DATA_DIR, 'city-snapshots.jsonl');

// Bump when the snapshot shape changes incompatibly so a future scrubber can
// gate on frame shape and skip / migrate older frames rather than mis-render.
export const SNAPSHOT_SCHEMA_VERSION = 1;

// Config defaults — surfaced via getSnapshotConfig() so installs with no
// `citySnapshots` settings key behave sanely without a migration.
export const DEFAULT_SNAPSHOT_CONFIG = {
  enabled: true,
  intervalMinutes: 5,
  maxSnapshots: 1000, // ~3.5 days at the 5-minute default
};

// In-memory cache with TTL (mirrors history.js).
let snapshotCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000;
const queueSnapshotWrite = createFileWriteQueue();

/**
 * Resolve the effective snapshot config, layering the user's settings slice
 * over the defaults. Hand-edited / partial settings degrade to defaults
 * field-by-field rather than disabling capture wholesale.
 */
export async function getSnapshotConfig() {
  const settings = await getSettings().catch(() => ({}));
  const c = settings?.citySnapshots || {};
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULT_SNAPSHOT_CONFIG.enabled,
    intervalMinutes: Number.isFinite(c.intervalMinutes) && c.intervalMinutes >= 1
      ? Math.floor(c.intervalMinutes)
      : DEFAULT_SNAPSHOT_CONFIG.intervalMinutes,
    maxSnapshots: Number.isFinite(c.maxSnapshots) && c.maxSnapshots >= 10
      ? Math.floor(c.maxSnapshots)
      : DEFAULT_SNAPSHOT_CONFIG.maxSnapshots,
  };
}

async function loadSnapshots() {
  const now = Date.now();
  if (snapshotCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return snapshotCache;
  }
  await ensureDir(DATA_DIR);
  snapshotCache = await readJSONLines(SNAPSHOTS_FILE, { logErrors: true });
  cacheTimestamp = now;
  return snapshotCache;
}

/**
 * Assemble a compact city-state frame from server-side service getters.
 *
 * Each source is wrapped so one failing getter degrades that field to a
 * sentinel (null / empty) rather than dropping the whole frame — a partial
 * snapshot is more useful to a scrubber than a missing one, and a captured
 * `null` distinguishes "source unavailable at capture time" from "absent."
 */
async function buildSnapshot() {
  const [appStatuses, cosStatus, self, peers, backupState, notifCounts, character, memStats] =
    await Promise.all([
      apps.getAppStatuses().catch(() => []),
      cos.getStatus().catch(() => null),
      getSelf().catch(() => null),
      getPeers().catch(() => []),
      backup.getState().catch(() => null),
      getCountsByType().catch(() => null),
      getCharacter().catch(() => null),
      getMemoryStats().catch(() => null),
    ]);

  const onlineApps = appStatuses.filter(a => a.overallStatus === 'online').length;
  const onlinePeers = (peers || []).filter(p => p?.status === 'online').length;

  const memUsagePercent = memStats && memStats.total > 0
    ? Math.round((memStats.used / memStats.total) * 100)
    : null;
  const cpuCount = os.cpus().length || 1;
  const cpuUsagePercent = Math.round((os.loadavg()[0] / cpuCount) * 100);

  return {
    ts: new Date().toISOString(),
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    // Per-building state — the minimum a scrubber needs to re-render and
    // diff adjacent frames for construction/teardown animations.
    apps: appStatuses.map(a => ({ id: a.id, name: a.name, status: a.overallStatus })),
    counts: {
      appsOnline: onlineApps,
      appsTotal: appStatuses.length,
      agentsActive: cosStatus?.activeAgents ?? 0,
      agentsPaused: cosStatus?.pausedAgents ?? 0,
      tasksCompleted: cosStatus?.stats?.tasksCompleted ?? 0,
      peersOnline: onlinePeers,
      peersTotal: (peers || []).length,
      notificationsUnread: notifCounts?.unread ?? 0,
    },
    cos: {
      running: cosStatus?.running ?? false,
      paused: cosStatus?.paused ?? false,
    },
    backup: {
      status: backupState?.status ?? null,
      lastRun: backupState?.lastRun ?? null,
    },
    health: {
      cpuPercent: Number.isFinite(cpuUsagePercent) ? cpuUsagePercent : null,
      memPercent: memUsagePercent,
    },
    character: {
      level: character?.level ?? null,
    },
    instance: {
      id: self?.instanceId ?? null,
      name: self?.name ?? null,
    },
  };
}

/**
 * Capture a snapshot now: build the frame, append it, and enforce the cap.
 * Serialized on the write queue so a scheduled capture and a manual
 * `POST /capture` can't interleave their read-modify-write.
 *
 * @returns {Promise<object>} the captured snapshot frame
 */
export async function captureSnapshot() {
  const frame = await buildSnapshot();
  const { maxSnapshots } = await getSnapshotConfig();

  return queueSnapshotWrite(async () => {
    const existing = await loadSnapshots();
    const next = [...existing, frame];

    if (next.length > maxSnapshots) {
      // Over cap: rewrite the file with the trailing window (drops oldest).
      const trimmed = next.slice(-maxSnapshots);
      await ensureDir(DATA_DIR);
      await writeJSONLines(SNAPSHOTS_FILE, trimmed);
      snapshotCache = trimmed;
    } else {
      await appendJSONLine(SNAPSHOTS_FILE, frame);
      snapshotCache = next;
    }
    cacheTimestamp = Date.now();
    return frame;
  });
}

/**
 * Read the snapshot series, oldest-first (chronological — a scrubber drags
 * left→right through time).
 *
 * @param {object} [options]
 * @param {number} [options.limit] - return only the most recent N frames
 * @param {string} [options.since] - ISO timestamp; return only frames at/after it
 * @returns {Promise<{ total: number, snapshots: Array }>}
 */
export async function getSnapshots({ limit, since } = {}) {
  const all = await loadSnapshots();
  let frames = all;

  if (since) {
    const sinceMs = Date.parse(since);
    if (Number.isFinite(sinceMs)) {
      frames = frames.filter(f => Date.parse(f.ts) >= sinceMs);
    }
  }

  const total = frames.length;
  if (Number.isFinite(limit) && limit >= 0 && limit < frames.length) {
    frames = frames.slice(-limit); // most-recent N, still chronological
  }

  return { total, snapshots: frames };
}
