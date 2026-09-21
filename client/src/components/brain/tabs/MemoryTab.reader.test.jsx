import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import MemoryTab from './MemoryTab';

const api = vi.hoisted(() => ({
  getBrainMemories: vi.fn(), getMemoryBackendStatus: vi.fn().mockResolvedValue({ backend: 'postgres' }),
  getChatgptArchive: vi.fn()
}));
vi.mock('../../../services/api', () => api);
vi.mock('../../../services/apiBrain', () => api);
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function Location() { return <output data-testid="location">{useLocation().pathname}</output>; }
function mount(path = '/brain/memory') {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback; }
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  return render(<MemoryRouter initialEntries={[path]}><Location /><Routes>
    <Route path="/brain/:tab/:recordType?/:recordId?" element={<MemoryTab />} />
  </Routes></MemoryRouter>);
}

describe('Brain memory reader', () => {
  it('previews images, opens rendered handwritten content through a record URL, and closes', async () => {
    api.getBrainMemories.mockResolvedValue([{ id: 'note-1', title: 'Example note', content: '# Heading\n\n**Important**\n\n![Sketch](https://example.com/sketch.png)' }]);
    mount();
    expect(await screen.findByAltText('Sketch')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read Example note' }));
    expect(screen.getByTestId('location').textContent).toBe('/brain/memory/memories/note-1');
    expect(await screen.findByRole('heading', { name: 'Heading' })).toBeTruthy();
    expect(screen.getByText('Important').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: 'Close entry reader' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.getChatgptArchive).not.toHaveBeenCalled();
  });

  it('loads archive-only thumbnails and the complete transcript from a direct URL', async () => {
    api.getBrainMemories.mockResolvedValue([{ id: 'import-1', title: 'Example import', source: 'chatgpt-import', sourceRef: 'example.json', content: 'Short preview' }]);
    api.getChatgptArchive.mockImplementation((_ref, options) => Promise.resolve(options?.preview
      ? { images: [{ src: '/data/brain-imports/example.png', alt: 'Archive thumbnail' }] }
      : { transcript: '# Complete conversation\n\n![Full image](/data/brain-imports/example.png)' }));
    mount('/brain/memory/memories/import-1');
    expect(await screen.findByRole('heading', { name: 'Complete conversation' })).toBeTruthy();
    expect(await screen.findByAltText('Archive thumbnail')).toBeTruthy();
    expect(screen.getByAltText('Full image')).toBeTruthy();
  });

  it('renders saved markdown when an archive is unavailable and identifies stale record URLs', async () => {
    api.getBrainMemories.mockResolvedValue([{ id: 'import-1', title: 'Example import', source: 'chatgpt-import', sourceRef: 'missing.json', content: '**Saved preview**' }]);
    api.getChatgptArchive.mockRejectedValue(new Error('Not found'));
    const view = mount('/brain/memory/memories/import-1');
    await waitFor(() => expect(screen.getByText('Saved preview', { selector: 'strong' }).tagName).toBe('STRONG'));
    expect(screen.getByText(/Couldn't load the full transcript/)).toBeTruthy();
    view.unmount();
    mount('/brain/memory/memories/deleted');
    expect(await screen.findByText('Entry not found')).toBeTruthy();
  });
});
