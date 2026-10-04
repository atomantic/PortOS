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

const setup = (submitSections) => {
  const replaceProject = vi.fn();
  const hook = renderHook(() => useMusicVideoAutoReview({ project, replaceProject, submitSections }));
  return { ...hook, replaceProject };
};
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it('says so — and points at Continue — when handing out revised sections throws (#9940)', async () => {
  setup(vi.fn(() => Promise.reject(new Error('lane exploded'))));
  act(() => handlers.get('music-video:auto-review')(generateEvent));
  await flush();
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('lane exploded'));
  expect(toast.error.mock.calls[0][0]).toContain('Continue');
});

it('reports how many revised sections the board submitted', async () => {
  const submitSections = vi.fn(() => Promise.resolve(2));
  setup(submitSections);
  act(() => handlers.get('music-video:auto-review')(generateEvent));
  await flush();
  expect(submitSections).toHaveBeenCalledWith(project, generateEvent.action.sections, 'mvrev-example');
  expect(toast.info).toHaveBeenCalledWith('Auto-review: generating 2 revised sections');
  expect(toast.error).not.toHaveBeenCalled();
});

it('does not hand out sections for a run a production owns or one that is no longer running', async () => {
  const submitSections = vi.fn(() => Promise.resolve(1));
  setup(submitSections);
  act(() => handlers.get('music-video:auto-review')({ ...generateEvent, run: { ...generateEvent.run, productionRunId: 'mvpr-example' } }));
  act(() => handlers.get('music-video:auto-review')({ ...generateEvent, run: { ...generateEvent.run, status: 'stopped' } }));
  await flush();
  expect(submitSections).not.toHaveBeenCalled();
});

it('links a start refused for an open revision to it, reloading the record so the banner can show it', async () => {
  const persisted = { ...project, revisions: [{ id: 'mvrev-open', status: 'open' }] };
  getMusicVideoProject.mockResolvedValue(persisted);
  startMusicVideoAutoReview.mockRejectedValue(Object.assign(new Error('Finish or cancel the open revision before starting an auto-review run'), {
    code: 'REVISION_IN_PROGRESS', context: { revisionId: 'mvrev-open' },
  }));
  const { result, replaceProject } = setup(vi.fn());
  await act(async () => { await result.current.start(0, 10, { maxAttempts: 1, maxGenerations: 1 }); });
  expect(getMusicVideoProject).toHaveBeenCalledWith('mv-example', { silent: true });
  await flush();
  expect(replaceProject).toHaveBeenCalledWith(persisted);
  // A render-prop toast (with its "Show revision" link), not a bare message.
  expect(typeof toast.error.mock.calls[0][0]).toBe('function');
});
