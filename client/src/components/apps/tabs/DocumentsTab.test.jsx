import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DocumentsTab from './DocumentsTab';

vi.mock('../../../services/api', () => ({
  getAppDocuments: vi.fn(),
  getAppDocument: vi.fn(),
  saveAppDocument: vi.fn()
}));

import * as api from '../../../services/api';

// Assert on the requested path only — the third arg is the shared request()
// options bag ({ silent: true }), not part of this component's contract.
const requestedPaths = () => api.getAppDocument.mock.calls.map(([, filename]) => filename);

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
    api.getAppDocuments.mockResolvedValue(listing);
    api.getAppDocument.mockImplementation((_id, filename) =>
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
    api.getAppDocument.mockResolvedValue({ filename: 'ARCHITECTURE.md', content: '' });

    renderTab();

    expect(await screen.findByText('This document is empty.')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load document')).not.toBeInTheDocument();
  });

  it('still offers to create a conventional document the repo is missing', async () => {
    renderTab();

    expect(await screen.findByRole('button', { name: /AGENTS\.md/ })).toBeInTheDocument();
  });

  it('shows the empty state only when the root and docs/ are both empty', async () => {
    api.getAppDocuments.mockResolvedValue({ documents: [], docs: [], hasPlanning: false });

    renderTab();

    expect(await screen.findByText('No documents found')).toBeInTheDocument();
    expect(api.getAppDocument).not.toHaveBeenCalled();
  });

  it('reports a failed listing instead of claiming the repo has no documents', async () => {
    api.getAppDocuments.mockRejectedValue(new Error('boom'));

    renderTab();

    expect(await screen.findByText(/Could not load the document list/)).toBeInTheDocument();
    expect(screen.queryByText('No documents found')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
