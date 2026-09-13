import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { stubSequentialLayout, pressKey, dndAnnouncement } from '../test/dndKeyboardDrag';

// Guards #7243. This lives in its own file rather than in VideoTimelineEditor.test.jsx
// because that suite mocks `useSortable` down to empty attributes/listeners —
// exactly the wiring a keyboard drag has to exercise for real.
//
// Two defects are pinned here. The page registered a PointerSensor alone, so
// `arrayMove` inside onDragEnd — the only clip-reorder path there is — was
// unreachable without a mouse. And `TimelineBlock` spread `clickableProps`
// AFTER dnd-kit's `listeners`, which REPLACES the keyboard activator outright,
// so adding the sensor alone would still have left Space doing nothing.

const toastError = vi.hoisted(() => vi.fn());
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }),
}));

vi.mock('react-router', () => ({
  useParams: () => ({ projectId: 'p1' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('../hooks/useSseProgress', () => ({
  useSseProgress: () => ({ latest: null, closed: false }),
  isTerminalSseFrame: () => false,
}));

const api = vi.hoisted(() => ({ project: null, saved: [] }));

vi.mock('../services/api', () => ({
  getTimelineProject: async () => api.project,
  listVideoHistory: async () => [],
  getGalleryImages: async () => [{ filename: 'first.png' }, { filename: 'second.png' }],
  listMusicLibrary: async () => ({ tracks: [] }),
  updateTimelineProject: async (_id, patch) => { api.saved.push(patch); return { updatedAt: 'u2' }; },
  renderTimelineProject: async () => ({ jobId: 'j1' }),
}));

vi.mock('../services/apiImageVideo', () => ({
  listImageGalleryPage: async () => ({ items: [], total: 0, offset: 0, limit: 24 }),
}));

const VideoTimelineEditor = (await import('./VideoTimelineEditor')).default;

const still = (assetFile) => ({
  type: 'still', assetKind: 'images', assetFile, durationSec: 3, fadeInSec: 0, fadeOutSec: 0,
});

let restoreLayout;
beforeEach(() => {
  api.saved = [];
  api.project = {
    id: 'p1', name: 'Example Project', updatedAt: 'u1', schemaVersion: 2,
    segments: [still('first.png'), still('second.png')],
    overlays: [], audio: { clipVolume: 1, tracks: [] }, clips: [],
  };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  window.matchMedia = vi.fn((query) => ({
    matches: query === '(min-width: 64rem)', media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  // The clip lane is a horizontal sortable list.
  restoreLayout = stubSequentialLayout({ axis: 'horizontal' });
});
afterEach(() => restoreLayout());

const renderEditor = async () => {
  render(<VideoTimelineEditor />);
  await waitFor(() => expect(screen.queryByText('Loading project…')).not.toBeInTheDocument());
};

// The block is the drag handle, so it is reached through its own remove
// button's accessible name — the only text that names a specific segment.
const blockFor = (assetFile) => screen
  .getByRole('button', { name: `Remove ${assetFile} from timeline` })
  .closest('[aria-roledescription="sortable"]');

describe('VideoTimelineEditor keyboard clip reordering (#7243)', () => {
  it('reorders segments with Space, arrows and Space', async () => {
    await renderEditor();
    const first = blockFor('first.png');
    first.focus();

    await pressKey('Space', first);
    // Collision resolves immediately after the pickup, so the live region
    // already carries the onDragOver announcement by the time it is read.
    expect(dndAnnouncement()).toMatch(/Clip 1 is over position 1 of 2/);

    await pressKey('ArrowRight');
    await pressKey('Space');

    expect(dndAnnouncement()).toMatch(/Dropped clip in position 2 of 2/);
    await waitFor(() => expect(api.saved.length).toBeGreaterThan(0));
    expect(api.saved.at(-1).segments.map((s) => s.assetFile)).toEqual(['second.png', 'first.png']);
  });

  it('cancels on Escape and leaves the order untouched', async () => {
    await renderEditor();
    const first = blockFor('first.png');
    first.focus();

    await pressKey('Space', first);
    await pressKey('ArrowRight');
    await pressKey('Escape');

    expect(dndAnnouncement()).toMatch(/Cancelled moving clip 1/);
    expect(api.saved).toEqual([]);
  });

  it('still selects the block on Enter, which the drag must not swallow', async () => {
    // Enter is deliberately NOT a dnd-kit start/end code on this surface, so
    // the block's own select handler keeps it — that is what lets one element
    // be both the drag handle and the click-to-select target.
    await renderEditor();
    const second = blockFor('second.png');
    second.focus();

    await pressKey('Enter', second);

    expect(dndAnnouncement()).not.toMatch(/Picked up/);
    // The inspector only renders a Hold field once a still segment is selected.
    expect(screen.getByLabelText('Hold (s)')).toBeInTheDocument();
  });
});
