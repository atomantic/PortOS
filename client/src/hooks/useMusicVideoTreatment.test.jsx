import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import toast from '../components/ui/Toast';
import useMusicVideoTreatment from './useMusicVideoTreatment.js';
import {
  applyMusicVideoTreatment,
  getMusicVideoProject,
  previewMusicVideoTreatmentApply,
} from '../services/apiMusicVideo.js';

vi.mock('../services/apiMusicVideo.js', () => ({
  getMusicVideoProject: vi.fn(),
  updateMusicVideoTreatment: vi.fn(),
  compileMusicVideoTreatment: vi.fn(),
  previewMusicVideoTreatmentApply: vi.fn(),
  applyMusicVideoTreatment: vi.fn(),
  reviewMusicVideoTreatmentProof: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const applied = { project: { id: 'mv-example', updatedAt: 'applied' }, result: { directed: 2, promptsKept: [], conflicted: [], textCuesAdded: 0 } };
const persisted = { id: 'mv-example', updatedAt: 'after-reload' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  previewMusicVideoTreatmentApply.mockResolvedValue({ revision: 4 });
  getMusicVideoProject.mockResolvedValue(persisted);
});

// Apply needs a loaded review; reaching it is part of the director's flow.
const withPreview = async (replaceProject) => {
  const hook = renderHook(() => useMusicVideoTreatment({ project: { id: 'mv-example' }, onProjectPatch: vi.fn(), replaceProject }));
  await act(async () => { await hook.result.current.loadPreview(); });
  return hook;
};

it('reports a server refusal of Apply as a failure and re-reads the stale review (409)', async () => {
  applyMusicVideoTreatment.mockRejectedValue(Object.assign(new Error('The review is out of date'), { status: 409 }));
  const { result } = await withPreview(vi.fn());
  await act(async () => { await result.current.apply(); });
  expect(toast.error).toHaveBeenCalledWith('The review is out of date');
  expect(previewMusicVideoTreatmentApply).toHaveBeenCalledTimes(2);
});

it('does NOT report "Apply failed" when only this tab\'s follow-up threw after the server applied it (#9940)', async () => {
  applyMusicVideoTreatment.mockResolvedValue(applied);
  const replaceProject = vi.fn()
    .mockImplementationOnce(() => { throw new Error('render crashed'); })
    .mockImplementation(() => {});
  const { result } = await withPreview(replaceProject);
  let outcome;
  await act(async () => { outcome = await result.current.apply(); });
  // The server's result still reaches the caller, the record is reloaded, and no failure is announced.
  expect(outcome).toEqual(applied.result);
  expect(replaceProject).toHaveBeenLastCalledWith(persisted);
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('applied'));
  expect(result.current.applying).toBe(false);
  expect(result.current.preview).toBeNull();
});
