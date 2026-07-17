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
import { getAgents } from './cosAgents.js';
import { getCosTasks } from './cosTaskStore.js';
import { getPendingCounts } from './review.js';
import { getSelf, getPeers } from './instances.js';
import * as backup from './backup.js';
import { getCountsByType } from './notifications.js';
import { getCharacter } from './character.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { statfs } from 'fs/promises';
import os from 'os';

// Root-filesystem disk usage percent, derived the same way the
// /api/system/health/details route does (bavail = blocks available to the
// user). Returns null when statfs is unavailable so a failed read reads as
// "unknown," not "0% full".
async function getDiskPercent() {
  const stats = await statfs('/').catch(() => null);
  if (!stats) return null;
  const total = stats.blocks * stats.bsize;
  if (!(total > 0)) return null;
  const used = total - stats.bavail * stats.bsize;
  return Math.round((used / total) * 100);
}

const DATA_DIR = PATHS.data;
const SNAPSHOTS_FILE = join(DATA_DIR, 'city-snapshots.jsonl');

// Sentinel a getter falls back to when it throws — distinct from a successful
// empty read. `null` for object/array sources means "source unavailable at
// capture time" (CLAUDE.md's absent-vs-empty rule), so a transient failure
// never reads as a legitimate "zero apps / zero peers" in the history.
const FAILED = null;

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

// True when `child` is `parent` itself or a path strictly nested under it.
// Plain `startsWith` would mis-match sibling-prefix repos (/repos/proj would
// "contain" /repos/project), so require a path boundary at the join.
function isPathUnder(child, parent) {
  if (child === parent) return true;
  const base = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(base);
}

// Map a CoS agent to the app it's working in by matching its workspacePath
// against each app's repoPath. workspacePath may sit on the agent or in its
// metadata depending on spawn path. Unlike the client's live agentMap (which
// recomputes every render), this mapping is persisted replay data, so it must
// be unambiguous: match on a path boundary and let the LONGEST matching
// repoPath win, so a nested app repo beats its parent.
function resolveAgentApp(agent, appStatuses) {
  const workspacePath = agent?.workspacePath || agent?.metadata?.workspacePath;
  if (!workspacePath || !Array.isArray(appStatuses)) return null;
  let best = null;
  for (const a of appStatuses) {
    if (!a.repoPath || !isPathUnder(workspacePath, a.repoPath)) continue;
    if (!best || a.repoPath.length > best.repoPath.length) best = a;
  }
  return best?.id ?? null;
}

/**
 * Assemble a compact city-state frame from server-side service getters.
 *
 * Each source is wrapped so one failing getter degrades to the `FAILED` (null)
 * sentinel rather than dropping the whole frame — a partial snapshot is more
 * useful to a scrubber than a missing one. Crucially, a thrown getter records
 * `null` (source unavailable), NOT an empty array / zero count, so a transient
 * failure can't masquerade as a legitimate "zero apps / zero peers" in the
 * history (CLAUDE.md's absent-vs-empty rule). Counts derived from a FAILED
 * source are likewise `null`, distinct from a real `0` on a successful read.
 */
async function buildSnapshot() {
  const [appStatuses, cosStatus, agents, taskState, reviewCounts, self, peers, backupState, notifCounts, character, memStats, diskPercent] =
    await Promise.all([
      apps.getAppStatuses().catch(() => FAILED),
      cos.getStatus().catch(() => FAILED),
      getAgents().catch(() => FAILED),
      getCosTasks().catch(() => FAILED),
      getPendingCounts().catch(() => FAILED),
      getSelf().catch(() => FAILED),
      getPeers().catch(() => FAILED),
      backup.getState().catch(() => FAILED),
      getCountsByType().catch(() => FAILED),
      // Only `character.level` is snapshotted (see the frame below), so skip the skill
      // fan-out — this runs on every snapshot tick.
      getCharacter({ withSkills: false }).catch(() => FAILED),
      getMemoryStats().catch(() => FAILED),
      getDiskPercent().catch(() => null),
    ]);

  // Per-app state + agent→app assignments — the minimum a scrubber needs to
  // re-render buildings and diff adjacent frames for construction/teardown.
  // `null` (not `[]`) when the source failed, so the scrubber can skip vs. clear.
  const appsFrame = Array.isArray(appStatuses)
    ? appStatuses.map(a => ({ id: a.id, name: a.name, status: a.overallStatus }))
    : null;
  const assignmentsFrame = Array.isArray(agents)
    ? agents
        .filter(a => a?.status === 'running')
        .map(a => ({ agentId: a.id, appId: resolveAgentApp(a, appStatuses), status: a.status }))
    : null;

  const tasks = Array.isArray(taskState?.tasks) ? taskState.tasks : null;
  const taskCount = (status) => tasks === null ? null : tasks.filter(t => t?.status === status).length;

  const memUsagePercent = memStats && memStats.total > 0
    ? Math.round((memStats.used / memStats.total) * 100)
    : null;
  // os.loadavg() returns [0,0,0] on Windows (no load average) — record null
  // there rather than a misleading 0% so it reads as "unavailable," not "idle."
  const cpuPercent = process.platform === 'win32'
    ? null
    : Math.min(100, Math.round((os.loadavg()[0] / (os.cpus().length || 1)) * 100));

  // Successful-empty reads yield real 0s; FAILED sources yield null.
  const onlineApps = appsFrame === null ? null : appsFrame.filter(a => a.status === 'online').length;
  const onlinePeers = peers === null ? null : peers.filter(p => p?.status === 'online').length;

  return {
    ts: new Date().toISOString(),
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    apps: appsFrame,
    assignments: assignmentsFrame,
    counts: {
      appsOnline: onlineApps,
      appsTotal: appsFrame === null ? null : appsFrame.length,
      agentsActive: cosStatus === null ? null : (cosStatus.activeAgents ?? 0),
      agentsPaused: cosStatus === null ? null : (cosStatus.pausedAgents ?? 0),
      tasksCompleted: cosStatus === null ? null : (cosStatus.stats?.tasksCompleted ?? 0),
      tasksPending: taskCount('pending'),
      tasksInProgress: taskCount('in_progress'),
      peersOnline: onlinePeers,
      peersTotal: peers === null ? null : peers.length,
      notificationsUnread: notifCounts === null ? null : (notifCounts.unread ?? 0),
      reviewTotal: reviewCounts === null ? null : (reviewCounts.total ?? 0),
    },
    cos: cosStatus === null ? null : {
      running: cosStatus.running ?? false,
      paused: cosStatus.paused ?? false,
    },
    backup: backupState === null ? null : {
      status: backupState.status ?? null,
      lastRun: backupState.lastRun ?? null,
    },
    health: {
      cpuPercent,
      memPercent: memUsagePercent,
      diskPercent,
    },
    character: { level: character === null ? null : (character.level ?? null) },
    instance: self === null ? null : {
      id: self.instanceId ?? null,
      name: self.name ?? null,
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

  return queueSnapshotWrite(async () => {
    // Resolve the cap inside the queued turn so the trim reads the freshest
    // config alongside the persisted series (mirrors history.js keeping MAX in
    // its write path).
    const { maxSnapshots } = await getSnapshotConfig();
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
  // A direct caller passing limit 0 means "none" — but slice(-0) returns the
  // WHOLE array, so handle 0 explicitly. The route's Zod schema enforces
  // limit >= 1, so this only hardens direct callers.
  if (Number.isFinite(limit) && limit >= 0 && limit < frames.length) {
    frames = limit === 0 ? [] : frames.slice(-limit); // most-recent N, chronological
  }

  return { total, snapshots: frames };
}
