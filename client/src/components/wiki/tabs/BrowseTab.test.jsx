import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import BrowseTab from './BrowseTab';
import { getNote, updateNote } from '../../../services/apiNotes.js';

vi.mock('../../../services/apiNotes.js');

const sampleNote = {
  path: 'wiki/sources/example.md',
  name: 'Example Source',
  folder: 'wiki/sources',
  content: '# Example Source\n\nBody text.',
  body: 'Body text.',
  size: 42,
  modifiedAt: new Date().toISOString(),
  frontmatter: {},
  tags: [],
  wikilinks: [],
  backlinks: [],
};

const notes = [
  { path: 'wiki/sources/example.md', name: 'Example Source', folder: 'wiki/sources' },
];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderTab(initialEntries = ['/wiki/browse']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <BrowseTab vaultId="v1" notes={notes} rawNotes={[]} allNotes={notes} onRefresh={() => {}} />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe('BrowseTab responsive list/detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNote.mockResolvedValue(sampleNote);
  });

  it('uses a responsive grid parent instead of a fixed calc() height', () => {
    const { container } = renderTab();
    const root = container.firstChild;
    expect(root.className).toContain('grid-cols-1');
    expect(root.className).toContain('md:grid-cols-[320px_1fr]');
    expect(root.className).toContain('min-h-0');
    // No magic viewport-offset height anymore.
    expect(container.innerHTML).not.toContain('calc(100dvh');
  });

  it('shows the empty detail placeholder before a note is selected', () => {
    renderTab();
    expect(screen.getByText('Select a page to view')).toBeInTheDocument();
  });

  it('selecting a note loads it and exposes a mobile back control that clears selection', async () => {
    renderTab();
    fireEvent.click(screen.getByText('Example Source'));
    await waitFor(() => expect(getNote).toHaveBeenCalledWith('v1', 'wiki/sources/example.md', { silent: true }));

    const back = await screen.findByLabelText('Back to list');
    // Back control is mobile-only (hidden from md+).
    expect(back.className).toContain('md:hidden');

    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Example Source' })).toBeNull());
    expect(screen.getByTestId('location')).toHaveTextContent('/wiki/browse');
  });

  it('opens a note from the URL and removes the note param when closed', async () => {
    renderTab(['/wiki/browse?vault=v1&note=wiki%2Fsources%2Fexample.md']);

    await waitFor(() => expect(getNote).toHaveBeenCalledWith('v1', 'wiki/sources/example.md', { silent: true }));
    expect(await screen.findByRole('heading', { name: 'Example Source' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/wiki/browse?vault=v1'));
  });

  it('keeps a failed read selected and retries it without calling the page missing', async () => {
    getNote.mockRejectedValueOnce(new Error('temporary vault failure'));
    renderTab(['/wiki/browse?vault=v1&note=wiki%2Fsources%2Fexample.md']);

    expect(await screen.findByText('Note is unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Page unavailable in this vault')).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent('note=wiki%2Fsources%2Fexample.md');

    getNote.mockResolvedValueOnce(sampleNote);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Example Source' })).toBeInTheDocument();
    expect(getNote).toHaveBeenCalledTimes(2);
  });
});

/**
 * The iCloud force-save escape hatch — #3717. Mirrored from NotesTab: the same
 * lockout is reachable from the wiki editor, so the same way out has to be wired
 * here, and it must stay shut until the same page has been refused twice.
 */
describe('BrowseTab iCloud force save', () => {
  // Only a refusal the server flags as `stalled` (retrying cannot help) may arm
  // the override; a transient one must not.
  const evicted = ({ stalled = true } = {}) =>
    Object.assign(new Error('evicted'), { code: 'NOTE_EVICTED', context: { stalled } });

  beforeEach(() => {
    vi.clearAllMocks();
    getNote.mockResolvedValue(sampleNote);
  });

  const openEditor = async () => {
    renderTab();
    fireEvent.click(screen.getByText('Example Source'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    // Clicking Edit swaps the button row for the Save/Cancel pair — under
    // full-suite contention that re-render doesn't always land before the
    // next synchronous query runs, so wait for it here rather than assuming
    // it's already mounted at every clickSave() call site (#6051).
    await screen.findByRole('button', { name: /Save/ });
  };

  const clickSave = async () => {
    const before = updateNote.mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: /Save/ }));
    await waitFor(() => expect(updateNote.mock.calls.length).toBe(before + 1));
  };

  it('arms "Save anyway" only on the second refusal, and only it forces', async () => {
    updateNote.mockRejectedValue(evicted());
    await openEditor();

    await clickSave();
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();

    await clickSave();
    const forceAnyway = await screen.findByRole('button', { name: 'Save anyway' });
    // An ordinary save must never carry `force` — that would make the override
    // the retry default and re-admit the blocking write with no user decision.
    for (const call of updateNote.mock.calls) {
      expect(call[3]).toEqual({ force: false });
    }

    updateNote.mockResolvedValue(sampleNote);
    fireEvent.click(forceAnyway);
    await waitFor(() => expect(updateNote).toHaveBeenLastCalledWith(
      'v1', 'wiki/sources/example.md', sampleNote.content, { force: true }
    ));
  });

  it('hides the override once the user leaves edit mode', async () => {
    updateNote.mockRejectedValue(evicted());
    await openEditor();

    await clickSave();
    await clickSave();
    expect(await screen.findByRole('button', { name: 'Save anyway' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull());
  });

  it('does not arm on an unrelated save failure', async () => {
    updateNote.mockRejectedValue(Object.assign(new Error('nope'), { code: 'INVALID_PATH' }));
    await openEditor();

    await clickSave();
    await clickSave();

    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });

  it('does not arm while a download is genuinely in flight', async () => {
    updateNote.mockRejectedValue(evicted({ stalled: false }));
    await openEditor();

    await clickSave();
    await clickSave();

    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });
});

describe('BrowseTab save lifetimes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNote.mockResolvedValue(sampleNote);
  });

  const openEditor = async () => {
    renderTab();
    fireEvent.click(screen.getByText('Example Source'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    return screen.findByRole('textbox', { name: 'Note content' });
  };

  it('keeps text typed during a deferred save visible and unsaved, and the next save sends it', async () => {
    let resolveSave;
    updateNote.mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve; }));
    const editor = await openEditor();
    fireEvent.change(editor, { target: { value: 'Submitted body' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    fireEvent.change(editor, { target: { value: 'Later unsaved body' } });
    await act(async () => { resolveSave({ ...sampleNote, content: 'Submitted body' }); });
    expect(screen.getByRole('textbox', { name: 'Note content' })).toHaveValue('Later unsaved body');
    updateNote.mockResolvedValueOnce({ ...sampleNote, content: 'Later unsaved body' });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(updateNote).toHaveBeenLastCalledWith(
      'v1', 'wiki/sources/example.md', 'Later unsaved body', { force: false },
    ));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Note content' })).toBeNull());
  });

  it('closes the editor when the buffer is unchanged during the save', async () => {
    updateNote.mockResolvedValueOnce({ ...sampleNote, content: 'Submitted body' });
    const editor = await openEditor();
    fireEvent.change(editor, { target: { value: 'Submitted body' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Note content' })).toBeNull());
  });
});
