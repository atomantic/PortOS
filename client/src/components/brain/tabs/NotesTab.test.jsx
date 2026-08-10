import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// ── Mock toast ────────────────────────────────────────────────────────────────
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: mockToast }));

// ── Mock API ──────────────────────────────────────────────────────────────────
const api = vi.hoisted(() => ({
  getNotesVaults: vi.fn(),
  detectNotesVaults: vi.fn(),
  scanNotesVault: vi.fn(),
  getNotesVaultFolders: vi.fn(),
  getNotesVaultTags: vi.fn(),
  addNotesVault: vi.fn(),
  getNote: vi.fn(),
  updateNote: vi.fn(),
  createNote: vi.fn(),
  deleteNote: vi.fn(),
  searchNotes: vi.fn(),
}));
vi.mock('../../../services/api', () => api);

const NotesTab = (await import('./NotesTab')).default;

// jsdom has no layout engine and Tailwind is never compiled for the test run,
// so touch-target size is asserted from the utility tokens the element renders
// with rather than from measured geometry — the same approach as the repo-wide
// guard in src/a11yConventions.test.js and Layout.test.jsx. Reverting
// NotesTab.jsx to its pre-fix state fails every case in this file.
//
// Tailwind `min-h-`/`min-w-`/`h-`/`w-` token → px, for both the arbitrary value
// (`min-h-[44px]`) and the spacing scale (`h-11` = 11 * 4px = 44px). Mirrors
// `tokenPx` in src/a11yConventions.test.js.
const tokenPx = token => {
  const arb = token.match(/^(?:min-)?[hw]-\[(\d+(?:\.\d+)?)px\]$/);
  if (arb) return parseFloat(arb[1]);
  const scale = token.match(/^(?:min-)?[hw]-(\d+(?:\.5)?)$/);
  if (scale) return parseFloat(scale[1]) * 4;
  return null;
};

const axisPx = (className, axis) => {
  let px = 0;
  for (const token of String(className).split(/\s+/)) {
    if (!new RegExp(`^(?:min-)?${axis}-`).test(token)) continue;
    const value = tokenPx(token);
    if (value !== null && value > px) px = value;
  }
  return px;
};

// Tailwind spacing token on the given prefix (`right-2`, `pr-14`) → px.
// 0 when the class carries no such token.
const spacingPx = (className, prefix) => {
  const m = String(className).match(new RegExp(`(?:^|\\s)${prefix}-(\\d+)(?:\\s|$)`));
  return m ? Number(m[1]) * 4 : 0;
};

const expectTouchTarget = (el, { width = true } = {}) => {
  expect(axisPx(el.className, 'h'), `height floor on: ${el.className}`).toBeGreaterThanOrEqual(44);
  if (width) {
    expect(axisPx(el.className, 'w'), `width floor on: ${el.className}`).toBeGreaterThanOrEqual(44);
  }
};

const renderTab = async () => {
  await act(async () => { render(<NotesTab />); });
};

describe('NotesTab header touch targets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getNotesVaults.mockResolvedValue([{ id: 'vault-1', name: 'Example Vault', path: '/example/vault' }]);
    api.detectNotesVaults.mockResolvedValue([]);
    api.scanNotesVault.mockResolvedValue({ notes: [], total: 0 });
    api.getNotesVaultFolders.mockResolvedValue({ folders: [] });
    api.getNotesVaultTags.mockResolvedValue({ tags: [] });
  });

  it('sizes the "Manage vaults" and "New note" buttons to the 44px minimum', async () => {
    await renderTab();

    // Icon-only header actions: both axes must clear the floor, since a bare
    // `p-1.5` wrapper around a 14px icon is only ~26x26.
    expectTouchTarget(screen.getByRole('button', { name: 'Manage vaults' }));
    expectTouchTarget(screen.getByRole('button', { name: 'New note' }));
  });

  it('sizes the vault select and search input to the 44px minimum', async () => {
    await renderTab();

    // Full-width/flex-1 controls only need the height floor — their width is
    // driven by the row, not a min-w token.
    expectTouchTarget(screen.getByRole('combobox'), { width: false });
    expectTouchTarget(screen.getByPlaceholderText('Search notes...'), { width: false });
  });

  it('sizes the create-note form controls to the 44px minimum', async () => {
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'New note' }));

    expectTouchTarget(screen.getByPlaceholderText('folder/note-name'), { width: false });
    // The Create button needs the width floor too: mid-create its label
    // collapses to '...', which `px-3` alone does not pad out to 44px.
    expectTouchTarget(screen.getByRole('button', { name: 'Create' }));
    expectTouchTarget(screen.getByRole('button', { name: 'Close' }));
  });

  it('pads the search input past the clear button so the query is not obscured', async () => {
    await renderTab();

    const input = screen.getByPlaceholderText('Search notes...');
    fireEvent.change(input, { target: { value: 'meeting' } });

    // The create-note form is closed here, so the clear-search button is the
    // only thing labelled "Close" — assert that, or a second Close button
    // appearing later would silently redirect this assertion at the wrong
    // element and make it pass for the wrong reason.
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    expect(closeButtons).toHaveLength(1);
    const [clear] = closeButtons;

    // The clear button is absolutely positioned at `right-2` (8px) and is 44px
    // wide, so the input needs >= 52px of right padding or the typed text runs
    // underneath it.
    const rightOffset = spacingPx(clear.className, 'right');
    const clearWidth = axisPx(clear.className, 'w');
    // Guard the guard: if either token stopped parsing, the comparison below
    // would degrade to `padRight >= 0` and pass trivially.
    expect(rightOffset).toBeGreaterThan(0);
    expect(clearWidth).toBeGreaterThanOrEqual(44);

    const padRight = spacingPx(input.className, 'pr');
    expect(padRight).toBeGreaterThanOrEqual(rightOffset + clearWidth);
  });
});

