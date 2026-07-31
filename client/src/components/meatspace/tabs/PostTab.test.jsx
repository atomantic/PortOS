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
  // Memory tab (MemoryBuilder / MemoryPractice / ElementsSong) — issue #3249.
  // `getMemoryItem` resolves the seeded item and returns null for anything else,
  // which is what drives the not-found fallback.
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
const { MEMORY_ITEM, ELEMENTS_ITEM } = vi.hoisted(() => ({
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
});
