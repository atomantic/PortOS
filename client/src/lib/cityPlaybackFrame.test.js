import { describe, it, expect } from 'vitest';
import {
  isPlayableFrame,
  buildPlaybackApps,
  buildPlaybackAgentMap,
  mergeFrameIntoCityProps,
  SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
} from './cityPlaybackFrame.js';

const liveApps = [
  { id: 'a1', name: 'App One', overallStatus: 'online', archived: false, processes: [{ name: 'api' }], repoPath: '/repos/a1', type: 'express' },
  { id: 'a2', name: 'App Two', overallStatus: 'online', archived: false, processes: [], repoPath: '/repos/a2', type: 'express' },
];

const frame = (over = {}) => ({
  ts: '2026-06-05T12:00:00.000Z',
  schemaVersion: SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
  apps: [
    { id: 'a1', name: 'App One', status: 'stopped' },
    { id: 'a2', name: 'App Two', status: 'online' },
  ],
  assignments: [{ agentId: 'agent-1', appId: 'a1', status: 'running' }],
  counts: {
    appsOnline: 1, appsTotal: 2, agentsActive: 1, agentsPaused: 0,
    tasksCompleted: 7, tasksPending: 2, tasksInProgress: 1,
    peersOnline: 1, peersTotal: 2, notificationsUnread: 3, reviewTotal: 4,
  },
  cos: { running: true, paused: false },
  backup: { status: 'success', lastRun: '2026-06-05T00:00:00.000Z' },
  health: { cpuPercent: 12, memPercent: 40, diskPercent: 55 },
  character: { level: 4 },
  instance: { id: 'inst-1', name: 'void' },
  ...over,
});

describe('isPlayableFrame', () => {
  it('accepts a frame on the supported schema version', () => {
    expect(isPlayableFrame(frame())).toBe(true);
  });
  it('rejects a frame with a mismatched or absent schemaVersion', () => {
    expect(isPlayableFrame(frame({ schemaVersion: 99 }))).toBe(false);
    expect(isPlayableFrame({ ...frame(), schemaVersion: undefined })).toBe(false);
    expect(isPlayableFrame(null)).toBe(false);
  });
});

describe('buildPlaybackApps', () => {
  it('overrides live overallStatus with the frame status, keeping render-only fields', () => {
    const apps = buildPlaybackApps(frame(), liveApps);
    expect(apps).toHaveLength(2);
    const a1 = apps.find(a => a.id === 'a1');
    expect(a1.overallStatus).toBe('stopped');           // overridden from frame
    expect(a1.processes).toEqual([{ name: 'api' }]);     // recovered from live
    expect(a1.repoPath).toBe('/repos/a1');
  });

  it('drops live apps absent from the frame (teardown)', () => {
    const f = frame({ apps: [{ id: 'a1', name: 'App One', status: 'online' }] });
    const apps = buildPlaybackApps(f, liveApps);
    expect(apps.map(a => a.id)).toEqual(['a1']);
  });

  it('renders a minimal building for a frame app no longer live', () => {
    const f = frame({ apps: [{ id: 'gone', name: 'Ghost', status: 'stopped' }] });
    const apps = buildPlaybackApps(f, liveApps);
    expect(apps).toEqual([{ id: 'gone', name: 'Ghost', overallStatus: 'stopped', archived: false, processes: [] }]);
  });

  it('falls back to live apps when the frame apps array is null (failed capture)', () => {
    const f = frame({ apps: null });
    expect(buildPlaybackApps(f, liveApps)).toBe(liveApps);
  });
});

describe('buildPlaybackAgentMap', () => {
  it('rebuilds the agentMap keyed by appId from assignments', () => {
    const apps = buildPlaybackApps(frame(), liveApps);
    const map = buildPlaybackAgentMap(frame(), apps);
    expect(map.get('a1').agents).toEqual([{ agentId: 'agent-1', status: 'running' }]);
    expect(map.has('a2')).toBe(false);
  });

  it('returns an empty map when assignments are null', () => {
    const apps = buildPlaybackApps(frame(), liveApps);
    const map = buildPlaybackAgentMap(frame({ assignments: null }), apps);
    expect(map.size).toBe(0);
  });
});

describe('mergeFrameIntoCityProps', () => {
  it('returns null for an unplayable frame so the page keeps live data', () => {
    expect(mergeFrameIntoCityProps(frame({ schemaVersion: 99 }), { apps: liveApps })).toBeNull();
  });

  it('maps counts/health/cos/backup/character into scene props', () => {
    const props = mergeFrameIntoCityProps(frame(), { apps: liveApps });
    expect(props.cosStatus).toMatchObject({ running: true, activeAgents: 1, stats: { tasksCompleted: 7 } });
    expect(props.backupStatus).toEqual({ status: 'success', lastRun: '2026-06-05T00:00:00.000Z' });
    expect(props.systemHealth.system.cpu.usagePercent).toBe(12);
    expect(props.systemHealth.system.disk.usagePercent).toBe(55);
    expect(props.character).toEqual({ level: 4 });
    expect(props.reviewCounts).toEqual({ total: 4 });
    expect(props.notificationCounts).toEqual({ unread: 3 });
    expect(props.instances.self).toEqual({ instanceId: 'inst-1', name: 'void' });
  });

  it('passes null (not a fabricated 0) when a frame field was unavailable at capture', () => {
    const props = mergeFrameIntoCityProps(
      frame({ cos: null, backup: null, character: null, health: { cpuPercent: null, memPercent: null, diskPercent: null }, counts: { reviewTotal: null, notificationsUnread: null } }),
      { apps: liveApps },
    );
    expect(props.cosStatus).toBeNull();
    expect(props.backupStatus).toBeNull();
    expect(props.character).toBeNull();
    expect(props.systemHealth).toBeNull();
    expect(props.reviewCounts).toBeNull();
    expect(props.notificationCounts).toBeNull();
  });

  it('does NOT return unfed landmark props, so the page leaves them at live values', () => {
    const props = mergeFrameIntoCityProps(frame(), { apps: liveApps });
    for (const key of ['memoryGraph', 'goals', 'jiraTickets', 'activityCalendar', 'productivityData', 'chronotype']) {
      expect(props).not.toHaveProperty(key);
    }
  });
});
