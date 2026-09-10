import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
