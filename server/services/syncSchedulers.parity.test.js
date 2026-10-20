import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

const FIXED_NOW = new Date('2024-01-01T00:00:00.000Z');

let syncStates = {
  imessage: { lastRunAt: null },
  signal: { lastRunAt: null },
  spotify: { lastRunAt: null },
  youtube: { lastRunAt: null },
};

const scheduleMock = vi.fn();

vi.mock('./eventScheduler.js', async () => {
  const actual = await vi.importActual('./eventScheduler.js');
  return {
    ...actual,
    schedule: (config) => {
      const event = actual.schedule(config);
      scheduleMock(config, event);
      return event;
    },
  };
});

const enabledConfig = async () => ({ enabled: true, intervalMinutes: 25 });
vi.mock('./imessageSync.js', () => ({
  getImessageConfig: enabledConfig,
  runSync: vi.fn(),
  readSyncState: async () => syncStates.imessage,
}));
vi.mock('./signalSync.js', () => ({
  getSignalConfig: enabledConfig,
  runSync: vi.fn(),
  readSyncState: async () => syncStates.signal,
}));
vi.mock('./spotifySync.js', () => ({
  getSpotifyConfig: enabledConfig,
  runSync: vi.fn(),
  readSyncState: async () => syncStates.spotify,
}));
vi.mock('./youtubeSync.js', () => ({
  getYoutubeConfig: enabledConfig,
  runSync: vi.fn(),
  readSyncState: async () => syncStates.youtube,
}));
vi.mock('./beeperSync.js', () => ({
  getBeeperSyncConfig: enabledConfig,
  isBeeperIngestionArmed: async () => true,
  runBeeperSweep: vi.fn(),
}));

const { cancelAll, BOOT_GRACE_MS } = await import('./eventScheduler.js');
const { startImessageScheduler } = await import('./imessageScheduler.js');
const { startSignalScheduler } = await import('./signalScheduler.js');
const { startSpotifyScheduler } = await import('./spotifyScheduler.js');
const { startYoutubeScheduler } = await import('./youtubeScheduler.js');
const { startBeeperScheduler } = await import('./beeperScheduler.js');

const DOMAINS = [
  { name: 'iMessage', key: 'imessage', start: startImessageScheduler, id: 'imessage-sync', source: 'imessageScheduler', icon: '💬', label: 'iMessage' },
  { name: 'Signal', key: 'signal', start: startSignalScheduler, id: 'signal-sync', source: 'signalScheduler', icon: '🔒', label: 'Signal' },
  { name: 'Spotify', key: 'spotify', start: startSpotifyScheduler, id: 'spotify-sync', source: 'spotifyScheduler', icon: '🎧', label: 'Spotify' },
  { name: 'YouTube', key: 'youtube', start: startYoutubeScheduler, id: 'youtube-sync', source: 'youtubeScheduler', icon: '📺', label: 'YouTube' },
  { name: 'Beeper', key: null, start: startBeeperScheduler, id: 'beeper-sync', source: 'beeperScheduler', icon: '🫧', label: 'Beeper' },
];

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  cancelAll();
  scheduleMock.mockClear();
  syncStates = {
    imessage: { lastRunAt: null },
    signal: { lastRunAt: null },
    spotify: { lastRunAt: null },
    youtube: { lastRunAt: null },
  };
});

describe.each(DOMAINS)('$name sync scheduler', ({ key, start, id, source, icon, label }) => {
  it('registers its own event id, metadata source, and log prefix without boot sweep when never run', async () => {
    if (key) syncStates[key] = { lastRunAt: null };
    const logs = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line) => { logs.push(line); });

    await start();

    logSpy.mockRestore();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const [config, event] = scheduleMock.mock.calls[0];
    expect(config.id).toBe(id);
    expect(config.metadata).toEqual({ source });
    // 'interval' means the first run lands one interval AFTER registration:
    // no ingestion sweep fires at boot, for any domain.
    expect(config.type).toBe('interval');
    expect(config.intervalMs).toBe(25 * 60 * 1000);
    expect(config.lastRunAt ?? null).toBeNull();
    expect(event.nextRunAt).toBe(FIXED_NOW.getTime() + 25 * 60 * 1000);
    expect(logs).toContain(`${icon} ${label} sync scheduler: registered every 25min`);
  });

  if (key) {
    it('runs once BOOT_GRACE_MS after boot when last run is overdue (#12624)', async () => {
      // 2 hours ago (interval is 25 min, so overdue)
      const overdueAt = new Date(FIXED_NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
      syncStates[key] = { lastRunAt: overdueAt };

      await start();

      expect(scheduleMock).toHaveBeenCalledTimes(1);
      const [config, event] = scheduleMock.mock.calls[0];
      expect(config.lastRunAt).toBe(overdueAt);
      expect(event.nextRunAt).toBe(FIXED_NOW.getTime() + BOOT_GRACE_MS);
    });

    it('first fires at lastRunAt + intervalMs when last run was recent (#12624)', async () => {
      // 5 minutes ago (interval is 25 min, remaining is 20 min)
      const recentAt = new Date(FIXED_NOW.getTime() - 5 * 60 * 1000).toISOString();
      syncStates[key] = { lastRunAt: recentAt };

      await start();

      expect(scheduleMock).toHaveBeenCalledTimes(1);
      const [config, event] = scheduleMock.mock.calls[0];
      expect(config.lastRunAt).toBe(recentAt);
      expect(event.nextRunAt).toBe(new Date(recentAt).getTime() + 25 * 60 * 1000);
    });
  }
});

it('gives every domain a distinct event id', () => {
  expect(new Set(DOMAINS.map((d) => d.id)).size).toBe(DOMAINS.length);
});
