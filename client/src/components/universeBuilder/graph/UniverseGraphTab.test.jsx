import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({ getUniverseGraph: vi.fn() }));
vi.mock('../../../services/api', () => apiMocks);

const { default: UniverseGraphTab } = await import('./UniverseGraphTab');

const GRAPH = {
  universeId: 'u1',
  name: 'Example Universe',
  totalIssues: 2,
  series: [{ id: 'series:s1', recordId: 's1', name: 'First Arc' }],
  issues: [
    { id: 'issue:i1', recordId: 'i1', index: 0, name: 'First Arc #1', seriesId: 'series:s1' },
    { id: 'issue:i2', recordId: 'i2', index: 1, name: 'First Arc #2', seriesId: 'series:s1' },
  ],
  appear: { 'character:c1': [0, 1], 'character:c2': [1] },
  nodes: [
    {
      id: 'character:c1',
      kind: 'character',
      name: 'Alice Vane',
      role: 'Tidewarden',
      hasImage: true,
      locked: true,
      firstIssue: 0,
      arcType: 'positive',
      sliders: { proactivity: 7 },
      framework: { ghost: 'Lost the key.' },
      evolution: null,
    },
    { id: 'character:c2', kind: 'character', name: 'Bob Ashe', role: 'Foil', hasImage: false, firstIssue: 1 },
    { id: 'place:p1', kind: 'place', name: 'The Vault', role: 'INT. VAULT', hasImage: true, firstIssue: 0 },
    { id: 'series:s1', kind: 'series', name: 'First Arc', role: '2 issues', hasImage: false, firstIssue: 0 },
    { id: 'issue:i1', kind: 'issue', name: 'First Arc #1', role: 'Issue 1', hasImage: false, firstIssue: 0 },
    { id: 'issue:i2', kind: 'issue', name: 'First Arc #2', role: 'Issue 2', hasImage: false, firstIssue: 1 },
  ],
  edges: [
    { source: 'character:c1', target: 'character:c2', type: 'rival', directed: true, since: 1 },
    { source: 'character:c1', target: 'issue:i1', type: 'appearance', since: 0 },
    { source: 'issue:i1', target: 'series:s1', type: 'membership', since: 0 },
  ],
};

let lastSearch = '';
const SearchProbe = () => { lastSearch = useLocation().search; return null; };

const renderTab = async (props = {}, initialEntry = '/universes/u1?tab=graph') => {
  const view = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/universes/:universeId"
          element={<><UniverseGraphTab universeId="u1" universeName="Example Universe" {...props} /><SearchProbe /></>}
        />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  return view;
};

beforeEach(() => {
  lastSearch = '';
  apiMocks.getUniverseGraph.mockReset();
  apiMocks.getUniverseGraph.mockResolvedValue(GRAPH);
});

describe('UniverseGraphTab', () => {
  it('shows the overview with derived counts once the graph loads', async () => {
    await renderTab();
    expect(await screen.findByText('Example Universe')).toBeTruthy();
    // Scoped to the inspector: the toolbar's kind filters carry the same labels.
    const inspector = within(screen.getByLabelText('Graph inspector'));
    expect(inspector.getByText('Most connected')).toBeTruthy();
    // 2 characters, 1 place + 0 objects.
    expect(inspector.getByText('Characters').previousSibling.textContent).toBe('2');
    expect(inspector.getByText('Places · Objects').previousSibling.textContent).toBe('1 · 0');
  });

  it('owns its own error state instead of letting the shared toast report it', async () => {
    apiMocks.getUniverseGraph.mockRejectedValue(new Error('graph exploded'));
    await renderTab();
    expect(await screen.findByText('graph exploded')).toBeTruthy();
    expect(apiMocks.getUniverseGraph).toHaveBeenCalledWith('u1', { silent: true });
  });

  it('asks the user to save before graphing an unsaved universe', async () => {
    await renderTab({ universeId: null });
    expect(screen.getByText(/Save this universe/)).toBeTruthy();
    expect(apiMocks.getUniverseGraph).not.toHaveBeenCalled();
  });

  it('points an empty universe at the canon tabs rather than drawing nothing', async () => {
    apiMocks.getUniverseGraph.mockResolvedValue({ ...GRAPH, nodes: [], edges: [], appear: {} });
    await renderTab();
    expect(await screen.findByText(/Nothing to graph yet/)).toBeTruthy();
  });

  it('writes the selected node into the URL and renders its dossier', async () => {
    await renderTab();
    fireEvent.click(await screen.findByText('Alice Vane'));
    await waitFor(() => expect(lastSearch).toContain('node=character%3Ac1'));
    expect(screen.getByText('Tidewarden')).toBeTruthy();
    expect(screen.getByText('Character framework')).toBeTruthy();
    expect(screen.getByText('No evolution lens authored yet.')).toBeTruthy();
  });

  it('restores the selection from the URL on load', async () => {
    await renderTab({}, '/universes/u1?tab=graph&node=place%3Ap1');
    expect(await screen.findByText('INT. VAULT')).toBeTruthy();
  });

  it('drops a ?node= that points at a record the graph no longer has', async () => {
    await renderTab({}, '/universes/u1?tab=graph&node=character%3Agone');
    await waitFor(() => expect(lastSearch).not.toContain('node='));
    expect(screen.getByText('Most connected')).toBeTruthy();
  });

  it('lists the derived gaps behind the Gaps toggle', async () => {
    await renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Gaps/ }));
    expect(screen.getByText('Gaps & enrichment')).toBeTruthy();
    // Bob has no render, and the c1 → c2 rival link has no reverse.
    expect(screen.getByText('Bob Ashe has no render')).toBeTruthy();
    expect(screen.getByText('Alice Vane → Bob Ashe is one-directional')).toBeTruthy();
  });

  it('narrows the gap list to one category', async () => {
    await renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Gaps/ }));
    fireEvent.click(screen.getByRole('button', { name: /No render/ }));
    expect(screen.getByText('Bob Ashe has no render')).toBeTruthy();
    expect(screen.queryByText('Alice Vane → Bob Ashe is one-directional')).toBeNull();
  });

  it('scrubs the timeline to a single issue and back to the whole universe', async () => {
    await renderTab();
    const slider = await screen.findByLabelText('Timeline position');
    fireEvent.change(slider, { target: { value: '0' } });
    expect(slider.value).toBe('0');
    expect(screen.getAllByText('First Arc #1').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Whole universe' }));
    // The far right of the track is "no scope", not the last issue.
    expect(slider.value).toBe(String(GRAPH.totalIssues));
  });

  it('hides a kind from the canvas stats when its filter is switched off', async () => {
    await renderTab();
    expect(await screen.findByText(/^6 nodes/)).toBeTruthy();
    fireEvent.click(screen.getByTitle('Hide Issues'));
    expect(screen.getByText(/^4 nodes/)).toBeTruthy();
  });
});
