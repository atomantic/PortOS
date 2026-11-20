import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import PostTab from './PostTab';

// The trainers under test are lazy chunks in PostTab. Load them once up front so
// the first test to open one does not race its module transform; after that a
// lazy import resolves within one macrotask.
await Promise.all([
  import('../post/MorseTrainer'),
  import('../post/MemoryPractice'),
  import('../post/ElementsSong'),
]);

// Settle the mount-effect fetches (config/sessions/stats/morse progress) and the
// lazy trainer imports inside act so their state updates can't land outside it
// mid-test. The api mocks are pre-resolved promises; the macrotask gives the
// cached dynamic import room to resolve and React room to mount the trainer.
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

// PostTab pulls config/sessions/stats on mount and drives a session hook; stub
// both so the component renders in isolation. The Morse tab doesn't depend on
// any of this data — it's the pure routing surface under test here.
vi.mock('../../../services/apiMeatspace.js', () => ({
  getPostConfig: () => Promise.resolve(null),
  getPostRecommendations,
  getPostSessions: () => Promise.resolve([]),
  getPostStats: () => Promise.resolve(null),
  getTrainingStats: () => Promise.resolve({ currentStreak: 0, byDrill: {} }),
  submitTrainingEntry: () => Promise.resolve({}),
  getMorseProgress: () => Promise.resolve({
    days: 30, kochLevel: 2, kochLevelSet: false, settings: null, totalRounds: 0,
    series: { copy: [], 'head-copy': [], send: [] }, confusionMatrix: {}, confusionPairs: [], charAccuracy: [],
  }),
  submitMorseRound: () => Promise.resolve({}),
  updateMorseLevel: () => Promise.resolve({ kochLevel: 2, kochLevelSet: true, adopted: false, settings: null }),
  getMemoryItems: () => Promise.resolve([MEMORY_ITEM, ELEMENTS_ITEM]),
  getMemoryItem: (id) => Promise.resolve([MEMORY_ITEM, ELEMENTS_ITEM].find(i => i.id === id) || null),
  getMemoryMastery: () => Promise.resolve(null),
  getChunkMastery: () => Promise.resolve([]),
  submitMemoryPractice: () => Promise.resolve({}),
  createMemoryItem: () => Promise.resolve(null),
  deleteMemoryItem: () => Promise.resolve({}),
}));

// The RapidReader modal pulls in browser-only APIs and is never opened here.
vi.mock('../../RapidReader', () => ({ RapidReaderModal: () => null }));

// Hoisted so the api mock factory (which vitest lifts above imports) can close
// over it — a plain `const` declared below would be in the TDZ at mock time.
const { MEMORY_ITEM, ELEMENTS_ITEM, getPostRecommendations, POST_SESSION_OVERRIDE } = vi.hoisted(() => ({
  MEMORY_ITEM: {
    id: 'raven',
    title: 'The Raven',
    type: 'poem',
    content: {
      lines: [{ text: 'Once upon a midnight dreary' }, { text: 'While I pondered weak and weary' }],
      chunks: [{ id: 'v1', label: 'Verse 1', lineRange: [0, 1] }],
    },
    mastery: { overallPct: 0, chunks: {}, elements: {} },
  },
  // The built-in Elements Song reaches its own reserved surface, not the
  // generic per-item practice route.
  ELEMENTS_ITEM: {
    id: 'elements-song',
    title: 'The Elements Song',
    type: 'song',
    builtin: true,
    content: { lines: [], chunks: [], elementMap: { H: { name: 'Hydrogen', atomicNumber: 1 } } },
    mastery: { overallPct: 0, chunks: {}, elements: {} },
  },
  getPostRecommendations: vi.fn().mockResolvedValue({ recommendations: [] }),
  POST_SESSION_OVERRIDE: { current: null },
}));

vi.mock('../post/usePostSession', () => ({
  usePostSession: () => POST_SESSION_OVERRIDE.current || ({
    state: 'idle',
    drills: [],
    currentDrillIndex: 0,
    currentDrill: null,
    drillCount: 0,
    drillResults: [],
    reset: vi.fn(),
  }),
}));

afterEach(() => {
  POST_SESSION_OVERRIDE.current = null;
});

// Surfaces the live URL so the test can assert mode transitions keep the ?ref
// query param — the "mode AND reference view are both deep-linkable" contract.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>;
}

describe('PostTab saved-run routing (#4441)', () => {
  it('returns a saved training run to the launcher instead of a scored-session detail', async () => {
    POST_SESSION_OVERRIDE.current = {
      state: 'complete',
      drills: [],
      currentDrillIndex: 0,
      currentDrill: null,
      drillCount: 0,
      drillResults: [],
      sessionScore: 0,
      isTraining: true,
      saveSession: vi.fn().mockResolvedValue({ id: 'training-run', training: true }),
      reset: vi.fn(),
    };
    render(
      <MemoryRouter initialEntries={['/post/session/run']}>
        <Routes>
          <Route path="/post/*" element={<><PostTab tab="session" subtab="run" /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );
    await settle();

    await act(async () => { fireEvent.click(screen.getByText('Log Training')); });

    expect(screen.getByTestId('loc').textContent).toBe('/post/launcher');
    expect(POST_SESSION_OVERRIDE.current.reset).toHaveBeenCalledOnce();
  });
});

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
    // Check surfaces the send-drill feedback, whose "Finish for Now" action exits
    // the mode back to the grid; ?ref=length must not reset to tree on the way out.
    fireEvent.click(screen.getByText('Check'));
    // Check submits the round + training entry — settle those writes before
    // navigating away so their state updates stay act-wrapped.
    await settle();
    fireEvent.click(screen.getByText('Finish for Now'));
    await settle();
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse?ref=length');
  });
});

