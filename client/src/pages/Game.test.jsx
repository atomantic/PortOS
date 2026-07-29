import { act, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  bindGameMusic: vi.fn(),
  bindGameSprite: vi.fn(),
  compileGameAssets: vi.fn(),
  createGame: vi.fn(),
  getApps: vi.fn(),
  getGame: vi.fn(),
  getGameIntegrity: vi.fn(),
  launchNativeApp: vi.fn(),
  listGames: vi.fn(),
  listSpriteRecords: vi.fn(),
  listTracks: vi.fn(),
  requestGameFeedback: vi.fn(),
  startApp: vi.fn(),
  unbindGameMusic: vi.fn(),
  unbindGameSprite: vi.fn(),
}));

vi.mock('../services/api.js', () => api);
vi.mock('../components/ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../components/games/GameCompilePanel.jsx', () => ({
  default: ({ integrity, loadingIntegrity }) => (
    <div data-testid="integrity-state">
      {loadingIntegrity ? 'loading' : integrity?.bundle?.message || 'none'}
    </div>
  ),
}));

import Game from './Game.jsx';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const game = (id) => ({
  id,
  appId: `app-${id}`,
  name: `Game ${id}`,
  spriteBindings: [],
  musicBindings: [],
  feedbackHistory: [],
  updatedAt: '2026-07-29T12:00:00.000Z',
  compiledManifest: null,
});

describe('Game integrity request ownership', () => {
  it('ignores a prior workspace response that finishes after navigation', async () => {
    const first = deferred();
    const second = deferred();
    api.listGames.mockResolvedValue([game('one'), game('two')]);
    api.getApps.mockResolvedValue([
      { id: 'app-one', name: 'App One' },
      { id: 'app-two', name: 'App Two' },
    ]);
    api.listSpriteRecords.mockResolvedValue([]);
    api.listTracks.mockResolvedValue([]);
    api.getGameIntegrity.mockImplementation((id) => (
      id === 'one' ? first.promise : second.promise
    ));

    const router = createMemoryRouter(
      [{ path: '/game/:id', element: <Game /> }],
      { initialEntries: ['/game/one'] },
    );
    render(<RouterProvider router={router} />);

    await waitFor(() => expect(api.getGameIntegrity).toHaveBeenCalledWith('one', { silent: true }));
    await act(() => router.navigate('/game/two'));
    await waitFor(() => expect(api.getGameIntegrity).toHaveBeenCalledWith('two', { silent: true }));

    second.resolve({
      canLaunch: true,
      bundle: { status: 'current', message: 'two-current' },
      issues: [],
      counts: { spriteReady: 0, spriteTotal: 0, verifiedFiles: 0 },
    });
    await waitFor(() => expect(screen.getByTestId('integrity-state')).toHaveTextContent('two-current'));

    first.resolve({
      canLaunch: true,
      bundle: { status: 'current', message: 'one-stale-response' },
      issues: [],
      counts: { spriteReady: 0, spriteTotal: 0, verifiedFiles: 0 },
    });
    await act(async () => {});

    expect(screen.getByTestId('integrity-state')).toHaveTextContent('two-current');
    expect(screen.getByTestId('integrity-state')).not.toHaveTextContent('one-stale-response');
  });
});
