import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';

// The 3D scene and the cockpit HUD are stubbed: this suite is about the page's fast-travel
// WIRING (route param → scene props, M → panel, pick → navigate + teleport), not about
// rendering WebGL in jsdom. The scene stub records the props it received so the assertions
// can read them directly.
const sceneProps = { current: null };
const openWorldDataState = vi.hoisted(() => ({ loading: false }));
vi.mock('../components/openworld/OpenWorldScene', () => ({
  default: (props) => {
    sceneProps.current = props;
    return <div data-testid="scene" />;
  },
}));
vi.mock('../components/openworld/OpenWorldHud', () => ({
  default: ({ onOpenFastTravel, activeRegion, onEnterPhotoMode }) => (
    <div>
      <button type="button" onClick={onOpenFastTravel}>hud-fast-travel</button>
      <button type="button" onClick={onEnterPhotoMode}>hud-photo</button>
      <span data-testid="hud-region">{activeRegion?.id || 'none'}</span>
    </div>
  ),
}));
vi.mock('../components/openworld/OpenWorldPhotoOverlay', () => ({ default: () => null }));
vi.mock('../components/openworld/OpenWorldPlaybackOverlay', () => ({ default: () => null }));
vi.mock('../components/openworld/OpenWorldSettingsDrawer', () => ({ default: () => null }));

vi.mock('../hooks/useOpenWorldData', () => ({
  useOpenWorldData: () => ({
    apps: [], cosAgents: [], cosStatus: {}, eventLogs: [], agentMap: new Map(),
    reviewCounts: {}, instances: {}, systemHealth: null, notificationCounts: {},
    backupStatus: null, cosTasks: [], healthMetrics: null, voiceState: null,
    character: null, aiActivity: null, loading: openWorldDataState.loading, connected: true,
  }),
}));
vi.mock('../hooks/useOpenWorldPlayback', () => ({
  useOpenWorldPlayback: () => ({
    active: false, currentFrame: null, snapshots: [], frameIndex: 0, stats: null,
    playing: false, speed: 1, loading: false, error: null,
    enter: vi.fn(), exit: vi.fn(), seek: vi.fn(), step: vi.fn(),
    togglePlay: vi.fn(), cycleSpeed: vi.fn(),
  }),
}));
vi.mock('../hooks/useOpenWorldAudio', () => ({ default: () => ({ playSfx: vi.fn(), isAudioReady: false }) }));
vi.mock('../hooks/useAutoRefetch', () => ({ useAutoRefetch: () => ({ data: null }) }));
// Only the endpoints this page polls. `useAutoRefetch` is stubbed above so none of them
// actually fire — the mock exists to keep the real api module (and its socket import) out
// of the jsdom run.
vi.mock('../services/api', () => ({
  getCosQuickSummary: vi.fn(async () => null),
  getCosActivityCalendar: vi.fn(async () => null),
  getGoals: vi.fn(async () => null),
  getChronotype: vi.fn(async () => null),
  getMemoryGraph: vi.fn(async () => null),
  getBrainInbox: vi.fn(async () => null),
  getOpenWorldIntrospection: vi.fn(async () => null),
  getMySprintTickets: vi.fn(async () => []),
}));

const OpenWorld = (await import('./OpenWorld')).default;

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocationProbe />
    <Routes>
      <Route path="/openworld" element={<OpenWorld />} />
      <Route path="/openworld/region/:regionId" element={<OpenWorld />} />
      <Route path="/brain/inbox" element={<div>brain page</div>} />
    </Routes>
  </MemoryRouter>
);

