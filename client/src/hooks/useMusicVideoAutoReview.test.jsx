import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import toast from '../components/ui/Toast';
import useMusicVideoAutoReview from './useMusicVideoAutoReview.js';
import { getMusicVideoProject, startMusicVideoAutoReview } from '../services/apiMusicVideo.js';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: vi.fn((event, fn) => handlers.set(event, fn)),
    off: vi.fn((event) => handlers.delete(event)),
  },
}));
vi.mock('../services/apiMusicVideo.js', () => ({
  getMusicVideoProject: vi.fn(),
  startMusicVideoAutoReview: vi.fn(),
  resumeMusicVideoAutoReview: vi.fn(),
  stopMusicVideoAutoReview: vi.fn(),
  cancelMusicVideoAutoReview: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }));

const project = { id: 'mv-example', scenes: [] };
const generateEvent = {
  projectId: 'mv-example',
  project,
  run: { id: 'mvar-example', status: 'running', attempts: [] },
  action: { type: 'generate', revisionId: 'mvrev-example', sections: [{ sceneId: 'scene-a', kind: 'video' }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const setup = () => {
  const replaceProject = vi.fn();
  const hook = renderHook(() => useMusicVideoAutoReview({ project, replaceProject }));
  return { ...hook, replaceProject };
};
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it('applies the pushed project and never submits a revised section from the board (#10014)', async () => {
  const submitSections = vi.fn(() => Promise.resolve(2));
  const replaceProject = vi.fn();
  const pushed = { ...project, autoReviews: [] };
  const { result } = renderHook(() => useMusicVideoAutoReview({ project, replaceProject, submitSections }));
  // A hand-out with a running run — the shape the board used to submit — is only applied.
  act(() => handlers.get('music-video:auto-review')({ ...generateEvent, project: pushed }));
  await flush();
  expect(submitSections).not.toHaveBeenCalled();
  expect(replaceProject).toHaveBeenCalledWith(pushed);
  expect(result.current.action).toEqual(generateEvent.action);
  expect(toast.error).not.toHaveBeenCalled();
});

it('ignores another project\'s event', async () => {
  const { result, replaceProject } = setup();
  act(() => handlers.get('music-video:auto-review')({ ...generateEvent, projectId: 'mv-other' }));
  await flush();
  expect(replaceProject).not.toHaveBeenCalled();
  expect(result.current.action).toBeNull();
});

it('links a start refused for an open revision to it, reloading the record so the banner can show it', async () => {
  const persisted = { ...project, revisions: [{ id: 'mvrev-open', status: 'open' }] };
  getMusicVideoProject.mockResolvedValue(persisted);
  startMusicVideoAutoReview.mockRejectedValue(Object.assign(new Error('Finish or cancel the open revision before starting an auto-review run'), {
    code: 'REVISION_IN_PROGRESS', context: { revisionId: 'mvrev-open' },
  }));
  const { result, replaceProject } = setup();
  await act(async () => { await result.current.start(0, 10, { maxAttempts: 1, maxGenerations: 1 }); });
  expect(getMusicVideoProject).toHaveBeenCalledWith('mv-example', { silent: true });
  await flush();
  expect(replaceProject).toHaveBeenCalledWith(persisted);
  // A render-prop toast (with its "Show revision" link), not a bare message.
  expect(typeof toast.error.mock.calls[0][0]).toBe('function');
});
