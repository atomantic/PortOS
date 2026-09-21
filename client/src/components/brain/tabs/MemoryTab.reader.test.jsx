import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import MemoryTab from './MemoryTab';

const api = vi.hoisted(() => ({
  getBrainMemories: vi.fn(), getMemoryBackendStatus: vi.fn().mockResolvedValue({ backend: 'postgres' }),
  getChatgptArchive: vi.fn(), deleteBrainMemory: vi.fn()
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

  it('renders preview in a sidebar aside area without popping a modal dialog', async () => {
    api.getBrainMemories.mockResolvedValue([
      { id: 'mem-1', title: 'First memory', content: 'First memory full content', mood: 'reflective' },
      { id: 'mem-2', title: 'Second memory', content: 'Second memory full content', mood: 'energetic' },
    ]);
    mount('/brain/memory');
    expect(await screen.findByText('First memory')).toBeTruthy();
    expect(screen.getByText('Second memory')).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    // Selecting from a scrolled list keeps that same independent scroll region.
    const entries = screen.getByRole('region', { name: 'Memory entries' });
    expect(entries.className).toContain('overflow-y-auto');
    entries.scrollTop = 800;

    // Click to read full entry
    fireEvent.click(screen.getByRole('button', { name: 'Read First memory' }));
    expect(screen.getByTestId('location').textContent).toBe('/brain/memory/memories/mem-1');

    // Sidebar aside preview appears, NO modal dialog
    const sidebar = await screen.findByRole('complementary', { name: 'Preview: First memory' });
    expect(sidebar).toBeTruthy();
    expect(sidebar.className).toContain('h-full');
    expect(screen.getByRole('region', { name: 'Memory entries' })).toBe(entries);
    expect(entries.scrollTop).toBe(800);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(sidebar).getByText('First memory full content')).toBeTruthy();
    expect(screen.getByText('Viewing')).toBeTruthy();

    // Switch selection to second memory directly
    fireEvent.click(screen.getByRole('button', { name: 'Read Second memory' }));
    expect(screen.getByTestId('location').textContent).toBe('/brain/memory/memories/mem-2');
    const secondSidebar = await screen.findByRole('complementary', { name: 'Preview: Second memory' });
    expect(secondSidebar).toBeTruthy();
    expect(within(secondSidebar).getByText('Second memory full content')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    // Close preview
    fireEvent.click(screen.getByRole('button', { name: 'Close entry reader' }));
    expect(screen.getByTestId('location').textContent).toBe('/brain/memory');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});


describe('Brain deletion preserves the list', () => {
  it('waits for success, collapses only the deleted row and keeps search and siblings mounted', async () => {
    let resolveDelete;
    api.deleteBrainMemory.mockImplementation(() => new Promise(resolve => { resolveDelete = resolve; }));
    api.getBrainMemories.mockResolvedValue([
      { id: 'example-a', title: 'Example first' }, { id: 'example-b', title: 'Example second' }
    ]);
    mount();
    const first = await screen.findByRole('button', { name: 'Read Example first' });
    const second = screen.getByRole('button', { name: 'Read Example second' });
    const region = screen.getByRole('region', { name: 'Memory entries' });
    const search = screen.getByRole('textbox', { name: /Search/ });
    fireEvent.change(search, { target: { value: 'Example' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete', exact: true })[0]);
    const confirm = screen.getByTitle('Confirm delete');
    confirm.focus();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(api.deleteBrainMemory).toHaveBeenCalledTimes(1);
    expect(first.isConnected).toBe(true);
    resolveDelete({});
    await waitFor(() => expect(first.closest('[inert]')).toBeTruthy());
    expect(second.isConnected).toBe(true);
    await waitFor(() => expect(first.isConnected).toBe(false));
    expect(document.activeElement.contains(second)).toBe(true);
    expect(screen.getByRole('region', { name: 'Memory entries' })).toBe(region);
    expect(screen.getByRole('button', { name: 'Read Example second' })).toBe(second);
    expect(search.value).toBe('Example');
    expect(api.getBrainMemories).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed deletion visible and allows retry with reduced motion', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    api.getBrainMemories.mockResolvedValue([{ id: 'example-a', title: 'Example first' }]);
    api.deleteBrainMemory.mockRejectedValueOnce(new Error('Example failure')).mockResolvedValueOnce({});
    mount();
    await screen.findByRole('button', { name: 'Read Example first' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    fireEvent.click(screen.getByTitle('Confirm delete'));
    await waitFor(() => expect(api.deleteBrainMemory).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Read Example first' }).closest('[inert]')).toBeNull();
    fireEvent.click(screen.getByTitle('Confirm delete'));
    await waitFor(() => expect(screen.getByText(/No memories yet/)).toBeTruthy());
    expect(api.getBrainMemories).toHaveBeenCalledTimes(1);
  });
});
