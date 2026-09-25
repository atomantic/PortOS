import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';

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

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function HistoryControls() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>Browser back</button>
      <button type="button" onClick={() => navigate(1)}>Browser forward</button>
    </>
  );
}

const renderTab = async (entry = '/brain/notes') => {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[entry]}>
        <NotesTab />
        <Location />
        <HistoryControls />
      </MemoryRouter>,
    );
  });
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
    const clear = screen.getByRole('button', { name: 'Clear search' });

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

describe('NotesTab request lifetimes', () => {
  const note = (name, content = name) => ({
    path: `${name}.md`, name, folder: '', size: 12, tags: [],
    modifiedAt: '2026-09-11T00:00:00Z', content, body: content, backlinks: []
  });
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const switchVault = value => fireEvent.change(screen.getByRole('combobox', { name: 'Vault' }), { target: { value } });

  beforeEach(() => {
    vi.resetAllMocks();
    api.getNotesVaults.mockResolvedValue([
      { id: 'a', name: 'Vault A' }, { id: 'b', name: 'Vault B' }
    ]);
    api.scanNotesVault.mockResolvedValue({ notes: [note('first'), note('second')], total: 2 });
    api.getNotesVaultFolders.mockResolvedValue({ folders: [] });
    api.getNotesVaultTags.mockResolvedValue({ tags: [] });
    api.getNote.mockImplementation((_vault, path) => Promise.resolve(note(path.replace('.md', ''))));
  });

  it('keeps the newest selected note and saves its buffer after an older fetch resolves', async () => {
    const first = deferred();
    api.getNote.mockImplementation((_vault, path) => path === 'first.md' ? first.promise : Promise.resolve(note('second')));
    await renderTab();
    fireEvent.click(screen.getByText('first'));
    await act(async () => { fireEvent.click(screen.getByText('second')); });
    await act(async () => { first.resolve(note('first', 'stale body')); });
    expect(screen.getByRole('heading', { name: 'second' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Note content' })).toHaveValue('second');
    api.updateNote.mockResolvedValue(note('second'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(api.updateNote).toHaveBeenCalledWith('a', 'second.md', 'second', { force: false });
  });

  it('does not let an old failed selection stop the newest note loading', async () => {
    const first = deferred();
    const second = deferred();
    api.getNote.mockImplementation((_vault, path) => path === 'first.md' ? first.promise : second.promise);
    await renderTab();
    fireEvent.click(screen.getByText('first'));
    fireEvent.click(screen.getByText('second'));
    await act(async () => { first.reject(new Error('old failure')); });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await act(async () => { second.resolve(note('second')); });
    expect(screen.getByRole('heading', { name: 'second' })).toBeInTheDocument();
  });

  it('clears the old vault immediately and ignores old scans, note reads, and search results after switching back', async () => {
    const oldScan = deferred();
    const newScan = deferred();
    const oldNote = deferred();
    const oldSearch = deferred();
    await renderTab();
    api.scanNotesVault.mockReturnValueOnce(oldScan.promise).mockReturnValueOnce(newScan.promise);
    api.getNote.mockReturnValueOnce(oldNote.promise);
    api.searchNotes.mockReturnValueOnce(oldSearch.promise);
    fireEvent.click(screen.getByText('first'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search notes' }), { target: { value: 'old' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search notes' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    switchVault('b');
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await act(async () => { switchVault('a'); });
    await act(async () => {
      oldScan.resolve({ notes: [note('stale scan')], total: 1 });
      newScan.resolve({ notes: [note('wrong vault')], total: 1 });
      oldNote.resolve(note('stale editor'));
      oldSearch.resolve({ results: [note('stale search')], total: 1 });
    });
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.queryByText(/stale|wrong vault/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('keeps the newest refresh when same-vault scans finish out of order', async () => {
    const older = deferred();
    const newer = deferred();
    await renderTab();
    api.scanNotesVault.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { newer.resolve({ notes: [note('current')], total: 1 }); });
    await act(async () => { older.resolve({ notes: [note('stale')], total: 1 }); });
    expect(screen.getByText('current')).toBeInTheDocument();
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('does not restore a saved note after the user selects another note', async () => {
    const saved = deferred();
    api.updateNote.mockReturnValueOnce(saved.promise);
    await renderTab();
    await act(async () => { fireEvent.click(screen.getByText('first')); });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { fireEvent.click(screen.getByText('second')); });
    await act(async () => { saved.resolve(note('first')); });
    expect(screen.getByRole('heading', { name: 'second' })).toBeInTheDocument();
    expect(mockToast.success).not.toHaveBeenCalledWith('Note saved');
  });

  it('does not remove the previous vault row when a delete finishes after browser back', async () => {
    const deleted = deferred();
    api.deleteNote.mockReturnValueOnce(deleted.promise);
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/brain/notes?vault=a', '/brain/notes?vault=b&note=first.md']} initialIndex={1}>
          <NotesTab />
          <Location />
          <HistoryControls />
        </MemoryRouter>,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    expect(api.deleteNote).toHaveBeenCalledWith('b', 'first.md', { silent: true });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Browser back' })); });
    expect(screen.getByRole('combobox', { name: 'Vault' })).toHaveValue('a');
    expect(screen.getByText('first')).toBeInTheDocument();
    await act(async () => { deleted.resolve(); });
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(mockToast.success).not.toHaveBeenCalledWith('Note deleted');
  });

  it('does not start follow-up work when the initial vault request finishes after unmount', async () => {
    const vaults = deferred();
    api.getNotesVaults.mockReturnValueOnce(vaults.promise);
    const view = render(<MemoryRouter><NotesTab /></MemoryRouter>);
    view.unmount();
    await act(async () => { vaults.resolve([]); });
    expect(api.detectNotesVaults).not.toHaveBeenCalled();
    expect(api.scanNotesVault).not.toHaveBeenCalled();
  });
});

describe('NotesTab URL state and unavailable reads', () => {
  const note = {
    path: 'Projects/first.md',
    name: 'first',
    folder: 'Projects',
    size: 12,
    tags: [],
    modifiedAt: '2026-09-11T00:00:00Z',
    content: 'body',
    body: 'body',
    backlinks: []
  };
  const vaults = [{ id: 'vault-1', name: 'Example Vault', path: '/example/vault' }];

  beforeEach(() => {
    vi.resetAllMocks();
    api.getNotesVaults.mockResolvedValue(vaults);
    api.detectNotesVaults.mockResolvedValue([]);
    api.scanNotesVault.mockResolvedValue({ notes: [note], total: 1 });
    api.getNotesVaultFolders.mockResolvedValue({ folders: [] });
    api.getNotesVaultTags.mockResolvedValue({ tags: [] });
    api.getNote.mockResolvedValue(note);
    api.searchNotes.mockResolvedValue({ results: [note], total: 1 });
  });

  it('restores vault, folder, search, and note context from an encoded deep link, then returns to the list', async () => {
    await renderTab('/brain/notes?vault=vault-1&folder=Projects%2F2026&q=design%20notes&note=Projects%2Ffirst.md');

    expect(await screen.findByRole('heading', { name: 'first' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Vault' })).toHaveValue('vault-1');
    expect(screen.getByRole('textbox', { name: 'Search notes' })).toHaveValue('design notes');

    const params = new URLSearchParams(screen.getByTestId('location').textContent);
    expect(params.get('vault')).toBe('vault-1');
    expect(params.get('folder')).toBe('Projects/2026');
    expect(params.get('q')).toBe('design notes');
    expect(params.get('note')).toBe('Projects/first.md');
    expect(api.scanNotesVault).toHaveBeenCalledWith('vault-1', { folder: 'Projects/2026', limit: 500, silent: true });
    expect(api.searchNotes).toHaveBeenCalledWith('vault-1', 'design notes', undefined, { silent: true });
    expect(api.getNote).toHaveBeenCalledWith('vault-1', 'Projects/first.md', { silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const afterBack = new URLSearchParams(screen.getByTestId('location').textContent);
    expect(afterBack.get('note')).toBeNull();
    expect(afterBack.get('vault')).toBe('vault-1');
    expect(screen.queryByRole('heading', { name: 'first' })).toBeNull();
  });

  it('writes folder, search, and note selection changes into the URL', async () => {
    api.scanNotesVault.mockResolvedValueOnce({
      notes: [note, ...Array.from({ length: 20 }, (_, index) => ({ ...note, path: `Projects/extra-${index}.md`, name: `extra-${index}` }))],
      total: 21,
    });
    await renderTab();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Projects 21' })); });
    await screen.findByRole('button', { name: 'Show all 21 notes...' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show all 21 notes...' })); });
    expect(new URLSearchParams(screen.getByTestId('location').textContent).get('folder')).toBe('Projects');
    expect(await screen.findAllByText('first')).toHaveLength(1);

    await act(async () => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Search notes' }), { target: { value: 'needle' } });
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search notes' }), { key: 'Enter' });
    });
    expect(new URLSearchParams(screen.getByTestId('location').textContent).get('q')).toBe('needle');

    await act(async () => { fireEvent.click((await screen.findAllByText('first'))[0]); });
    expect(new URLSearchParams(screen.getByTestId('location').textContent).get('note')).toBe('Projects/first.md');
  });

  it('replays note selection through browser back and forward', async () => {
    const rootNote = { ...note, path: 'first.md', folder: '' };
    api.scanNotesVault.mockResolvedValueOnce({ notes: [rootNote], total: 1 });
    api.getNote.mockResolvedValue(rootNote);
    await renderTab();

    await act(async () => { fireEvent.click(screen.getByText('first')); });
    expect(new URLSearchParams(screen.getByTestId('location').textContent).get('note')).toBe('first.md');
    expect(await screen.findByRole('heading', { name: 'first' })).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Browser back' })); });
    expect(new URLSearchParams(screen.getByTestId('location').textContent).get('note')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'first' })).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Browser forward' })); });
    expect(await screen.findByRole('heading', { name: 'first' })).toBeInTheDocument();
  });

  it('keeps vault failure distinct from an empty vault and retries it', async () => {
    api.getNotesVaults.mockRejectedValueOnce(new Error('temporary outage'));
    await renderTab();

    expect(await screen.findByText('Notes vaults are unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No notes yet/)).toBeNull();

    api.getNotesVaults.mockResolvedValueOnce(vaults);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByRole('combobox', { name: 'Vault' })).toHaveValue('vault-1');
  });

  it('keeps the selected vault when retrying a failed vault list', async () => {
    api.getNotesVaults.mockRejectedValueOnce(new Error('temporary outage'));
    await renderTab('/brain/notes?vault=vault-2');

    expect(await screen.findByText('Notes vaults are unavailable')).toBeInTheDocument();

    api.getNotesVaults.mockResolvedValueOnce([
      ...vaults,
      { id: 'vault-2', name: 'Second Vault', path: '/second/vault' },
    ]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });

    expect(await screen.findByRole('combobox', { name: 'Vault' })).toHaveValue('vault-2');
    expect(new URLSearchParams(screen.getByTestId('location').textContent).get('vault')).toBe('vault-2');
  });

  it('clears the previous vault list before loading a newly added vault', async () => {
    const oldNote = { ...note, path: 'old.md', name: 'old', folder: '' };
    api.scanNotesVault.mockResolvedValueOnce({ notes: [oldNote], total: 1 });
    await renderTab('/brain/notes?vault=vault-1');
    expect(await screen.findByText('old')).toBeInTheDocument();

    let resolveScan;
    const newScan = new Promise(resolve => { resolveScan = resolve; });
    api.scanNotesVault.mockReturnValue(newScan);
    api.addNotesVault.mockResolvedValueOnce({ id: 'vault-2', name: 'Second Vault' });
    api.getNotesVaults.mockResolvedValueOnce([
      ...vaults,
      { id: 'vault-2', name: 'Second Vault', path: '/second/vault' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Manage vaults' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom vault path' }), {
      target: { value: '/second/vault' },
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });

    expect(screen.getByRole('combobox', { name: 'Vault' })).toHaveValue('vault-2');
    expect(screen.queryByText('old')).toBeNull();
    resolveScan({ notes: [], total: 0 });
  });

  it('keeps scan failure distinct from an empty list and retries the failed region', async () => {
    api.scanNotesVault.mockRejectedValueOnce(new Error('temporary outage'));
    await renderTab();

    expect(await screen.findByText('Notes are unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No notes yet/)).toBeNull();

    api.scanNotesVault.mockResolvedValueOnce({ notes: [], total: 0 });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByText(/No notes yet/)).toBeInTheDocument();
    expect(screen.queryByText('Notes are unavailable')).toBeNull();
  });

  it('does not render the previous folder when the next folder scan fails', async () => {
    const project = { ...note, path: 'Projects/project.md', name: 'project', folder: 'Projects' };
    const otherNotes = Array.from({ length: 21 }, (_, index) => ({
      ...note,
      path: `Other/other-${index}.md`,
      name: `other-${index}`,
      folder: 'Other',
    }));
    api.scanNotesVault.mockResolvedValueOnce({ notes: [project, ...otherNotes], total: 22 });
    await renderTab();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Other 21' })); });
    await screen.findByRole('button', { name: 'Show all 21 notes...' });
    api.scanNotesVault.mockRejectedValueOnce(new Error('temporary outage'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show all 21 notes...' })); });

    expect(await screen.findByText('Notes are unavailable')).toBeInTheDocument();
    expect(screen.queryByText('project')).toBeNull();
  });

  it('surfaces vault-add, note-create, and note-delete failures without false success', async () => {
    const rootNote = { ...note, path: 'first.md', name: 'first', folder: '' };
    api.scanNotesVault.mockResolvedValueOnce({ notes: [rootNote], total: 1 });
    api.addNotesVault.mockRejectedValueOnce(new Error('vault unavailable'));
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Manage vaults' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom vault path' }), { target: { value: '/new/vault' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });
    expect(mockToast.error).toHaveBeenCalledWith('vault unavailable');

    api.createNote.mockRejectedValueOnce(new Error('note unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'New note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New note path' }), { target: { value: 'new.md' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
    expect(mockToast.error).toHaveBeenCalledWith('note unavailable');

    api.getNote.mockResolvedValueOnce(rootNote);
    api.deleteNote.mockRejectedValueOnce(new Error('delete unavailable'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })); });
    await act(async () => { fireEvent.click(screen.getByText('first')); });
    await screen.findByRole('heading', { name: 'first' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true })); });
    expect(mockToast.error).toHaveBeenCalledWith('delete unavailable');
    expect(mockToast.success).not.toHaveBeenCalledWith('Note deleted');
    expect(screen.getByRole('heading', { name: 'first' })).toBeInTheDocument();
  });

  it('keeps tag-read failures visible through the normal API error feedback', async () => {
    api.getNotesVaultTags.mockRejectedValueOnce(new Error('tags unavailable'));
    await renderTab();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tags' })); });
    expect(api.getNotesVaultTags).toHaveBeenCalledWith('vault-1');
  });

  it('keeps a failed note deep link open for retry instead of showing blank content', async () => {
    api.getNote.mockRejectedValueOnce(new Error('temporary outage'));
    await renderTab('/brain/notes?vault=vault-1&note=Projects%2Ffirst.md&context=keep');

    expect(await screen.findByText('Note is unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Select a note to view')).toBeNull();
    expect(new URLSearchParams(screen.getByTestId('location').textContent).get('note')).toBe('Projects/first.md');

    api.getNote.mockResolvedValueOnce(note);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByRole('heading', { name: 'first' })).toBeInTheDocument();
  });

  it('lets a failed note deep link return to the mobile list without retrying', async () => {
    api.getNote.mockRejectedValueOnce(new Error('note no longer exists'));
    await renderTab('/brain/notes?vault=vault-1&note=Projects%2Ffirst.md&context=keep');
    expect(await screen.findByText('Note is unavailable')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }));
    expect(new URLSearchParams(screen.getByTestId('location').textContent).get('note')).toBeNull();
    expect(new URLSearchParams(screen.getByTestId('location').textContent).get('context')).toBe('keep');
    expect(screen.queryByText('Note is unavailable')).toBeNull();
    const listPanel = screen.getByRole('combobox', { name: 'Vault' }).closest('.border-r');
    expect(listPanel.className.split(/\s+/)).toContain('flex');
    expect(listPanel.className.split(/\s+/)).not.toContain('hidden');
    expect(api.getNote).toHaveBeenCalledTimes(1);
  });

  it('keeps search failure distinct from a successful no-match result and retries it', async () => {
    api.searchNotes.mockRejectedValueOnce(new Error('temporary outage'));
    await renderTab();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Projects 1' })); });
    await screen.findByText('first');

    await act(async () => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Search notes' }), { target: { value: 'needle' } });
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search notes' }), { key: 'Enter' });
    });
    expect(await screen.findByText('Search is unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No matches found')).toBeNull();

    api.searchNotes.mockResolvedValueOnce({ results: [], total: 0 });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByText('No matches found')).toBeInTheDocument();
    expect(screen.queryByText('Search is unavailable')).toBeNull();
  });
});
