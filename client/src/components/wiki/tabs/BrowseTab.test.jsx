import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
