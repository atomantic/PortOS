/**
 * Game studio page — the integrity gate.
 *
 * The workspace's whole promise is "a game starts only after its manifest and
 * every bound asset byte verify," and that promise lives in this component's
 * state handling. Both cases below are regressions this file exists to catch:
 * the index route rendering at all, and one game's verdict never being shown
 * for another game (`/game/A` → `/game/B` reuses this route WITHOUT remounting,
 * so unkeyed integrity state would enable Start game on an unverified bundle).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  integrityByGame: {},
  integrityCalls: [],
}));

vi.mock('../services/api.js', () => ({
  listGames: vi.fn(async () => [
    {
      id: 'verified-game',
      appId: 'app-1',
      name: 'Verified Game',
      spriteBindings: [{ spriteId: 'hero' }],
      musicBindings: [],
      artworkBindings: [],
      feedbackHistory: [],
      compiledManifest: {
        version: 2,
        spriteCount: 1,
        musicCount: 0,
        verifiedFileCount: 2,
        builtAt: '2026-07-28T12:00:00.000Z',
        manifestPath: 'manifests/game-assets-v2.json',
      },
      updatedAt: '2026-07-28T12:00:00.000Z',
    },
    {
      id: 'unbuilt-game',
      appId: 'app-1',
      name: 'Unbuilt Game',
      spriteBindings: [],
      musicBindings: [],
      artworkBindings: [],
      feedbackHistory: [],
      compiledManifest: null,
      updatedAt: '2026-07-28T12:00:00.000Z',
    },
    {
      id: 'artwork-game',
      appId: 'app-1',
      name: 'Artwork Game',
      spriteBindings: [],
      musicBindings: [],
      artworkBindings: [{ id: 'art-1', role: 'title-key-art', imageFilename: 'cover.png', label: 'Cover', destinationPath: 'game/assets/art/title/title-key-art.png' }],
      feedbackHistory: [],
      compiledManifest: null,
      updatedAt: '2026-07-28T12:00:00.000Z',
    },
  ]),
  getApps: vi.fn(async () => [{ id: 'app-1', name: 'Example App' }]),
  listSpriteRecords: vi.fn(async () => [{ id: 'hero', name: 'Hero', kind: 'character', status: 'ready' }]),
  listTracks: vi.fn(async () => []),
  getGalleryImages: vi.fn(async () => []),
  getGameIntegrity: vi.fn(async (id) => {
    api.integrityCalls.push(id);
    return api.integrityByGame[id] ?? null;
  }),
  getGame: vi.fn(),
  createGame: vi.fn(),
  compileGameAssets: vi.fn(),
  requestGameFeedback: vi.fn(),
  bindGameSprite: vi.fn(),
  bindGameMusic: vi.fn(),
  bindGameArtwork: vi.fn(),
  updateGameArtwork: vi.fn(),
  publishGameArtwork: vi.fn(),
  unbindGameSprite: vi.fn(),
  unbindGameMusic: vi.fn(),
  unbindGameArtwork: vi.fn(),
  startApp: vi.fn(),
  launchNativeApp: vi.fn(),
}));

const { default: Game } = await import('./Game.jsx');

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/game" element={<Game />} />
      <Route path="/game/:id" element={<Game />} />
    </Routes>
  </MemoryRouter>,
);

describe('Game page', () => {
  beforeEach(() => {
    api.integrityCalls = [];
    api.integrityByGame = {
      'verified-game': {
        readyToCompile: true,
        canLaunch: true,
        bundle: { status: 'current' },
        issues: [],
        counts: {
          spriteReady: 1,
          spriteTotal: 1,
          musicReady: 0,
          musicTotal: 0,
          artworkReady: 0,
          artworkTotal: 0,
          verifiedFiles: 2,
        },
        assets: { sprites: [], music: [], artwork: [] },
      },
      'unbuilt-game': {
        readyToCompile: true,
        canLaunch: false,
        bundle: { status: 'missing' },
        issues: [],
        counts: {
          spriteReady: 0,
          spriteTotal: 0,
          musicReady: 0,
          musicTotal: 0,
          artworkReady: 0,
          artworkTotal: 0,
          verifiedFiles: 0,
        },
        assets: { sprites: [], music: [], artwork: [] },
      },
      'artwork-game': {
        readyToCompile: true,
        canLaunch: false,
        bundle: { status: 'missing' },
        issues: [],
        counts: {
          spriteReady: 0,
          spriteTotal: 0,
          musicReady: 0,
          musicTotal: 0,
          artworkReady: 1,
          artworkTotal: 1,
          verifiedFiles: 0,
        },
        assets: { sprites: [], music: [], artwork: [] },
      },
    };
  });

  // The index route has no `:id`, so every id-keyed derivation has to tolerate
  // an undefined id — including the "is this result for the game on screen?"
  // comparison, where undefined must NOT read as a match.
  it('renders the index route, which has no game id', async () => {
    renderAt('/game');
    expect(await screen.findByText('Create a Game workspace')).toBeInTheDocument();
    expect(screen.getByText('Verified Game')).toBeInTheDocument();
    expect(api.integrityCalls).toEqual([]);
  });

  it('shows a verified game as launchable', async () => {
    renderAt('/game/verified-game');
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start game' })).toBeEnabled();
    const back = screen.getByRole('link', { name: 'All Games' });
    expect(back.className).toContain('h-11');
    expect(back.className).toContain('w-11');
    expect(back).toHaveAttribute('title', 'All Games');
    expect(back.closest('[class*="border-b"]')?.className).toContain('shrink-0');
    expect(screen.getByRole('tabpanel').parentElement?.className)
      .toContain('overflow-y-auto');
  });

  it('never offers to launch a game whose bundle was never built', async () => {
    renderAt('/game/unbuilt-game');
    expect(await screen.findByText('Not built')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled();
  });

  it('does not show one game as launchable because another one was', async () => {
    // The regression: a slow fetch for the unbuilt game, while the verified
    // game's verdict is already in state. Until this game's own result lands,
    // Start game must stay shut rather than inherit `canLaunch: true`.
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { getGameIntegrity } = await import('../services/api.js');
    getGameIntegrity.mockImplementationOnce(async () => {
      await pending;
      return api.integrityByGame['unbuilt-game'];
    });

    renderAt('/game/unbuilt-game');
    await screen.findByRole('button', { name: 'Start game' });
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled();

    release();
    await waitFor(() => expect(screen.getByText('Not built')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled();
  });

  it('keeps the current game verdict when an older game read finishes last', async () => {
    // Integrity hashes every bound asset, so leaving a game before its read
    // settles is ordinary. The older answer must not replace the newer one —
    // that left the panel on "Checking…" with Build and Start disabled.
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { getGameIntegrity } = await import('../services/api.js');
    getGameIntegrity.mockImplementationOnce(async () => {
      await pending;
      return api.integrityByGame['verified-game'];
    });

    renderAt('/game/verified-game');
    fireEvent.click(await screen.findByRole('link', { name: 'All Games' }));
    fireEvent.click(await screen.findByRole('link', { name: /Unbuilt Game/ }));
    expect(await screen.findByText('Not built')).toBeInTheDocument();

    release();
    await pending;
    await waitFor(() => expect(api.integrityCalls).toEqual(['unbuilt-game']));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(screen.getByText('Not built')).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Build & verify/ })).toBeEnabled();
  });

  it('keeps the current game verdict when a compile started on another game finishes later', async () => {
    // The compile's follow-up refresh belongs to the game it was started on.
    // Once the route has moved on it must not take over the newest-read slot.
    let finishCompile;
    const { compileGameAssets, getGame, listGames } = await import('../services/api.js');
    const [verified] = await listGames();
    compileGameAssets.mockImplementationOnce(() => new Promise((resolve) => { finishCompile = resolve; }));
    getGame.mockResolvedValueOnce(verified);

    renderAt('/game/verified-game');
    fireEvent.click(await screen.findByRole('button', { name: /Rebuild & verify/ }));
    fireEvent.click(screen.getByRole('link', { name: 'All Games' }));
    fireEvent.click(await screen.findByRole('link', { name: /Unbuilt Game/ }));
    expect(await screen.findByText('Not built')).toBeInTheDocument();

    finishCompile({ created: true, version: 3 });
    await waitFor(() => expect(getGame).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(screen.getByText('Not built')).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
  });

  it('does not show one game\'s failed build on another game', async () => {
    const { compileGameAssets } = await import('../services/api.js');
    compileGameAssets.mockRejectedValueOnce(new Error('Example build failure'));

    renderAt('/game/verified-game');
    fireEvent.click(await screen.findByRole('button', { name: /Rebuild & verify/ }));
    expect(await screen.findByText(/Example build failure/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'All Games' }));
    fireEvent.click(await screen.findByRole('link', { name: /Unbuilt Game/ }));
    expect(await screen.findByText('Not built')).toBeInTheDocument();
    expect(screen.queryByText(/Example build failure/)).not.toBeInTheDocument();
  });

  it('shows a failed studio read with Retry, not an empty studio or a deleted game', async () => {
    const { listGames } = await import('../services/api.js');
    listGames.mockRejectedValueOnce(new Error('Games unavailable'));

    renderAt('/game/verified-game');
    expect(await screen.findByText('Could not load the Game studio.')).toBeInTheDocument();
    expect(screen.queryByText(/may have been deleted/)).not.toBeInTheDocument();
    expect(screen.queryByText('No Game workspaces yet.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Verified')).toBeInTheDocument();
  });

  it('renders ListLoadError with retry when gallery images fail to load', async () => {
    const { getGalleryImages } = await import('../services/api.js');
    getGalleryImages.mockReset();
    getGalleryImages.mockRejectedValueOnce(new Error('Gallery unavailable'));

    renderAt('/game/artwork-game?gameTab=assets');
    expect(await screen.findByText(/Could not load artwork images/)).toBeInTheDocument();
    expect(screen.queryByText(/No world or interface artwork is bound yet/)).not.toBeInTheDocument();

    getGalleryImages.mockResolvedValueOnce([{ filename: 'cover.png', prompt: 'Cover Art' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByText(/Could not load artwork images/)).not.toBeInTheDocument();
    });
  });

  it('renders empty copy when a game has no artwork bindings', async () => {
    renderAt('/game/verified-game?gameTab=assets');
    expect(await screen.findByText(/No world or interface artwork is bound yet/)).toBeInTheDocument();
    expect(screen.queryByText('Could not load artwork images.')).not.toBeInTheDocument();
  });
});
