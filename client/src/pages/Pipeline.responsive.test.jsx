import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

// Sharing/sync affordances are exercised in their own suites; stub them so this
// test only asserts the row's stacking behavior.
vi.mock('../components/sharing/ShareToButton', () => ({ default: () => <button type="button">share</button> }));
vi.mock('../components/sharing/SyncToPeerButton', () => ({ default: () => <button type="button">sync-to-peer</button> }));
vi.mock('../components/moodBoard/MoodBoardReferenceStrip', () => ({ default: () => <div>mood-board</div> }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

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

describe('Pipeline series list — mobile layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPipelineSeries.mockResolvedValue([SERIES]);
    listUniverses.mockResolvedValue([]);
    listLooms.mockResolvedValue([]);
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
});