// The memory tab is the one POST surface whose practice selection used to live
// in local state, so a recommendation could only ever link at the item LIST.
// These pin the URL grammar that replaced it (issue #3249):
//   /post/memory                  → item list
//   /post/memory/elements[/:mode] → the Elements Song surface
//   /post/memory/:itemId[/:mode]  → that item's practice
describe('PostTab memory deep-linking (issue #3249)', () => {
  const renderMemory = (path, { subtab, mode } = {}) => render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/post/*" element={<><PostTab tab="memory" subtab={subtab} mode={mode} /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );

  it('renders the item list at the bare /post/memory', async () => {
    renderMemory('/post/memory');
    await settle();
    expect(screen.getByText('Memory Builder')).toBeInTheDocument();
  });

  it('starts Review Next inside the due practice mode instead of reopening the item menu', async () => {
    renderMemory('/post/memory');
    await settle();

    fireEvent.click(screen.getByText('Review Next'));
    await settle();

    expect(screen.getByTestId('loc').textContent).toBe('/post/memory/raven/spaced');
  });

  it('loads an item practice mode straight from the URL on a cold load', async () => {
    renderMemory('/post/memory/raven/spaced', { subtab: 'raven', mode: 'spaced' });
    await settle();
    // Spaced practice for the fetched item — not the mode picker, and no item
    // was seeded in, so this exercises the cold deep-link fetch path.
    expect(screen.getByText('Spaced Repetition — The Raven')).toBeInTheDocument();
    expect(screen.queryByText('Choose a practice mode:')).not.toBeInTheDocument();
  });

  it('degrades an unknown practice mode to the mode picker, not a blank panel', async () => {
    renderMemory('/post/memory/raven/bogus-mode', { subtab: 'raven', mode: 'bogus-mode' });
    await settle();
    expect(screen.getByText('Choose a practice mode:')).toBeInTheDocument();
  });

  it('renders a not-found fallback (with a route back) for an unknown item id', async () => {
    renderMemory('/post/memory/no-such-item', { subtab: 'no-such-item' });
    await settle();
    expect(screen.getByText('Item not found')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Back to Memory Builder'));
    await settle();
    expect(screen.getByTestId('loc').textContent).toBe('/post/memory');
  });

  it('puts the practice mode in the URL when entering and exiting it', async () => {
    const { rerender } = renderMemory('/post/memory/raven', { subtab: 'raven' });
    await settle();
    fireEvent.click(screen.getByText('Sequence Recall'));
    await settle();
    expect(screen.getByTestId('loc').textContent).toBe('/post/memory/raven/sequence');

    // Re-render at the new URL as the router would, then exit back to the picker.
    rerender(
      <MemoryRouter initialEntries={['/post/memory/raven/sequence']}>
        <Routes>
          <Route path="/post/*" element={<><PostTab tab="memory" subtab="raven" mode="sequence" /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );
    await settle();
    fireEvent.click(screen.getByLabelText('Back'));
    await settle();
    expect(screen.getByTestId('loc').textContent).toBe('/post/memory/raven');
  });

  it('degrades an unknown elements mode to the Elements picker', async () => {
    renderMemory('/post/memory/elements/bogus-mode', { subtab: 'elements', mode: 'bogus-mode' });
    await settle();
    expect(screen.getByText('Periodic Table')).toBeInTheDocument();
  });

  it('continues from a saved Elements lesson to the next cross-domain recommendation', async () => {
    getPostRecommendations.mockResolvedValueOnce({ recommendations: [{
      id: 'stalled:morse-copy',
      kind: 'stalled-progression',
      title: 'Morse: keep climbing',
      deepLink: '/post/morse/copy',
      drillType: 'morse-copy',
      priority: 0,
    }] });
    renderMemory('/post/memory/elements/element-study', { subtab: 'elements', mode: 'element-study' });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    fireEvent.click(screen.getByText('Got It'));
    await settle();
    fireEvent.click(screen.getByText("Continue Today's Routine"));
    await settle();

    expect(getPostRecommendations).toHaveBeenCalledWith(1);
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse/copy');
  });

  // Issue #3428: a sub-50% run legitimately makes the drill just finished the
  // top recommendation again, so its deepLink is the page already in view.
  // Navigating there is a no-op — Continue must restart the drill instead of
  // leaving the completion panel on screen.
  it('restarts the drill in place when the next recommendation deep-links to the current page', async () => {
    getPostRecommendations.mockResolvedValueOnce({ recommendations: [{
      id: 'memory-due:elements-song',
      kind: 'memory-due',
      title: 'Elements: due for review',
      deepLink: '/post/memory/elements/element-flash',
      priority: 0,
    }] });
    renderMemory('/post/memory/elements/element-flash?ref=list', { subtab: 'elements', mode: 'element-flash' });
    await settle();

    // Skip the only question (ELEMENTS_ITEM has a single-element map) to land on
    // the completion panel with a sub-50% score.
    fireEvent.click(screen.getByLabelText('Skip'));
    fireEvent.click(screen.getByText('Next'));
    await settle();
    expect(screen.getByText('Element Flash Complete')).toBeInTheDocument();

    fireEvent.click(screen.getByText("Continue Today's Routine"));
    await settle();

    // Fresh run: progress back at the first question, completion panel gone —
    // and the unrelated ?ref= param survives the restart.
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    expect(screen.queryByText('Element Flash Complete')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('/post/memory/elements/element-flash?ref=list&run=1');
  });
});
