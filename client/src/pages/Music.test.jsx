import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { afterEach } from 'vitest';

// Stub the three manager panels — this suite pins the tab/route wiring
// (URL param → active tab, redirect on an unknown tab, TabPills → navigate),
// not the managers' own internals.
vi.mock('../components/music/ArtistsManager', () => ({ default: () => <div data-testid="artists-manager" /> }));
vi.mock('../components/music/AlbumsManager', () => ({ default: () => <div data-testid="albums-manager" /> }));
vi.mock('../components/music/TracksManager', () => ({ default: () => <div data-testid="tracks-manager" /> }));

import Music from './Music.jsx';

// Sibling readout of the current route, rendered alongside the page so a
// redirect's resulting pathname is directly observable (mirrors the
// `EditorLanding`-style helper in PipelineFindingRedirect.test.jsx).
function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/music" element={<><LocationDisplay /><Music /></>} />
      <Route path="/music/:tab" element={<><LocationDisplay /><Music /></>} />
    </Routes>
  </MemoryRouter>,
);

describe('<Music>', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the matching manager for a known tab', () => {
    renderAt('/music/albums');
    expect(screen.getByTestId('albums-manager')).toBeInTheDocument();
    expect(screen.queryByTestId('artists-manager')).toBeNull();
    expect(screen.queryByTestId('tracks-manager')).toBeNull();
  });

  it('defaults bare /music to the artists tab', () => {
    renderAt('/music');
    expect(screen.getByTestId('artists-manager')).toBeInTheDocument();
    expect(screen.queryByTestId('albums-manager')).toBeNull();
  });

  it('redirects an unknown tab param to /music/artists', () => {
    renderAt('/music/bogus');
    expect(screen.getByTestId('location')).toHaveTextContent('/music/artists');
    expect(screen.getByTestId('artists-manager')).toBeInTheDocument();
  });

  it('clicking a TabPill navigates the URL to the matching tab route', () => {
    renderAt('/music/artists');
    expect(screen.getByTestId('location')).toHaveTextContent('/music/artists');

    fireEvent.click(screen.getByRole('tab', { name: /tracks/i }));

    expect(screen.getByTestId('location')).toHaveTextContent('/music/tracks');
    expect(screen.getByTestId('tracks-manager')).toBeInTheDocument();
    expect(screen.queryByTestId('artists-manager')).toBeNull();
  });
});
