import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
    off: (event, fn) => handlers.get(event)?.delete(fn),
    receive: (event, payload) => handlers.get(event)?.forEach(fn => fn(payload)),
  };
});
vi.mock('../services/socket', () => ({ default: socket }));
vi.mock('../services/apiSprites.js', () => ({
  listSpriteRecords: vi.fn(async () => []),
  getSpriteRecord: vi.fn(),
  listSpriteAnimationProviders: vi.fn(async () => ({ providers: [] })),
  generateSpriteWalk: vi.fn(), generateSpriteTrack: vi.fn(), generateSpriteReference: vi.fn(),
  listSpriteThumbnails: vi.fn(async () => []),
  approveSpriteWalk: vi.fn(), postprocessSpriteWalk: vi.fn(), unlockSpriteWalk: vi.fn(),
  reopenSpriteWalk: vi.fn(), setSpriteWalkTarget: vi.fn(),
  approveSpriteTrack: vi.fn(), reopenSpriteTrack: vi.fn(),
}));
vi.mock('../services/apiSystem.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../services/apiMediaJobs.js', () => ({
  listMediaJobs: vi.fn(async () => []), getMediaJob: vi.fn(),
}));
vi.mock('../components/sprites/ReferenceWorkflow.jsx', () => ({ default: () => null }));
vi.mock('../components/sprites/AmbientWorkflow.jsx', () => ({ default: () => null }));
vi.mock('../components/sprites/AnimationTypesDrawer.jsx', () => ({ default: () => null }));
vi.mock('../components/sprites/LoopTrimmer.jsx', () => ({ default: () => null }));
vi.mock('../components/sprites/PublishWorkflow.jsx', () => ({ default: () => null }));
vi.mock('../components/sprites/AssetCollection.jsx', () => ({ default: () => null }));
vi.mock('../components/sprites/SpriteCatalog.jsx', () => ({ default: () => null }));
vi.mock('../components/sprites/SpriteDetailHeader.jsx', () => ({ default: ({ record }) => <h2>{record.name}</h2> }));
vi.mock('../components/sprites/ImportPanel.jsx', () => ({ default: () => null }));
vi.mock('../components/sprites/NewSpritePanel.jsx', () => ({
  default: ({ showTrigger = true }) => (showTrigger ? <button type="button">New Sprite</button> : null),
}));
vi.mock('../components/sprites/SpriteSearch.jsx', () => ({ default: () => null }));

import Sprites from './Sprites.jsx';
import { getSpriteRecord, listSpriteRecords, listSpriteAnimationProviders, generateSpriteWalk, generateSpriteTrack } from '../services/apiSprites.js';
import { listMediaJobs, getMediaJob } from '../services/apiMediaJobs.js';

