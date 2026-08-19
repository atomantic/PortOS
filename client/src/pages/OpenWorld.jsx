import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router';
import { useOpenWorldData } from '../hooks/useOpenWorldData';
import { useOpenWorldPlayback } from '../hooks/useOpenWorldPlayback';
import useOpenWorldAudio from '../hooks/useOpenWorldAudio';
import useKeyboardControls from '../hooks/useKeyboardControls';
import useKeyboardShortcuts from '../hooks/useKeyboardShortcuts';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { mergeFrameIntoOpenWorldProps } from '../lib/openWorldPlaybackFrame';
import * as api from '../services/api';
import OpenWorldScene from '../components/openworld/OpenWorldScene';
import OpenWorldHud from '../components/openworld/OpenWorldHud';
import OpenWorldScanlines from '../components/openworld/OpenWorldScanlines';
import OpenWorldPhotoOverlay from '../components/openworld/OpenWorldPhotoOverlay';
import OpenWorldPlaybackOverlay from '../components/openworld/OpenWorldPlaybackOverlay';
import { OpenWorldSettingsProvider, useOpenWorldSettingsContext } from '../components/openworld/OpenWorldSettingsContext';
import { QUALITY_PRESETS } from '../hooks/useOpenWorldSettings';
import OpenWorldSettingsDrawer from '../components/openworld/OpenWorldSettingsDrawer';
import { computeFilterResult } from '../utils/openWorldFilter';
import { resolveOpenWorldFocus } from '../utils/openWorldFocusState';
import useOpenWorldViewport from '../hooks/useOpenWorldViewport';
import { DEFAULT_PRESET_ID, cyclePreset } from '../utils/openWorldPhotoMode';
import { computeSoundscape } from '../utils/openWorldSoundscape';
import { deriveOpenWorldPalette, getTimeOfDayPreset, resolveOpenWorldTimeOfDay, resolveWorldStyle } from '../components/openworld/openWorldConstants';
import OpenWorldFastTravel from '../components/openworld/OpenWorldFastTravel';
import { getRegion, regionArrivalPoint, regionPath } from '../utils/openWorldRegions';
import { OpenWorldPaletteProvider } from '../components/openworld/OpenWorldPaletteContext';
import { useThemeContext } from '../components/ThemeContext';

