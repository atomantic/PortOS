import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import toast from '../components/ui/Toast';
import useMusicVideoRevisions from './useMusicVideoRevisions.js';
import {
  getMusicVideoProject,
  resumeMusicVideoRevision,
  startMusicVideoDependencyRepair,
  cancelMusicVideoRevision,
} from '../services/apiMusicVideo.js';

vi.mock('../services/apiMusicVideo.js', () => ({
  getMusicVideoProject: vi.fn(),
  startMusicVideoDependencyRepair: vi.fn(),
  startMusicVideoRevision: vi.fn(),
  repairMusicVideoPerformance: vi.fn(),
  resumeMusicVideoRevision: vi.fn(),
  cancelMusicVideoRevision: vi.fn(),
  releaseMusicVideoRevisionSection: vi.fn(() => Promise.resolve()),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const opened = { id: 'mv-example', revisions: [{ id: 'mvrev-example', status: 'open' }], scenes: [{ sceneId: 'scene-a' }] };
const persisted = { ...opened, updatedAt: 'after-reload' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  startMusicVideoDependencyRepair.mockResolvedValue({ project: opened, revision: { id: 'mvrev-example' } });
  getMusicVideoProject.mockResolvedValue(persisted);
});

const setup = (sceneMedia = { generateFrame: vi.fn(), generateSceneVideo: vi.fn() }) => {
  const replaceProject = vi.fn();
  const hook = renderHook(() => useMusicVideoRevisions({ project: { id: 'mv-example' }, replaceProject, sceneMedia }));
  return { ...hook, replaceProject, sceneMedia };
};

it('a repair whose resume request fails leaves the opened revision recoverable, not reported as a failed repair (#9940)', async () => {
  resumeMusicVideoRevision.mockRejectedValue(new Error('Network down'));
  const { result, replaceProject } = setup();
  await act(async () => { await result.current.repair('basis-example'); });
  // The revision opened server-side: the record is reloaded so the banner can offer Resume/Cancel…
  expect(replaceProject).toHaveBeenLastCalledWith(persisted);
  expect(getMusicVideoProject).toHaveBeenCalledWith('mv-example', { silent: true });
  // …and nobody is told the repair failed.
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('Needs attention'));
  expect(result.current.busy).toBe(false);
});

it('a client step that throws AFTER a successful resume reloads the record instead of toasting a failure', async () => {
  resumeMusicVideoRevision.mockResolvedValue({
    project: opened, revision: { id: 'mvrev-example', sections: [] },
    needsGeneration: [{ sceneId: 'scene-a', kind: 'image' }], generating: [],
  });
  const sceneMedia = { generateFrame: vi.fn(() => { throw new Error('lane exploded'); }), generateSceneVideo: vi.fn() };
  const { result, replaceProject } = setup(sceneMedia);
  await act(async () => { await result.current.resume('mvrev-example'); });
  expect(sceneMedia.generateFrame).toHaveBeenCalled();
  expect(replaceProject).toHaveBeenLastCalledWith(persisted);
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('saved'));
});

it('a SERVER failure to open the repair is still a real failure: toast it, resume nothing, reload nothing', async () => {
  startMusicVideoDependencyRepair.mockRejectedValue(new Error('Finish or cancel the open revision first'));
  const { result } = setup();
  await act(async () => { await result.current.repair('basis-example'); });
  expect(toast.error).toHaveBeenCalledWith('Finish or cancel the open revision first');
  expect(resumeMusicVideoRevision).not.toHaveBeenCalled();
  expect(getMusicVideoProject).not.toHaveBeenCalled();
});

it('a cancel the server accepted but whose follow-up throws reloads rather than reporting a failed cancel', async () => {
  cancelMusicVideoRevision.mockResolvedValue({ project: opened, canceledJobIds: [] });
  const replaceProject = vi.fn()
    .mockImplementationOnce(() => { throw new Error('render crashed'); })
    .mockImplementation(() => {});
  const { result } = renderHook(() => useMusicVideoRevisions({ project: { id: 'mv-example' }, replaceProject, sceneMedia: {} }));
  await act(async () => { await result.current.cancel('mvrev-example'); });
  expect(replaceProject).toHaveBeenLastCalledWith(persisted);
  expect(toast.error).not.toHaveBeenCalled();
});

it('hands out only the sections the server says need a take once a repair resumes', async () => {
  resumeMusicVideoRevision.mockResolvedValue({
    project: opened, revision: { id: 'mvrev-example', sections: [] },
    needsGeneration: [{ sceneId: 'scene-a', kind: 'video' }], generating: [],
  });
  const generateSceneVideo = vi.fn(() => Promise.resolve({ ok: true }));
  const { result } = setup({ generateFrame: vi.fn(), generateSceneVideo });
  await act(async () => { await result.current.repair('basis-example'); });
  expect(generateSceneVideo).toHaveBeenCalledWith(opened.scenes[0], { revisionId: 'mvrev-example' });
  expect(getMusicVideoProject).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});
