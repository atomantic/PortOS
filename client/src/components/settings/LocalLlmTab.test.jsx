import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

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
// Jev integrations are optional; management stays discoverable regardless.
// Which pills the bar
// advertises depends on live feature state rather than the static view list.
const disabledFeatures = new Set();
vi.mock('../../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({
    isFeatureEnabled: (featureId) => !featureId || !disabledFeatures.has(featureId),
  }),
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
  disabledFeatures.clear();
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

  // The pill bar is what a user reaches these views by, so a Runtimes pill left
  // behind would navigate to `/models/llms/runtimes` — a path that now only
  // redirects away — instead of the tab that owns the page.
  it('no longer advertises Runtimes as one of its pills', () => {
    renderTab();

    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Model Library', 'Abuse Guard', 'jev']);
  });

  it('navigates between the focused panels with a shareable URL', () => {
    renderTab();

    fireEvent.click(screen.getByRole('tab', { name: 'Model Library' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/models/llms/library');
    fireEvent.click(screen.getByRole('tab', { name: 'Abuse Guard' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/models/llms/abuse');
    fireEvent.click(screen.getByRole('tab', { name: 'jev' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/models/llms/jev');
  });

  it('keeps the Jev install and management page discoverable while disabled', () => {
    disabledFeatures.add('jev');
    renderTab();
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Model Library', 'Abuse Guard', 'jev']);
  });

  it('still mounts jev from a direct URL while the feature is disabled', () => {
    disabledFeatures.add('jev');
    renderTab('jev');

    expect(screen.getByTestId('jev-view')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Model Library', 'Abuse Guard', 'jev']);
  });

  it('describes the selected panel under the pills', () => {
    renderTab('library');

    expect(screen.getByText(/Find, install, compare, and remove the model weights/)).toBeInTheDocument();
  });
});
