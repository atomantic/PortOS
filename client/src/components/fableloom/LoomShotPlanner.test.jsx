import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import LoomShotPlanner from './LoomShotPlanner';
const api = vi.hoisted(() => ({ getLoom: vi.fn(async () => ({ id: 'loom-1' })), getLoomEpisodeShotRun: vi.fn(async () => null), cancelLoomEpisodeShotRun: vi.fn(), startLoomEpisodeShotRun: vi.fn(), applyLoomEpisodeShots: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
it('previews with the selected route, then explicitly applies the reviewed fingerprint', async () => {
  const episode = { id: 'ep-1', nodes: [{ id: 'scene-1', title: 'The gate' }] };
  const groups = [{ sceneId: 'scene-1', shots: [{ title: 'A knock', durationSeconds: 8, framing: 'Close', action: 'A hand knocks.', dialogue: [] }] }];
  api.startLoomEpisodeShotRun.mockResolvedValue({ id: 'run-1', loomId: 'loom-1', episodeId: 'ep-1', status: 'completed', createdAt: '2026-01-01', revision: 1, result: { sourceFingerprint: 'a'.repeat(64), groups, review: { summary: 'Ready.' } } });
  api.applyLoomEpisodeShots.mockResolvedValue({ loom: { id: 'loom-1', episodes: [episode] } });
  const onLoomUpdate = vi.fn();
  render(<LoomShotPlanner loom={{ id: 'loom-1' }} episode={episode} route={{ model: 'example-model', effort: 'low' }} onLoomUpdate={onLoomUpdate} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview shot split' }));
  await screen.findByText('Ready.');
  expect(api.startLoomEpisodeShotRun).toHaveBeenCalledWith('loom-1', 'ep-1', expect.objectContaining({ model: 'example-model', effort: 'low', apply: false }), { silent: true });
  expect(onLoomUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed shots' }));
  expect(api.applyLoomEpisodeShots).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Replace with reviewed shots' }));
  await waitFor(() => expect(onLoomUpdate).toHaveBeenCalled());
  expect(api.applyLoomEpisodeShots).toHaveBeenCalledWith('loom-1', 'ep-1', { sourceFingerprint: 'a'.repeat(64), groups }, { silent: true });
});

it('confirms destructive autopilot replacement and reports its active lifecycle', async () => {
  let finish;
  api.startLoomEpisodeShotRun.mockClear();
  api.startLoomEpisodeShotRun.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const onRunningChange = vi.fn();
  render(<LoomShotPlanner loom={{ id: 'loom-1' }} episode={{ id: 'ep-1', nodes: [{ id: 'scene-1', image: 'example.png' }] }} onLoomUpdate={vi.fn()} onRunningChange={onRunningChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Run shot autopilot' }));
  expect(api.startLoomEpisodeShotRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.startLoomEpisodeShotRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Run shot autopilot' }));
  fireEvent.click(screen.getByRole('button', { name: 'Replace with shot autopilot' }));
  await waitFor(() => expect(onRunningChange).toHaveBeenLastCalledWith(true));
  finish({ id: 'run-2', loomId: 'loom-1', episodeId: 'ep-1', createdAt: '2026-01-02', revision: 1, status: 'completed', result: { review: { summary: 'Applied.' }, groups: [], loom: { id: 'loom-1' } } });
  await waitFor(() => expect(onRunningChange).toHaveBeenLastCalledWith(false));
});

it('reattaches to an interrupted run and resumes its saved options', async () => {
  const interrupted = { id: 'run-saved', loomId: 'loom-1', episodeId: 'ep-1', revision: 2, attempt: 1, createdAt: '2026-01-03', status: 'failed', message: 'Interrupted; saved draft preserved.' };
  api.getLoomEpisodeShotRun.mockResolvedValueOnce(interrupted);
  api.startLoomEpisodeShotRun.mockResolvedValue({ ...interrupted, revision: 3, attempt: 2, status: 'running', message: 'Resuming saved draft' });
  render(<LoomShotPlanner loom={{ id: 'loom-1' }} episode={{ id: 'ep-1', nodes: [] }} onLoomUpdate={vi.fn()} />);
  await screen.findByText('Interrupted; saved draft preserved.');
  fireEvent.click(screen.getByRole('button', { name: 'Resume saved shot plan' }));
  await screen.findByRole('button', { name: 'Stop shot planning' });
  expect(api.startLoomEpisodeShotRun).toHaveBeenLastCalledWith('loom-1', 'ep-1', expect.objectContaining({ resume: true }), { silent: true });
});
