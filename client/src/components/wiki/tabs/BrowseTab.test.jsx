import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import BrowseTab from './BrowseTab';
import * as api from '../../../services/api';

vi.mock('../../../services/api');

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

function renderTab() {
  return render(
    <MemoryRouter>
      <BrowseTab vaultId="v1" notes={notes} rawNotes={[]} allNotes={notes} onRefresh={() => {}} />
    </MemoryRouter>
  );
}

describe('BrowseTab responsive list/detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getNote.mockResolvedValue(sampleNote);
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
    await waitFor(() => expect(api.getNote).toHaveBeenCalledWith('v1', 'wiki/sources/example.md'));

    const back = await screen.findByLabelText('Back to list');
    // Back control is mobile-only (hidden from md+).
    expect(back.className).toContain('md:hidden');

    fireEvent.click(back);
    await waitFor(() => expect(screen.getByText('Select a page to view')).toBeInTheDocument());
  });
});

/**
 * The iCloud force-save escape hatch — #3717. Mirrored from NotesTab: the same
 * lockout is reachable from the wiki editor, so the same way out has to be wired
 * here, and it must stay shut until the same page has been refused twice.
 */
describe('BrowseTab iCloud force save', () => {
  const evicted = () => Object.assign(new Error('evicted'), { code: 'NOTE_EVICTED' });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getNote.mockResolvedValue(sampleNote);
  });

  const openEditor = async () => {
    renderTab();
    fireEvent.click(screen.getByText('Example Source'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  };

  const clickSave = async () => {
    const before = api.updateNote.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.updateNote.mock.calls.length).toBe(before + 1));
  };

  it('arms "Save anyway" only on the second refusal, and only it forces', async () => {
    api.updateNote.mockRejectedValue(evicted());
    await openEditor();

    await clickSave();
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();

    await clickSave();
    const forceAnyway = await screen.findByRole('button', { name: 'Save anyway' });
    // An ordinary save must never carry `force` — that would make the override
    // the retry default and re-admit the blocking write with no user decision.
    for (const call of api.updateNote.mock.calls) {
      expect(call[3]).toEqual({ force: false });
    }

    api.updateNote.mockResolvedValue(sampleNote);
    fireEvent.click(forceAnyway);
    await waitFor(() => expect(api.updateNote).toHaveBeenLastCalledWith(
      'v1', 'wiki/sources/example.md', sampleNote.content, { force: true }
    ));
  });

  it('does not arm on an unrelated save failure', async () => {
    api.updateNote.mockRejectedValue(Object.assign(new Error('nope'), { code: 'INVALID_PATH' }));
    await openEditor();

    await clickSave();
    await clickSave();

    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });
});
