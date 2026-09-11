import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getGsdDocument: vi.fn(),
  saveGsdDocument: vi.fn(),
}));

vi.mock('../../services/api', () => api);

import GsdDocumentsPanel from './GsdDocumentsPanel';

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

const renderPanel = (selectedDoc = 'PROJECT.md') => render(
  <GsdDocumentsPanel
    appId="example-app"
    selectedDoc={selectedDoc}
    onSelectDoc={vi.fn()}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GsdDocumentsPanel document loading', () => {
  it('discards stale responses and loading state after switching documents', async () => {
    let resolveProject;
    let resolveRoadmap;
    api.getGsdDocument.mockImplementation((_appId, document) => (
      document === 'PROJECT.md'
        ? new Promise(resolve => { resolveProject = resolve; })
        : new Promise(resolve => { resolveRoadmap = resolve; })
    ));

    const { rerender } = renderPanel();
    await waitFor(() => expect(api.getGsdDocument).toHaveBeenCalledWith('example-app', 'PROJECT.md'));

    rerender(
      <GsdDocumentsPanel
        appId="example-app"
        selectedDoc="ROADMAP.md"
        onSelectDoc={vi.fn()}
      />
    );
    await waitFor(() => expect(api.getGsdDocument).toHaveBeenCalledWith('example-app', 'ROADMAP.md'));

    await act(async () => {
      resolveProject({ content: 'Project body' });
      await flushMicrotasks();
    });
    expect(screen.getByText('Loading document')).toBeInTheDocument();
    expect(screen.queryByText('Project body')).not.toBeInTheDocument();

    await act(async () => {
      resolveRoadmap({ content: 'Roadmap body' });
      await flushMicrotasks();
    });
    expect(screen.getByText('Roadmap body')).toBeInTheDocument();
    expect(screen.queryByText('Project body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByRole('textbox', { name: 'Document content' })).toHaveValue('Roadmap body');
  });

  it('ignores an in-flight response after unmount', async () => {
    let resolveDocument;
    api.getGsdDocument.mockReturnValue(new Promise(resolve => { resolveDocument = resolve; }));

    const { unmount } = renderPanel();
    await waitFor(() => expect(api.getGsdDocument).toHaveBeenCalled());
    unmount();

    await act(async () => {
      resolveDocument({ content: 'Unmounted body' });
      await flushMicrotasks();
    });
  });
});
