import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import Brain from '../../../pages/Brain';
import OnThisDayWidget from './OnThisDayWidget';

const api = vi.hoisted(() => ({
  getBrainSummary: vi.fn().mockResolvedValue({ counts: {} }),
  getBrainSettings: vi.fn().mockResolvedValue({}),
  getMemoryBackendStatus: vi.fn().mockResolvedValue({ backend: 'postgres' }),
  getBrainMemories: vi.fn(),
  getBrainMemory: vi.fn(),
  getBrainIdeas: vi.fn(),
  getBrainIdea: vi.fn(),
  updateBrainMemory: vi.fn(),
  updateBrainIdea: vi.fn(),
}));
vi.mock('../../../services/api', () => api);
vi.mock('../../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

const first = { id: 'example-first', title: 'Example first', content: '**First full text**', notes: '**First full text**' };
const second = { id: 'example-second', title: 'Example second', content: '**Second full text**', notes: '**Second full text**' };

function Navigation() {
  const navigate = useNavigate();
  return <>
    <output data-testid="location">{useLocation().pathname}</output>
    <button onClick={() => navigate(-1)}>Browser Back</button>
    <button onClick={() => navigate('/brain/memory/memories/example-first')}>Select first memory</button>
  </>;
}

function mount(type, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Navigation />
      <Routes>
        <Route path="/" element={<OnThisDayWidget dashboardState={{ brainOnThisDay: {
          total: 2, items: [first, second].map(record => ({ ...record, type, yearsAgo: 1 }))
        } }} />} />
        {/* Use the same base and detail route shapes as App, with real lazy Brain tabs. */}
        <Route path="/brain/:tab/:recordType/:recordId" element={<Brain />} />
        <Route path="/brain/:tab" element={<Brain />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  api.getBrainMemories.mockResolvedValue({ items: [first], total: 2, nextCursor: 'older-page' });
  api.getBrainIdeas.mockResolvedValue({ items: [first], total: 2, nextCursor: 'older-page' });
  api.getBrainMemory.mockResolvedValue(second);
  api.getBrainIdea.mockResolvedValue(second);
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('On This Day record destinations', () => {
  it.each([
    ['memory', '/brain/memory/memories/example-second', 'getBrainMemory'],
    ['idea', '/brain/ideas/ideas/example-second', 'getBrainIdea'],
  ])('opens the exact %s outside the visible page, preserves its URL on reload, and goes Back', async (type, path, getter) => {
    let resolveDetail;
    let resolvePage;
    const listGetter = type === 'memory' ? 'getBrainMemories' : 'getBrainIdeas';
    const page = { items: [first], total: 2, nextCursor: 'older-page' };
    api[listGetter].mockImplementation(() => new Promise(resolve => { resolvePage = resolve; }));
    api[getter].mockImplementationOnce(() => new Promise(resolve => { resolveDetail = resolve; })).mockResolvedValue(second);
    const view = mount(type);
    fireEvent.click(screen.getByRole('link', { name: /Example second/ }));
    expect(screen.getByTestId('location').textContent).toBe(path);
    expect(await screen.findByRole('complementary', { name: 'Loading entry' })).toBeTruthy();
    expect(screen.queryByText('Entry not found')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Preview: Example first' })).toBeNull();

    await act(async () => resolveDetail(second));
    const reader = await screen.findByRole('complementary', { name: 'Preview: Example second' });
    expect(within(reader).getByText('Second full text').tagName).toBe('STRONG');
    expect(api[getter]).toHaveBeenCalledWith(second.id, { silent: true });
    // The selected reader renders even while the collection page is still pending.
    await act(async () => resolvePage(page));
    api[listGetter].mockResolvedValue(page);

    // A fresh mount starts with only the URL, just as a reload does.
    view.unmount();
    api[getter].mockResolvedValue(second);
    const reloaded = mount(type, path);
    expect(await screen.findByRole('complementary', { name: 'Preview: Example second' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close entry reader' }));
    expect(screen.getByTestId('location').textContent).toBe(type === 'memory' ? '/brain/memory' : '/brain/ideas');
    expect(await screen.findByRole('button', { name: 'Read Example first' })).toBeTruthy();
    reloaded.unmount();

    mount(type);
    fireEvent.click(screen.getByRole('link', { name: /Example second/ }));
    await screen.findByRole('complementary', { name: 'Preview: Example second' });
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByTestId('location').textContent).toBe('/');
    expect(screen.getByRole('link', { name: /Example first/ })).toBeTruthy();
    // The other resurfaced record still selects its own existing reader.
    fireEvent.click(screen.getByRole('link', { name: /Example first/ }));
    expect(await screen.findByRole('complementary', { name: 'Preview: Example first' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByTestId('location').textContent).toBe('/');
  });

  it.each([
    ['memory', '/brain/memory/memories/example-deleted', 'getBrainMemory'],
    ['idea', '/brain/ideas/ideas/example-deleted', 'getBrainIdea'],
  ])('shows missing or unavailable %s without substituting the first list record', async (type, path, getter) => {
    if (type === 'memory') api[getter].mockResolvedValue(null);
    else api[getter].mockRejectedValue(new Error('Example unavailable'));
    mount(type, path);
    expect(await screen.findByText('Entry not found')).toBeTruthy();
    expect(screen.getByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Preview: Example first' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to entries' }));
    expect(await screen.findByRole('button', { name: 'Read Example first' })).toBeTruthy();
  });

  it.each([
    ['memory', '/brain/memory'],
    ['idea', '/brain/ideas'],
  ])('returns to the prior %s collection with browser Back', async (type, path) => {
    mount(type, path);
    fireEvent.click(await screen.findByRole('button', { name: 'Read Example first' }));
    expect(await screen.findByRole('complementary', { name: 'Preview: Example first' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByTestId('location').textContent).toBe(path);
    expect(await screen.findByRole('button', { name: 'Read Example first' })).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it.each([
    ['memory', '/brain/memory/memories/example-second', 'getBrainMemory', 'updateBrainMemory'],
    ['idea', '/brain/ideas/ideas/example-second', 'getBrainIdea', 'updateBrainIdea'],
    ['memory', '/brain/memory/memories/example-first', 'getBrainMemory', 'updateBrainMemory'],
  ])('edits the URL-selected %s in the reader pane and shows its saved content', async (type, path, getter, updater) => {
    const record = path.endsWith(first.id) ? first : second;
    const saved = { ...record, title: 'Example saved' };
    api[updater].mockImplementation(async () => {
      api[getter].mockResolvedValue(saved);
      return saved;
    });
    mount(type, path);
    const reader = await screen.findByRole('complementary', { name: `Preview: ${record.title}` });
    fireEvent.click(within(reader).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: saved.title } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByRole('complementary', { name: 'Preview: Example saved' })).toBeTruthy();
    expect(api[updater]).toHaveBeenCalledWith(record.id, expect.objectContaining({ title: saved.title }), { silent: true });
    expect(screen.getByTestId('location').textContent).toBe(path);
  });

  it.each([
    ['memory', '/brain/memory/memories/example-second', 'getBrainMemories', 'getBrainMemory'],
    ['idea', '/brain/ideas/ideas/example-second', 'getBrainIdeas', 'getBrainIdea'],
  ])('keeps the open %s editor when the collection page lands after the reader loaded', async (type, path, listGetter, getter) => {
    let resolvePage;
    // Any refetch after the first load hangs, so a reset to "Loading entry" stays observable.
    api[getter].mockReset().mockResolvedValueOnce(second).mockImplementation(() => new Promise(() => {}));
    api[listGetter].mockImplementation(() => new Promise(resolve => { resolvePage = resolve; }));
    mount(type, path);
    const reader = await screen.findByRole('complementary', { name: 'Preview: Example second' });
    fireEvent.click(within(reader).getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeTruthy();

    // The late list page must not reset the already-resolved detail back to loading.
    await act(async () => resolvePage({ items: [first], total: 2, nextCursor: 'older-page' }));
    expect(screen.queryByRole('complementary', { name: 'Loading entry' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeTruthy();
  });

  it('drops a superseded detail response when another URL selects a different record', async () => {
    let resolveDetail;
    api.getBrainMemory.mockImplementation(() => new Promise(resolve => { resolveDetail = resolve; }));
    mount('memory', '/brain/memory/memories/example-second');
    await screen.findByRole('complementary', { name: 'Loading entry' });
    fireEvent.click(screen.getByRole('button', { name: 'Select first memory' }));
    await screen.findByRole('complementary', { name: 'Preview: Example first' });
    await act(async () => resolveDetail(second));
    expect(screen.getByTestId('location').textContent).toBe('/brain/memory/memories/example-first');
    expect(screen.getByRole('complementary', { name: 'Preview: Example first' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Preview: Example second' })).toBeNull();
  });
});
