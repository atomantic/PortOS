import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncExternalStore } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';

// The six heaviest trainers and runners are lazy chunks behind PostTab's
// Suspense boundary. Each stub names itself and echoes its routed props, so a
// test passes only when that exact component resolved and mounted, from a cold
// deep link or after leaving the launcher.

vi.mock('../../../services/apiMeatspace.js', () => ({
  getPostConfig: () => Promise.resolve({}),
  getPostRecommendations: () => Promise.resolve({ recommendations: [] }),
  getPostSessions: () => Promise.resolve([]),
  getPostStats: () => Promise.resolve(null),
}));

const stub = (id, describeProps = () => '') => (props) => (
  <div data-testid={`drill-${id}`}>{describeProps(props)}</div>
);
vi.mock('../post/MorseTrainer', () => ({ default: stub('morse', (p) => p.mode) }));
vi.mock('../post/RhetoricTrainer', () => ({ default: stub('rhetoric', (p) => p.mode) }));
vi.mock('../post/MemoryPractice', () => ({ default: stub('memory', (p) => `${p.itemId}/${p.mode}`) }));
vi.mock('../post/ElementsSong', () => ({ default: stub('elements', (p) => p.mode) }));
vi.mock('../post/PostLlmDrillRunner', () => ({ default: stub('llm', (p) => p.drill.type) }));
vi.mock('../post/PostCognitiveDrillRunner', () => ({ default: stub('cognitive', (p) => p.drill.type) }));

// The launcher's own suite covers which links and starts it offers; here it is
// reduced to the two exits PostTab wires up: onNavigate (trainer pages) and
// onStart (a session run).
vi.mock('../post/PostSessionLauncher', () => ({
  default: ({ onNavigate, onStart }) => (
    <div data-testid="launcher">
      <button onClick={() => onNavigate('/post/morse/copy')}>open morse</button>
      <button onClick={() => onNavigate('/post/rhetoric/meter')}>open rhetoric</button>
      <button onClick={() => onNavigate('/post/memory/raven/spaced')}>open memory</button>
      <button onClick={() => onNavigate('/post/memory/elements/element-flash')}>open elements</button>
      <button onClick={() => onStart({ drills: [{ type: 'compound-chain', timeLimitSec: 60 }] })}>start llm</button>
      <button onClick={() => onStart({ drills: [{ type: 'n-back' }] })}>start cognitive</button>
    </div>
  ),
}));

// The real session hook survives the remount a route change causes (App
// declares /post/:tab, /post/:tab/:subtab and /post/:tab/:subtab/:mode as
// separate routes), so this fake keeps its run in a module-level store too.
const { sessionStore } = vi.hoisted(() => {
  const listeners = new Set();
  const store = {
    value: null,
    set(next) { store.value = next; listeners.forEach((l) => l()); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { sessionStore: store };
});
const idleSession = () => ({
  state: 'idle', drills: [], currentDrillIndex: 0, currentDrill: null, drillCount: 0, drillResults: [],
});
const activeSession = (drill) => ({
  state: 'active', drills: [drill], currentDrillIndex: 0, currentDrill: { ...drill }, drillCount: 1, drillResults: [],
});
vi.mock('../post/usePostSession', () => ({
  usePostSession: () => {
    const value = useSyncExternalStore(sessionStore.subscribe, () => sessionStore.value);
    return {
      ...value,
      reset: () => sessionStore.set(idleSession()),
      startSession: async ({ drills }) => { sessionStore.set(activeSession(drills[0])); return true; },
      completeLlmDrill: vi.fn(),
      completeCognitiveDrill: vi.fn(),
    };
  },
}));

const PostTab = (await import('./PostTab')).default;

function PostRoute() {
  const { tab, subtab, mode } = useParams();
  return <PostTab tab={tab} subtab={subtab} mode={mode} />;
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/post/:tab" element={<PostRoute />} />
      <Route path="/post/:tab/:subtab" element={<PostRoute />} />
      <Route path="/post/:tab/:subtab/:mode" element={<PostRoute />} />
    </Routes>
  </MemoryRouter>,
);

// Reset before (not after) each test: a store write while the previous test's
// tree is still mounted would land outside act.
beforeEach(() => {
  sessionStore.set(idleSession());
});

// Drain the mount-effect fetches and let a lazy import resolve and commit, all
// inside act (a stray update outside it fails the suite, see src/test/setup.js).
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const TRAINERS = [
  { id: 'morse', path: '/post/morse/copy', button: 'open morse', shows: 'copy' },
  { id: 'rhetoric', path: '/post/rhetoric/meter', button: 'open rhetoric', shows: 'meter' },
  { id: 'memory', path: '/post/memory/raven/spaced', button: 'open memory', shows: 'raven/spaced' },
  { id: 'elements', path: '/post/memory/elements/element-flash', button: 'open elements', shows: 'element-flash' },
];
const RUNNERS = [
  { id: 'llm', drill: { type: 'compound-chain', timeLimitSec: 60 }, button: 'start llm' },
  { id: 'cognitive', drill: { type: 'n-back' }, button: 'start cognitive' },
];

describe('PostTab lazy drills', () => {
  it.each(TRAINERS)('$id opens from a deep link', async ({ id, path, shows }) => {
    renderAt(path);
    await settle();
    expect(screen.getByTestId(`drill-${id}`)).toHaveTextContent(shows);
  });

  it.each(TRAINERS)('$id opens from the launcher', async ({ id, button, shows }) => {
    renderAt('/post/launcher');
    await settle();
    fireEvent.click(screen.getByText(button));
    await settle();
    expect(screen.getByTestId(`drill-${id}`)).toHaveTextContent(shows);
    expect(screen.queryByTestId('launcher')).toBeNull();
  });

  // A live run is reached at /post/session/run; a reload or a link there with a
  // restored run is the runner's deep link.
  it.each(RUNNERS)('$id runner opens from a deep link to the live run', async ({ id, drill }) => {
    sessionStore.set(activeSession(drill));
    renderAt('/post/session/run');
    await settle();
    expect(screen.getByTestId(`drill-${id}`)).toHaveTextContent(drill.type);
  });

  it.each(RUNNERS)('$id runner opens when the launcher starts a session', async ({ id, drill, button }) => {
    renderAt('/post/launcher');
    await settle();
    fireEvent.click(screen.getByText(button));
    await settle();
    expect(screen.getByTestId(`drill-${id}`)).toHaveTextContent(drill.type);
    expect(screen.queryByTestId('launcher')).toBeNull();
  });
});
