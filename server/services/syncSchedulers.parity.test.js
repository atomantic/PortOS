import { describe, it, expect, vi, beforeEach } from 'vitest';

// Parity guard for the shared factory refactor (#4883): the settings-gated
// ingestion schedulers now differ only in the options they hand
// `createSyncScheduler`, which makes an id/emoji/source copy-paste swap between
// domains invisible at a glance. Pin each domain's registered event here.
//
// Beeper (fork issue #32) is the fifth domain. It carries one extra gate the
// other four do not — the instance feature plus a configured token, checked
// before the factory ever runs — so `./beeperSync.js` is mocked with that gate
// already open here; `beeperScheduler.test.js` covers the closed cases.
const scheduleMock = vi.fn();
// `getEvent`/`cancel` are here for beeperScheduler's arm/disarm helpers, which
// ask the scheduler whether `beeper-sync` is already registered rather than
// keeping a second copy of that fact. Nothing is registered in this suite, so
// `getEvent` always answers null.
vi.mock('./eventScheduler.js', () => ({
  schedule: (...args) => scheduleMock(...args),
  getEvent: () => null,
  cancel: () => false,
}));

const enabledConfig = async () => ({ enabled: true, intervalMinutes: 25 });
vi.mock('./imessageSync.js', () => ({ getImessageConfig: enabledConfig, runSync: vi.fn() }));
vi.mock('./signalSync.js', () => ({ getSignalConfig: enabledConfig, runSync: vi.fn() }));
vi.mock('./spotifySync.js', () => ({ getSpotifyConfig: enabledConfig, runSync: vi.fn() }));
vi.mock('./youtubeSync.js', () => ({ getYoutubeConfig: enabledConfig, runSync: vi.fn() }));
vi.mock('./beeperSync.js', () => ({
  getBeeperSyncConfig: enabledConfig,
  isBeeperIngestionArmed: async () => true,
  runBeeperSweep: vi.fn(),
}));

const { startImessageScheduler } = await import('./imessageScheduler.js');
const { startSignalScheduler } = await import('./signalScheduler.js');
const { startSpotifyScheduler } = await import('./spotifyScheduler.js');
const { startYoutubeScheduler } = await import('./youtubeScheduler.js');
const { startBeeperScheduler } = await import('./beeperScheduler.js');

const DOMAINS = [
  { name: 'iMessage', start: startImessageScheduler, id: 'imessage-sync', source: 'imessageScheduler', icon: '💬', label: 'iMessage' },
  { name: 'Signal', start: startSignalScheduler, id: 'signal-sync', source: 'signalScheduler', icon: '🔒', label: 'Signal' },
  { name: 'Spotify', start: startSpotifyScheduler, id: 'spotify-sync', source: 'spotifyScheduler', icon: '🎧', label: 'Spotify' },
  { name: 'YouTube', start: startYoutubeScheduler, id: 'youtube-sync', source: 'youtubeScheduler', icon: '📺', label: 'YouTube' },
  { name: 'Beeper', start: startBeeperScheduler, id: 'beeper-sync', source: 'beeperScheduler', icon: '🫧', label: 'Beeper' },
];

beforeEach(() => {
  scheduleMock.mockClear();
});

describe.each(DOMAINS)('$name sync scheduler', ({ start, id, source, icon, label }) => {
  it('registers its own event id, metadata source, and log prefix', async () => {
    const logs = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line) => { logs.push(line); });

    await start();

    logSpy.mockRestore();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const [event] = scheduleMock.mock.calls[0];
    expect(event.id).toBe(id);
    expect(event.metadata).toEqual({ source });
    // 'interval' means the first run lands one interval AFTER registration:
    // no ingestion sweep fires at boot, for any domain.
    expect(event.type).toBe('interval');
    expect(event.intervalMs).toBe(25 * 60 * 1000);
    expect(logs).toContain(`${icon} ${label} sync scheduler: registered every 25min`);
  });
});

it('gives every domain a distinct event id', () => {
  expect(new Set(DOMAINS.map((d) => d.id)).size).toBe(DOMAINS.length);
});
