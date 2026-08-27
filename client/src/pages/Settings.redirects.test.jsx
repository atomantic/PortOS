import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

// Settings.jsx imports every tab component, and those pull in the API client.
// Stub the whole module so no tab's import-time wiring reaches the network. The
// Proxy answers any named import with a resolved-promise spy; `then` must stay
// undefined or Vitest's `await` on the factory result treats the namespace as a
// thenable and hangs waiting for a resolve that never comes.
vi.mock('../services/api', () => new Proxy({}, {
  get: (_target, key) => (key === 'then' || key === '__esModule' ? undefined : vi.fn().mockResolvedValue({})),
}));

const Settings = (await import('./Settings')).default;

function Landed() {
  const { pathname, search } = useLocation();
  return <div data-testid="landed">{`${pathname}${search}`}</div>;
}

// Former Settings tabs now live as drawers over the pages they configure.
// Their old /settings/<tab> URLs stay live as redirects so bookmarks, stale ⌘K
// history, and older docs keep working — and land with the drawer already open.
describe('Settings — retired tabs redirect to their drawer', () => {
  it.each([
    ['/settings/image-gen', '/media/image?settings=1'],
    ['/settings/imessage', '/messages/imessage?settings=1'],
    ['/settings/catalog', '/catalog?settings=1'],
  ])('%s → %s', (from, to) => {
    render(
      <MemoryRouter initialEntries={[from]}>
        <Routes>
          <Route path="/settings/:tab" element={<Settings />} />
          <Route path="*" element={<Landed />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('landed').textContent).toBe(to);
  });
});
