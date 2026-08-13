import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { createMemoryRouter, RouterProvider } from 'react-router';

// Header layout contract for #3568: on a ~375px phone the WorkEditor header
// used to wrap into 4-5 rows and push the prose textarea below the fold. The
// fix moves the status select and view-mode toggle into a full-width sub-bar
// that `sm:contents` dissolves back into the single header row on desktop —
// so DOM order stays the desktop order and only the phone layout changes.
// jsdom doesn't apply Tailwind, so these assert the class contract that drives
// the layout plus the behaviour that must survive the regroup.

vi.mock('./StoryboardPanel', () => ({
  default: function StoryboardPanelStub() { return <div data-testid="storyboard-panel" />; },
  STORYBOARD_TAB: {
    CHARACTERS: 'characters', WORLD: 'world', OBJECTS: 'objects',
    SCENES: 'scenes', BOARDS: 'boards', CONFIG: 'config',
  },
  STORYBOARD_TAB_VALUES: ['characters', 'world', 'objects', 'scenes', 'boards', 'config'],
}));

// Socket.IO auto-connects on import (useImageGenQueue / LiveRenderPanel).
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false },
}));

vi.mock('../../services/apiWritersRoom', async (importOriginal) => ({
  ...(await importOriginal()),
  listWritersRoomCharacters: vi.fn(async () => []),
  listWritersRoomPlaces: vi.fn(async () => []),
  listWritersRoomObjects: vi.fn(async () => []),
}));

import WorkEditor from './WorkEditor';

const work = {
  id: 'wr-work-1',
  title: 'Example Work',
  status: 'drafting',
  kind: 'novel',
  activeDraftBody: 'The hero wakes.',
  activeDraftVersionId: 'wr-draft-1',
  drafts: [{ id: 'wr-draft-1', label: 'v1', wordCount: 3 }],
};

// A DATA router: WorkEditor's unsaved-changes guard uses `useBlocker`, which
// throws under a plain <MemoryRouter> (#3995).
const editorRouter = () => createMemoryRouter([
  { path: '/writers-room', element: <WorkEditor work={work} onChange={() => {}} /> },
  { path: '/dashboard', element: <div>dashboard</div> },
], { initialEntries: ['/writers-room'] });

async function renderEditor() {
  const router = editorRouter();
  const view = render(<RouterProvider router={router} />);
  await act(async () => {});
  return { ...view, router };
}

