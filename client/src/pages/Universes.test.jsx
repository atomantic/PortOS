import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// The page pulls in network-y siblings (sync integrity hook, share/sync peer
// buttons) that fetch on mount. Stub them so the test only exercises the
// duplicate-detection banner + merge flow added here.
vi.mock('../services/api', () => ({
  listUniverses: vi.fn(),
  deleteUniverse: vi.fn(),
  listPipelineSeries: vi.fn(),
  listMediaCollections: vi.fn(),
  listUniverseDuplicates: vi.fn(),
  previewUniverseMerge: vi.fn(),
  mergeUniverses: vi.fn(),
  previewSeriesMerge: vi.fn(),
  mergeSeries: vi.fn(),
  updateUniverse: vi.fn(),
  updatePipelineSeries: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../components/ui/Modal', () => ({ default: ({ open, children }) => (open ? <div role="dialog">{children}</div> : null) }));
vi.mock('../components/ui/InlineDiff', () => ({ default: ({ oldText, newText }) => <div data-testid="diff">{oldText}|{newText}</div> }));
vi.mock('../hooks/useSyncIntegrity', () => ({ useSyncIntegrity: () => ({}), syncBadgeStatus: () => 'unknown' }));
vi.mock('../components/sharing/ShareToButton', () => ({ default: () => null }));
vi.mock('../components/sharing/SyncToPeerButton', () => ({ default: () => null }));
vi.mock('../components/sync/SyncBadge', () => ({ default: () => null }));

import * as api from '../services/api';
import Universes from './Universes';

const dupGroup = {
  normalizedName: 'clandestiny',
  records: [
    { id: 'u-new', name: 'Clandestiny', updatedAt: '2026-05-22T00:00:00Z', counts: { characters: 5, places: 2, objects: 1, categories: 4 }, linkedSeriesCount: 1, linkedCollectionItemCount: 3 },
    { id: 'u-old', name: 'Clandestiny', updatedAt: '2026-05-11T00:00:00Z', counts: { characters: 1, places: 0, objects: 0, categories: 4 }, linkedSeriesCount: 0, linkedCollectionItemCount: 0 },
  ],
};

const renderPage = () => render(<MemoryRouter><Universes /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  api.listUniverses.mockResolvedValue([
    { id: 'u-new', name: 'Clandestiny', createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z' },
    { id: 'u-old', name: 'Clandestiny', createdAt: '2026-05-11T00:00:00Z', updatedAt: '2026-05-11T00:00:00Z' },
  ]);
  api.listPipelineSeries.mockResolvedValue([]);
  api.listMediaCollections.mockResolvedValue([]);
  api.listUniverseDuplicates.mockResolvedValue({ groups: [dupGroup] });
});

describe('Universes page — duplicate detection', () => {
  it('shows a banner when duplicate-named universes are detected', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/1 duplicate-named universe detected/)).toBeInTheDocument());
    expect(screen.getByText(/2 copies/)).toBeInTheDocument();
  });

  it('hides the banner when no duplicates exist', async () => {
    api.listUniverseDuplicates.mockResolvedValue({ groups: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Universes')).toBeInTheDocument());
    expect(screen.queryByText(/duplicate-named/)).not.toBeInTheDocument();
  });

  it('opens the merge modal, previews, executes with field choices, and re-scans', async () => {
    api.previewUniverseMerge.mockResolvedValue({
      conflicts: [{ field: 'starterPrompt', survivorValue: 'A', loserValue: 'B' }],
      cascade: { seriesToRepoint: [{ id: 's1' }], loserCollectionItemCount: 3 },
    });
    api.mergeUniverses.mockResolvedValue({ merged: true });
    // After the merge tombstones the loser, the re-scan returns no duplicates.
    api.listUniverseDuplicates
      .mockResolvedValueOnce({ groups: [dupGroup] })
      .mockResolvedValue({ groups: [] });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Merge…/ }));
    await waitFor(() => expect(api.previewUniverseMerge).toHaveBeenCalledWith({ survivorId: 'u-new', loserId: 'u-old' }, expect.anything()));
    await waitFor(() => expect(screen.getByText('starterPrompt')).toBeInTheDocument());
    expect(screen.getByText(/child series re-pointed/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Merge$/ }));
    await waitFor(() => expect(api.mergeUniverses).toHaveBeenCalledWith(
      { survivorId: 'u-new', loserId: 'u-old', fieldChoices: { starterPrompt: 'survivor' } },
      expect.anything(),
    ));
    // Banner clears after the re-scan finds nothing.
    await waitFor(() => expect(screen.queryByText(/duplicate-named/)).not.toBeInTheDocument());
  });

  it('dismisses a group via "Keep both" for the session', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/duplicate-named/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Keep both/ }));
    await waitFor(() => expect(screen.queryByText(/duplicate-named/)).not.toBeInTheDocument());
  });
});

describe('Universes page — row thumbnail', () => {
  beforeEach(() => {
    api.listUniverseDuplicates.mockResolvedValue({ groups: [] });
  });

  it('shows the base style image (last styleImageRef), matching the detail page', async () => {
    api.listUniverses.mockResolvedValue([
      { id: 'u1', name: 'Neon Expanse', styleImageRefs: ['old-style.png', 'base-style.png'], updatedAt: '2026-06-01T00:00:00Z' },
    ]);
    // A media-collection image exists too, but the base style image wins.
    api.listMediaCollections.mockResolvedValue([
      { universeId: 'u1', items: [{ kind: 'image', ref: 'contact-sheet.png', addedAt: '2026-06-10T00:00:00Z' }] },
    ]);
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByText('Neon Expanse').length).toBeGreaterThan(0));
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toContain('base-style.png');
    expect(img.getAttribute('src')).not.toContain('contact-sheet.png');
  });

  it('falls back to the latest media-collection image when no base style image exists', async () => {
    api.listUniverses.mockResolvedValue([
      { id: 'u2', name: 'Reality', updatedAt: '2026-06-01T00:00:00Z' },
    ]);
    api.listMediaCollections.mockResolvedValue([
      { universeId: 'u2', items: [{ kind: 'image', ref: 'fallback.png', addedAt: '2026-06-10T00:00:00Z' }] },
    ]);
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByText('Reality').length).toBeGreaterThan(0));
    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toContain('fallback.png');
  });
});
