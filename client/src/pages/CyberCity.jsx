import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useCityData } from '../hooks/useCityData';
import { useCityPlayback } from '../hooks/useCityPlayback';
import useCityAudio from '../hooks/useCityAudio';
import useKeyboardControls from '../hooks/useKeyboardControls';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { mergeFrameIntoCityProps } from '../lib/cityPlaybackFrame';
import * as api from '../services/api';
import CityScene from '../components/city/CityScene';
import CityHud from '../components/city/CityHud';
import CityScanlines from '../components/city/CityScanlines';
import CityPhotoOverlay from '../components/city/CityPhotoOverlay';
import CityPlaybackOverlay from '../components/city/CityPlaybackOverlay';
import { CitySettingsProvider, useCitySettingsContext } from '../components/city/CitySettingsContext';
import CitySettingsDrawer from '../components/city/CitySettingsDrawer';
import { computeFilterResult } from '../utils/cityFilter';
import { resolveCityFocus } from '../utils/cityFocusState';
import useCityViewport from '../hooks/useCityViewport';
import { DEFAULT_PRESET_ID, cyclePreset } from '../utils/cityPhotoMode';
import { computeSoundscape } from '../utils/citySoundscape';
import { CITY_COLORS, deriveCityPalette, resolveCityTimeOfDay } from '../components/city/cityConstants';
import { CityPaletteProvider } from '../components/city/CityPaletteContext';
import { useThemeContext } from '../components/ThemeContext';