describe('OpenWorld — fast travel wiring', () => {
  beforeEach(() => {
    sceneProps.current = null;
    openWorldDataState.loading = false;
    localStorage.clear();
  });

  it('keeps the scene mounted while the initial data bundle is loading', () => {
    openWorldDataState.loading = true;

    renderAt('/openworld');

    expect(screen.getByTestId('scene')).toBeInTheDocument();
    expect(screen.queryByText('ENTERING OPENWORLD')).not.toBeInTheDocument();
  });

  it('hands the scene no region on the plain overview route', () => {
    renderAt('/openworld');
    expect(sceneProps.current.focusedRegion).toBeNull();
  });

  it('resolves the :regionId route param into a region for the camera', () => {
    renderAt('/openworld/region/memory');
    expect(sceneProps.current.focusedRegion.id).toBe('memory');
    // Geography comes from the master town plan, not from the route.
    expect(sceneProps.current.focusedRegion.anchor).toBeDefined();
  });

  it('arms the first-person arrival point for a direct region deep link', () => {
    renderAt('/openworld/region/memory');
    expect(sceneProps.current.playerTeleport).toMatchObject({
      x: expect.any(Number),
      z: expect.any(Number),
      regionId: 'memory',
      token: 1,
    });
  });

  it('hands the scene a null region for an unknown id rather than crashing', () => {
    renderAt('/openworld/region/atlantis');
    expect(sceneProps.current.focusedRegion).toBeNull();
  });

  it('defaults to the Vibes world style, and reflects it in the scene settings', () => {
    renderAt('/openworld');
    expect(sceneProps.current.settings.worldStyle).toBe('vibes');
    expect(sceneProps.current.settings.timeOfDay).toMatch(/^vibes/);
    expect(sceneProps.current.palette.lowPoly).toBe(true);
  });

  it('honors a stored cyber style, restoring the original preset pair', () => {
    localStorage.setItem('portos-city-settings', JSON.stringify({ worldStyle: 'cyber' }));
    renderAt('/openworld');
    expect(sceneProps.current.settings.worldStyle).toBe('cyber');
    expect(sceneProps.current.settings.timeOfDay).toBe('sunset');
    expect(sceneProps.current.palette.lowPoly).toBe(false);
  });

  it('opens fast travel with M and warps to the picked region', () => {
    renderAt('/openworld');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });

    fireEvent.click(screen.getByLabelText('Teleport to Memory Quarter'));

    expect(screen.getByTestId('path')).toHaveTextContent('/openworld/region/memory');
    expect(sceneProps.current.focusedRegion.id).toBe('memory');
  });

  it('opens fast travel from the HUD button too', () => {
    renderAt('/openworld');
    fireEvent.click(screen.getByText('hud-fast-travel'));
    expect(screen.getByLabelText('Teleport to Memory Quarter')).toBeInTheDocument();
  });

  it('closes fast travel with Escape', () => {
    renderAt('/openworld');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    expect(screen.getByLabelText('Search regions')).toBeInTheDocument();

    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByLabelText('Search regions')).not.toBeInTheDocument();
  });

  it('arms no arrival point until something is actually warped to', () => {
    renderAt('/openworld');
    expect(sceneProps.current.playerTeleport).toBeNull();
  });

  it(`arms the walking player's arrival point on every warp, exploring or not`, () => {
    // PlayerController mounts only in exploration mode and applies the current token on
    // mount, so arming it from the orbital overview is what makes "warp, then Tab in"
    // land at the region rather than the old spawn.
    renderAt('/openworld');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByLabelText('Teleport to Memory Quarter'));

    const teleport = sceneProps.current.playerTeleport;
    expect(teleport).toMatchObject({ x: expect.any(Number), z: expect.any(Number) });
    expect(teleport.token).toBe(1);
  });

  it('teleports the player when warping on foot', () => {
    localStorage.setItem('portos-city-settings', JSON.stringify({ explorationMode: true }));
    renderAt('/openworld');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByLabelText('Teleport to Memory Quarter'));

    const teleport = sceneProps.current.playerTeleport;
    expect(teleport).toMatchObject({ x: expect.any(Number), z: expect.any(Number) });
    expect(teleport.token).toBe(1);
  });

  it('bumps the teleport token when the same region is picked twice', () => {
    renderAt('/openworld');

    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByLabelText('Teleport to Memory Quarter'));
    expect(sceneProps.current.playerTeleport.token).toBe(1);

    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByLabelText('Teleport to Memory Quarter'));
    // Same destination, new warp — a plain {x,z} identity check would have swallowed this.
    expect(sceneProps.current.playerTeleport.token).toBe(2);
  });

  it('does not bank an M keypress while photo mode owns the camera', () => {
    // The panel is hidden in photo/playback mode; a live binding there would spring it
    // open the moment the user returned to the live view.
    renderAt('/openworld');
    fireEvent.click(screen.getByText('hud-photo'));
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    expect(screen.queryByLabelText('Search regions')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' }); // leave photo mode
    act(() => {});
    expect(screen.queryByLabelText('Search regions')).not.toBeInTheDocument();
  });

  it('tells the HUD which region is active', () => {
    renderAt('/openworld/region/data-harbor');
    expect(screen.getByTestId('hud-region')).toHaveTextContent('data-harbor');
  });

  it('keeps map interactions inside OpenWorld', () => {
    renderAt('/openworld/region/memory');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    expect(screen.queryByTitle(/Open\s+\//)).not.toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/openworld/region/memory');
  });

  it('returns to the overview from the panel', () => {
    renderAt('/openworld/region/memory');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByText('OVERVIEW'));
    expect(screen.getByTestId('path')).toHaveTextContent('/openworld');
    expect(sceneProps.current.focusedRegion).toBeNull();
  });
});
