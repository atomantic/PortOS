// Pure mappers that turn a recorded CyberCity snapshot frame (issue #877 capture
// pipeline) into the prop shape CityScene consumes, for the timeline scrubber
// (issue #967). No React, no I/O — unit-tested in cityPlaybackFrame.test.js.
//
// A snapshot frame is compact: per-app { id, name, status }, agent assignments,
// and counts/health/cos/backup/character. It does NOT carry the rich landmark
// inputs (memory graph, goals, jira, activity, productivity), so playback drives
// only what the frame can feed and the page leaves the rest at their live values
// ("freeze unfed landmarks at live").
//
// Sentinel discipline mirrors the capture side: a `null` field means "source
// unavailable at capture time" — never fabricate a 0/empty in its place. A null
// apps/assignments array falls back to the live value rather than emptying the
// city.

// The snapshot shape this scrubber understands. A frame whose schemaVersion
// differs should be skipped/flagged by the caller rather than mis-rendered.
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSION = 1;

export const isPlayableFrame = (frame) =>
  !!frame && frame.schemaVersion === SUPPORTED_SNAPSHOT_SCHEMA_VERSION;

// Build the apps array CityScene renders from a frame, recovering render-only
// fields (processes, repoPath, type, archived) from the matching live app and
// overriding overallStatus with the frame's recorded status. Apps in the live
// set but absent from the frame are dropped (they teardown-animate out). Apps in
// the frame but no longer live render from the compact fields with safe defaults.
export function buildPlaybackApps(frame, liveApps = []) {
  // Failed capture → fall back to live apps rather than emptying the city.
  if (!Array.isArray(frame?.apps)) return liveApps;
  const liveById = new Map((liveApps || []).map((a) => [a.id, a]));
  return frame.apps.map((snap) => {
    const live = liveById.get(snap.id);
    if (live) {
      return { ...live, overallStatus: snap.status };
    }
    // App no longer exists live — render a minimal building from the frame.
    return {
      id: snap.id,
      name: snap.name,
      overallStatus: snap.status,
      archived: false,
      processes: [],
    };
  });
}

// Rebuild the agentMap (Map<appId, { app, agents }>) from the frame's compact
// assignment list. Only running assignments are captured.
//
// Sentinel discipline: a `null` assignments array means "agent source failed at
// capture time" — return the live agentMap (passed in) rather than an empty map,
// so a transient capture failure doesn't read as "no agents were running." A
// real empty array yields a real empty map (no agent entities).
export function buildPlaybackAgentMap(frame, playbackApps = [], liveAgentMap = new Map()) {
  if (!Array.isArray(frame?.assignments)) return liveAgentMap;
  const map = new Map();
  const appById = new Map((playbackApps || []).map((a) => [a.id, a]));
  for (const asn of frame.assignments) {
    if (!asn?.appId) continue;
    const app = appById.get(asn.appId);
    if (!app) continue;
    const existing = map.get(asn.appId) || { app, agents: [] };
    existing.agents.push({ agentId: asn.agentId, status: asn.status });
    map.set(asn.appId, existing);
  }
  return map;
}

// The CityScene props a snapshot frame can FAITHFULLY drive — i.e. scene elements
// whose data the frame actually carries at the right granularity:
//   apps        → buildings (per-app status)
//   agentMap    → agent entities (assignments)
//   cosStatus   → skyline automation state (running/paused/active)
//   backupStatus→ backup vault (status/lastRun)
//   character   → artifact placement (level)
//
// Deliberately NOT returned (so the page leaves them at LIVE — "freeze unfed
// landmarks at live"): the count-only landmarks (task queue, federation horizon,
// health tower, memory, goals, jira, activity) render from rich per-item arrays
// the snapshot doesn't carry, only aggregate counts. Faking array items from a
// count would misrepresent history; instead the captured counts are surfaced as
// numbers in the playback overlay via buildPlaybackStats(). Each value is null
// when the frame recorded null (source unavailable at capture).
//
// Returns null when the frame isn't playable (wrong/absent schemaVersion) so the
// caller can keep showing live data and flag the frame.
export function mergeFrameIntoCityProps(frame, live = {}) {
  if (!isPlayableFrame(frame)) return null;
  const apps = buildPlaybackApps(frame, live.apps);
  const agentMap = buildPlaybackAgentMap(frame, apps, live.agentMap);
  return {
    apps,
    agentMap,
    cosStatus: frame?.cos == null ? null : {
      running: frame.cos.running ?? false,
      paused: frame.cos.paused ?? false,
      activeAgents: frame.counts?.agentsActive ?? null,
      pausedAgents: frame.counts?.agentsPaused ?? null,
      stats: { tasksCompleted: frame.counts?.tasksCompleted ?? null },
    },
    backupStatus: frame?.backup == null ? null : {
      status: frame.backup.status ?? null,
      lastRun: frame.backup.lastRun ?? null,
    },
    character: frame?.character == null ? null : { level: frame.character.level ?? null },
  };
}

// Historical numbers the snapshot captured that don't drive a 3D landmark (their
// landmarks render from rich arrays and stay live). Surfaced as a readout in the
// playback overlay so the captured counts/health are still visible while
// scrubbing. Preserves null (unavailable at capture) vs a real number — the
// overlay renders null as "—". Returns null for an unplayable frame.
export function buildPlaybackStats(frame) {
  if (!isPlayableFrame(frame)) return null;
  const c = frame.counts || {};
  const h = frame.health || {};
  return {
    cpuPercent: h.cpuPercent ?? null,
    memPercent: h.memPercent ?? null,
    diskPercent: h.diskPercent ?? null,
    agentsActive: c.agentsActive ?? null,
    tasksPending: c.tasksPending ?? null,
    tasksInProgress: c.tasksInProgress ?? null,
    peersOnline: c.peersOnline ?? null,
    peersTotal: c.peersTotal ?? null,
    reviewTotal: c.reviewTotal ?? null,
    notificationsUnread: c.notificationsUnread ?? null,
  };
}
