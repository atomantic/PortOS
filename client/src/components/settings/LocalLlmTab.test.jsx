import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// The tab is a dispatcher: the assertion that matters is WHICH view mounts, so
// the views themselves are stubbed. Their own behaviour is covered in
// LocalLlmLibraryView.test.jsx (and, for the departed runtimes view, in
// LocalLlmRuntimesView.test.jsx — it is a sibling Models tab since #7414, so
// this dispatcher must no longer be able to mount it at all).
vi.mock('./LocalLlmRuntimesView.jsx', () => ({
  default: () => <div data-testid="runtimes-view">runtimes</div>,
}));
vi.mock('./LocalLlmLibraryView.jsx', () => ({
  default: () => <div data-testid="library-view">library</div>,
}));
vi.mock('../models/ModelAbuseGuardPanel.jsx', () => ({
  default: () => <div data-testid="abuse-view">abuse</div>,
}));
vi.mock('../models/JevPanel.jsx', () => ({
  default: () => <div data-testid="jev-view">jev</div>,
}));
import { LocalLlmTab } from './LocalLlmTab';

const renderTab = (view) => render(
  <MemoryRouter>
    <LocalLlmTab view={view} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LocalLlmTab view dispatch', () => {
  // The `view` prop comes straight off the URL, so anything that is not a known
  // view id — a bare `/models/llms`, a typo, a stale bookmark, or `runtimes`
  // from before the split — has to land on Model Library rather than rendering
  // an empty tab body.
  it.each([
    [undefined, 'library-view'],
    ['library', 'library-view'],
    ['abuse', 'abuse-view'],
    ['not-a-view', 'library-view'],
    ['runtimes', 'library-view'],
  ])('renders the %s panel', (view, testId) => {
    renderTab(view);

    expect(screen.getByTestId(testId)).toBeInTheDocument();
    for (const other of ['runtimes-view', 'library-view', 'abuse-view'].filter((id) => id !== testId)) {
      expect(screen.queryByTestId(other)).not.toBeInTheDocument();
    }
  });

  it('dispatches every promoted route directly without a redundant local nav row', () => {
    renderTab('jev');
    expect(screen.getByTestId('jev-view')).toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});
