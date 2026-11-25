import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('../../../services/apiSystem.js', () => ({ getSettings: api.getSettings, updateSettings: api.updateSettings }));
vi.mock('../../../services/apiSpotify.js', () => ({
  getSpotifyStatus: api.getSpotifyStatus,
  getSpotifyAuthUrl: api.getSpotifyAuthUrl,
  saveSpotifyCredentials: api.saveSpotifyCredentials,
  clearSpotifyAuth: api.clearSpotifyAuth,
  syncSpotify: api.syncSpotify,
  getSpotifyPlaylists: api.getSpotifyPlaylists,
  syncSpotifyPlaylists: api.syncSpotifyPlaylists,
}));
vi.mock('../../ui/Toast', () => ({ default: toast }));

const { SpotifyTab } = await import('./SpotifyTab');

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ spotify: { enabled: false, intervalMinutes: 25 } });
  api.getSpotifyStatus.mockResolvedValue({ state: {}, auth: { hasTokens: false } });
  api.getSpotifyPlaylists.mockResolvedValue({ snapshot: null });
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

describe('SpotifyTab failure rendering', () => {
  it('renders an inline error when state.lastResult.ok is false, and points to Reconnect button when needsAuth is true', async () => {
    api.getSpotifyStatus.mockResolvedValue({
      state: {
        cursorAfter: 1234,
        lastRunAt: '2026-11-12T07:00:00.000Z',
        lastResult: {
          ok: false,
          needsAuth: true,
          error: 'Spotify rejected the saved authorization — reconnect Spotify.',
          failedAt: '2026-11-12T07:25:00.000Z',
        },
      },
      auth: { hasTokens: true, hasCredentials: true },
    });

    render(<MemoryRouter><SpotifyTab /></MemoryRouter>);

    expect(await screen.findByText(/Sync failed/)).toBeTruthy();
    expect(screen.getByText('Spotify rejected the saved authorization — reconnect Spotify.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect Spotify' })).toBeTruthy();
  });

  it('renders a general sync failure without reconnect button when needsAuth is false', async () => {
    api.getSpotifyStatus.mockResolvedValue({
      state: {
        cursorAfter: 1234,
        lastRunAt: '2026-11-12T07:00:00.000Z',
        lastResult: {
          ok: false,
          needsAuth: false,
          error: 'Spotify API request failed: request timed out',
          failedAt: '2026-11-12T07:25:00.000Z',
        },
      },
      auth: { hasTokens: true, hasCredentials: true },
    });

    render(<MemoryRouter><SpotifyTab /></MemoryRouter>);

    expect(await screen.findByText(/Sync failed/)).toBeTruthy();
    expect(screen.getByText('Spotify API request failed: request timed out')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reconnect Spotify' })).toBeNull();
  });

  it('renders a later successful sync clearing the failure', async () => {
    api.getSpotifyStatus.mockResolvedValue({
      state: {
        cursorAfter: 1234,
        lastRunAt: '2026-11-12T07:00:00.000Z',
        lastResult: {
          ok: false,
          needsAuth: false,
          error: 'Spotify API request failed: request timed out',
          failedAt: '2026-11-12T07:25:00.000Z',
        },
      },
      auth: { hasTokens: true, hasCredentials: true },
    });

    render(<MemoryRouter><SpotifyTab /></MemoryRouter>);

    expect(await screen.findByText(/Sync failed/)).toBeTruthy();

    api.syncSpotify.mockResolvedValue({
      ok: true,
      scanned: 10,
      recorded: 5,
      cursorAfter: 1300,
    });

    const syncButton = screen.getByRole('button', { name: /Sync now/i });
    fireEvent.click(syncButton);

    expect(await screen.findByText('10')).toBeTruthy();
    expect(screen.queryByText(/Sync failed/)).toBeNull();
  });

  it('shows server error toast instead of generic connect message when tokens exist on sync now failure', async () => {
    api.getSpotifyStatus.mockResolvedValue({
      state: { cursorAfter: 1234 },
      auth: { hasTokens: true, hasCredentials: true },
    });

    render(<MemoryRouter><SpotifyTab /></MemoryRouter>);

    await screen.findByRole('button', { name: /Sync now/i });

    api.syncSpotify.mockResolvedValue({
      ok: false,
      needsAuth: true,
      error: 'Spotify rejected the saved authorization — reconnect Spotify.',
    });

    fireEvent.click(screen.getByRole('button', { name: /Sync now/i }));

    await screen.findByText('Spotify rejected the saved authorization — reconnect Spotify.');
    expect(toast.error).toHaveBeenCalledWith('Spotify rejected the saved authorization — reconnect Spotify.');
  });
});

describe('SpotifyTab load errors and disconnect (#17971)', () => {
  it('shows ListLoadError with Retry when the playlist read fails', async () => {
    api.getSpotifyStatus.mockResolvedValue({ state: {}, auth: { hasTokens: true, hasCredentials: true } });
    api.getSpotifyPlaylists.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ snapshot: null });
    render(<MemoryRouter><SpotifyTab /></MemoryRouter>);
    expect(await screen.findByText(/Could not load Spotify playlists — boom/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/grant playlist access to build/)).toBeTruthy();
    expect(screen.queryByText(/Could not load Spotify playlists/)).toBeNull();
  });

  it('requires confirmation before clearing Spotify auth', async () => {
    api.getSpotifyStatus.mockResolvedValue({ state: {}, auth: { hasTokens: true, hasCredentials: true } });
    api.clearSpotifyAuth.mockResolvedValue({ cleared: true });
    render(<MemoryRouter><SpotifyTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Disconnect/ }));
    expect(api.clearSpotifyAuth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.clearSpotifyAuth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
    expect(api.clearSpotifyAuth).toHaveBeenCalledTimes(1);
  });

  it('shows inline prerequisite copy for disabled Connect and Sync now', async () => {
    render(<MemoryRouter><SpotifyTab /></MemoryRouter>);
    expect(await screen.findByText(/Save your client ID and secret above to enable Connect Spotify/)).toBeTruthy();
    expect(screen.getByText(/Connect Spotify \(step 2\) to enable Sync now/)).toBeTruthy();
  });
});

it.each([false, true])('retries an unread Spotify status (connected: %s)', async (connected) => {
  api.getSpotifyStatus.mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ state: {}, auth: { hasTokens: connected, hasCredentials: connected } });
  render(<MemoryRouter><SpotifyTab /></MemoryRouter>);

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Spotify status');
  expect(screen.queryByText('Not connected')).not.toBeInTheDocument();
  expect(screen.queryByText(/Save your client ID and secret above/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(connected ? 'Connected' : 'Not connected')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
