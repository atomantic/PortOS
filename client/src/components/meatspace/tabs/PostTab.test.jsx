import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import PostTab from './PostTab';

// PostTab pulls config/sessions/stats on mount and drives a session hook; stub
// both so the component renders in isolation. The Morse tab doesn't depend on
// any of this data — it's the pure routing surface under test here.
vi.mock('../../../services/api', () => ({
  getPostConfig: () => Promise.resolve(null),
  getPostSessions: () => Promise.resolve([]),
  getPostStats: () => Promise.resolve(null),
}));

vi.mock('../../../hooks/usePostSession', () => ({
  usePostSession: () => ({
    state: 'idle',
    drills: [],
    currentDrillIndex: 0,
    currentDrill: null,
    drillCount: 0,
    drillResults: [],
    reset: vi.fn(),
  }),
}));

// Surfaces the live URL so the test can assert mode transitions keep the ?ref
// query param — the "mode AND reference view are both deep-linkable" contract.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>;
}

describe('PostTab morse deep-linking', () => {
  // A wildcard route keeps the probe mounted after navigation moves the URL to a
  // different /post/morse* path (PostTab's tab/subtab arrive as props here, so the
  // fixed element re-renders while LocationProbe reports the new location).
  it('preserves the ?ref reference tab when entering a mode from the grid', () => {
    render(
      <MemoryRouter initialEntries={['/post/morse?ref=list']}>
        <Routes>
          <Route path="/post/*" element={<><PostTab tab="morse" /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );
    // Pick the Send mode from the grid — the ?ref=list selection must survive.
    fireEvent.click(screen.getByText('Send'));
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse/send?ref=list');
  });

  it('preserves the ?ref reference tab when exiting a mode back to the grid', () => {
    render(
      <MemoryRouter initialEntries={['/post/morse/send?ref=length']}>
        <Routes>
          <Route path="/post/*" element={<><PostTab tab="morse" subtab="send" /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );
    // Check surfaces the send-drill feedback, whose "Pick Mode" button exits the
    // mode back to the grid; ?ref=length must not reset to tree on the way out.
    fireEvent.click(screen.getByText('Check'));
    fireEvent.click(screen.getByText('Pick Mode'));
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse?ref=length');
  });
});