const detail = (status = 'rendering', id = 'example-sprite') => ({
  record: { id, kind: 'character', name: id },
  reference: { manifest: { mainReference: { locked: true }, anchors: [{ direction: 'east', status: 'locked', path: 'reference/east.png' }] } },
  walk: { runs: [{ id: 'walk-east', direction: 'east', status }], selection: { directions: {} } },
  tracks: {
    ambient: {
      definition: { id: 'ambient', label: 'Ambient loop', directional: false, defaultFrameCount: 3, defaultFps: 4 },
      runs: [{ id: 'ambient-south', direction: 'south', status }],
    },
  },
  assets: [],
});
let navigate;
function Page() {
  navigate = useNavigate();
  return <Sprites />;
}
const mount = () => render(<MemoryRouter initialEntries={['/sprites/example-sprite']}>
  <Routes><Route path="/sprites/:id" element={<Page />} /></Routes>
</MemoryRouter>);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getSpriteRecord.mockResolvedValue(detail());
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('persisted sprite events in the rendered page', () => {
  it('updates walk and track review cards within one matching event and never polls', async () => {
    mount();
    await act(async () => {});
    expect(screen.getAllByText('rendering').length).toBeGreaterThan(0);
    const initialJobs = listMediaJobs.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(70000); });
    expect(getSpriteRecord).toHaveBeenCalledTimes(1);
    expect(listMediaJobs).toHaveBeenCalledTimes(initialJobs);
    expect(getMediaJob).not.toHaveBeenCalled();
    await act(async () => socket.receive('sprites:changed', { recordId: 'another-sprite' }));
    expect(getSpriteRecord).toHaveBeenCalledTimes(1);
    getSpriteRecord.mockResolvedValue(detail('postprocessing'));
    await act(async () => socket.receive('sprites:changed', { recordId: 'example-sprite' }));
    expect(screen.getAllByText('postprocessing').length).toBeGreaterThan(0);
    getSpriteRecord.mockResolvedValue(detail('candidate'));
    await act(async () => socket.receive('sprites:changed', { recordId: 'example-sprite' }));
    expect(screen.getByRole('button', { name: 'Approve Ambient loop Ambient loop row 0' })).toBeInTheDocument();
    expect(screen.queryByText('postprocessing')).not.toBeInTheDocument();
    await act(async () => socket.receive('connect'));
    expect(getSpriteRecord).toHaveBeenCalledTimes(4);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(getSpriteRecord).toHaveBeenCalledTimes(5);
  });

  it('ignores the old record response after navigation and reads the new route once', async () => {
    let finishOld;
    getSpriteRecord.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    mount();
    await act(async () => {});
    getSpriteRecord.mockResolvedValue(detail('candidate', 'second-sprite'));
    await act(async () => navigate('/sprites/second-sprite'));
    expect(screen.getByRole('heading', { name: 'second-sprite' })).toBeInTheDocument();
    await act(async () => finishOld(detail('error')));
    expect(screen.queryByRole('heading', { name: 'example-sprite' })).not.toBeInTheDocument();
    expect(getSpriteRecord).toHaveBeenCalledTimes(2);
  });

  it('renders ListLoadError with retry on failed sprite records load, and empty state on real empty list', async () => {
    listSpriteRecords.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    render(
      <MemoryRouter initialEntries={['/sprites']}>
        <Routes><Route path="/sprites" element={<Page />} /></Routes>
      </MemoryRouter>
    );
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load sprites — 503 Service Unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No sprites yet')).not.toBeInTheDocument();

    listSpriteRecords.mockResolvedValueOnce([]);
    await act(async () => {
      screen.getByRole('button', { name: 'Retry' }).click();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('No sprites yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Sprite' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create your first sprite' })).toBeInTheDocument();
  });

  it('keeps the header New Sprite action while loading, after a failed read, and with records', async () => {
    listSpriteRecords.mockRejectedValueOnce(new Error('503'));
    const { unmount } = render(<MemoryRouter initialEntries={['/sprites']}><Routes><Route path="/sprites" element={<Page />} /></Routes></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'New Sprite' })).toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Sprite' })).toBeInTheDocument();
    unmount();

    listSpriteRecords.mockResolvedValueOnce([{ id: 'example-sprite', kind: 'character', name: 'Example' }]);
    render(<MemoryRouter initialEntries={['/sprites']}><Routes><Route path="/sprites" element={<Page />} /></Routes></MemoryRouter>);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'New Sprite' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create your first sprite' })).not.toBeInTheDocument();
  });
});

it('submits paired local inputs and verbatim corrections from the rendered authoring cards', async () => {
  getSpriteRecord.mockResolvedValue(detail('error'));
  listSpriteAnimationProviders.mockResolvedValue({ providers: [
    { id: 'grok', ready: true, label: 'Grok' },
    { id: 'local', ready: true, label: 'Local', returnToIdleAnchorSupported: true },
  ] });
  mount();
  await act(async () => {});
  fireEvent.change(screen.getAllByLabelText(/Render on/)[0], { target: { value: 'local' } });
  const east = screen.getByRole('checkbox', { name: 'Return to idle anchor east' });
  fireEvent.click(east);
  fireEvent.click(screen.getByRole('button', { name: 'Show correction note for east walk cycle' }));
  const correctionPrompt = '  Lift feet!\nKeep hat.  ';
  fireEvent.change(screen.getByLabelText('Correction guidance for the east walk cycle re-roll'), { target: { value: correctionPrompt } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Generate walk/ })));
  expect(generateSpriteWalk).toHaveBeenCalledWith('example-sprite', expect.objectContaining({
    direction: 'east', provider: 'local', returnToIdleAnchor: true, correctionPrompt,
  }), { silent: true });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Return to idle anchor south' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
  expect(generateSpriteTrack).toHaveBeenCalledWith('example-sprite', 'ambient', expect.objectContaining({
    provider: 'local', returnToIdleAnchor: true,
  }), { silent: true });
});
