import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';

const shotRenders = vi.hoisted(() => ({ status: null, retry: vi.fn() }));
vi.mock('../../hooks/useMusicVideoShotRenders.js', () => ({ default: () => ({ status: shotRenders.status, retry: shotRenders.retry }) }));
import { RenderFinalButton } from './ProjectActionGroups.jsx';

const scenes = [{ id: 'a', videoFilename: 'a.mp4' }];
const project = { id: 'example', scenes, renderHistoryId: 'r1', composition: { mode: 'composed' } };
const renderJob = { start: vi.fn(), active: false };
const view = (overrides = {}) => render(<RenderFinalButton project={{ ...project, ...overrides }} renderJob={renderJob} readiness={{ readyForProduction: true }} />);

beforeEach(() => {
  cleanup();
  shotRenders.status = { available: true, ready: 3, total: 116, outro: { state: 'stale' }, shots: [] };
});

it('does not claim shots still need rendering once the final render is current', () => {
  view({ renderDependencyState: { status: 'current' } });
  expect(screen.getByTestId('final-render-current').textContent).toBe('Final render is current.');
  expect(screen.queryByTestId('shot-renders-ready')).toBeNull();
});

it('keeps the per-shot hint for a stale or unrendered project and labels the outro card in the total', () => {
  view({ renderDependencyState: { status: 'stale' } });
  expect(screen.queryByTestId('final-render-current')).toBeNull();
  expect(screen.getByTestId('shot-renders-ready').textContent).toContain('3 of 116 shots and the outro card ready');
  cleanup();
  view({ renderHistoryId: null });
  expect(screen.getByTestId('shot-renders-ready')).toBeTruthy();
});

it('exposes a failed refresh with an error notice and offers retry rather than claiming ready', () => {
  shotRenders.status = { available: true, error: { message: 'Shot render status unavailable' }, shots: [], outro: null, ready: 0, total: 0 };
  view({ renderHistoryId: null });
  expect(screen.queryByTestId('shot-renders-ready')).toBeNull();
  expect(screen.getByTestId('shot-renders-error').textContent).toContain('Shot render status unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(shotRenders.retry).toHaveBeenCalledTimes(1);
});
