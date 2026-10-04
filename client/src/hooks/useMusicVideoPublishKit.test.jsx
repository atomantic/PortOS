import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useMusicVideoPublishKit from './useMusicVideoPublishKit.js';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';
import { buildMusicVideoPublishKit, cancelMusicVideoPublishKit } from '../services/apiMusicVideo.js';

vi.mock('../services/apiMusicVideo.js', () => ({
  getMusicVideoProject: vi.fn(() => Promise.resolve({ id: 'mv-example' })),
  buildMusicVideoPublishKit: vi.fn(),
  musicVideoPublishKitEventsUrl: id => `/events/${id}`,
  cancelMusicVideoPublishKit: vi.fn(() => Promise.resolve({ ok: true })),
  draftMusicVideoPublishCopy: vi.fn(),
  updateMusicVideoPublishCopy: vi.fn(),
  selectMusicVideoPublishThumbnail: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource); });
afterEach(() => vi.unstubAllGlobals());

it('reattaches to a build already running on load, shows progress, and cancels it', async () => {
  const project = { id: 'mv-example', activePublishKitBuild: { jobId: 'mvpk-running', status: 'running' } };
  const { result } = renderHook(() => useMusicVideoPublishKit({ project, replaceProject: vi.fn() }));
  expect(result.current.building).toBe(true);
  expect(lastEventSource().url).toBe('/events/mvpk-running');
  act(() => lastEventSource().emit({ type: 'progress', progress: 0.5 }));
  expect(result.current.progress).toBe(50);
  act(() => result.current.cancelBuild());
  expect(cancelMusicVideoPublishKit).toHaveBeenCalledWith('mvpk-running', { silent: true });
});

it('adopts the running job when Build answers 409 with its jobId', async () => {
  buildMusicVideoPublishKit.mockRejectedValue(Object.assign(new Error('already running'), { status: 409, code: 'PUBLISH_KIT_BUILD_IN_PROGRESS', context: { jobId: 'mvpk-other' } }));
  const { result } = renderHook(() => useMusicVideoPublishKit({ project: { id: 'mv-example' }, replaceProject: vi.fn() }));
  await act(async () => result.current.build());
  expect(result.current.building).toBe(true);
  expect(lastEventSource().url).toBe('/events/mvpk-other');
});
