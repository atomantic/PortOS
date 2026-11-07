import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getSpotifyStatus: vi.fn(),
  getSpotifyAuthUrl: vi.fn(),
  saveSpotifyCredentials: vi.fn(),
  clearSpotifyAuth: vi.fn(),
  syncSpotify: vi.fn(),
  getSpotifyPlaylists: vi.fn(),
  syncSpotifyPlaylists: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const { SpotifyTab } = await import('./SpotifyTab');

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ spotify: { enabled: false, intervalMinutes: 25 } });
  api.getSpotifyStatus.mockResolvedValue({ state: {}, auth: { hasTokens: false } });
});

describe('SpotifyTab unreadable sync state', () => {
  it('warns that sync is stopped when the status reports an unreadable store', async () => {
    api.getSpotifyStatus.mockResolvedValue({ state: { cursorAfter: null }, auth: { hasTokens: false }, stateError: 'UNREADABLE_STORE' });
    render(<MemoryRouter><SpotifyTab /></MemoryRouter>);
    expect(await screen.findByText(/Sync is stopped: its saved position could not be read/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Sync now/ })).toBeTruthy();
  });

  it('shows no warning when the status carries no stateError', async () => {
    render(<MemoryRouter><SpotifyTab /></MemoryRouter>);
    await screen.findByRole('button', { name: /Sync now/ });
    expect(screen.queryByText(/Sync is stopped/)).toBeNull();
  });
});
