import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import Pipeline from './Pipeline';

const listPipelineSeries = vi.fn();
const listUniverses = vi.fn();
const listLooms = vi.fn();

vi.mock('../services/api', () => ({
  listPipelineSeries: (...a) => listPipelineSeries(...a),
  createPipelineSeries: vi.fn(),
  deletePipelineSeries: vi.fn(),
  generateSeriesTitleLogo: vi.fn(),
  generateSeriesConcepts: vi.fn(),
  listUniverses: (...a) => listUniverses(...a),
  listLooms: (...a) => listLooms(...a),
  WORLD_LOGLINE_MAX: 400,
  WORLD_PREMISE_MAX: 2000,
  WORLD_STYLE_NOTES_MAX: 2000,
}));

vi.mock('../hooks/useSyncIntegrity', () => ({
  useSyncIntegrity: () => ({ integrity: null }),
  syncBadgeStatus: () => 'not-syncing',
}));

vi.mock('../components/sharing/ShareToButton', () => ({ default: () => <button type="button">share</button> }));
vi.mock('../components/sharing/SyncToPeerButton', () => ({ default: () => <button type="button">sync-to-peer</button> }));
vi.mock('../components/moodBoard/MoodBoardReferenceStrip', () => ({ default: () => <div>mood-board</div> }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const SERIES = [
  { id: 'series-1', name: 'Example Series' },
  { id: 'series-2', name: 'Second Series' },
];

const renderPage = () => render(
  <MemoryRouter initialEntries={['/pipeline']}><Pipeline /></MemoryRouter>,
);

describe('Pipeline series list — branching-narrative badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPipelineSeries.mockResolvedValue(SERIES);
    listUniverses.mockResolvedValue([]);
    listLooms.mockResolvedValue([
      { id: 'loom-1', seriesId: 'series-1' },
      { id: 'loom-2', seriesId: 'series-1' },
      { id: 'loom-3', seriesId: null },
      { id: 'loom-4', seriesId: 'series-gone' },
    ]);
  });

  it('counts only the looms linked to each row and leaves unlinked rows bare', async () => {
    renderPage();
    await screen.findByText('Example Series');
    await waitFor(() => expect(screen.getByText('2 branching')).toBeInTheDocument());

    const badged = screen.getByText('2 branching').closest('li');
    expect(badged).toContainElement(screen.getByText('Example Series'));
    // series-2 has no looms, and the standalone / dangling ones match nothing.
    expect(screen.queryByText('1 branching')).toBeNull();
  });

  it('renders the list without badges when the loom fetch fails', async () => {
    listLooms.mockRejectedValue(new Error('offline'));
    renderPage();
    await screen.findByText('Example Series');
    await waitFor(() => expect(screen.getByText('Second Series')).toBeInTheDocument());
    expect(screen.queryByText(/branching/)).toBeNull();
  });
});
