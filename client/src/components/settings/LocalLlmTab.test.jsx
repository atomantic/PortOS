import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

// The tab is a dispatcher: the assertion that matters is WHICH view mounts, so
// the views themselves are stubbed. Their own behaviour is covered in
// LocalLlmRuntimesView.test.jsx / LocalLlmLibraryView.test.jsx.
vi.mock('./LocalLlmRuntimesView.jsx', () => ({
  default: () => <div data-testid="runtimes-view">runtimes</div>,
}));
vi.mock('./LocalLlmLibraryView.jsx', () => ({
  default: () => <div data-testid="library-view">library</div>,
}));
vi.mock('../models/ModelAbuseGuardPanel.jsx', () => ({
  default: () => <div data-testid="abuse-view">abuse</div>,
}));

import { LocalLlmTab } from './LocalLlmTab';

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

const renderTab = (view) => render(
  <MemoryRouter>
    <LocalLlmTab view={view} />
    <LocationProbe />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LocalLlmTab view dispatch', () => {
  // The `view` prop comes straight off the URL, so anything that is not a known
  // view id — a legacy `/models/llms` with no segment, a typo, a stale bookmark —
  // has to land on runtimes rather than rendering an empty tab body.
  it.each([
    [undefined, 'runtimes-view'],
    ['runtimes', 'runtimes-view'],
    ['library', 'library-view'],
    ['abuse', 'abuse-view'],
    ['not-a-view', 'runtimes-view'],
  ])('renders the %s panel', (view, testId) => {
    renderTab(view);

    expect(screen.getByTestId(testId)).toBeInTheDocument();
    for (const other of ['runtimes-view', 'library-view', 'abuse-view'].filter((id) => id !== testId)) {
      expect(screen.queryByTestId(other)).not.toBeInTheDocument();
    }
  });

  it('navigates between the focused panels with a shareable URL', () => {
    renderTab();

    fireEvent.click(screen.getByRole('tab', { name: 'Model Library' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/models/llms/library');
    fireEvent.click(screen.getByRole('tab', { name: 'Abuse Guard' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/models/llms/abuse');
  });

  it('describes the selected panel under the pills', () => {
    renderTab('library');

    expect(screen.getByText(/Find, install, compare, and remove the model weights/)).toBeInTheDocument();
  });
});
