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

// A reproducible-scratch category whose files a running job still needs: the
// server refuses the whole-directory purge, and the row says why instead of
// offering a button that fails on click (#3342).
const BUSY_REASON = '1 LoRA training run(s) queued or running — purging now would delete checkpoints out from under a live trainer.';

const busyOverview = {
  totalSize: 3000,
  dataDir: 'data',
  categories: [
    { key: 'training-runs', path: 'data/training-runs', label: 'LoRA Training Runs', description: 'Training checkpoints', archivable: false, deletable: true, purgeScope: 'category', classified: true, busy: true, busyReason: BUSY_REASON, size: 2000, fileCount: 9 },
    { key: 'messages', path: 'data/messages', label: 'Messages', description: 'Email and messaging data', archivable: true, deletable: true, purgeScope: 'category', classified: true, busy: false, busyReason: null, size: 1000, fileCount: 5 },
  ],
};

describe('DataManager busy categories (#3342)', () => {
  beforeEach(() => {
    getDataOverview.mockReset().mockResolvedValue(busyOverview);
    getDataCategory.mockReset().mockResolvedValue({ key: 'training-runs', items: [] });
    purgeDataCategory.mockReset();
  });

  it('replaces the Purge button with the server reason while the category is busy', async () => {
    render(<DataManager />);
    await waitFor(() => expect(screen.getAllByText('LoRA Training Runs').length).toBeGreaterThan(0));

    expandRow('LoRA Training Runs');
    await waitFor(() => expect(screen.getByText(BUSY_REASON)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Purge/ })).not.toBeInTheDocument();
    expect(purgeDataCategory).not.toHaveBeenCalled();
  });

  it('keeps the Purge button for an idle category in the same list', async () => {
    render(<DataManager />);
    await waitFor(() => expect(screen.getByText('Messages')).toBeInTheDocument());

    expandRow('Messages');
    await waitFor(() => expect(screen.getByRole('button', { name: /Purge/ })).toBeInTheDocument());
  });

  // The detail fetch re-runs the probe on expand, so a job that started after
  // the overview loaded must still take the button away before the click.
  it('prefers the fresher busy state from the category detail', async () => {
    getDataOverview.mockResolvedValue({
      ...busyOverview,
      categories: [{ ...busyOverview.categories[0], busy: false, busyReason: null }],
    });
    getDataCategory.mockResolvedValue({ key: 'training-runs', items: [], busy: true, busyReason: BUSY_REASON });

    render(<DataManager />);
    await waitFor(() => expect(screen.getAllByText('LoRA Training Runs').length).toBeGreaterThan(0));

    expandRow('LoRA Training Runs');
    await waitFor(() => expect(screen.getByText(BUSY_REASON)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Purge/ })).not.toBeInTheDocument();
  });

  // Detail fetches land out of order: a slow response for a row the user has
  // already collapsed past must not paint its busy state onto the row now open.
  it('ignores a detail response that a newer expand has superseded', async () => {
    let resolveSlow;
    getDataCategory.mockImplementation((key) => (key === 'training-runs'
      ? new Promise((res) => { resolveSlow = res; })
      : Promise.resolve({ key, items: [], busy: false, busyReason: null })));

    render(<DataManager />);
    await waitFor(() => expect(screen.getAllByText('LoRA Training Runs').length).toBeGreaterThan(0));

    expandRow('LoRA Training Runs');
    expandRow('Messages');
    await waitFor(() => expect(screen.getByRole('button', { name: /Purge/ })).toBeInTheDocument());

    // The stale training-runs detail arrives last and must be dropped.
    resolveSlow({ key: 'training-runs', items: [], busy: true, busyReason: BUSY_REASON });
    await waitFor(() => expect(screen.getByRole('button', { name: /Purge/ })).toBeInTheDocument());
    expect(screen.queryByText(BUSY_REASON)).not.toBeInTheDocument();
  });

  // A purge started on one row finishes after the user has moved to another. Its
  // post-action refresh holds a stale `expandedCat` closure and must not repaint
  // the row that is open now.
  it('drops the post-action detail refresh for a row the user has since left', async () => {
    getDataOverview.mockResolvedValue({
      ...busyOverview,
      categories: [{ ...busyOverview.categories[0], busy: false, busyReason: null }, busyOverview.categories[1]],
    });
    getDataCategory.mockImplementation((key) => Promise.resolve(key === 'training-runs'
      ? { key, items: [], busy: true, busyReason: BUSY_REASON }
      : { key, items: [], busy: false, busyReason: null }));
    let resolvePurge;
    purgeDataCategory.mockImplementation(() => new Promise((res) => { resolvePurge = res; }));

    render(<DataManager />);
    await waitFor(() => expect(screen.getByText('Messages')).toBeInTheDocument());

    expandRow('Messages');
    await waitFor(() => expect(screen.getByRole('button', { name: /Purge/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Purge/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Purge' }));

    expandRow('LoRA Training Runs');
    await waitFor(() => expect(screen.getByText(BUSY_REASON)).toBeInTheDocument());

    resolvePurge({ category: 'messages', subPath: null });
    await waitFor(() => expect(getDataOverview).toHaveBeenCalledTimes(2));
    expect(screen.getByText(BUSY_REASON)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Purge/ })).not.toBeInTheDocument();
  });

  // Older servers omit `busy` entirely — treating anything but an explicit true
  // as busy would strip the button from every category on an older peer.
  it('treats a missing busy flag as idle', async () => {
    getDataOverview.mockResolvedValue({
      ...busyOverview,
      categories: [{ ...busyOverview.categories[0], busy: undefined, busyReason: undefined }],
    });
    render(<DataManager />);
    await waitFor(() => expect(screen.getAllByText('LoRA Training Runs').length).toBeGreaterThan(0));

    expandRow('LoRA Training Runs');
    await waitFor(() => expect(screen.getByRole('button', { name: /Purge/ })).toBeInTheDocument());
  });
});

