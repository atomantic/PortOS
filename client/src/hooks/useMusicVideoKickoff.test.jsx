import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import toast from '../components/ui/Toast';
import useMusicVideoKickoff from './useMusicVideoKickoff.js';

vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const analyzed = { id: 'mv-example', audioAnalysis: { sections: [{}] }, lyricCues: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const steps = (overrides = {}) => ({
  analyze: vi.fn(async () => analyzed),
  importLyrics: vi.fn(async (project) => project),
  separateVocals: vi.fn(async (project) => project),
  alignLyrics: vi.fn(async (project) => project),
  castAndSets: vi.fn(async (project) => ({ ...project, castAndSets: { status: 'approved' } })),
  plan: vi.fn(async () => {}),
  ...overrides,
});

it('says which step threw instead of ending the run in silence (#9940)', async () => {
  const analyze = vi.fn(() => { throw new Error('beat tracker crashed'); });
  const config = steps({ analyze });
  const { result } = renderHook(() => useMusicVideoKickoff(config));
  await act(async () => { await result.current.run({ id: 'mv-example' }); });
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Analyzing the song failed'));
  expect(toast.error.mock.calls[0][0]).toContain('beat tracker crashed');
  expect(config.plan).not.toHaveBeenCalled();
  expect(result.current.running).toBe(false);
});

it('ends on an interrupted Cast & Sets stage with a note, and plans nothing', async () => {
  const config = steps({ castAndSets: vi.fn(async (project) => ({ ...project, castAndSets: { status: 'imaging', interrupted: true } })) });
  const { result } = renderHook(() => useMusicVideoKickoff(config));
  await act(async () => { await result.current.run(analyzed); });
  expect(config.plan).not.toHaveBeenCalled();
  expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('interrupted by a restart'));
  expect(result.current.running).toBe(false);
});

it('stays silent when the check-in simply waits for the director (review)', async () => {
  const config = steps({ castAndSets: vi.fn(async (project) => ({ ...project, castAndSets: { status: 'review' } })) });
  const { result } = renderHook(() => useMusicVideoKickoff(config));
  await act(async () => { await result.current.run(analyzed); });
  expect(config.plan).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
});

it('Cancel ends a kickoff stuck waiting on Cast & Sets and plans nothing', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const config = steps({
    castAndSets: vi.fn(() => waiting),
    cancelCastAndSets: vi.fn(() => release(null)),
  });
  const { result } = renderHook(() => useMusicVideoKickoff(config));
  let finished;
  act(() => { finished = result.current.run(analyzed); });
  expect(result.current.step).toBe('castAndSets');
  await act(async () => { result.current.cancel(); await finished; });
  expect(config.cancelCastAndSets).toHaveBeenCalledTimes(1);
  expect(config.plan).not.toHaveBeenCalled();
  expect(result.current.running).toBe(false);
});

it('Cancel stops before the next step when no wait is in flight', async () => {
  let finishAnalyze;
  const config = steps({ analyze: vi.fn(() => new Promise((resolve) => { finishAnalyze = () => resolve(analyzed); })) });
  const { result } = renderHook(() => useMusicVideoKickoff(config));
  let finished;
  act(() => { finished = result.current.run({ id: 'mv-example' }); });
  // The step starts on the next microtask; let analyze begin before cancelling.
  await act(async () => { await Promise.resolve(); });
  act(() => result.current.cancel());
  await act(async () => { finishAnalyze(); await finished; });
  expect(config.castAndSets).not.toHaveBeenCalled();
  expect(config.plan).not.toHaveBeenCalled();
});

it('runs the whole sequence to the plan when every step succeeds', async () => {
  const config = steps();
  const { result } = renderHook(() => useMusicVideoKickoff(config));
  await act(async () => { await result.current.run({ id: 'mv-example' }); });
  expect(config.plan).toHaveBeenCalledTimes(1);
  expect(toast.error).not.toHaveBeenCalled();
});
