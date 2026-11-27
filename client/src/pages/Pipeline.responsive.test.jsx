import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import Pipeline from './Pipeline';

const listPipelineSeriesSummaries = vi.fn();
const deletePipelineSeries = vi.fn();
const listUniverseNames = vi.fn();
const getUniverse = vi.fn();
const listLooms = vi.fn();
const listAuthors = vi.fn();

vi.mock('../services/apiPipeline.js', () => ({
  listPipelineSeriesSummaries: (...a) => listPipelineSeriesSummaries(...a),
  createPipelineSeries: vi.fn(),
  deletePipelineSeries: (...a) => deletePipelineSeries(...a),
  generateSeriesTitleLogo: vi.fn(),
  generateSeriesConcepts: vi.fn(),
}));
vi.mock('../services/apiUniverseBuilder.js', () => ({
  listUniverseNames: (...a) => listUniverseNames(...a),
  getUniverse: (...a) => getUniverse(...a),
  WORLD_LOGLINE_MAX: 400,
  WORLD_PREMISE_MAX: 2000,
  WORLD_STYLE_NOTES_MAX: 2000,
}));
vi.mock('../services/apiFableLoom.js', () => ({
  listLooms: (...a) => listLooms(...a),
}));
vi.mock('../services/apiAuthors.js', () => ({
  listAuthors: (...a) => listAuthors(...a),
}));

vi.mock('../hooks/useSyncIntegrity', () => ({
  useSyncIntegrity: () => ({ integrity: null }),
  syncBadgeStatus: () => 'not-syncing',
}));

// Sharing/sync affordances are exercised in their own suites; stub them so this
// test only asserts the row's stacking behavior.
vi.mock('../components/sharing/ShareToButton', () => ({ default: () => <button type="button">share</button> }));
vi.mock('../components/sharing/SyncToPeerButton', () => ({ default: () => <button type="button">sync-to-peer</button> }));
vi.mock('../components/moodBoard/MoodBoardReferenceStrip', () => ({ default: () => <div>mood-board</div> }));
vi.mock('../components/ui/Toast');

const SERIES = {
  id: 'series-1',
  name: 'Example Series',
  logline: 'A drifter walks into a salt town and leaves owing it everything.',
  issueCountTarget: 3,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pipeline']}>
      <Pipeline />
    </MemoryRouter>,
  );
}

describe('Pipeline series index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPipelineSeriesSummaries.mockResolvedValue([SERIES]);
    listUniverseNames.mockResolvedValue([]);
    getUniverse.mockResolvedValue({});
    listLooms.mockResolvedValue([]);
    listAuthors.mockResolvedValue([]);
  });

  it('loads only the selected universe bible and ignores a stale selection response', async () => {
    listUniverseNames.mockResolvedValue([{ id: 'u-a', name: 'World A' }, { id: 'u-b', name: 'World B' }]);
    let resolveA;
    getUniverse.mockImplementation((id) => id === 'u-a'
      ? new Promise((resolve) => { resolveA = resolve; })
      : Promise.resolve({ logline: 'World B logline', premise: 'World B premise', styleNotes: 'World B style' }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New Series' }));
    await screen.findByRole('option', { name: 'World A' });
    expect(getUniverse).not.toHaveBeenCalled();
    const select = screen.getByLabelText(/Universe \(required\)/);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New story' } });
    fireEvent.change(select, { target: { value: 'u-a' } });
    expect(screen.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    fireEvent.change(select, { target: { value: 'u-b' } });
    await waitFor(() => expect(screen.getByLabelText('Logline')).toHaveValue('World B logline'));
    await act(async () => resolveA({ logline: 'Stale A', premise: 'Stale A' }));
    expect(screen.getByLabelText('Logline')).toHaveValue('World B logline');
    expect(screen.getByLabelText('Premise')).toHaveValue('World B premise');
    expect(screen.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    expect(getUniverse).toHaveBeenCalledWith('u-b', { silent: true });
  });

  it('stacks the row below sm so the logline gets the full card width', async () => {
    renderPage();

    const link = await screen.findByRole('link', { name: /Example Series/ });
    const row = link.closest('li');

    // Below sm the row is a column (content, then actions); sm+ restores the
    // side-by-side row. Without the stack the nowrap sync badge + icon buttons
    // hold their min-content width and squeeze the logline to ~one word/line.
    expect(row).toHaveClass('flex-col');
    expect(row).toHaveClass('sm:flex-row');

    // The trailing controls live in one shrink-0 group so they wrap together
    // rather than each competing with the text column for width.
    const actions = screen.getByRole('button', { name: /Delete series Example Series/ }).parentElement;
    expect(actions).toHaveClass('shrink-0');
    expect(actions).toHaveClass('flex-wrap');
    expect(actions.parentElement).toBe(row);
  });

  it('offers a retry after the universe list fails and shows the recovered options', async () => {
    listUniverseNames.mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce([{ id: 'u-a', name: 'World A' }]);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New Series' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load universes — Offline');
    expect(screen.queryByText(/No universes yet/)).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'World A' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('restores a failed deletion without resurrecting another deleted series', async () => {
    const otherSeries = { id: 'series-2', name: 'Second Series' };
    listPipelineSeriesSummaries.mockResolvedValue([SERIES, otherSeries]);
    let rejectDelete;
    deletePipelineSeries
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectDelete = reject; }))
      .mockResolvedValueOnce(undefined);
    renderPage();

    for (const { name } of [SERIES, otherSeries]) {
      fireEvent.click(await screen.findByRole('button', { name: `Delete series ${name}` }));
      const confirm = screen.getByRole('group', { name: `Confirm delete series ${name}` });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
      expect(screen.queryByRole('link', { name: new RegExp(name) })).toBeNull();
    }

    await act(async () => rejectDelete(new Error('Delete failed')));
    expect(await screen.findByRole('link', { name: /Example Series/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Second Series/ })).toBeNull();
  });

  it('directs an empty series form to the Create universes page', async () => {
    listPipelineSeriesSummaries.mockResolvedValue([]);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Create a series' }));
    expect(await screen.findByText('No universes yet. Create one under Create → Universes before creating a series.')).toBeTruthy();
  });
});