/**
 * The iCloud force-save escape hatch — #3717.
 *
 * The server refuses to overwrite a note whose bytes look offloaded, because that
 * write blocks the process. The screen can false-positive on a genuinely-local
 * file, and when it does no amount of retrying clears it — so the user gets a way
 * through. These pin BOTH halves: the way through exists, and it never opens on
 * its own.
 */
describe('NotesTab iCloud force save', () => {
  const NOTE = { path: 'a.md', name: 'a', folder: '', size: 12, tags: [], modifiedAt: new Date().toISOString() };
  // A refusal the server flags as `stalled` — its own before/after check found
  // the download moved nothing, so retrying provably cannot clear it. Only this
  // shape may arm the override.
  const evicted = ({ stalled = true } = {}) =>
    Object.assign(new Error('evicted'), { code: 'NOTE_EVICTED', context: { stalled } });

  const openEditor = async () => {
    await renderTab();
    await act(async () => { fireEvent.click(screen.getByText('a')); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit' })); });
  };

  const clickSave = async () => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })); });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getNotesVaults.mockResolvedValue([{ id: 'vault-1', name: 'Example Vault', path: '/example/vault' }]);
    api.detectNotesVaults.mockResolvedValue([]);
    api.scanNotesVault.mockResolvedValue({ notes: [NOTE], total: 1 });
    api.getNotesVaultFolders.mockResolvedValue({ folders: [] });
    api.getNotesVaultTags.mockResolvedValue({ tags: [] });
    api.getNote.mockResolvedValue({ ...NOTE, content: 'body', body: 'body', backlinks: [] });
  });

  it('offers no override on the first refusal', async () => {
    api.updateNote.mockRejectedValue(evicted());
    await openEditor();

    await clickSave();

    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });

  it('offers the override on the second consecutive refusal and forces only on that click', async () => {
    api.updateNote.mockRejectedValue(evicted());
    await openEditor();

    await clickSave();
    await clickSave();

    // Neither ordinary save may have forced — that would make the override the
    // retry default and re-admit the blocking write with no user decision.
    for (const call of api.updateNote.mock.calls) {
      expect(call[3]).toEqual({ force: false });
    }

    api.updateNote.mockResolvedValue({ ...NOTE, content: 'body' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save anyway' })); });

    expect(api.updateNote).toHaveBeenLastCalledWith('vault-1', 'a.md', 'body', { force: true });
  });

  it('hides the override once the user leaves edit mode', async () => {
    // Outside edit mode there is no buffer the user meant to write, so a stray
    // "Save anyway" click would issue the risky forced write for nothing.
    api.updateNote.mockRejectedValue(evicted());
    await openEditor();

    await clickSave();
    await clickSave();
    expect(screen.getByRole('button', { name: 'Save anyway' })).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close editor' })); });

    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });

  it('does not arm on an unrelated failure', async () => {
    api.updateNote.mockRejectedValue(Object.assign(new Error('nope'), { code: 'INVALID_PATH' }));
    await openEditor();

    await clickSave();
    await clickSave();

    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });

  it('does not arm while a download is genuinely in flight', async () => {
    // The transient case: waiting IS the right answer, and forcing here would
    // issue the blocking write the guard exists to prevent. An impatient user
    // clicking Save twice must not be handed the override.
    api.updateNote.mockRejectedValue(evicted({ stalled: false }));
    await openEditor();

    await clickSave();
    await clickSave();

    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });
});
