import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import PostTab from './PostTab';

// Issue #3428 — "Continue Today's Routine" is shared by four practice surfaces
// and dead-ends whenever the top recommendation deep-links to the page already
// in view. That contract lives in PostTab, not in any one drill, so the drills
// are stubbed here: each surface is a two-state panel whose "complete" state is
// LOCAL, exactly like the real drills' internal progress. If the restart fails
// to remount the surface, the stub stays on its completion panel — the same
// symptom the real ElementFlashMode shows.
//
// (The end-to-end version against the real Element Flash quiz lives in
// PostTab.test.jsx; this file covers the other three routes plus the handler's
// edge cases without dragging in WebAudio and per-drill fixtures.)

const settle = () => act(async () => {});

const { getPostRecommendations } = vi.hoisted(() => ({
  getPostRecommendations: vi.fn().mockResolvedValue({ recommendations: [] }),
}));

vi.mock('../../../services/api', () => ({
  getPostConfig: () => Promise.resolve({}),
  getPostRecommendations,
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

// A stand-in drill: "Finish" flips it to the completion panel (local state, so a
// remount resets it), and the panel offers the shared Continue action.
function SurfaceStub({ label, onContinue }) {
  const [done, setDone] = useState(false);
  if (!done) return <button onClick={() => setDone(true)}>Finish {label}</button>;
  return (
    <div>
      <div>{label} complete</div>
      <button onClick={() => onContinue()}>Continue Today&apos;s Routine</button>
    </div>
  );
}

vi.mock('../post/MorseTrainer', () => ({
  default: ({ onContinue }) => <SurfaceStub label="Morse" onContinue={onContinue} />,
  MORSE_MODE_IDS: ['copy', 'head-copy', 'send'],
}));
vi.mock('../post/WordplayTrainer', () => ({
  default: ({ onContinue }) => <SurfaceStub label="Wordplay" onContinue={onContinue} />,
}));
vi.mock('../post/MemoryPractice', () => ({
  default: ({ onContinue }) => <SurfaceStub label="Memory" onContinue={onContinue} />,
  MEMORY_PRACTICE_MODE_IDS: ['spaced', 'sequence'],
}));
vi.mock('../post/ElementsSong', () => ({
  default: ({ onContinue }) => <SurfaceStub label="Elements" onContinue={onContinue} />,
  ELEMENTS_MODE_IDS: ['learn', 'element-study', 'element-flash', 'fill-blank'],
}));
// PostTab's remaining imports are unreachable on the routes exercised here, but
// they still have to resolve — stub the ones that pull in heavy dependencies.
vi.mock('../../RapidReader', () => ({ RapidReaderModal: () => null }));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>;
}

const renderAt = (path, props) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/post/*" element={<><PostTab {...props} /><LocationProbe /></>} />
    </Routes>
  </MemoryRouter>,
);

const recommend = (deepLink) => getPostRecommendations.mockResolvedValueOnce({
  recommendations: [{ id: 'rec-1', kind: 'memory-due', title: 'Practice this again', deepLink, priority: 0 }],
});

// Drive one surface from "finish the drill" through "Continue".
async function finishAndContinue(label) {
  fireEvent.click(screen.getByText(`Finish ${label}`));
  await settle();
  expect(screen.getByText(`${label} complete`)).toBeInTheDocument();
  fireEvent.click(screen.getByText("Continue Today's Routine"));
  await settle();
}

describe('PostTab continueDailyRoutine', () => {
  beforeEach(() => {
    getPostRecommendations.mockReset();
    getPostRecommendations.mockResolvedValue({ recommendations: [] });
  });

  it('restarts the Morse drill in place, preserving the ?ref reference tab', async () => {
    recommend('/post/morse/copy');
    renderAt('/post/morse/copy?ref=list', { tab: 'morse', subtab: 'copy' });
    await settle();

    await finishAndContinue('Morse');

    expect(screen.getByText('Finish Morse')).toBeInTheDocument();
    expect(screen.queryByText('Morse complete')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse/copy?ref=list&run=1');
  });

  it('restarts the Wordplay trainer in place', async () => {
    recommend('/post/wordplay/anagram');
    renderAt('/post/wordplay/anagram', { tab: 'wordplay', subtab: 'anagram' });
    await settle();

    await finishAndContinue('Wordplay');

    expect(screen.getByText('Finish Wordplay')).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('/post/wordplay/anagram?run=1');
  });

  it('restarts memory practice in place', async () => {
    recommend('/post/memory/raven/spaced');
    renderAt('/post/memory/raven/spaced', { tab: 'memory', subtab: 'raven', mode: 'spaced' });
    await settle();

    await finishAndContinue('Memory');

    expect(screen.getByText('Finish Memory')).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('/post/memory/raven/spaced?run=1');
  });

  it('compares only the deepLink path, so a query-carrying self-link still restarts', async () => {
    recommend('/post/morse/copy?ref=tree');
    renderAt('/post/morse/copy', { tab: 'morse', subtab: 'copy' });
    await settle();

    await finishAndContinue('Morse');

    expect(screen.getByText('Finish Morse')).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse/copy?run=1');
  });

  it('bumps the nonce on each successive same-page continue', async () => {
    recommend('/post/morse/copy');
    renderAt('/post/morse/copy?run=1', { tab: 'morse', subtab: 'copy' });
    await settle();

    await finishAndContinue('Morse');

    expect(screen.getByTestId('loc').textContent).toBe('/post/morse/copy?run=2');
  });

  it('still navigates away when the recommendation points at a different surface', async () => {
    recommend('/post/memory/raven/spaced');
    renderAt('/post/morse/copy', { tab: 'morse', subtab: 'copy' });
    await settle();

    await finishAndContinue('Morse');

    expect(screen.getByTestId('loc').textContent).toBe('/post/memory/raven/spaced');
  });

  it('falls back to the launcher when there is nothing to recommend', async () => {
    renderAt('/post/morse/copy', { tab: 'morse', subtab: 'copy' });
    await settle();

    await finishAndContinue('Morse');

    expect(screen.getByTestId('loc').textContent).toBe('/post/launcher');
  });

  it('routes a launcher recommendation through the autostart param, not a restart', async () => {
    recommend('/post/launcher');
    renderAt('/post/morse/copy', { tab: 'morse', subtab: 'copy' });
    await settle();

    await finishAndContinue('Morse');

    expect(screen.getByTestId('loc').textContent).toBe('/post/launcher?continue=rec-1');
  });
});
