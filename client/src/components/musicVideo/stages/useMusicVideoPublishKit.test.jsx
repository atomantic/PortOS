import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useMusicVideoPublishKit from './useMusicVideoPublishKit.js';
import { MockEventSource, lastEventSource } from '../../../test/mockEventSource';
import { buildMusicVideoPublishKit, cancelMusicVideoPublishKit, getMusicVideoPublishCropPreview } from '../../../services/apiMusicVideo.js';

vi.mock('../../../services/apiMusicVideo.js', async importOriginal => ({
  ...await importOriginal(),
  getMusicVideoProject: vi.fn(() => Promise.resolve({ id: 'mv-example' })),
  buildMusicVideoPublishKit: vi.fn(),
  getMusicVideoPublishCropPreview: vi.fn(),
  musicVideoPublishKitEventsUrl: id => `/events/${id}`,
  cancelMusicVideoPublishKit: vi.fn(() => Promise.resolve({ ok: true })),
  draftMusicVideoPublishCopy: vi.fn(),
  updateMusicVideoPublishCopy: vi.fn(),
  composeMusicVideoYoutubeThumbnail: vi.fn(),
  clearMusicVideoYoutubeThumbnail: vi.fn(),
  addMusicVideoThumbnailTest: vi.fn(),
  paintMusicVideoYoutubeThumbnail: vi.fn(),
  previewMusicVideoThumbnailPaint: vi.fn(),
  removeMusicVideoThumbnailTest: vi.fn(),
}));
vi.mock('../../ui/Toast');
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

it('starts centered, requires a current preview and refreshes after a stale kickoff', async () => {
  const preview = { renderHistoryId: 'render-1', startSec: 5, endSec: 30, width: 1280, height: 720, filename: 'master.mp4' };
  getMusicVideoPublishCropPreview.mockResolvedValue(preview);
  const stale = Object.assign(new Error('The hook window changed. Refresh the crop preview.'), { status: 409, code: 'PUBLISH_CROP_PREVIEW_STALE' });
  buildMusicVideoPublishKit.mockRejectedValueOnce(stale).mockResolvedValueOnce({ jobId: 'mvpk-crop' });
  const { result, rerender } = renderHook(({ renderHistoryId }) => useMusicVideoPublishKit({
    project: { id: 'mv-example', renderHistoryId }, replaceProject: vi.fn(),
  }), { initialProps: { renderHistoryId: 'render-1' } });
  await act(async () => result.current.setCropMode(true));
  expect(result.current.crop.position).toBe(0.5);
  act(() => result.current.build());
  expect(buildMusicVideoPublishKit).not.toHaveBeenCalled();
  act(() => result.current.setCropMediaState(preview));
  act(() => result.current.setCropPosition(0.85));
  await act(async () => result.current.build());
  expect(buildMusicVideoPublishKit).toHaveBeenLastCalledWith('mv-example', { silent: true, crop: { ...preview, position: 0.85 } });
  expect(result.current.cropBlockedReason).toBe(stale.message);

  rerender({ renderHistoryId: 'render-2' });
  const refreshed = { ...preview, renderHistoryId: 'render-2', filename: 'new-master.mp4', startSec: 6 };
  getMusicVideoPublishCropPreview.mockResolvedValue(refreshed);
  await act(async () => result.current.refreshCropPreview());
  act(() => result.current.setCropMediaState(refreshed));
  await act(async () => result.current.build());
  expect(buildMusicVideoPublishKit).toHaveBeenLastCalledWith('mv-example', { silent: true, crop: { ...refreshed, position: 0.85 } });
  expect(lastEventSource().url).toBe('/events/mvpk-crop');
});
