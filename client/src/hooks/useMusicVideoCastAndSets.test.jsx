import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import useMusicVideoCastAndSets from './useMusicVideoCastAndSets.js';
import { getMusicVideoProject, startMusicVideoCastAndSets } from '../services/apiMusicVideo.js';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: vi.fn((event, fn) => handlers.set(event, fn)),
    off: vi.fn((event) => handlers.delete(event)),
  },
}));
vi.mock('../services/apiMusicVideo.js', () => ({
  getMusicVideoProject: vi.fn(),
  startMusicVideoCastAndSets: vi.fn(),
  regenerateMusicVideoCastAndSets: vi.fn(),
  editMusicVideoCastAndSetsDirection: vi.fn(),
  resumeMusicVideoCastAndSets: vi.fn(),
  approveMusicVideoCastAndSets: vi.fn(),
  skipMusicVideoCastAndSets: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const withStage = (castAndSets) => ({ id: 'mv-example', castAndSets });

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  getMusicVideoProject.mockResolvedValue(withStage({ status: 'imaging' }));
});

const setup = () => renderHook(() => useMusicVideoCastAndSets({ project: { id: 'mv-example' }, replaceProject: vi.fn() }));

it('resolves at once for a stage a restart already interrupted, without starting another (#9940)', async () => {
  const { result } = setup();
  const target = withStage({ status: 'imaging', interrupted: true });
  await expect(result.current.runToCheckpoint(target)).resolves.toBe(target);
  expect(startMusicVideoCastAndSets).not.toHaveBeenCalled();
});

it('ends a wait on a working stage when the server then reports it interrupted', async () => {
  const { result } = setup();
  let settled;
  act(() => { settled = result.current.runToCheckpoint(withStage({ status: 'imaging' })); });
  // A reconnect/visibility refresh (or a push) delivers the restarted server's view.
  const interrupted = withStage({ status: 'imaging', interrupted: true });
  act(() => handlers.get('music-video:cast-and-sets')({ projectId: 'mv-example', project: interrupted }));
  await expect(settled).resolves.toBe(interrupted);
});

it('keeps waiting while the stage is genuinely still working', async () => {
  const { result } = setup();
  let done = false;
  act(() => { result.current.runToCheckpoint(withStage({ status: 'imaging' })).then(() => { done = true; }); });
  act(() => handlers.get('music-video:cast-and-sets')({ projectId: 'mv-example', project: withStage({ status: 'assembling', interrupted: false }) }));
  await Promise.resolve();
  expect(done).toBe(false);
});

it('cancelWait releases a pending wait with null and leaves the stage alone', async () => {
  const { result } = setup();
  let settled;
  act(() => { settled = result.current.runToCheckpoint(withStage({ status: 'imaging' })); });
  act(() => result.current.cancelWait());
  await expect(settled).resolves.toBeNull();
  expect(startMusicVideoCastAndSets).not.toHaveBeenCalled();
});
