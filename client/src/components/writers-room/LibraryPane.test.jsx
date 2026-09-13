import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { stubSequentialLayout, pressKey, pressKeyTimes, dndAnnouncement } from '../../test/dndKeyboardDrag';

// Regression guard for #3569: the Writers Room library header actions wrapped
// 14px icons in `p-1`, giving them ~22x22px of tappable area — small enough
// that a thumb aiming for "New work" on a phone regularly missed. The row-level
// actions in the same pane already carried the 44px floor; the header ones and
// the create forms they open now do too.

vi.mock('../../services/apiWritersRoom', () => ({
  createWritersRoomFolder: vi.fn(),
  deleteWritersRoomFolder: vi.fn(),
  createWritersRoomWork: vi.fn(),
  deleteWritersRoomWork: vi.fn(),
  updateWritersRoomWork: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: Object.assign(() => {}, { success: vi.fn(), error: vi.fn() }),
}));

import { updateWritersRoomWork } from '../../services/apiWritersRoom';
import LibraryPane from './LibraryPane';

function LibraryPaneHarness(props) {
  const [creatingWork, setCreatingWork] = useState(null);
  return (
    <LibraryPane
      folders={[]}
      works={[]}
      activeWorkId={null}
      onSelectWork={() => {}}
      onRefresh={() => {}}
      onCollapse={() => {}}
      creatingWork={creatingWork}
      onCreatingWorkChange={setCreatingWork}
      {...props}
    />
  );
}

const renderPane = (props = {}) => render(<LibraryPaneHarness {...props} />);

// Tailwind arbitrary-value floors are what the rest of the app uses (see
// Drawer.jsx's close button), so assert on the classes rather than on computed
// layout — jsdom applies no stylesheet.
const expectTouchTarget = (el) => {
  expect(el.className).toContain('min-w-[44px]');
  expect(el.className).toContain('min-h-[44px]');
};

describe('LibraryPane header actions (#3569)', () => {
  it('meets the 44px touch floor on New folder, New work and Hide library', () => {
    renderPane();
    expectTouchTarget(screen.getByRole('button', { name: 'New folder' }));
    expectTouchTarget(screen.getAllByRole('button', { name: 'New work' })[0]);
    expectTouchTarget(screen.getByRole('button', { name: 'Hide library' }));
  });

  it('keeps the Hide library button desktop-only without losing its flex centering', () => {
    renderPane();
    const hide = screen.getByRole('button', { name: 'Hide library' });
    // `hidden md:inline-flex` and a bare `flex` are the same Tailwind layer, so
    // adding `flex` here would race the responsive variant rather than compose
    // with it — the icon must be centred by `inline-flex` instead.
    expect(hide.className).toContain('hidden md:inline-flex');
    expect(hide.className).not.toMatch(/(^|\s)flex(\s|$)/);
  });

  it('omits the Hide library button entirely when the pane cannot collapse', () => {
    renderPane({ onCollapse: undefined });
    expect(screen.queryByRole('button', { name: 'Hide library' })).toBeNull();
  });

  it('gives the new-folder form tappable controls', () => {
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    expect(screen.getByPlaceholderText('Folder name').className).toContain('min-h-[44px]');
    expect(screen.getByRole('button', { name: 'Add' }).className).toContain('min-h-[44px]');
    expectTouchTarget(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('gives the new-work form tappable controls', () => {
    renderPane();
    fireEvent.click(screen.getAllByRole('button', { name: 'New work' })[0]);
    expect(screen.getByPlaceholderText('Title').className).toContain('min-h-[44px]');
    expect(screen.getByRole('combobox').className).toContain('min-h-[44px]');
    expect(screen.getByRole('button', { name: 'Create' }).className).toContain('min-h-[44px]');
    expectTouchTarget(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('offers a direct New work action when the library is empty', () => {
    renderPane();
    fireEvent.click(screen.getAllByRole('button', { name: 'New work' })[1]);
    expect(screen.getByRole('textbox', { name: 'Work title' })).toBeInTheDocument();
    expect(screen.queryByText(/Click .* to start/)).toBeNull();
  });
});

// Guards #7243: filing a work into a folder is the ONLY write of `folderId`
// anywhere in the client, and this pane registered a PointerSensor alone. Every
// work's grip is a `<button>` carrying dnd-kit's `aria-roledescription="draggable"`
// and its "press the space bar to pick up" instructions, so the pane was telling
// keyboard users to do something nothing listened for — and there is no other
// path to the same edit, which makes it a WCAG 2.1.1 failure rather than a
// missing convenience.
describe('LibraryPane keyboard filing (#7243)', () => {
  const FOLDERS = [{ id: 'f-drafts', name: 'Drafts' }, { id: 'f-archive', name: 'Archive' }];
  const WORKS = [{
    id: 'w-1', title: 'Example Story', kind: 'short-story', wordCount: 120,
    folderId: null, updatedAt: '2026-01-01T00:00:00.000Z',
  }];

  let restoreLayout;
  beforeEach(() => {
    vi.clearAllMocks();
    updateWritersRoomWork.mockResolvedValue({ id: 'w-1', folderId: 'f-drafts' });
    restoreLayout = stubSequentialLayout();
  });
  afterEach(() => restoreLayout());

  const pickUpWork = async () => {
    renderPane({ folders: FOLDERS, works: WORKS });
    const handle = screen.getByRole('button', { name: 'Drag Example Story' });
    handle.focus();
    await pressKey('Space', handle);
  };

  it('files a work into a folder with Space, arrows and Space', async () => {
    await pickUpWork();
    expect(dndAnnouncement()).toMatch(/Example Story/);

    // The pane's three drop zones are Unfiled, then each folder row. Walk to
    // the top of that list (the getter clamps rather than wrapping), so one
    // ArrowDown lands on the first folder from a known position.
    await pressKeyTimes('ArrowUp', 3);
    expect(dndAnnouncement()).toMatch(/over Unfiled/);
    await pressKey('ArrowDown');
    expect(dndAnnouncement()).toMatch(/over Drafts/);

    await pressKey('Space');
    expect(updateWritersRoomWork).toHaveBeenCalledWith('w-1', { folderId: 'f-drafts' }, { silent: true });
    expect(dndAnnouncement()).toMatch(/Filed Example Story in Drafts/);
  });

  it('cancels on Escape without moving the work', async () => {
    await pickUpWork();
    await pressKeyTimes('ArrowUp', 3);
    await pressKey('ArrowDown');
    await pressKey('Escape');

    expect(updateWritersRoomWork).not.toHaveBeenCalled();
    expect(dndAnnouncement()).toMatch(/Cancelled moving Example Story/);
    // The overlay and the "drop here to unfile" affordance are driven by the
    // same state; a cancel that never cleared it would strand both on screen.
    expect(screen.queryByText('Drop here to unfile')).toBeNull();
  });
});
