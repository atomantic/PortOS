import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// A timed drill's runner is a lazy chunk. Its clock must start when the runner
// mounts, not when PostTab requests the chunk: a slow download must not eat the
// user's time or auto-submit the drill. The real PostLlmDrillRunner is used
// here, with its import held open until the test releases it.

vi.mock('../../../services/apiMeatspace.js', () => ({
  getPostConfig: () => Promise.resolve({}),
  getPostRecommendations: () => Promise.resolve({ recommendations: [] }),
  getPostSessions: () => Promise.resolve([]),
  getPostStats: () => Promise.resolve(null),
  scorePostLlmDrill: () => new Promise(() => {}),
}));

const { chunk, completeLlmDrill, DRILL } = vi.hoisted(() => {
  let release;
  const opened = new Promise((resolve) => { release = resolve; });
  return {
    chunk: { opened, release, requested: false },
    completeLlmDrill: vi.fn(() => new Promise(() => {})),
    DRILL: {
      type: 'compound-chain',
      timeLimitSec: 10,
      challenges: [{ rootWord: 'fire', position: 'prefix', minExpected: 1 }],
    },
  };
});

vi.mock('../post/PostLlmDrillRunner', async () => {
  chunk.requested = true;
  await chunk.opened;
  return chunk.actual;
});

vi.mock('../post/usePostSession', () => ({
  usePostSession: () => ({
    state: 'active',
    drills: [{ type: DRILL.type, timeLimitSec: DRILL.timeLimitSec }],
    currentDrillIndex: 0,
    currentDrill: DRILL,
    drillCount: 1,
    drillResults: [],
    isTraining: false,
    completeLlmDrill,
    reset: vi.fn(),
  }),
}));

// Load the real runner up front with real timers, so releasing the held import
// hands it over at once instead of waiting on a module transform under fake time.
chunk.actual = await vi.importActual('../post/PostLlmDrillRunner');
const PostTab = (await import('./PostTab')).default;

// Microtask-only flush: with fake timers installed, a macrotask would never run.
const flush = () => act(async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PostTab lazy timed drill clock', () => {
  it('starts the drill clock when the runner mounts, not when its chunk is requested', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    render(
      <MemoryRouter initialEntries={['/post/session/run']}>
        <PostTab tab="session" subtab="run" />
      </MemoryRouter>,
    );
    await flush();
    expect(chunk.requested).toBe(true);
    expect(screen.getByText('Loading drill')).toBeInTheDocument();

    // Three times the drill's limit passes while the chunk is still downloading.
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(screen.queryByText(/remaining/)).toBeNull();
    expect(completeLlmDrill).not.toHaveBeenCalled();

    await act(async () => { chunk.release(); });
    await flush();
    expect(screen.queryByText('Loading drill')).toBeNull();
    // The full limit is still on the clock once the runner is on screen.
    expect(screen.getByText('10s remaining')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(9_000); });
    expect(screen.getByText('1s remaining')).toBeInTheDocument();
    expect(completeLlmDrill).not.toHaveBeenCalled();

    // Expiry is measured from mount: it fires after the limit, and the drill's
    // total time excludes the 30 s the chunk took.
    await act(async () => { vi.advanceTimersByTime(1_100); });
    expect(completeLlmDrill).toHaveBeenCalledTimes(1);
    const { totalMs } = completeLlmDrill.mock.calls[0][0];
    expect(totalMs).toBeGreaterThanOrEqual(10_000);
    expect(totalMs).toBeLessThan(11_000);
  });
});