// `/data` is an `isFullWidthRoute`, so Layout's `<main>` is a bare
// `relative overflow-hidden`: this page must supply exactly ONE scroll region
// and all of its own padding. Before #4145 the route was NOT full-width, so the
// page's shell nested inside a padded, scrolling `<main>` — two scrollbars and
// doubled padding. Assert the shape so a revert on either side fails here.
describe('DataManager full-width shell (#4145)', () => {
  beforeEach(() => {
    getDataOverview.mockReset().mockResolvedValue(overview);
    getDataCategory.mockReset().mockResolvedValue({ key: 'mystery-dir', items: [] });
  });

  it('renders a single h-full column whose only scroll container is the body', async () => {
    const { container } = render(<DataManager />);
    await waitFor(() => expect(screen.getByText(UNKNOWN_DESCRIPTION)).toBeInTheDocument());

    const root = container.firstElementChild;
    expect(root.className).toContain('h-full');
    expect(root.className).toContain('flex-col');
    // The root itself never scrolls — it fills `<main>` exactly.
    expect(root.className).not.toMatch(/overflow-(auto|y-auto|scroll)/);

    // Exactly one scrolling region in the page shell (the category list's own
    // inner `max-h-64 overflow-auto` only exists on an expanded row).
    const scrollers = [...root.children].filter((el) => /overflow-auto/.test(el.className));
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0].className).toContain('flex-1');
    expect(scrollers[0].className).toContain('min-h-0');
    // The page owns its padding — Layout's full-width main supplies none.
    expect(scrollers[0].className).toContain('p-4');
  });

  it('keeps the header bar out of the scroll region', async () => {
    const { container } = render(<DataManager />);
    await waitFor(() => expect(screen.getByText(UNKNOWN_DESCRIPTION)).toBeInTheDocument());

    const bar = container.firstElementChild.firstElementChild;
    expect(bar).toContainElement(screen.getByRole('heading', { name: 'Data Manager' }));
    expect(bar.className).toContain('shrink-0');
    expect(bar.className).not.toMatch(/overflow-(auto|y-auto|scroll)/);
  });

  it('reserves the same shell in the loading skeleton', () => {
    // Never resolves — hold the page in its loading state.
    getDataOverview.mockReset().mockReturnValue(new Promise(() => {}));
    const { container } = render(<DataManager />);

    const skeleton = container.querySelector('[aria-busy="true"]');
    expect(skeleton.className).toContain('h-full');
    const skeletonScrollers = [...skeleton.children].filter((el) => /overflow-y-auto/.test(el.className));
    expect(skeletonScrollers).toHaveLength(1);
    expect(skeletonScrollers[0].className).toContain('p-4');
  });
});

// The category detail panel refetches after the page has already rendered, so
// it used to drop a bare BrailleSpinner into a panel the row had just expanded
// to full height (#4147).
describe('DataManager category detail loading state (#4147)', () => {
  beforeEach(() => {
    getDataOverview.mockReset().mockResolvedValue(overview);
    // Never resolves — hold the expanded category on its detail-loading branch.
    getDataCategory.mockReset().mockReturnValue(new Promise(() => {}));
  });

  it('reserves the item table instead of centering a spinner', async () => {
    render(<DataManager />);
    await waitFor(() => expect(screen.getAllByText('Prompts').length).toBeGreaterThan(0));

    expandRow('Prompts');

    const panel = await screen.findByRole('status', { name: 'Loading Prompts contents' });
    expect(panel).toHaveAttribute('aria-busy', 'true');
    // Five rows × three columns (Name / Size / Files) of reserved blocks.
    expect(panel.querySelectorAll('.animate-pulse')).toHaveLength(15);
    // Matches the loaded scroller's cap so filling in doesn't resize the panel.
    expect(panel.className).toContain('max-h-64');
  });
});
