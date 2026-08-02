import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DataManager from './DataManager';

// A directory with no server-side CATEGORIES entry comes back `classified: false`
// with both permission flags off. The row must explain *why* Archive/Purge are
// missing instead of leaving a dead end on the cleanup page (#3285).
const getDataOverview = vi.fn();
const getDataCategory = vi.fn();

vi.mock('../services/api', () => ({
  getDataOverview: (...a) => getDataOverview(...a),
  getDataBackups: vi.fn(() => Promise.resolve([])),
  getDataCategory: (...a) => getDataCategory(...a),
  archiveDataCategory: vi.fn(),
  purgeDataCategory: vi.fn(),
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
