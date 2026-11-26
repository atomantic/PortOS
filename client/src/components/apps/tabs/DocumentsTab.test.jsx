import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DocumentsTab from './DocumentsTab';

vi.mock('../../../services/apiApps.js', () => ({
  getAppDocuments: vi.fn(),
  getAppDocument: vi.fn(),
  saveAppDocument: vi.fn(),
}));

import { getAppDocument, getAppDocuments, saveAppDocument } from '../../../services/apiApps.js';

// Assert on the requested path only — the third arg is the shared request()
// options bag ({ silent: true }), not part of this component's contract.
const requestedPaths = () => getAppDocument.mock.calls.map(([, filename]) => filename);

const listing = {
  documents: [
    { filename: 'ARCHITECTURE.md', exists: true },
    { filename: 'README.md', exists: true },
    { filename: 'AGENTS.md', exists: false }
  ],
  docs: ['docs/API.md', 'docs/decisions/2026-01-01-choice.md'],
  hasPlanning: false
};

const renderTab = (initialPath = '/apps/app-1/documents') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <DocumentsTab appId="app-1" repoPath="/repo/example" />
    </MemoryRouter>
  );

describe('DocumentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAppDocuments.mockResolvedValue(listing);
    getAppDocument.mockImplementation((_id, filename) =>
      Promise.resolve({ filename, content: `# ${filename}` }));
  });

  it('lists every root markdown file, not just the conventional four', async () => {
    renderTab();

    expect(await screen.findByRole('button', { name: /ARCHITECTURE\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /README\.md/ })).toBeInTheDocument();
    // Auto-selects the first existing root document
    await waitFor(() => expect(requestedPaths()).toContain('ARCHITECTURE.md'));
  });

  it('groups the docs/ tree by directory and opens a nested file by its full path', async () => {
    renderTab();

    expect(await screen.findByText('docs/')).toBeInTheDocument();
    expect(screen.getByText('docs/decisions/')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /2026-01-01-choice\.md/ }));

    await waitFor(() => expect(requestedPaths()).toContain('docs/decisions/2026-01-01-choice.md'));
  });

  it('opens the document named by the URL instead of auto-selecting', async () => {
    renderTab('/apps/app-1/documents?doc=docs%2FAPI.md');

    await waitFor(() => expect(requestedPaths()).toEqual(['docs/API.md']));
  });

  it('renders an empty document as empty, not as a load failure', async () => {
    getAppDocument.mockResolvedValue({ filename: 'ARCHITECTURE.md', content: '' });

    renderTab();

    expect(await screen.findByText('This document is empty.')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load document')).not.toBeInTheDocument();
  });

  it('retries a failed document load and recovers the same document', async () => {
    getAppDocument
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ filename: 'ARCHITECTURE.md', content: '# Recovered' });

    renderTab('/apps/app-1/documents?doc=ARCHITECTURE.md');

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Recovered' })).toBeInTheDocument();
    expect(requestedPaths()).toEqual(['ARCHITECTURE.md', 'ARCHITECTURE.md']);
  });

  it('still offers to create a conventional document the repo is missing', async () => {
    renderTab();

    expect(await screen.findByRole('button', { name: /AGENTS\.md/ })).toBeInTheDocument();
  });

  it('shows the empty state only when the root and docs/ are both empty', async () => {
    getAppDocuments.mockResolvedValue({ documents: [], docs: [], hasPlanning: false });

    renderTab();

    expect(await screen.findByText('No documents found')).toBeInTheDocument();
    expect(getAppDocument).not.toHaveBeenCalled();
  });

  it('reports a failed listing instead of claiming the repo has no documents', async () => {
    getAppDocuments.mockRejectedValue(new Error('boom'));

    renderTab();

    expect(await screen.findByText(/Could not load the document list/)).toBeInTheDocument();
    expect(screen.queryByText('No documents found')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('asks before another document drops unsaved edits', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('textbox', { name: 'Document content' });
    fireEvent.change(editor, { target: { value: 'typed text' } });

    fireEvent.click(screen.getByRole('button', { name: /README\.md/ }));
    expect(editor).toHaveValue('typed text');
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(requestedPaths()).not.toContain('README.md');

    fireEvent.click(screen.getByRole('button', { name: /README\.md/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('heading', { name: 'README.md' })).toBeInTheDocument();
  });

  it('confirms dirty Cancel and exits immediately when the editor is clean', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Document content' }), { target: { value: 'typed text' } });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Document content' })).toHaveValue('typed text');

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('returns to the open document when creating another is cancelled', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Edit' });
    fireEvent.click(await screen.findByRole('button', { name: /AGENTS\.md/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('keeps a slow save out of the document opened meanwhile', async () => {
    let finish;
    saveAppDocument.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Document content' }), { target: { value: '# Saved text' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & Commit/ }));
    fireEvent.click(screen.getByRole('button', { name: /README\.md/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByRole('heading', { name: 'README.md' });

    await act(async () => { finish({ hash: 'abc1234' }); });
    expect(screen.getByRole('heading', { name: 'README.md' })).toBeInTheDocument();
    expect(screen.queryByText('Saved text')).not.toBeInTheDocument();
  });
});
