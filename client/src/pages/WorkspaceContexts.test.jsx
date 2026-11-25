import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/apiWorkspaceContexts.js', () => ({
  listWorkspaceContexts: vi.fn(),
  getWorkspaceContext: vi.fn(),
  saveWorkspaceContext: vi.fn(),
  restoreWorkspaceContext: vi.fn(),
  deleteWorkspaceContext: vi.fn(),
}));
vi.mock('../components/ui/Toast');

import WorkspaceContexts from './WorkspaceContexts';
import { listWorkspaceContexts } from '../services/apiWorkspaceContexts.js';

const renderPage = async () => {
  render(<MemoryRouter initialEntries={['/workspace-contexts']}><WorkspaceContexts /></MemoryRouter>);
  await act(async () => {});
};

describe('WorkspaceContexts list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the empty copy only for a successful empty read', async () => {
    listWorkspaceContexts.mockResolvedValue({ contexts: [] });
    await renderPage();
    expect(await screen.findByText(/No active projects/)).toBeInTheDocument();
  });

  it('shows a Retry instead of the empty copy on a failed read, and recovers on Retry', async () => {
    listWorkspaceContexts.mockRejectedValueOnce(new Error('503 down')).mockResolvedValue({
      contexts: [{ appId: 'app-1', appName: 'Example App', saved: null }],
    });
    await renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load workspace projects');
    expect(screen.queryByText(/No active projects/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example App')).toBeInTheDocument();
  });
});
