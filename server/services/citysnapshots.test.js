import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const readLines = (path) =>
  readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

describe('citysnapshots service', () => {
  let dataDir;
  let snapshotsFile;

  beforeEach(() => {
    vi.resetModules();
    dataDir = mkdtempSync(join(tmpdir(), 'portos-citysnap-'));
    snapshotsFile = join(dataDir, 'city-snapshots.jsonl');
  });

  afterEach(() => {
    vi.doUnmock('../lib/fileUtils.js');
    vi.doUnmock('./settings.js');
    vi.doUnmock('./apps.js');
    vi.doUnmock('./cos.js');
    vi.doUnmock('./cosAgents.js');
    vi.doUnmock('./cosTaskStore.js');
    vi.doUnmock('./review.js');
    vi.doUnmock('./instances.js');
    vi.doUnmock('./backup.js');
    vi.doUnmock('./notifications.js');
    vi.doUnmock('./character.js');
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Load the service with the data dir redirected and all data-source services
  // mocked. `sources`/`settings` overrides let individual tests vary inputs.
  async function loadService({ settings = {}, sources = {}, reject = [], fileOverrides = {} } = {}) {
    // Honor an explicitly-provided override (including `null`) over the default;
    // `key in sources` distinguishes "not provided" from "provided as null".
    const src = (key, fallback) => (key in sources ? sources[key] : fallback);
    // A getter named in `reject` rejects (simulating a failed source) so the
    // service's .catch(() => FAILED) sentinel path is exercised.
    const mock = (key, value) => reject.includes(key)
      ? vi.fn().mockRejectedValue(new Error(`${key} unavailable`))
      : vi.fn().mockResolvedValue(value);
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, PATHS: { ...actual.PATHS, data: dataDir }, ...fileOverrides };
    });
    vi.doMock('./settings.js', () => ({
      getSettings: vi.fn().mockResolvedValue(settings),
    }));
    vi.doMock('./apps.js', () => ({
      getAppStatuses: mock('appStatuses', src('appStatuses', [
        { id: 'a1', name: 'App One', type: 'express', repoPath: '/repos/a1', overallStatus: 'online', managed: true },
        { id: 'a2', name: 'App Two', type: 'express', repoPath: '/repos/a2', overallStatus: 'stopped', managed: true },
      ])),
    }));
    vi.doMock('./cos.js', () => ({
      getStatus: mock('cosStatus', src('cosStatus', {
        running: true, paused: false, activeAgents: 2, pausedAgents: 0,
        stats: { tasksCompleted: 7 },
      })),
    }));
    vi.doMock('./cosAgents.js', () => ({
      getAgents: mock('agents', src('agents', [
        { id: 'agent-1', status: 'running', workspacePath: '/repos/a1/sub' },
        { id: 'agent-2', status: 'completed', workspacePath: '/repos/a2' },
      ])),
    }));
    vi.doMock('./cosTaskStore.js', () => ({
      getCosTasks: mock('taskState', src('taskState', {
        tasks: [{ status: 'pending' }, { status: 'pending' }, { status: 'in_progress' }],
      })),
    }));
    vi.doMock('./review.js', () => ({
      getPendingCounts: mock('reviewCounts', src('reviewCounts', { total: 4, alert: 1, todo: 3 })),
    }));
    vi.doMock('./instances.js', () => ({
      getSelf: mock('self', src('self', { instanceId: 'inst-1', name: 'void' })),
      getPeers: mock('peers', src('peers', [
        { status: 'online' }, { status: 'offline' },
      ])),
    }));
    vi.doMock('./backup.js', () => ({
      getState: mock('backupState', src('backupState', { status: 'success', lastRun: '2026-06-05T00:00:00.000Z' })),
    }));
    vi.doMock('./notifications.js', () => ({
      getCountsByType: mock('notifCounts', src('notifCounts', { total: 5, unread: 3, byType: {} })),
    }));
    vi.doMock('./character.js', () => ({
      getCharacter: mock('character', src('character', { level: 4 })),
    }));
    return import('./citysnapshots.js');
  }

  it('captures a compact frame and appends it as JSONL', async () => {
    const svc = await loadService();
    const frame = await svc.captureSnapshot();

    expect(frame.schemaVersion).toBe(svc.SNAPSHOT_SCHEMA_VERSION);
    expect(typeof frame.ts).toBe('string');
    expect(frame.apps).toEqual([
      { id: 'a1', name: 'App One', status: 'online' },
      { id: 'a2', name: 'App Two', status: 'stopped' },
    ]);
    // Only the running agent is captured, mapped to its app via repoPath prefix.
    expect(frame.assignments).toEqual([
      { agentId: 'agent-1', appId: 'a1', status: 'running' },
    ]);
    expect(frame.counts).toMatchObject({
      appsOnline: 1, appsTotal: 2, agentsActive: 2, tasksCompleted: 7,
      tasksPending: 2, tasksInProgress: 1,
      peersOnline: 1, peersTotal: 2, notificationsUnread: 3, reviewTotal: 4,
    });
    expect(frame.cos).toEqual({ running: true, paused: false });
    expect(frame.backup).toEqual({ status: 'success', lastRun: '2026-06-05T00:00:00.000Z' });
    expect(frame.character).toEqual({ level: 4 });
    expect(frame.instance).toEqual({ id: 'inst-1', name: 'void' });
    // Health triad — cpu/mem/disk are number-or-null (real values from the host).
    expect(frame.health).toHaveProperty('cpuPercent');
    expect(frame.health).toHaveProperty('memPercent');
    expect(frame.health).toHaveProperty('diskPercent');
    for (const v of [frame.health.cpuPercent, frame.health.memPercent, frame.health.diskPercent]) {
      expect(v === null || typeof v === 'number').toBe(true);
    }

    expect(existsSync(snapshotsFile)).toBe(true);
    expect(readLines(snapshotsFile)).toHaveLength(1);
  });

  it('resolves config defaults when settings absent, and overrides when present', async () => {
    const svcDefault = await loadService();
    expect(await svcDefault.getSnapshotConfig()).toEqual(svcDefault.DEFAULT_SNAPSHOT_CONFIG);

    vi.resetModules();
    const svcCustom = await loadService({
      settings: { citySnapshots: { enabled: false, intervalMinutes: 15, maxSnapshots: 50 } },
    });
    expect(await svcCustom.getSnapshotConfig()).toEqual({ enabled: false, intervalMinutes: 15, maxSnapshots: 50 });
  });

  it('falls back to defaults field-by-field for invalid settings values', async () => {
    const svc = await loadService({
      settings: { citySnapshots: { enabled: 'yes', intervalMinutes: 0, maxSnapshots: 5 } },
    });
    // enabled non-boolean → default true; intervalMinutes <1 → default; maxSnapshots <10 → default
    expect(await svc.getSnapshotConfig()).toEqual(svc.DEFAULT_SNAPSHOT_CONFIG);
  });

  it('enforces the maxSnapshots cap by dropping the oldest frames', async () => {
    const svc = await loadService({ settings: { citySnapshots: { maxSnapshots: 10 } } });

    for (let i = 0; i < 13; i += 1) {
      await svc.captureSnapshot();
    }

    const lines = readLines(snapshotsFile);
    expect(lines).toHaveLength(10);

    const { total, snapshots } = await svc.getSnapshots();
    expect(total).toBe(10);
    expect(snapshots).toHaveLength(10);
    // Chronological (oldest-first) and timestamps non-decreasing.
    for (let i = 1; i < snapshots.length; i += 1) {
      expect(Date.parse(snapshots[i].ts)).toBeGreaterThanOrEqual(Date.parse(snapshots[i - 1].ts));
    }
  });

  it('degrades a null data source to a sentinel rather than dropping the frame', async () => {
    const svc = await loadService({
      sources: { character: null, backupState: null, self: null },
    });
    const frame = await svc.captureSnapshot();
    expect(frame.character).toEqual({ level: null });
    expect(frame.backup).toBeNull();
    expect(frame.instance).toBeNull();
    // Frame still recorded despite missing sources.
    expect(readLines(snapshotsFile)).toHaveLength(1);
  });

  it('records null (not zero/empty) when a source throws, distinguishing failure from a real empty read', async () => {
    const svc = await loadService({ reject: ['appStatuses', 'peers', 'reviewCounts'] });
    const frame = await svc.captureSnapshot();

    // Failed array sources → null, NOT [] — so the scrubber can skip the frame
    // rather than rendering a transient outage as "all buildings demolished."
    expect(frame.apps).toBeNull();
    // Counts derived from a failed source are null, not a misleading 0.
    expect(frame.counts.appsOnline).toBeNull();
    expect(frame.counts.appsTotal).toBeNull();
    expect(frame.counts.peersOnline).toBeNull();
    expect(frame.counts.peersTotal).toBeNull();
    expect(frame.counts.reviewTotal).toBeNull();
    // Frame is still captured (partial > missing).
    expect(readLines(snapshotsFile)).toHaveLength(1);
  });

  it('distinguishes a real empty read (0) from a failed one (null)', async () => {
    const svc = await loadService({ sources: { appStatuses: [], peers: [], reviewCounts: { total: 0 } } });
    const frame = await svc.captureSnapshot();
    // Successful but empty → real zeros, not null.
    expect(frame.apps).toEqual([]);
    expect(frame.counts.appsOnline).toBe(0);
    expect(frame.counts.appsTotal).toBe(0);
    expect(frame.counts.peersOnline).toBe(0);
    expect(frame.counts.reviewTotal).toBe(0);
  });

  it('getSnapshots honors limit (most-recent N) and since filters', async () => {
    const svc = await loadService();
    const frames = [];
    for (let i = 0; i < 5; i += 1) frames.push(await svc.captureSnapshot());

    const limited = await svc.getSnapshots({ limit: 2 });
    expect(limited.total).toBe(5);
    expect(limited.snapshots).toHaveLength(2);
    expect(limited.snapshots[1].ts).toBe(frames[4].ts);

    const since = frames[3].ts;
    const sinceResult = await svc.getSnapshots({ since });
    expect(sinceResult.snapshots.every(f => Date.parse(f.ts) >= Date.parse(since))).toBe(true);
  });

  it('maps an agent to the longest matching repoPath, not a sibling-prefix app', async () => {
    const svc = await loadService({
      sources: {
        // App order deliberately puts the prefix-only app FIRST; boundary +
        // longest-match must still pick the nested app the agent actually works in.
        appStatuses: [
          { id: 'proj', name: 'Proj', repoPath: '/repos/proj', overallStatus: 'online' },
          { id: 'project', name: 'Project', repoPath: '/repos/project', overallStatus: 'online' },
        ],
        agents: [
          { id: 'agent-1', status: 'running', workspacePath: '/repos/project/sub/dir' },
          // A bare-prefix path that is NOT under /repos/proj (no boundary) maps to nothing.
          { id: 'agent-2', status: 'running', workspacePath: '/repos/projectile' },
        ],
      },
    });
    const frame = await svc.captureSnapshot();
    expect(frame.assignments).toEqual([
      { agentId: 'agent-1', appId: 'project', status: 'running' },
      { agentId: 'agent-2', appId: null, status: 'running' },
    ]);
  });

  it('getSnapshots({ limit: 0 }) returns no frames (not the whole series)', async () => {
    const svc = await loadService();
    for (let i = 0; i < 3; i += 1) await svc.captureSnapshot();
    const result = await svc.getSnapshots({ limit: 0 });
    expect(result.total).toBe(3);
    expect(result.snapshots).toEqual([]);
  });

  it('serializes concurrent captures so none are lost', async () => {
    const svc = await loadService();
    await Promise.all(Array.from({ length: 12 }, () => svc.captureSnapshot()));
    expect(readLines(snapshotsFile)).toHaveLength(12);
  });
});
