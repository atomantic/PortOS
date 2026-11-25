import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockEventSource, lastEventSource } from '../../../test/mockEventSource.js';
import useMusicVideoExcerpts from './useMusicVideoExcerpts.js';
import toast from '../../ui/Toast';
import { getMusicVideoProject, renderMusicVideoExcerpt, cancelMusicVideoExcerptRender } from '../../../services/apiMusicVideo.js';

vi.mock('../../../services/apiMusicVideo.js', () => ({
  getMusicVideoProject: vi.fn(), renderMusicVideoExcerpt: vi.fn(),
  musicVideoExcerptRenderEventsUrl: id => `/events/${id}`,
  cancelMusicVideoExcerptRender: vi.fn(), deleteMusicVideoExcerpt: vi.fn(),
  addMusicVideoExcerptNote: vi.fn(), updateMusicVideoExcerptNote: vi.fn(), deleteMusicVideoExcerptNote: vi.fn(),
}));
vi.mock('../../ui/Toast');
beforeEach(() => { vi.clearAllMocks(); MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource); });
afterEach(() => vi.unstubAllGlobals());

it('retains the occupied slot when switching projects, then refreshes the render owner on failure', async () => {
  const first = { id: 'first', excerpts: [] };
  const second = { id: 'second', excerpts: [] };
  const replaceProject = vi.fn();
  getMusicVideoProject.mockResolvedValue(first);
  renderMusicVideoExcerpt.mockResolvedValue({ jobId: 'draft-job' });
  const { result, rerender } = renderHook(({ project }) => useMusicVideoExcerpts({ project, replaceProject }), { initialProps: { project: first } });
  await act(async () => result.current.startExcerpt(0, 2));
  rerender({ project: second });
  expect(result.current).toMatchObject({ occupied: true, rendering: false, activeRenderId: null });
  act(() => result.current.startExcerpt(0, 2));
  expect(renderMusicVideoExcerpt).toHaveBeenCalledTimes(1);
  await act(async () => lastEventSource().emit({ type: 'error', error: 'Synthetic interruption' }));
  await waitFor(() => expect(replaceProject).toHaveBeenCalledWith(first));
  expect(getMusicVideoProject).toHaveBeenCalledWith('first', { silent: true });
  expect(result.current.occupied).toBe(false);
});

it('reattaches a persisted job after reopening and refreshes its completed record', async () => {
  const project = { id: 'first', excerpts: [{ id: 'draft-job', jobId: 'draft-job', status: 'rendering' }] };
  const finished = { ...project, excerpts: [{ id: 'draft-job', status: 'complete', filename: 'example.mp4' }] };
  getMusicVideoProject.mockResolvedValue(finished);
  const replaceProject = vi.fn();
  const { result } = renderHook(() => useMusicVideoExcerpts({ project, replaceProject }));
  expect(result.current).toMatchObject({ rendering: true, activeRenderId: 'draft-job', connected: false });
  await act(async () => lastEventSource().emit({ type: 'complete' }));
  await waitFor(() => expect(replaceProject).toHaveBeenCalledWith(finished));
  expect(result.current.rendering).toBe(false);
  expect(MockEventSource.instances).toHaveLength(1);
});

it('does not reattach its own settled job while the terminal refresh is still pending', async () => {
  const project = { id: 'first', excerpts: [] };
  renderMusicVideoExcerpt.mockResolvedValue({ jobId: 'draft-job' });
  getMusicVideoProject.mockReturnValue(new Promise(() => {}));
  const { result, rerender } = renderHook(({ project }) => useMusicVideoExcerpts({ project, replaceProject: vi.fn() }), { initialProps: { project } });
  await act(async () => result.current.startExcerpt(0, 2));
  rerender({ project: { ...project, excerpts: [{ id: 'draft-job', jobId: 'draft-job', status: 'rendering' }] } });
  act(() => lastEventSource().emit({ type: 'complete' }));
  expect(result.current.rendering).toBe(false);
  expect(MockEventSource.instances).toHaveLength(1);
});

it('reloads the project and toasts when an excerpt cancel returns { ok: false }, ignoring double-clicks', async () => {
  const project = { id: 'first', excerpts: [{ id: 'draft-job', status: 'rendering' }] };
  const fresh = { id: 'first', excerpts: [{ id: 'draft-job', status: 'complete' }] };
  let resolveCancel;
  cancelMusicVideoExcerptRender.mockReturnValue(new Promise((r) => { resolveCancel = r; }));
  getMusicVideoProject.mockResolvedValue(fresh);
  const replaceProject = vi.fn();
  const { result } = renderHook(() => useMusicVideoExcerpts({ project, replaceProject }));
  act(() => { result.current.cancelExcerpt('draft-job'); result.current.cancelExcerpt('draft-job'); });
  expect(cancelMusicVideoExcerptRender).toHaveBeenCalledTimes(1);
  expect(result.current.cancellingId).toBe('draft-job');
  await act(async () => resolveCancel({ ok: false }));
  await waitFor(() => expect(replaceProject).toHaveBeenCalledWith(fresh));
  expect(toast.error).toHaveBeenCalledWith('This draft render is no longer running — refreshed status');
  expect(result.current.cancellingId).toBe(null);
});

it('toasts the error when an excerpt cancel request rejects', async () => {
  cancelMusicVideoExcerptRender.mockRejectedValue(new Error('Synthetic 500'));
  const { result } = renderHook(() => useMusicVideoExcerpts({ project: { id: 'first', excerpts: [] }, replaceProject: vi.fn() }));
  await act(async () => result.current.cancelExcerpt('draft-job'));
  expect(toast.error).toHaveBeenCalledWith('Synthetic 500');
  expect(result.current.cancellingId).toBe(null);
});
