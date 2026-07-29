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

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
      feedbackHistory: [],
      compiledManifest: null,
      updatedAt: '2026-07-28T12:00:00.000Z',
    },
  ]),
  getApps: vi.fn(async () => [{ id: 'app-1', name: 'Example App' }]),
  listSpriteRecords: vi.fn(async () => [{ id: 'hero', name: 'Hero', kind: 'character', status: 'ready' }]),
  listTracks: vi.fn(async () => []),
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
  unbindGameSprite: vi.fn(),
  unbindGameMusic: vi.fn(),
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
        counts: { spriteReady: 1, spriteTotal: 1, musicReady: 0, musicTotal: 0, verifiedFiles: 2 },
        assets: { sprites: [], music: [] },
      },
      'unbuilt-game': {
        readyToCompile: true,
        canLaunch: false,
        bundle: { status: 'missing' },
        issues: [],
        counts: { spriteReady: 0, spriteTotal: 0, musicReady: 0, musicTotal: 0, verifiedFiles: 0 },
        assets: { sprites: [], music: [] },
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
});