function OpenWorldInner() {
  const { apps, cosAgents, cosStatus, eventLogs, agentMap, reviewCounts, instances, systemHealth, notificationCounts, backupStatus, cosTasks, healthMetrics, voiceState, character, aiActivity, loading, connected } = useOpenWorldData();
  const { settings, updateSetting, resetNonce } = useOpenWorldSettingsContext();

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
  const { playSfx } = useOpenWorldAudio(settings, soundscape);
  const navigate = useNavigate();
  const location = useLocation();
  const { appId, regionId } = useParams();
  const { isDesktop } = useOpenWorldViewport();

  // URL-addressed building focus (issue #2593). The `/openworld/apps/:appId` route param is the
  // single source of truth for "which borough is focused" — reload/back-forward/deep-link all
  // restore it.
  const { hasFocus, focusedApp, notFound: focusNotFound } = useMemo(
    () => resolveOpenWorldFocus(appId, apps, { loading }),
    [appId, apps, loading],
  );
  // Fast travel: `/openworld/region/:regionId` is the same contract one level out — the URL says
  // which region you warped to, so a warp is shareable, bookmarkable, and reachable from ⌘K and
  // voice. The registry is static (no loading race), and an unknown id resolves to null, which
  // simply leaves the camera on the overview.
  const focusedRegion = useMemo(() => getRegion(regionId), [regionId]);
  const focusAgents = useMemo(() => agentMap?.get?.(appId)?.agents || [], [agentMap, appId]);
  // HUD safe area the focus camera frames around: the detail panel sits on the right (desktop) or
  // as a bottom sheet (compact), so keep the borough clear of it.
  const focusHudSafe = useMemo(
    () => (isDesktop ? { right: 0.28, bottom: 0 } : { right: 0, bottom: 0.5 }),
    [isDesktop],
  );

  // OpenWorld follows the active PortOS theme: the HUD recolors via the
  // `openworld-themed` CSS scope (see index.css) and the 3D scene's brand colors
  // + surround are derived from the same theme here.
  const { theme: openWorldTheme } = useThemeContext();
  // Art direction — 'vibes' (bright low-poly open world, the default) or 'cyber' (the
  // original neon night). It selects the time-of-day preset pair and the palette's
  // structural/decorative surfaces, so it must resolve before either.
  const worldStyle = resolveWorldStyle(settings?.worldStyle);
  // Pure: derive the themed palette and hand it down through OpenWorldPaletteContext (and,
  // inside <Canvas>, a second provider in OpenWorldScene since r3f's reconciler doesn't
  // bridge context). No more during-render mutation of a shared singleton.
  const openWorldPalette = useMemo(() => deriveOpenWorldPalette(openWorldTheme, worldStyle), [openWorldTheme, worldStyle]);

  // The world renders day or night, following the theme mode by default (see
  // resolveOpenWorldTimeOfDay). The resolved preset key is handed to the scene via a
  // settings override (OpenWorldSky/OpenWorldLights/OpenWorldGround read settings.timeOfDay), and the
  // backdrop takes the matching preset's mid-sky band so the DOM surround behind the
  // canvas agrees with the sky the scene actually paints, in either art direction.
  const openWorldTimeOfDay = resolveOpenWorldTimeOfDay(settings?.timeOfDay, openWorldPalette.isDay, worldStyle);
  const sceneBackground = openWorldTimeOfDay.daytime
    ? getTimeOfDayPreset(openWorldTimeOfDay.presetKey).midSky
    : openWorldPalette.nightBackground;

  // Auto quality mode (issue #2592). In Auto, an adaptive render budget picks the
  // effective tier at runtime (starting at High); in Manual, the effective tier is the
  // saved preset. The runtime tier is deliberately separate from persisted settings —
  // adaptation never rewrites localStorage. `autoDiagnostics` is a local-only readout
  // (never persisted or transmitted). Auto always *starts* at High per the spec, even
  // if the user last had a different manual preset.
  const qualityMode = settings?.qualityMode === 'auto' ? 'auto' : 'manual';
  const [autoTier, setAutoTier] = useState('high');
  const [autoDiagnostics, setAutoDiagnostics] = useState(null);
  const effectiveTier = qualityMode === 'auto' ? autoTier : (settings?.qualityPreset ?? 'high');

  // Clear the stale local diagnostics readout whenever the budget re-arms: a RESET DEFAULTS
  // (resetNonce) or a quality-mode transition (Manual↔Auto). The adaptive budget itself
  // re-arms via OpenWorldScene and re-reports tier + fresh samples on the next window.
  useEffect(() => { setAutoDiagnostics(null); }, [resetNonce, qualityMode]);

  const sceneSettings = useMemo(() => {
    const base = { ...settings, effectiveTier, skyTheme: 'cyberpunk', timeOfDay: openWorldTimeOfDay.presetKey };
    if (qualityMode !== 'auto') return base;
    // Derive the render-affecting fields (reflections, particle density, DPR) from the
    // adaptive tier; leave user-tuned lighting/scanline toggles untouched.
    const tierCfg = QUALITY_PRESETS[effectiveTier] || QUALITY_PRESETS.high;
    return {
      ...base,
      reflectionsEnabled: tierCfg.reflectionsEnabled,
      particleDensity: tierCfg.particleDensity,
      dpr: tierCfg.dpr,
    };
  }, [settings, effectiveTier, qualityMode, openWorldTimeOfDay.presetKey]);

  const [filter, setFilter] = useState(() => {
    // try/catch is necessary because sessionStorage values are external state
    // a corrupted/older-schema entry would throw and crash the page render.
    try {
      const raw = sessionStorage.getItem('openworld.filter');
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
      sessionStorage.setItem('openworld.filter', JSON.stringify(filter));
    } catch {
      // intentionally swallow
    }
  }, [filter]);

  const filterResult = useMemo(
    () => computeFilterResult({ apps, agentMap, status: filter.status, search: filter.search }),
    [apps, agentMap, filter.status, filter.search]
  );

  const showSettings = location.pathname === '/openworld/settings';

  // Mode precedence (issue #2593): entering exploration/photo/history while a borough is focused
  // clears the focused route first, so the focus camera + detail panel stand down deterministically
  // before the new mode takes the camera. `hasFocus` reads the URL, the single source of truth.
  const clearFocusRoute = useCallback(() => {
    if (hasFocus) navigate('/openworld');
  }, [hasFocus, navigate]);

  const handleToggleExploration = useCallback(() => {
    clearFocusRoute();
    updateSetting('explorationMode', !settings?.explorationMode);
  }, [clearFocusRoute, updateSetting, settings?.explorationMode]);

  // V (in exploration mode) swaps the follow-camera character view and first person.
  const handleToggleCameraView = useCallback(() => {
    updateSetting('cameraView', (settings?.cameraView ?? 'third') === 'first' ? 'third' : 'first');
  }, [updateSetting, settings?.cameraView]);

  const keysRef = useKeyboardControls(handleToggleExploration);

  // --- World map / fast travel ----------------------------------------------
  // Warping stays under `/openworld/region/:regionId`; the route param drives the orbital
  // camera and, on foot, the player rig. The destination is still shareable, but it never
  // sends the player to the 2D page represented by that district.
  const [fastTravelOpen, setFastTravelOpen] = useState(false);
  // The walking player's arrival point for the latest warp, carrying a monotonic token so
  // PlayerController can tell "warp again to the same place" from a re-render with equal
  // coordinates — which is why it isn't derived from the region id. Direct region deep links
  // seed the first arrival synchronously; later route changes arm the same handoff in an effect.
  // Set on every warp, not only while exploring: PlayerController mounts only in exploration mode
  // and applies the current token on mount, so arming it unconditionally also means warping in the
  // orbital overview and THEN dropping in (Tab) lands you at the region you were looking at,
  // instead of back at your old spawn.
  const [playerTeleport, setPlayerTeleport] = useState(() => {
    if (!focusedRegion) return null;
    const arrival = regionArrivalPoint(focusedRegion);
    return arrival ? { ...arrival, regionId: focusedRegion.id, token: 1 } : null;
  });
  const lastRoutedRegionIdRef = useRef(regionId);

  const armPlayerTeleport = useCallback((region, force = false) => {
    const arrival = regionArrivalPoint(region);
    if (!arrival) return;
    setPlayerTeleport(prev => {
      if (!force && prev?.regionId === region.id) return prev;
      return { ...arrival, regionId: region.id, token: (prev?.token ?? 0) + 1 };
    });
  }, []);

  useEffect(() => {
    if (!focusedRegion) {
      lastRoutedRegionIdRef.current = regionId;
      return;
    }
    if (lastRoutedRegionIdRef.current === regionId) return;
    lastRoutedRegionIdRef.current = regionId;
    armPlayerTeleport(focusedRegion);
  }, [armPlayerTeleport, focusedRegion, regionId]);

  const handleTravelToRegion = useCallback((region) => {
    if (!region?.id) return;
    navigate(regionPath(region.id));
    // A map pick is an explicit warp even when the destination matches the current route (or
    // stale route state), so always re-arm it; browser back/forward and direct deep links are
    // armed by the effect above.
    armPlayerTeleport(region, true);
    playSfx?.('dataPulse');
  }, [armPlayerTeleport, navigate, playSfx]);

  const openFastTravel = useCallback(() => setFastTravelOpen(true), []);

  // Photo mode (roadmap 3.3): a cinematic capture mode with framing presets and a postcard
  // screenshot. The in-canvas OpenWorldPhotoCamera registers its capture function here via a ref so
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
  const playback = useOpenWorldPlayback();

  // M opens the fast-travel map. Deliberately open-only, not a toggle: the panel is a
  // <Modal>, which owns Esc/backdrop dismissal — and the shared shortcut hook suppresses
  // itself while any `aria-modal` dialog is up, so a toggle binding could never have
  // fired the close half anyway. The hook also drops ⌘/Ctrl/Alt chords, auto-repeat, and
  // keystrokes typed into a field, so the HUD filter and the panel's own search box keep
  // their letters. Inactive in photo and playback mode: those own the camera and hide the
  // panel, so a live binding there would only bank an "open" that springs the panel the
  // moment the user returns to the live view.
  useKeyboardShortcuts(!photoMode && !playback.active, { m: openFastTravel, M: openFastTravel });

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
    () => api.getOpenWorldIntrospection({ silent: true }),
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

  // Selecting a building focuses it in-place (issue #2593) — the URL becomes /openworld/apps/:id and the
  // camera/HUD stay inside OpenWorld. This is also the interaction target for the first-person player:
  // walking up to a building and pressing F opens its live status panel, never the 2D app page.
  const handleBuildingClick = useCallback((app) => {
    if (!app?.id) return;
    navigate(`/openworld/apps/${app.id}`);
  }, [navigate]);

  const handleJumpToFirst = useCallback(() => {
    const first = filterResult.matches[0];
    if (!first?.id) return;
    handleBuildingClick(first);
  }, [filterResult.matches, handleBuildingClick]);

  const handleTravelToRegionId = useCallback((id) => {
    const region = getRegion(id);
    if (region) handleTravelToRegion(region);
  }, [handleTravelToRegion]);

  // Every HUD attention item resolves to a building/region in the world. There is no external
  // page fallback: an item without a more specific destination opens the world map instead.
  const handleAttentionItem = useCallback((item) => {
    if (item?.appId) {
      handleBuildingClick({ id: item.appId });
      return;
    }
    if (item?.regionId) {
      handleTravelToRegionId(item.regionId);
      return;
    }
    openFastTravel();
  }, [handleBuildingClick, handleTravelToRegionId, openFastTravel]);

  // Close focus → back to the plain in-world overview. The panel's primary action also
  // re-focuses the building in OpenWorld rather than opening a separate PortOS page.
  const handleCloseFocus = useCallback(() => navigate('/openworld'), [navigate]);
  const handleFocusInWorld = useCallback((id) => {
    if (id) handleBuildingClick({ id });
  }, [handleBuildingClick]);

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
  // the scene consumes. mergeFrameIntoOpenWorldProps returns ONLY the props the frame
  // can faithfully drive (apps, agentMap, cosStatus, backupStatus, character),
  // so anything it omits (the count-only and rich-array landmarks: task queue,
  // federation, health tower, memory, goals, jira, activity, productivity) keeps
  // its live value — the "freeze unfed landmarks at live" behavior; their
  // captured numbers show in the playback overlay instead. Returns null for an
  // unplayable frame → keep live.
  const playbackProps = useMemo(() => {
    if (!playback.active || !playback.currentFrame) return null;
    return mergeFrameIntoOpenWorldProps(playback.currentFrame, { apps, agentMap });
  }, [playback.active, playback.currentFrame, apps, agentMap]);

  const v = useCallback((key, live) => (playbackProps && key in playbackProps ? playbackProps[key] : live), [playbackProps]);

  // Keep the scene and app shell mounted while the initial data bundle arrives. The route's
  // Suspense boundary already covers the lazy OpenWorld chunk; replacing the entire page here
  // created a second full-screen loader after the first one, then remounted WebGL once the API
  // calls settled. Empty/default props are safe for every landmark, and OpenWorldScene's own
  // warm-up keeps the first data-driven layout cheap while the real values stream in.

  return (
    <OpenWorldPaletteProvider palette={openWorldPalette}>
    <div className="relative w-full h-full openworld-themed" style={{ background: sceneBackground, isolation: 'isolate' }}>
      <OpenWorldScene
        // A theme switch recolors the live scene in place — NO full-scene remount.
        // Every themed surface either reads the palette fresh each render (declarative
        // `color=` props, palette helper fns) or carries the palette value in its
        // useMemo deps so it rebuilds on a new palette object (WorldGround, OpenWorldLandscape,
        // OpenWorldTraffic, OpenWorldNeonSigns, …). The two persistent GPU shader materials whose
        // uniforms are set once at construction (OpenWorldBillboards scan overlay,
        // OpenWorldVolumetricLights cones) push the new accent into their uColor uniform
        // imperatively, mirroring OpenWorldSky's per-frame uniform updates. Dropping the old
        // `key={openWorldPalette.themeId}` avoids the jarring full-scene rebuild flash.
        palette={openWorldPalette}
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
        autoQuality={qualityMode === 'auto'}
        autoStartTier="high"
        autoResetToken={resetNonce}
        diagnosticsEnabled={showSettings}
        onAutoTierChange={setAutoTier}
        onAutoDiagnostics={setAutoDiagnostics}
        focusedAppId={appId || null}
        focusedRegion={focusedRegion}
        playerTeleport={playerTeleport}
        hudSafe={focusHudSafe}
        onTravelToRegion={handleTravelToRegion}
      />
      {/* The full HUD hides in photo + playback mode so the view is clean; each
          mode's overlay replaces it. */}
      {!photoMode && !playback.active && (
        <OpenWorldHud
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
          onFocusInWorld={handleFocusInWorld}
          onOpenFastTravel={openFastTravel}
          onOpenDestination={handleTravelToRegionId}
          onAttentionItem={handleAttentionItem}
          activeRegion={focusedRegion}
        />
      )}
      <OpenWorldPhotoOverlay
        active={photoMode}
        presetId={photoPresetId}
        onPresetChange={setPhotoPresetId}
        onExit={exitPhotoMode}
        captureFnRef={captureFnRef}
        statsSnapshot={photoStats}
        dofEnabled={photoDof}
        onToggleDof={() => setPhotoDof(v => !v)}
      />
      <OpenWorldPlaybackOverlay
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
      {/* World map (M). Hidden in photo + playback mode, which own the camera and would
          fight a warp. Mounted OUTSIDE the HUD's pointer-events-none shell so it can take
          clicks, and above the CRT overlay so its panel isn't scanlined. */}
      <OpenWorldFastTravel
        open={fastTravelOpen && !photoMode && !playback.active}
        onClose={() => setFastTravelOpen(false)}
        onTravel={handleTravelToRegion}
        activeRegionId={focusedRegion?.id || null}
        onLeaveRegion={() => navigate('/openworld')}
      />
      <OpenWorldScanlines settings={settings} crt={openWorldPalette.crt} />
      {/* Settings on the shared Drawer (issue #2591). Closing preserves other query
          params (e.g. an open openWorldPane) so the disclosure state survives. The Auto-quality
          props (#2592) drive the Performance tab's effective-tier label + local diagnostics. */}
      <OpenWorldSettingsDrawer
        open={showSettings}
        onClose={() => navigate(`/openworld${location.search}`)}
        qualityMode={qualityMode}
        effectiveTier={effectiveTier}
        diagnostics={qualityMode === 'auto' ? autoDiagnostics : null}
      />
    </div>
    </OpenWorldPaletteProvider>
  );
}

export default function OpenWorld() {
  return (
    <OpenWorldSettingsProvider>
      <OpenWorldInner />
    </OpenWorldSettingsProvider>
  );
}
