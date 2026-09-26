import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import EpisodeVideoStage from './EpisodeVideoStage';
import { getCreativeDirectorProject } from '../../../services/apiCreativeDirector';

const handlers = vi.hoisted(() => new Map());
vi.mock('../../../services/socket', () => ({ default: {
  on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
  off: (event, fn) => handlers.get(event)?.delete(fn),
  emit: vi.fn(),
} }));
vi.mock('../../../services/api', () => ({ listVideoModels: vi.fn(async () => []), generatePipelineVisualImage: vi.fn() }));
vi.mock('../../../services/apiCreativeDirector', () => ({ getCreativeDirectorProject: vi.fn() }));
vi.mock('../../../hooks/useVideoFileSrc', () => ({ useVideoFileSrc: () => ({ src: null }) }));
vi.mock('../../creative-director/ScenePreview', () => ({ default: () => null }));
const fire = async (event, payload) => act(async () => {
  for (const fn of handlers.get(event) || []) fn(payload);
});
const view = id => <MemoryRouter><EpisodeVideoStage issue={{ id: 'issue-example', stages: { episodeVideo: { cdProjectId: id } } }} onStageUpdate={vi.fn()} /></MemoryRouter>;
afterEach(() => vi.useRealTimers());

it('refreshes only the bound project, including terminal updates, reconnect and tab re-show without polling', async () => {
  vi.useFakeTimers();
  getCreativeDirectorProject.mockResolvedValue({ id: 'cd-one', status: 'rendering' });
  await act(async () => render(view('cd-one')));
  expect(getCreativeDirectorProject).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  await fire('creative-director:project:changed', { id: 'cd-other' });
  expect(getCreativeDirectorProject).toHaveBeenCalledTimes(1);
  getCreativeDirectorProject.mockResolvedValue({ id: 'cd-one', status: 'failed', failureReason: 'Example failure' });
  await fire('creative-director:project:changed', { id: 'cd-one' });
  expect(screen.getByText('Example failure')).toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(getCreativeDirectorProject).toHaveBeenCalledTimes(2);
  await fire('connect');
  expect(getCreativeDirectorProject).toHaveBeenCalledTimes(3);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent(document, new Event('visibilitychange'));
  await fire('creative-director:project:changed', { id: 'cd-one' });
  expect(getCreativeDirectorProject).toHaveBeenCalledTimes(3);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => fireEvent(document, new Event('visibilitychange')));
  expect(getCreativeDirectorProject).toHaveBeenCalledTimes(4);
});

it('drops late reads after the stage switches projects', async () => {
  let resolveOld;
  getCreativeDirectorProject.mockImplementation(id => id === 'cd-old'
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ id, status: 'failed', failureReason: 'Current project failure' }));
  let page;
  await act(async () => { page = render(view('cd-old')); });
  await act(async () => page.rerender(view('cd-new')));
  expect(screen.getByText('Current project failure')).toBeInTheDocument();
  await act(async () => resolveOld({ id: 'cd-old', status: 'failed', failureReason: 'Stale failure' }));
  expect(screen.queryByText('Stale failure')).not.toBeInTheDocument();
  expect(screen.getByText('Current project failure')).toBeInTheDocument();
});