function headerControls() {
  const title = screen.getByLabelText('Work title');
  return {
    header: title.parentElement,
    title,
    status: screen.getByLabelText('Status'),
    viewGroup: screen.getByRole('group', { name: 'View mode' }),
    save: screen.getByRole('button', { name: /^Sav/ }),
    snapshot: screen.getByRole('button', { name: 'Snapshot' }),
    // The `relative` wrapper that positions the dropdown, not the button.
    menu: screen.getByLabelText('Work menu').parentElement,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkEditor header layout (#3568)', () => {
  it('gives the secondary controls their own row under sm and none of their own on desktop', async () => {
    await renderEditor();
    const { status, viewGroup } = headerControls();
    const secondary = screen.getByTestId('work-header-secondary');

    // Its own full-width row, ordered after the primary actions, under `sm`…
    expect(secondary.className).toContain('w-full');
    expect(secondary.className).toContain('order-last');
    // …dissolved into the header row at `sm+`.
    expect(secondary.className).toContain('sm:contents');
    for (const el of [status, viewGroup]) {
      expect(secondary.contains(el)).toBe(true);
    }
  });

  it('leaves title, Save, Snapshot and the Work menu on the first mobile row', async () => {
    await renderEditor();
    const { header, title, save, snapshot, menu } = headerControls();
    const secondary = screen.getByTestId('work-header-secondary');

    expect([...header.children]).toEqual([title, secondary, save, snapshot, menu]);
    // Only the sub-bar is re-ordered; anything else carrying an `order-*` class
    // would either break the row split or desync tab order from the layout.
    for (const el of [title, save, snapshot, menu]) {
      expect(el.className).not.toMatch(/(?:^|\s)(?:sm:)?order-/);
    }
  });

  it('keeps DOM order equal to the desktop left-to-right order', async () => {
    await renderEditor();
    const { title, status, viewGroup, save, snapshot, menu } = headerControls();

    // title · status · view mode · Save · Snapshot · menu — the pre-#3568
    // desktop sequence, and (because nothing sets `order` on desktop) the tab
    // order a keyboard user gets.
    const sequence = [title, status, viewGroup, save, snapshot, menu];
    for (let i = 0; i < sequence.length - 1; i += 1) {
      const relation = sequence[i].compareDocumentPosition(sequence[i + 1]);
      expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('renders every control exactly once — nothing is duplicated per breakpoint', async () => {
    await renderEditor();
    expect(screen.getAllByLabelText('Status')).toHaveLength(1);
    expect(screen.getAllByLabelText('Work menu')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Snapshot' })).toHaveLength(1);
    expect(screen.getAllByRole('group', { name: 'View mode' })).toHaveLength(1);
  });

  it('keeps buttons named when their labels collapse to icons under sm', async () => {
    await renderEditor();
    const { viewGroup, snapshot } = headerControls();

    for (const name of ['Edit', 'Read', 'Review']) {
      const button = within(viewGroup).getByRole('button', { name });
      expect(button).toHaveAttribute('aria-label', name);
      expect(within(button).getByText(name).className).toContain('hidden sm:inline');
    }
    expect(snapshot).toHaveAttribute('aria-label', 'Snapshot');
    expect(within(snapshot).getByText('Snapshot').className).toContain('hidden sm:inline');
  });

  it('gives the header controls a 44px touch target on mobile', async () => {
    await renderEditor();
    const { title, status, save, snapshot } = headerControls();
    const menuButton = screen.getByLabelText('Work menu');

    for (const el of [title, status, save, snapshot, menuButton]) {
      expect(el.className).toContain('min-h-[44px]');
      expect(el.className).toContain('sm:min-h-0');
    }
  });

  it('still switches view mode from the regrouped toggle', async () => {
    const { container } = await renderEditor();
    const { viewGroup } = headerControls();
    expect(container.querySelector('textarea')).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(viewGroup).getByRole('button', { name: 'Read' }));
    });

    expect(within(viewGroup).getByRole('button', { name: 'Read' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(viewGroup).getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('textarea')).toBeNull();
  });
});

describe('WorkEditor unsaved-changes route guard (#3995)', () => {
  const CONFIRM = 'Discard your unsaved changes to this work?';
  const typeUnsaved = async (container, next) => {
    const area = container.querySelector('textarea');
    await act(async () => { fireEvent.change(area, { target: { value: next } }); });
    return area;
  };

  it('blocks an in-app navigation while the draft is dirty', async () => {
    const { container, router } = await renderEditor();
    await typeUnsaved(container, 'The hero wakes, then hesitates.');

    await act(async () => { await router.navigate('/dashboard'); });
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
  });

  it('discards the draft and runs the parked navigation', async () => {
    const { container, router } = await renderEditor();
    await typeUnsaved(container, 'The hero wakes, then hesitates.');
    await act(async () => { await router.navigate('/dashboard'); });

    await act(async () => { fireEvent.click(screen.getByText('Discard')); });
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('keeps the editor and the draft on cancel', async () => {
    const { container, router } = await renderEditor();
    await typeUnsaved(container, 'The hero wakes, then hesitates.');
    await act(async () => { await router.navigate('/dashboard'); });

    await act(async () => { fireEvent.click(screen.getByText('Keep editing')); });
    expect(screen.queryByText(CONFIRM)).not.toBeInTheDocument();
    expect(container.querySelector('textarea').value).toBe('The hero wakes, then hesitates.');
    expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
  });

  it('lets a navigation through while the draft is clean', async () => {
    const { router } = await renderEditor();
    await act(async () => { await router.navigate('/dashboard'); });
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });
});
