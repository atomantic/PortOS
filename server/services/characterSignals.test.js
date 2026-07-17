import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Every domain getter is stubbed so the context can be driven without any of the real
// dependency graphs (Postgres, the universe store, the meatspace files) loading. Each stub
// counts its calls — the whole point of this module is that a signal is read ONCE per
// context no matter how many skills/metrics ask for it.
const calls = vi.hoisted(() => ({ universes: 0, sessions: 0, memories: 0 }));

vi.mock('./universeBuilder.js', () => ({
  countUniverses: vi.fn(async () => { calls.universes += 1; return 3; }),
}));
vi.mock('./writersRoom/local.js', () => ({ countWorks: vi.fn(async () => 1) }));
vi.mock('./catalogDB.js', () => ({ getCatalogStats: vi.fn(async () => ({ total: 2, scraps: 1 })) }));
vi.mock('./meatspacePost.js', () => ({
  getPostSessions: vi.fn(async () => { calls.sessions += 1; return [{ date: '2026-07-17' }]; }),
}));
vi.mock('./meatspacePostTraining.js', () => ({ getAllTrainingEntries: vi.fn(async () => []) }));
vi.mock('./meatspaceLoggingStats.js', () => ({ getLoggingStats: vi.fn(async () => ({ currentStreak: 4, totalLogged: 9 })) }));
vi.mock('./identity/goals.js', () => ({ getGoals: vi.fn(async () => ({ goals: [] })) }));
vi.mock('./memoryBackend.js', () => ({
  countMemories: vi.fn(async () => { calls.memories += 1; return 42; }),
}));
vi.mock('./mediaAssetIndex/db.js', () => ({ countAssets: vi.fn(async () => 7) }));
vi.mock('../lib/timezone.js', () => ({ userLocalToday: vi.fn(async () => '2026-07-17') }));

import { createSignalContext, SIGNAL_READERS } from './characterSignals.js';
import { countUniverses } from './universeBuilder.js';
import { countMemories } from './memoryBackend.js';

beforeEach(() => {
  calls.universes = 0;
  calls.sessions = 0;
  calls.memories = 0;
  vi.mocked(countUniverses).mockImplementation(async () => { calls.universes += 1; return 3; });
  vi.mocked(countMemories).mockImplementation(async () => { calls.memories += 1; return 42; });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the signal registry', () => {
  it('exposes every signal the skills and metrics registries read', () => {
    // A signal removed from here silently breaks whichever registry reads it (the read throws
    // → the consumer classifies it `unavailable` → the tile lies about the domain being down).
    expect(Object.keys(SIGNAL_READERS).sort()).toEqual([
      'assetCount', 'catalogStats', 'goals', 'loggingStats', 'memoryCount',
      'postSessions', 'postToday', 'postTraining', 'universeCount', 'workCount',
    ]);
  });

  it('declares every reader as a function', () => {
    for (const reader of Object.values(SIGNAL_READERS)) {
      expect(typeof reader).toBe('function');
    }
  });
});

describe('createSignalContext — read-once', () => {
  it('resolves a signal to its getter value', async () => {
    const read = createSignalContext();
    await expect(read('universeCount')).resolves.toBe(3);
    await expect(read('memoryCount')).resolves.toBe(42);
    await expect(read('catalogStats')).resolves.toEqual({ total: 2, scraps: 1 });
  });

  it('reads a signal ONCE however many consumers ask for it', async () => {
    // The reason this module exists: Wordsmith and recordsCreated both want universeCount.
    const read = createSignalContext();
    const [a, b, c] = await Promise.all([read('universeCount'), read('universeCount'), read('universeCount')]);
    expect([a, b, c]).toEqual([3, 3, 3]);
    expect(calls.universes).toBe(1);
  });

  it('memoizes across sequential reads too, not just concurrent ones', async () => {
    const read = createSignalContext();
    await read('postSessions');
    await read('postSessions');
    expect(calls.sessions).toBe(1);
  });

  it('gives each context its OWN cache, so a later request sees fresh stats', async () => {
    // A module-level cache would be a correctness bug: the sheet would never notice the
    // session the user just logged.
    await createSignalContext()('universeCount');
    await createSignalContext()('universeCount');
    expect(calls.universes).toBe(2);
  });
});

describe('createSignalContext — failures propagate, they are not classified', () => {
  it('rejects with the getter\'s own error so the consumer can classify it', async () => {
    const boom = new Error('memory backend unavailable');
    vi.mocked(countMemories).mockImplementation(async () => { throw boom; });

    const read = createSignalContext();
    await expect(read('memoryCount')).rejects.toBe(boom);
  });

  it('caches a failure and re-throws it to every consumer', async () => {
    let hits = 0;
    vi.mocked(countMemories).mockImplementation(async () => { hits += 1; throw new Error('down'); });

    const read = createSignalContext();
    await expect(read('memoryCount')).rejects.toThrow('down');
    await expect(read('memoryCount')).rejects.toThrow('down');
    // A failing signal must not be retried per consumer — that would stampede a downed
    // Postgres once per skill AND once per metric that reads it.
    expect(hits).toBe(1);
  });

  it('contains a failure to its own signal — other signals still resolve', async () => {
    vi.mocked(countMemories).mockImplementation(async () => { throw new Error('down'); });

    const read = createSignalContext();
    await expect(read('memoryCount')).rejects.toThrow('down');
    await expect(read('universeCount')).resolves.toBe(3);
  });

  it('normalizes a getter that throws SYNCHRONOUSLY into a rejection', async () => {
    // Otherwise the throw would escape read() synchronously and blow past the consumer's
    // `.catch()`-based unavailable classification.
    vi.mocked(countMemories).mockImplementation(() => { throw new Error('sync boom'); });

    const read = createSignalContext();
    await expect(read('memoryCount')).rejects.toThrow('sync boom');
  });

  it('re-throws a cached failure to a consumer that reads it AFTER it already settled', async () => {
    // The two registries do not read in lockstep — a metric can reach a signal a skill already
    // resolved (and failed on) ticks earlier. A settled rejected promise must still reject for
    // that late reader rather than resolving undefined.
    vi.mocked(countMemories).mockImplementation(async () => { throw new Error('down'); });

    const read = createSignalContext();
    await expect(read('memoryCount')).rejects.toThrow('down');
    await new Promise((resolve) => setTimeout(resolve, 5)); // let it fully settle

    await expect(read('memoryCount')).rejects.toThrow('down');
  });

  it('raises no unhandled rejection when every consumer handles the failure', async () => {
    // The realistic shape: both registries read a downed signal and each classifies it. Node's
    // default policy kills the process on an unhandled rejection, so a shared cached rejection
    // fanning out to several awaiters must not produce one.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.mocked(countMemories).mockImplementation(async () => { throw new Error('down'); });

    const read = createSignalContext();
    await Promise.all([
      read('memoryCount').catch(() => 'skill-classified-it'),
      read('memoryCount').catch(() => 'metric-classified-it'),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);

    expect(unhandled.mock.calls.filter(([err]) => err?.message === 'down')).toHaveLength(0);
  });
});

describe('createSignalContext — unknown signal', () => {
  it('throws synchronously rather than rejecting', async () => {
    // A rejection would be swallowed by the consumer's unavailable classification and a typo'd
    // signal id would masquerade as "this domain is down" forever.
    const read = createSignalContext();
    expect(() => read('nopeNotASignal')).toThrow('Unknown character signal: nopeNotASignal');
  });
});
