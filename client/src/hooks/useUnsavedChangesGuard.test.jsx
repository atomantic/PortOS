import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import useUnsavedChangesGuard from './useUnsavedChangesGuard.js';

// Minimal editor standing in for a real page: a dirty flag it can clear, plus
// the caller-owned confirm the hook expects (never window.confirm).
function Editor({ options }) {
  const [dirty, setDirty] = useState(true);
  const { blocked, proceed, reset } = useUnsavedChangesGuard(dirty, options);
  return (
    <div>
      <span>editor</span>
      <button type="button" onClick={() => setDirty(false)}>save</button>
      {blocked && (
        <>
          <button type="button" onClick={() => { setDirty(false); proceed(); }}>discard</button>
          <button type="button" onClick={reset}>keep</button>
        </>
      )}
    </div>
  );
}

// router.navigate resolves asynchronously — settle it inside act() or the
// suite's strict act-warning guard fails the test (src/test/setup.js).
const navigate = (router, to) => act(async () => { await router.navigate(to); });

const renderEditor = ({ options, history = [] } = {}) => {
  const router = createMemoryRouter([
    { path: '/away', element: <div>away</div> },
    { path: '/edit', element: <Editor options={options} /> },
    { path: '/edit/deeper', element: <Editor options={options} /> },
  ], { initialEntries: [...history, '/edit'], initialIndex: history.length });
  render(<RouterProvider router={router} />);
  return router;
};

describe('useUnsavedChangesGuard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks a router navigation while the draft is dirty', async () => {
    const router = renderEditor();
    await navigate(router, '/away');
    expect(await screen.findByText('keep')).toBeTruthy();
    expect(screen.getByText('editor')).toBeTruthy();
    expect(screen.queryByText('away')).toBeNull();
  });

  it('runs the parked navigation on proceed', async () => {
    const router = renderEditor();
    await navigate(router, '/away');
    fireEvent.click(await screen.findByText('discard'));
    expect(await screen.findByText('away')).toBeTruthy();
  });

  it('drops the parked navigation on reset', async () => {
    const router = renderEditor();
    await navigate(router, '/away');
    fireEvent.click(await screen.findByText('keep'));
    await waitFor(() => expect(screen.queryByText('keep')).toBeNull());
    expect(screen.getByText('editor')).toBeTruthy();
    expect(screen.queryByText('away')).toBeNull();
  });

  it('blocks a POP navigation (browser Back)', async () => {
    const router = renderEditor({ history: ['/away'] });
    await navigate(router, -1);
    expect(await screen.findByText('keep')).toBeTruthy();
    expect(screen.queryByText('away')).toBeNull();
  });

  it('lets a navigation through once the draft goes clean', async () => {
    const router = renderEditor();
    fireEvent.click(screen.getByText('save'));
    await navigate(router, '/away');
    expect(await screen.findByText('away')).toBeTruthy();
  });

  it('auto-proceeds a parked navigation when the draft settles', async () => {
    const router = renderEditor();
    await navigate(router, '/away');
    expect(await screen.findByText('keep')).toBeTruthy();
    // Saving clears the dirty flag with the confirm still up — the navigation
    // the user asked for RUNS instead of being swallowed.
    fireEvent.click(screen.getByText('save'));
    expect(await screen.findByText('away')).toBeTruthy();
  });

  it('does not block a same-pathname navigation (search-param change)', async () => {
    const router = renderEditor();
    await navigate(router, '/edit?tab=notes');
    await waitFor(() => expect(router.state.location.search).toBe('?tab=notes'));
    expect(screen.queryByText('keep')).toBeNull();
  });

  it('blocks a navigation to a different pathname under the same page', async () => {
    const router = renderEditor();
    await navigate(router, '/edit/deeper');
    expect(await screen.findByText('keep')).toBeTruthy();
  });

  it('lets an in-editor move through when it stays under scopePath (splat route tab switch)', async () => {
    const router = renderEditor({ options: { scopePath: '/edit' } });
    await navigate(router, '/edit/deeper');
    await waitFor(() => expect(router.state.location.pathname).toBe('/edit/deeper'));
    expect(screen.queryByText('keep')).toBeNull();
  });

  it('still blocks a navigation that leaves scopePath', async () => {
    const router = renderEditor({ options: { scopePath: '/edit' } });
    await navigate(router, '/away');
    expect(await screen.findByText('keep')).toBeTruthy();
    expect(screen.queryByText('away')).toBeNull();
  });

  it('arms beforeunload while dirty and disarms once clean', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    renderEditor();
    expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(remove.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true));
  });

  it('skips beforeunload when the caller opts out', () => {
    const add = vi.spyOn(window, 'addEventListener');
    renderEditor({ options: { beforeUnload: false } });
    expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(false);
  });
});
