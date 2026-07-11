import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import PostTab from './PostTab';

// Settle the mount-effect fetches (config/sessions/stats/morse progress) inside
// act so their state updates can't land outside it mid-test — the mocks are all
// pre-resolved promises, so one microtask flush drains every pending .then.
const settle = () => act(async () => {});

// PostTab pulls config/sessions/stats on mount and drives a session hook; stub
// both so the component renders in isolation. The Morse tab doesn't depend on
// any of this data — it's the pure routing surface under test here.
vi.mock('../../../services/api', () => ({
  getPostConfig: () => Promise.resolve(null),
  getPostSessions: () => Promise.resolve([]),
  getPostStats: () => Promise.resolve(null),
  // MorseTrainer (rendered by the 'morse' tab) fetches/logs training stats on
  // mount — stub both so its effects resolve without hitting the network.
  getTrainingStats: () => Promise.resolve({ currentStreak: 0, byDrill: {} }),
  submitTrainingEntry: () => Promise.resolve({}),
  // MorseTrainer + its progress panel read server-side Morse progress on mount.
  getMorseProgress: () => Promise.resolve({
    days: 30, kochLevel: 2, kochLevelSet: false, settings: null, totalRounds: 0,
    series: { copy: [], 'head-copy': [], send: [] }, confusionMatrix: {}, confusionPairs: [], charAccuracy: [],
  }),
  submitMorseRound: () => Promise.resolve({}),
  updateMorseLevel: () => Promise.resolve({ kochLevel: 2, kochLevelSet: true, adopted: false, settings: null }),
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
  it('preserves the ?ref reference tab when entering a mode from the grid', async () => {
    render(
      <MemoryRouter initialEntries={['/post/morse?ref=list']}>
        <Routes>
          <Route path="/post/*" element={<><PostTab tab="morse" /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );
    await settle();
    // Pick the Send mode from the grid — the ?ref=list selection must survive.
    fireEvent.click(screen.getByText('Send'));
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse/send?ref=list');
  });

  it('preserves the ?ref reference tab when exiting a mode back to the grid', async () => {
    render(
      <MemoryRouter initialEntries={['/post/morse/send?ref=length']}>
        <Routes>
          <Route path="/post/*" element={<><PostTab tab="morse" subtab="send" /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );
    await settle();
    // Check surfaces the send-drill feedback, whose "Pick Mode" button exits the
    // mode back to the grid; ?ref=length must not reset to tree on the way out.
    fireEvent.click(screen.getByText('Check'));
    // Check submits the round + training entry — settle those writes before
    // navigating away so their state updates stay act-wrapped.
    await settle();
    fireEvent.click(screen.getByText('Pick Mode'));
    await settle();
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse?ref=length');
  });
});