function CyberCityInner() {
  const { apps, cosAgents, cosStatus, eventLogs, agentMap, reviewCounts, instances, systemHealth, notificationCounts, backupStatus, cosTasks, healthMetrics, voiceState, character, aiActivity, loading, connected } = useCityData();
  const { settings, updateSetting } = useCitySettingsContext();

  // Ambient soundscape (roadmap 3.4): the music's mood follows system health and its energy
  // follows live agent activity. Derived from data the page already has — no extra fetch.
  const activeAgentCount = useMemo(
    () => (cosAgents || []).filter(a => a.status === 'running' || a.state === 'coding' || a.state === 'thinking' || a.state === 'investigating').length,
    [cosAgents]
  );
  const soundscape = useMemo(
    () => computeSoundscape({ systemHealth, agentCount: activeAgentCount }),
    [systemHealth, activeAgentCount]
  );
  const { playSfx } = useCityAudio(settings, soundscape);
  const navigate = useNavigate();
  const location = useLocation();
  const { appId } = useParams();
  const { isDesktop } = useCityViewport();

  // URL-addressed building focus (issue #2593). The `/city/apps/:appId` route param is the single
  // source of truth for "which borough is focused" — reload/back-forward/deep-link all restore it.
  const { hasFocus, focusedApp, notFound: focusNotFound } = useMemo(
    () => resolveCityFocus(appId, apps, { loading }),
    [appId, apps, loading],
  );
  const focusAgents = useMemo(() => agentMap?.get?.(appId)?.agents || [], [agentMap, appId]);
  // HUD safe area the focus camera frames around: the detail panel sits on the right (desktop) or
  // as a bottom sheet (compact), so keep the borough clear of it.
  const focusHudSafe = useMemo(
    () => (isDesktop ? { right: 0.28, bottom: 0 } : { right: 0, bottom: 0.5 }),
    [isDesktop],
  );

  // CyberCity follows the active PortOS theme: the HUD recolors via the
  // `cybercity-themed` CSS scope (see index.css) and the 3D scene's brand colors
  // + surround are derived from the same theme here.
  const { theme: cityTheme } = useThemeContext();
  // Pure: derive the themed palette and hand it down through CityPaletteContext (and,
  // inside <Canvas>, a second provider in CityScene since r3f's reconciler doesn't
  // bridge context). No more during-render mutation of a shared singleton.
  const cityPalette = useMemo(() => deriveCityPalette(cityTheme), [cityTheme]);

  // The city renders day or night, following the theme mode by default (see
  // resolveCityTimeOfDay). The resolved preset key is handed to the scene via a
  // settings override (CitySky/CityLights/CityGround read settings.timeOfDay), and
  // the backdrop swaps between the blue day sky and the dark night void to match.
  const cityTimeOfDay = resolveCityTimeOfDay(settings?.timeOfDay, cityPalette.isDay);
  const sceneBackground = cityTimeOfDay.daytime ? CITY_COLORS.timeOfDay.noon.midSky : cityPalette.nightBackground;
  const sceneSettings = useMemo(
    () => ({ ...settings, skyTheme: 'cyberpunk', timeOfDay: cityTimeOfDay.presetKey }),
    [settings, cityTimeOfDay.presetKey],
  );

  const [filter, setFilter] = useState(() => {
    // try/catch is necessary because sessionStorage values are external state
    // a corrupted/older-schema entry would throw and crash the page render.
    try {
      const raw = sessionStorage.getItem('cybercity.filter');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.status === 'string') {
          return {
            status: parsed.status,
            search: typeof parsed.search === 'string' ? parsed.search : '',
          };
        }
      }
    } catch {
      // fall through to default
    }
    return { status: 'all', search: '' };
  });

  useEffect(() => {
    // setItem can throw (Safari private mode, storage quota); ignore — this
    // is a UX nicety, not load-bearing state.
    try {
      sessionStorage.setItem('cybercity.filter', JSON.stringify(filter));
    } catch {
      // intentionally swallow
    }
  }, [filter]);

  const filterResult = useMemo(
    () => computeFilterResult({ apps, agentMap, status: filter.status, search: filter.search }),
    [apps, agentMap, filter.status, filter.search]
  );

  const showSettings = location.pathname === '/city/settings';

  // Mode precedence (issue #2593): entering exploration/photo/history while a borough is focused
  // clears the focused route first, so the focus camera + detail panel stand down deterministically
  // before the new mode takes the camera. `hasFocus` reads the URL, the single source of truth.
  const clearFocusRoute = useCallback(() => {
    if (hasFocus) navigate('/city');
  }, [hasFocus, navigate]);

  const handleToggleExploration = useCallback(() => {
    clearFocusRoute();
    updateSetting('explorationMode', !settings?.explorationMode);
  }, [clearFocusRoute, updateSetting, settings?.explorationMode]);

  // V (in exploration mode) swaps the follow-camera character view and first person.
  const handleToggleCameraView = useCallback(() => {
    updateSetting('cameraView', settings?.cameraView === 'first' ? 'third' : 'first');
  }, [updateSetting, settings?.cameraView]);

  const keysRef = useKeyboardControls(handleToggleExploration);

  // Photo mode (roadmap 3.3): a cinematic capture mode with framing presets and a postcard
  // screenshot. The in-canvas CityPhotoCamera registers its capture function here via a ref so
  // the overlay (outside the Canvas) can trigger a grab. Exiting photo mode clears the fn.
  const [photoMode, setPhotoMode] = useState(false);
  const [photoPresetId, setPhotoPresetId] = useState(DEFAULT_PRESET_ID);
  // Depth-of-field for cinematic shots (roadmap 3.3) — on by default since it's the point of the
  // mode; the user can toggle it off (D / overlay button) for a fully-sharp frame.
  const [photoDof, setPhotoDof] = useState(true);
  const captureFnRef = useRef(null);
  const handlePhotoCaptureReady = useCallback((fn) => { captureFnRef.current = fn; }, []);

  // Playback / "history" mode (roadmap 3.6): scrub recorded city-state snapshots.
  // Transport state lives in the hook; the page swaps the current frame's data
  // into the scene props below. Mutually exclusive with photo mode.
  const playback = useCityPlayback();

  // Entering photo mode leaves exploration + playback; they're mutually exclusive modes.
  const enterPhotoMode = useCallback(() => {
    clearFocusRoute();
    updateSetting('explorationMode', false);
    playback.exit();
    setPhotoPresetId(DEFAULT_PRESET_ID);
    setPhotoMode(true);
  }, [clearFocusRoute, updateSetting, playback]);
  const exitPhotoMode = useCallback(() => setPhotoMode(false), []);

  // Entering playback leaves photo + exploration mode.
  const enterPlayback = useCallback(() => {
    clearFocusRoute();
    setPhotoMode(false);
    updateSetting('explorationMode', false);
    playback.enter();
  }, [clearFocusRoute, updateSetting, playback]);

  // Esc exits photo mode; ←/→ cycle the framing preset; D toggles depth-of-field. Bound only while
  // photo mode is on so it doesn't shadow other shortcuts. Ignores key events while typing.
  useEffect(() => {
    if (!photoMode) return;
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') setPhotoMode(false);
      else if (e.key === 'ArrowLeft') setPhotoPresetId(id => cyclePreset(id, -1));
      else if (e.key === 'ArrowRight') setPhotoPresetId(id => cyclePreset(id, 1));
      else if (e.key === 'd' || e.key === 'D') setPhotoDof(v => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photoMode]);

  // Playback keyboard transport: Esc exits, Space play/pause, ←/→ step a frame.
  // Bound only while playback is active. Ignores key events while typing.
  useEffect(() => {
    if (!playback.active) return;
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') playback.exit();
      else if (e.key === ' ') { e.preventDefault(); playback.togglePlay(); }
      else if (e.key === 'ArrowLeft') playback.step(-1);
      else if (e.key === 'ArrowRight') playback.step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playback.active, playback]);

  // Task-complete chime (roadmap 3.4): when a CoS task transitions to completed, play a reward
  // chime. Track the set of completed ids across socket updates and chime on each newly-seen one.
  // Seeded on first populated render (completedSeenRef === null) so a fresh page load doesn't
  // chime for every already-completed task in the backlog.
  const completedSeenRef = useRef(null);
  useEffect(() => {
    const completedIds = (cosTasks || []).filter(t => t?.status === 'completed').map(t => t.id);
    if (completedSeenRef.current === null) {
      completedSeenRef.current = new Set(completedIds);
      return;
    }
    let fired = false;
    for (const id of completedIds) {
      if (!completedSeenRef.current.has(id)) {
        completedSeenRef.current.add(id);
        if (!fired) { playSfx('taskComplete'); fired = true; } // one chime per batch, not per task
      }
    }
  }, [cosTasks, playSfx]);

  // Productivity data for HUD vitals and billboards. Let errors throw —
  // `useAutoRefetch` preserves the last-good snapshot on transient failures.
  const { data: productivityData } = useAutoRefetch(
    () => api.getCosQuickSummary({ silent: true }),
    60_000,
  );

  // Activity calendar drives the productivity district's heatmap ground tiles and feeds the
  // task-flow river's throughput signal. Low-frequency: the daily contribution grid changes
  // slowly. Same last-good-snapshot semantics as productivityData.
  const { data: activityCalendar } = useAutoRefetch(
    () => api.getCosActivityCalendar(12, { silent: true }),
    120_000,
  );

  // Life goals drive the goal-monument district. Same pattern as productivityData —
  // `useAutoRefetch` keeps the last-good snapshot on transient failures.
  const { data: goalsData } = useAutoRefetch(
    () => api.getGoals({ silent: true }),
    120_000,
  );

  // Chronotype profile drives the ambient energy overlay — the city brightens during
  // peak focus hours and dims during recovery. Low-frequency: the daily schedule
  // rarely changes. Same last-good-snapshot semantics as the fetches above.
  const { data: chronotypeData } = useAutoRefetch(
    () => api.getChronotype({ silent: true }),
    600_000,
  );

  // Long-term memory graph drives the knowledge district (crystal clusters + light bridges).
  // The graph changes slowly (new memories trickle in), so a 2-minute poll is plenty. Same
  // last-good-snapshot semantics as the fetches above.
  const { data: memoryGraph } = useAutoRefetch(
    () => api.getMemoryGraph({ silent: true }),
    120_000,
  );

  // Brain-inbox backlog feeds the memory district's glowing well — `needs_review` is the count
  // of captures waiting for the user to sort. Lightweight; the well pulses harder as it grows.
  const { data: inboxData } = useAutoRefetch(
    () => api.getBrainInbox({ status: 'needs_review', limit: 1, silent: true }),
    60_000,
  );

  // Storage introspection drives the Data Harbor district (DB table silos + data/ domain
  // racks on the waterfront). Server-side cache does the heavy lifting; a 2-minute poll
  // keeps the harbor current. `compare` strips the always-changing `ts` so a byte-identical
  // payload keeps its identity and the harbor subtree skips reconciliation.
  const { data: introspection } = useAutoRefetch(
    () => api.getCityIntrospection({ silent: true }),
    120_000,
    {
      compare: (prev, next) =>
        JSON.stringify({ ...prev, ts: null }) === JSON.stringify({ ...next, ts: null }),
    },
  );

  // JIRA sprint district: the set of apps with JIRA wired up (each carries instanceId+projectKey),
  // collapsed to a stable signature that gates and re-triggers the poll only when that set changes.
  const jiraAppsKey = useMemo(
    () => (apps || [])
      .filter(a => a?.jira?.enabled && a.jira.instanceId && a.jira.projectKey)
      .map(a => `${a.jira.instanceId}/${a.jira.projectKey}`)
      .sort().join(','),
    [apps]
  );
  // Fetch each enabled app's current-sprint tickets and merge; the helper dedupes by key. Skip
  // the poll entirely when no app has JIRA configured. Keyed on `jiraAppsKey` so the closure (and
  // poll) refresh when JIRA apps appear/disappear.
  const fetchSprintTickets = useCallback(async () => {
    const specs = (apps || [])
      .filter(a => a?.jira?.enabled && a.jira.instanceId && a.jira.projectKey)
      .map(a => ({ instanceId: a.jira.instanceId, projectKey: a.jira.projectKey }));
    if (specs.length === 0) return [];
    const batches = await Promise.all(
      specs.map(j => api.getMySprintTickets(j.instanceId, j.projectKey, { silent: true }).catch(() => []))
    );
    return batches.flat();
  }, [apps]);
  const { data: jiraTickets } = useAutoRefetch(
    fetchSprintTickets,
    120_000,
    { enabled: jiraAppsKey.length > 0 },
  );

  // Selecting a building focuses it in-place (issue #2593) — the URL becomes /city/apps/:id and the
  // camera flies to frame the borough WITHOUT leaving City. In street-level exploration the old
  // behavior stands (walking up to a building and interacting opens the app page).
  const handleBuildingClick = useCallback((app) => {
    if (!app?.id) return;
    if (settings?.explorationMode) navigate(`/apps/${app.id}`);
    else navigate(`/city/apps/${app.id}`);
  }, [navigate, settings?.explorationMode]);

  const handleJumpToFirst = useCallback(() => {
    const first = filterResult.matches[0];
    if (first?.id) navigate(`/city/apps/${first.id}`);
  }, [filterResult.matches, navigate]);

  // Close focus → back to the plain overview. Open app → the existing app detail page (explicit).
  const handleCloseFocus = useCallback(() => navigate('/city'), [navigate]);
  const handleOpenApp = useCallback((id) => { if (id) navigate(`/apps/${id}`); }, [navigate]);

  // Headline numbers baked onto a captured city postcard. Derived from data the page already
  // has — no extra fetch. buildPostcardStats (in the overlay) omits absent/zero fields.
  const photoStats = useMemo(() => {
    const active = (apps || []).filter(a => !a.archived);
    return {
      online: active.filter(a => a.overallStatus === 'online').length,
      total: active.length,
      agents: (cosAgents || []).filter(a => a.status === 'running' || a.state === 'coding' || a.state === 'thinking').length,
      peers: (instances?.peers || []).filter(p => p.status === 'online').length,
      level: character?.level,
      streak: productivityData?.currentStreak ?? productivityData?.streak,
    };
  }, [apps, cosAgents, instances, character, productivityData]);

  // In playback mode, overlay the current snapshot frame's data onto the props
  // the scene consumes. mergeFrameIntoCityProps returns ONLY the props the frame
  // can faithfully drive (apps, agentMap, cosStatus, backupStatus, character),
  // so anything it omits (the count-only and rich-array landmarks: task queue,
  // federation, health tower, memory, goals, jira, activity, productivity) keeps
  // its live value — the "freeze unfed landmarks at live" behavior; their
  // captured numbers show in the playback overlay instead. Returns null for an
  // unplayable frame → keep live.
  const playbackProps = useMemo(() => {
    if (!playback.active || !playback.currentFrame) return null;
    return mergeFrameIntoCityProps(playback.currentFrame, { apps, agentMap });
  }, [playback.active, playback.currentFrame, apps, agentMap]);

  const v = useCallback((key, live) => (playbackProps && key in playbackProps ? playbackProps[key] : live), [playbackProps]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 cybercity-themed" style={{ background: cityPalette.background }}>
        <div className="font-pixel text-cyan-400 text-lg tracking-widest animate-pulse" style={{ textShadow: '0 0 12px rgba(6,182,212,0.5)' }}>
          INITIALIZING CITY
        </div>
        <div className="w-48 h-1 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-cyan-500 rounded-full animate-pulse" style={{ width: '60%', boxShadow: '0 0 8px rgba(6,182,212,0.5)' }} />
        </div>
        <div className="font-pixel text-[10px] text-cyan-500/40 tracking-wider">
          LOADING SYSTEMS...
        </div>
      </div>
    );
  }

  return (
    <CityPaletteProvider palette={cityPalette}>
    <div className="relative w-full h-full cybercity-themed" style={{ background: sceneBackground, isolation: 'isolate' }}>
      <CityScene
        // A theme switch recolors the live scene in place — NO full-scene remount.
        // Every themed surface either reads the palette fresh each render (declarative
        // `color=` props, palette helper fns) or carries the palette value in its
        // useMemo deps so it rebuilds on a new palette object (CityGround, CityLandscape,
        // CityTraffic, CityNeonSigns, …). The two persistent GPU shader materials whose
        // uniforms are set once at construction (CityBillboards scan overlay,
        // CityVolumetricLights cones) push the new accent into their uColor uniform
        // imperatively, mirroring CitySky's per-frame uniform updates. Dropping the old
        // `key={cityPalette.themeId}` avoids the jarring full-scene rebuild flash.
        palette={cityPalette}
        background={sceneBackground}
        apps={v('apps', apps)}
        agentMap={v('agentMap', agentMap)}
        onBuildingClick={handleBuildingClick}
        onToggleCameraView={handleToggleCameraView}
        cosStatus={v('cosStatus', cosStatus)}
        reviewCounts={reviewCounts}
        instances={instances}
        backupStatus={v('backupStatus', backupStatus)}
        cosTasks={cosTasks}
        healthMetrics={healthMetrics}
        voiceState={voiceState}
        aiActivity={aiActivity}
        productivityData={productivityData}
        activityCalendar={activityCalendar}
        goals={goalsData}
        character={v('character', character)}
        chronotype={chronotypeData}
        memoryGraph={memoryGraph}
        inboxDepth={inboxData?.counts?.needs_review ?? 0}
        jiraTickets={jiraTickets}
        introspection={introspection}
        playback={playback.active}
        photoMode={photoMode}
        photoPresetId={photoPresetId}
        photoDof={photoDof}
        onPhotoCaptureReady={handlePhotoCaptureReady}
        settings={sceneSettings}
        playSfx={playSfx}
        keysRef={keysRef}
        dimmedAppIds={filterResult.dimmed}
        focusedAppId={appId || null}
        hudSafe={focusHudSafe}
      />
      {/* The full HUD hides in photo + playback mode so the view is clean; each
          mode's overlay replaces it. */}
      {!photoMode && !playback.active && (
        <CityHud
          cosStatus={cosStatus}
          cosAgents={cosAgents}
          agentMap={agentMap}
          eventLogs={eventLogs}
          connected={connected}
          apps={apps}
          reviewCounts={reviewCounts}
          instances={instances}
          productivityData={productivityData}
          systemHealth={systemHealth}
          notificationCounts={notificationCounts}
          character={character}
          filter={filter}
          onFilterChange={setFilter}
          onJumpToFirst={handleJumpToFirst}
          matchCount={filterResult.matches.length}
          onToggleExploration={handleToggleExploration}
          explorationMode={settings?.explorationMode}
          onSelectApp={handleBuildingClick}
          onEnterPhotoMode={enterPhotoMode}
          onEnterPlayback={enterPlayback}
          focusedAppId={appId || null}
          focusedApp={focusedApp}
          focusNotFound={focusNotFound}
          focusAgents={focusAgents}
          onCloseFocus={handleCloseFocus}
          onOpenApp={handleOpenApp}
        />
      )}
      <CityPhotoOverlay
        active={photoMode}
        presetId={photoPresetId}
        onPresetChange={setPhotoPresetId}
        onExit={exitPhotoMode}
        captureFnRef={captureFnRef}
        statsSnapshot={photoStats}
        dofEnabled={photoDof}
        onToggleDof={() => setPhotoDof(v => !v)}
      />
      <CityPlaybackOverlay
        active={playback.active}
        loading={playback.loading}
        error={playback.error}
        snapshots={playback.snapshots}
        frameIndex={playback.frameIndex}
        currentFrame={playback.currentFrame}
        stats={playback.stats}
        playing={playback.playing}
        speed={playback.speed}
        onSeek={playback.seek}
        onStep={playback.step}
        onTogglePlay={playback.togglePlay}
        onCycleSpeed={playback.cycleSpeed}
        onExit={playback.exit}
      />
      <CityScanlines settings={settings} crt={cityPalette.crt} />
      {/* Settings on the shared Drawer (issue #2591). Closing preserves other query
          params (e.g. an open cityPane) so the disclosure state survives. */}
      <CitySettingsDrawer open={showSettings} onClose={() => navigate(`/city${location.search}`)} />
    </div>
    </CityPaletteProvider>
  );
}

export default function CyberCity() {
  return (
    <CitySettingsProvider>
      <CyberCityInner />
    </CitySettingsProvider>
  );
}
