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
// assignment list. Only running assignments are captured. A null assignments
// array (failed capture) yields an empty map — playback shows no agent entities
// rather than fabricating them.
export function buildPlaybackAgentMap(frame, playbackApps = []) {
  const map = new Map();
  if (!Array.isArray(frame?.assignments)) return map;
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

// Derive the count-driven scene props from a frame. Each value is null when the
// frame recorded null (source unavailable) so the consuming component shows its
// empty state rather than a fabricated zero.
function deriveCountProps(frame) {
  const c = frame?.counts || {};
  return {
    cosStatus: frame?.cos == null ? null : {
      running: frame.cos.running ?? false,
      paused: frame.cos.paused ?? false,
      activeAgents: c.agentsActive ?? null,
      pausedAgents: c.agentsPaused ?? null,
      stats: { tasksCompleted: c.tasksCompleted ?? null },
    },
    backupStatus: frame?.backup == null ? null : {
      status: frame.backup.status ?? null,
      lastRun: frame.backup.lastRun ?? null,
    },
    // systemHealth shape mirrors what useCityData exposes (percent fields).
    systemHealth: (frame?.health && (frame.health.cpuPercent != null || frame.health.memPercent != null || frame.health.diskPercent != null))
      ? {
          system: {
            cpu: { usagePercent: frame.health.cpuPercent },
            memory: { usagePercent: frame.health.memPercent },
            disk: { usagePercent: frame.health.diskPercent },
          },
        }
      : null,
    character: frame?.character == null ? null : { level: frame.character.level ?? null },
    instances: frame?.instance == null ? null : {
      self: { instanceId: frame.instance.id, name: frame.instance.name },
      peers: [],
      syncStatus: null,
    },
    reviewCounts: c.reviewTotal == null ? null : { total: c.reviewTotal },
    notificationCounts: c.notificationsUnread == null ? null : { unread: c.notificationsUnread },
  };
}

// The full set of CityScene/CityHud props a snapshot frame can drive. The page
// spreads these OVER the live props, so any prop NOT returned here (memoryGraph,
// goals, jiraTickets, activityCalendar, productivityData, chronotype, etc.) keeps
// its live value — the deliberate "freeze unfed landmarks at live" behavior.
//
// Returns null when the frame isn't playable (wrong/absent schemaVersion) so the
// caller can keep showing live data and flag the frame.
export function mergeFrameIntoCityProps(frame, live = {}) {
  if (!isPlayableFrame(frame)) return null;
  const apps = buildPlaybackApps(frame, live.apps);
  const agentMap = buildPlaybackAgentMap(frame, apps);
  return {
    apps,
    agentMap,
    ...deriveCountProps(frame),
  };
}
