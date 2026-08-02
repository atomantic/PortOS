import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DataManager from './DataManager';

// A directory with no server-side CATEGORIES entry comes back `classified: false`
// with both permission flags off. The row must explain *why* Archive/Purge are
// missing instead of leaving a dead end on the cleanup page (#3285).
const getDataOverview = vi.fn();
const getDataCategory = vi.fn();
const purgeDataCategory = vi.fn();

vi.mock('../services/api', () => ({
  getDataOverview: (...a) => getDataOverview(...a),
  getDataBackups: vi.fn(() => Promise.resolve([])),
  getDataCategory: (...a) => getDataCategory(...a),
  archiveDataCategory: vi.fn(),
  purgeDataCategory: (...a) => purgeDataCategory(...a),
  deleteDataBackup: vi.fn(),
  getTombstoneSweepStatus: vi.fn(() => Promise.resolve({ refused: [] })),
  sweepTombstonesNow: vi.fn(),
}));

vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

const UNKNOWN_DESCRIPTION = "Not classified — PortOS doesn't know if this is safe to remove";

const expandRow = (label) => {
  const toggle = screen.getAllByText(label).map((el) => el.closest('button')).find(Boolean);
  fireEvent.click(toggle);
};

const overview = {
  totalSize: 3000,
  dataDir: 'data',
  categories: [
    { key: 'mystery-dir', path: 'data/mystery-dir', label: 'mystery-dir', description: UNKNOWN_DESCRIPTION, archivable: false, deletable: false, classified: false, size: 2000, fileCount: 12 },
    { key: 'prompts', path: 'data/prompts', label: 'Prompts', description: 'AI prompt templates', archivable: false, deletable: false, classified: true, size: 1000, fileCount: 4 },
  ],
};

describe('DataManager unclassified rows (#3285)', () => {
  beforeEach(() => {
    getDataOverview.mockReset().mockResolvedValue(overview);
    getDataCategory.mockReset().mockResolvedValue({ key: 'mystery-dir', items: [] });
  });

  it('renders the outcome-phrased description for an unclassified directory', async () => {
    render(<DataManager />);
    await waitFor(() => expect(screen.getByText(UNKNOWN_DESCRIPTION)).toBeInTheDocument());
  });

  it('explains the withheld actions on expand, and keeps the protected wording for known categories', async () => {
    render(<DataManager />);
    await waitFor(() => expect(screen.getByText(UNKNOWN_DESCRIPTION)).toBeInTheDocument());

    // The label also appears in the "Largest" stat tile — expand via the row's
    // own toggle button, not the first text match.
    expandRow('mystery-dir');
    await waitFor(() => expect(screen.getByText(/withholds Archive and Purge/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Archive|Purge/ })).not.toBeInTheDocument();

    expandRow('Prompts');
    await waitFor(() => expect(screen.getByText(/This category is protected/)).toBeInTheDocument());
  });
});

// `purgeScope: 'items'` categories hold the only copy of each file, so the row
// trades the whole-category Purge button for a per-entry delete (#3327).
const scopedOverview = {
  totalSize: 3000,
  dataDir: 'data',
  categories: [
    { key: 'images', path: 'data/images', label: 'Images', description: 'Uploaded and generated images', archivable: true, deletable: true, purgeScope: 'items', classified: true, size: 2000, fileCount: 2 },
    { key: 'messages', path: 'data/messages', label: 'Messages', description: 'Email and messaging data', archivable: true, deletable: true, purgeScope: 'category', classified: true, size: 1000, fileCount: 5 },
    { key: 'legacy', path: 'data/legacy', label: 'Legacy', description: 'From a server that predates purgeScope', archivable: false, deletable: true, classified: true, size: 500, fileCount: 1 },
  ],
};

describe('DataManager per-item purge (#3327)', () => {
  beforeEach(() => {
    getDataOverview.mockReset().mockResolvedValue(scopedOverview);
    getDataCategory.mockReset().mockResolvedValue({
      key: 'images',
      items: [{ name: 'render-0001.png', type: 'file', size: 1200 }],
    });
    purgeDataCategory.mockReset().mockResolvedValue({ category: 'images', subPath: 'render-0001.png' });
  });

  it('hides the whole-category Purge button and explains why', async () => {
    render(<DataManager />);
    await waitFor(() => expect(screen.getAllByText('Images').length).toBeGreaterThan(0));

    expandRow('Images');
    await waitFor(() => expect(screen.getByText(/no whole-category purge/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Purge' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Archive/ })).toBeInTheDocument();
  });

  it('deletes a single entry through the subPath purge', async () => {
    render(<DataManager />);
    await waitFor(() => expect(screen.getAllByText('Images').length).toBeGreaterThan(0));

    expandRow('Images');
    const trash = await screen.findByRole('button', { name: 'Delete render-0001.png from Images' });
    fireEvent.click(trash);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(purgeDataCategory).toHaveBeenCalledWith('images', { subPath: 'render-0001.png' }));
    // Reactive removal — the row leaves the table without a detail refetch.
    await waitFor(() => expect(screen.queryByText('render-0001.png')).not.toBeInTheDocument());
  });

  it('offers no delete for a directory entry — the server refuses those too', async () => {
    getDataCategory.mockResolvedValue({
      key: 'images',
      items: [
        { name: 'render-0001.png', type: 'file', size: 1200 },
        { name: '.scratch', type: 'directory', size: 800, fileCount: 3 },
      ],
    });
    render(<DataManager />);
    await waitFor(() => expect(screen.getAllByText('Images').length).toBeGreaterThan(0));

    expandRow('Images');
    await screen.findByRole('button', { name: 'Delete render-0001.png from Images' });
    expect(screen.queryByRole('button', { name: 'Delete .scratch from Images' })).not.toBeInTheDocument();
  });

  it('keeps the category-wide Purge button for category-scoped and legacy rows', async () => {
    render(<DataManager />);
    await waitFor(() => expect(screen.getByText('Messages')).toBeInTheDocument());

    expandRow('Messages');
    await waitFor(() => expect(screen.getByRole('button', { name: /Purge/ })).toBeInTheDocument());

    // A server that predates purgeScope omits the field — the button must not
    // vanish for every deletable category on an older peer.
    expandRow('Legacy');
    await waitFor(() => expect(screen.getByRole('button', { name: /Purge/ })).toBeInTheDocument());
  });
});
