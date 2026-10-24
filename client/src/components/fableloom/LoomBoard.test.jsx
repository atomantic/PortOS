import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import LoomBoard from './LoomBoard';

const api = vi.hoisted(() => ({ listStoryboards: vi.fn(), makeStoryboardFromFableLoom: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../MediaImage', () => ({ default: () => null }));

it('does not show another episode’s storyboard links while the current list is unavailable', async () => {
  const episode = id => ({ id, startNodeId: 'node-1', nodes: [{ id: 'node-1', title: 'An ending', isEnding: true, transitions: [] }] });
  const props = { loomId: 'loom-1', aspectRatio: '16:9', via: [], onPick: vi.fn(), onOpenNode: vi.fn() };
  api.listStoryboards.mockResolvedValueOnce([
    { id: 'sb-first', name: 'First episode board', source: { kind: 'fableloom', loomId: 'loom-1', episodeId: 'ep-1' } },
  ]);
  let failRead;
  api.listStoryboards.mockImplementationOnce(() => new Promise((_, reject) => { failRead = reject; }));
  const view = render(<MemoryRouter><LoomBoard {...props} episode={episode('ep-1')} /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: 'First episode board' })).toBeInTheDocument();
  view.rerender(<MemoryRouter><LoomBoard {...props} episode={episode('ep-2')} /></MemoryRouter>);
  await act(async () => { failRead(new Error('List unavailable')); });
  expect(screen.queryByRole('link', { name: 'First episode board' })).not.toBeInTheDocument();
});
