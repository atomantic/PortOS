import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { MemoryRouter } from 'react-router';

// Header layout contract for #3568: on a ~375px phone the WorkEditor header
// used to wrap into 4-5 rows and push the prose textarea below the fold. The
// fix regroups the secondary controls (status, view mode, snapshot) into one
// full-width sub-bar under `sm` while `sm:contents` dissolves that wrapper on
// desktop so the single-row layout — and its left-to-right order — is
// unchanged. jsdom doesn't apply Tailwind, so these assert the class contract
// that drives the layout plus the behaviour that must survive the regroup.

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

async function renderEditor() {
  const view = render(
    <MemoryRouter>
      <WorkEditor work={work} onChange={() => {}} />
    </MemoryRouter>
  );
  await act(async () => {});
  return view;
}

// The header controls, in the order they must read left-to-right on desktop.
function headerControls() {
  const title = screen.getByLabelText('Work title');
  return {
    header: title.parentElement,
    title,
    status: screen.getByLabelText('Status'),
    viewGroup: screen.getByRole('group', { name: 'View mode' }),
    save: screen.getByRole('button', { name: /^Sav/ }),
    snapshot: screen.getByRole('button', { name: 'Snapshot' }),
    menu: screen.getByLabelText('Work menu').closest('div'),
  };
}

function orderOf(el) {
  const match = /(?:^|\s)sm:order-(\d+)(?:\s|$)/.exec(el.className);
  return match ? Number(match[1]) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkEditor header layout (#3568)', () => {
  it('keeps the first header row to title + Save + Work menu on mobile', async () => {
    await renderEditor();
    const { header, title, save, menu } = headerControls();
    const secondary = screen.getByTestId('work-header-secondary');

    // Four direct children: three first-row controls plus the sub-bar.
    expect([...header.children]).toEqual([title, save, menu, secondary]);
    // The sub-bar takes a full row of its own under `sm`…
    expect(secondary.className).toContain('w-full');
    // …and dissolves into the header row at `sm+`.
    expect(secondary.className).toContain('sm:contents');
  });

  it('parks status, view mode and snapshot in the mobile sub-bar', async () => {
    await renderEditor();
    const { status, viewGroup, snapshot } = headerControls();
    const secondary = screen.getByTestId('work-header-secondary');

    for (const el of [status, viewGroup, snapshot]) {
      expect(secondary.contains(el)).toBe(true);
    }
  });

  it('restores the original left-to-right control order on desktop', async () => {
    await renderEditor();
    const { title, status, viewGroup, save, snapshot, menu } = headerControls();

    const expected = [title, status, viewGroup, save, snapshot, menu];
    expect(expected.map(orderOf)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('renders every control exactly once — nothing is duplicated per breakpoint', async () => {
    await renderEditor();
    expect(screen.getAllByLabelText('Status')).toHaveLength(1);
    expect(screen.getAllByLabelText('Work menu')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Snapshot' })).toHaveLength(1);
    expect(screen.getAllByRole('group', { name: 'View mode' })).toHaveLength(1);
  });

  it('keeps view-mode buttons named when their labels collapse to icons under sm', async () => {
    await renderEditor();
    const { viewGroup } = headerControls();

    for (const name of ['Edit', 'Read', 'Review']) {
      const button = within(viewGroup).getByRole('button', { name });
      // The visible text is hidden under `sm`, so the name comes from aria-label.
      expect(button).toHaveAttribute('aria-label', name);
      expect(within(button).getByText(name).className).toContain('hidden sm:inline');
    }
  });

  it('gives the mobile-visible header controls a 44px touch target', async () => {
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
