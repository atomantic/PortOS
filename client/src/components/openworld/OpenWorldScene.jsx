import { memo, useState, useCallback, useRef, useEffect, useMemo, Suspense } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import WorldGround from './WorldGround';
import OpenWorldLights from './OpenWorldLights';
import OpenWorldParticles from './OpenWorldParticles';
import OpenWorldStarfield from './OpenWorldStarfield';
import OpenWorldCelestial from './OpenWorldCelestial';
import BuildingCluster from './BuildingCluster';
import OpenWorldDataStreams from './OpenWorldDataStreams';
import OpenWorldTraffic from './OpenWorldTraffic';
import OpenWorldWeather from './OpenWorldWeather';
import OpenWorldBillboards from './OpenWorldBillboards';
import OpenWorldShootingStars from './OpenWorldShootingStars';
import OpenWorldVolumetricLights from './OpenWorldVolumetricLights';
import OpenWorldSkyline from './OpenWorldSkyline';
import OpenWorldFederationHorizon from './OpenWorldFederationHorizon';
import OpenWorldBackupVault from './OpenWorldBackupVault';
import OpenWorldTaskQueue from './OpenWorldTaskQueue';
import OpenWorldHealthTower from './OpenWorldHealthTower';
import OpenWorldProductivityDistrict from './OpenWorldProductivityDistrict';
import OpenWorldActivityHeatmap from './OpenWorldActivityHeatmap';
import OpenWorldTaskFlowRiver from './OpenWorldTaskFlowRiver';
import OpenWorldGoalMonuments from './OpenWorldGoalMonuments';
import OpenWorldArtifacts from './OpenWorldArtifacts';
import OpenWorldEasterEggs from './OpenWorldEasterEggs';
import OpenWorldVoiceMarker from './OpenWorldVoiceMarker';
import OpenWorldMemoryDistrict from './OpenWorldMemoryDistrict';
import OpenWorldDataHarbor from './OpenWorldDataHarbor';
import OpenWorldJiraDistrict from './OpenWorldJiraDistrict';
import OpenWorldAiCore from './OpenWorldAiCore';
import OpenWorldDataRain from './OpenWorldDataRain';
import OpenWorldNeonSigns from './OpenWorldNeonSigns';
import OpenWorldEmbers from './OpenWorldEmbers';
import OpenWorldSignalBeacons from './OpenWorldSignalBeacons';
import OpenWorldSky from './OpenWorldSky';
import OpenWorldGalaxySky from './OpenWorldGalaxySky';
import OpenWorldLandscape from './OpenWorldLandscape';
import OpenWorldClouds from './OpenWorldClouds';
import OpenWorldNature from './OpenWorldNature';
import OpenWorldGrass from './OpenWorldGrass';
import OpenWorldWater from './OpenWorldWater';
import OpenWorldStreets from './OpenWorldStreets';
import OpenWorldStreetProps from './OpenWorldStreetProps';
import OpenWorldTransitLoop from './OpenWorldTransitLoop';
import OpenWorldEnergyOverlay from './OpenWorldEnergyOverlay';
import OpenWorldSpeedPads from './OpenWorldSpeedPads';
import OpenWorldCollectibles from './OpenWorldCollectibles';
import PlayerController from './PlayerController';
import CameraTransition from './CameraTransition';
import OpenWorldFocusCamera from './OpenWorldFocusCamera';
import OpenWorldPhotoCamera from './OpenWorldPhotoCamera';
import OpenWorldDepthOfField from './OpenWorldDepthOfField';
import OpenWorldAdaptiveQuality from './OpenWorldAdaptiveQuality';
import { openWorldDayMix, getTimeOfDayPreset } from './openWorldConstants';
import { CITY_MAX_ORBIT_DISTANCE } from '../../utils/openWorldFocusCamera';
import { THIRD_PERSON } from '../../utils/openWorldPlayerRig';
import { listRegions } from '../../utils/openWorldRegions';
import { getResolvedLandmarks } from '../../utils/openWorldProximity';
import { getCollectiblesList } from '../../utils/openWorldCollectibles';
import { computeEasterEggs } from '../../utils/openWorldEasterEggs';
import { OpenWorldPaletteProvider } from './OpenWorldPaletteContext';
import ErrorBoundary from '../ErrorBoundary';
import { useVisibilityEvent } from '../../hooks/useVisibilityEvent';

const STARTUP_PARTICLE_DENSITY = 0.49;

function OpenWorldScene({
  apps,
  agentMap,
  onBuildingClick,
  onToggleCameraView,
  cosStatus,
  reviewCounts,
  instances,
  backupStatus,
  cosTasks,
  healthMetrics,
  voiceState,
  aiActivity,
  productivityData,
  activityCalendar,
  goals,
  character,
  chronotype,
  memoryGraph,
  inboxDepth,
  jiraTickets,
  introspection,
  playback = false,
  photoMode,
  photoPresetId,
  photoDof,
  onPhotoCaptureReady,
  settings,
  playSfx,
  keysRef,
  mobileInputRef,
  playerActionRef,
  dimmedAppIds,
  focusedAppId,
  focusedRegion,
  isFeatureEnabled,
  isPassiveFeatureEnabled,
  playerTeleport,
  hudSafe,
  background,
  palette,
  onTravelToRegion,
  onProximityChange,
  autoQuality = false,
  autoStartTier = 'high',
  autoResetToken = 0,
  onAutoTierChange,
  collectedShardIds = new Set(),
  onCollectShard,
  activeBursts = [],
  onPlayerPoseChange,
}) {
  const [positions, setPositions] = useState(null);
  const [proximityApp, setProximityApp] = useState(null);
  const [proximityWarpPad, setProximityWarpPad] = useState(null);
  const [transitioning, setTransitioning] = useState(false);
  const [webglLost, setWebglLost] = useState(false);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [contextRecoveryMode, setContextRecoveryMode] = useState(false);
  const [startupSettled, setStartupSettled] = useState(false);
  // Visibility-aware frameloop (issue #2592): pause the live OpenWorld render loop while the
  // tab is hidden, resume (with a fresh warm-up) when it's shown again. `resumeToken`
  // bumps on each show so the warm-up effect re-runs and the adaptive budget re-arms.
  const [documentHidden, setDocumentHidden] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
  );
  const [resumeToken, setResumeToken] = useState(0);
  // Bumped whenever the scene warm-up (re)starts — startup, an app-count change, or a
  // visibility resume — so the adaptive budget re-arms and ignores the 1.2s of artificially
  // cheap (forced-Low) warm-up frames instead of banking them as headroom/erasing pressure.
  const [budgetRearmToken, setBudgetRearmToken] = useState(0);
  useVisibilityEvent(useCallback((state) => {
    const hidden = state === 'hidden';
    setDocumentHidden(hidden);
    if (!hidden) setResumeToken(t => t + 1);
  }, []));
  const prevExplorationRef = useRef(null);
  const orbitRef = useRef(null);
  const contextCleanupRef = useRef(null);
  const contextLostTimerRef = useRef(null);
  const activeCanvasRef = useRef(null);
  const contextRecoveryRef = useRef(0);
  // Shared between OpenWorldDepthOfField (which owns the EffectComposer while photo mode is on) and
  // OpenWorldPhotoCamera (whose capture path renders through that composer so the postcard matches the
  // DoF preview). Null whenever DoF isn't mounted — capture then falls back to a plain render.
  const photoComposerRef = useRef(null);

  const explorationMode = settings?.explorationMode ?? true;
  // Art direction gate, read off the palette every other themed surface already consumes
  // (Building, ProcessBuilding, OpenWorldLandscape) rather than re-resolving the style from
  // settings — one bit, one channel. The neon-night layers below (galaxy spheremap,
  // starfield/shooting stars, data rain, embers, volumetric light cones, neon signage)
  // belong to the OpenWorld style; over the Vibes world's sunlit low-poly landscape they
  // read as haze and grain, so they don't mount at all rather than fading per-frame.
  const neonLayers = Boolean(palette?.neonLayers);
  const jiraFeatureEnabled = typeof isPassiveFeatureEnabled === 'function'
    ? isPassiveFeatureEnabled('jira')
    : typeof isFeatureEnabled === 'function' ? isFeatureEnabled('jira') : true;
  const warpRegions = useMemo(() => listRegions(isFeatureEnabled), [isFeatureEnabled]);
  const landmarks = useMemo(() => getResolvedLandmarks(isFeatureEnabled), [isFeatureEnabled]);
  const collectibles = useMemo(() => getCollectiblesList(isPassiveFeatureEnabled), [isPassiveFeatureEnabled]);
  const easterEggsList = useMemo(
    () => computeEasterEggs({ character, goals }),
    [character, goals]
  );

  useEffect(() => {
    if (photoMode) {
      setStartupSettled(true);
      return undefined;
    }

    setStartupSettled(false);
    setBudgetRearmToken(t => t + 1);
    const timer = window.setTimeout(() => setStartupSettled(true), 1200);
    return () => window.clearTimeout(timer);
  }, [apps.length, photoMode, resumeToken]);

  const renderSettings = useMemo(() => {
    if (!contextRecoveryMode && (photoMode || startupSettled)) return settings;
    // During the startup (and post-visibility-resume) warm-up, drop to the cheapest
    // render path. `effectiveTier: 'low'` also suppresses set dressing + the ray-marched
    // interior-window shader via openWorldShowDetail/openWorldShowInteriorWindows — previously the
    // clamped particleDensity (0.49) did that implicitly; the explicit tier now owns it.
    return {
      ...settings,
      effectiveTier: 'low',
      particleDensity: Math.min(settings?.particleDensity ?? 1, contextRecoveryMode ? 0.25 : STARTUP_PARTICLE_DENSITY),
      dpr: [1, 1],
    };
  }, [contextRecoveryMode, photoMode, settings, startupSettled]);

  const clearContextTimer = useCallback(() => {
    if (contextLostTimerRef.current) {
      window.clearTimeout(contextLostTimerRef.current);
      contextLostTimerRef.current = null;
    }
  }, []);

  // drei's `keyEvents` only (re)connects pointer events to the DOM element in this
  // three-stdlib version — it does NOT attach the keydown listener OrbitControls
  // needs for arrow-key panning. Wire that explicitly when the orbital controls are
  // mounted (re-runs when the mode flips them in/out), with matching teardown.
  useEffect(() => {
    const controls = orbitRef.current;
    if (!controls?.listenToKeyEvents) return undefined;
    controls.listenToKeyEvents(window);
    return () => controls.stopListenToKeyEvents?.();
  }, [explorationMode, transitioning, photoMode]);

  useEffect(() => () => {
    clearContextTimer();
    contextCleanupRef.current?.();
  }, [clearContextTimer]);

  // Set transitioning=true when exploration mode toggles. The initial mount is
  // already in the requested mode; starting a transition there briefly hands the
  // camera to the orbital framing before the player rig takes over.
  useEffect(() => {
    if (prevExplorationRef.current === null) {
      prevExplorationRef.current = explorationMode;
      return;
    }
    if (prevExplorationRef.current !== explorationMode) {
      setTransitioning(true);
      prevExplorationRef.current = explorationMode;
    }
  }, [explorationMode]);

  const handlePositionsReady = useCallback((pos) => {
    setPositions(pos);
  }, []);

  const handleBuildingProximity = useCallback((app) => {
    setProximityApp(app);
  }, []);

  const handleWarpPadProximity = useCallback((region) => {
    setProximityWarpPad(region);
  }, []);

  useEffect(() => {
    if (explorationMode) return;
    setProximityApp(null);
    setProximityWarpPad(null);
  }, [explorationMode]);

  useEffect(() => {
    if (!explorationMode) {
      onProximityChange?.(null);
      return;
    }
    if (proximityWarpPad) {
      onProximityChange?.({ type: 'warpPad', id: proximityWarpPad.id, label: proximityWarpPad.label });
      return;
    }
    onProximityChange?.(proximityApp ? { type: 'building', id: proximityApp.id, label: proximityApp.name } : null);
  }, [explorationMode, onProximityChange, proximityApp, proximityWarpPad]);

  const handleTransitionComplete = useCallback(() => {
    setTransitioning(false);
  }, []);

  // Weather reflects confirmed outages. A PM2-unavailable ('unknown') app's
  // status is simply unknown, not down — excluded so a read blip doesn't
  // conjure rain/lightning over apps that may well be online.
  const stoppedCount = apps.filter(a => !a.archived && a.overallStatus !== 'online' && a.overallStatus !== 'unknown').length;
  const totalCount = apps.filter(a => !a.archived).length;

  // Quality presets always express dpr as a [min, max] pair. Cap it to the live
  // ceiling so a high preset can't push a context-losing pixel ratio; photo mode
  // gets a touch more for crisp postcards.
  const rawDpr = renderSettings?.dpr || [1, 1.25];
  const dprLimit = photoMode ? 1.5 : 1.25;
  const dpr = rawDpr.map(value => Math.min(value, dprLimit));
  const showGradientBackground = openWorldDayMix(renderSettings) > 0.5;
  const sceneClearColor = background || '#030308';
  // The pre-canvas / WebGL-lost backdrop. Under OpenWorld's daylight it's the blue sky
  // gradient; under the Vibes style the sky is warm at the horizon, so it takes its bands
  // from the resolved scene color rather than the hardcoded cyber gradient.
  const skyPreset = getTimeOfDayPreset(renderSettings?.timeOfDay ?? 'sunset');
  const fallbackBackground = showGradientBackground
    ? `linear-gradient(180deg, ${skyPreset.zenith} 0%, ${skyPreset.midSky} 48%, ${skyPreset.horizonLow} 100%)`
    : sceneClearColor;

  const handleCanvasCreated = useCallback(({ gl }) => {
    contextCleanupRef.current?.();
    const canvas = gl.domElement;
    activeCanvasRef.current = canvas;
    clearContextTimer();
    const handleContextLost = (event) => {
      event.preventDefault();
      clearContextTimer();
      contextLostTimerRef.current = window.setTimeout(() => {
        contextLostTimerRef.current = null;
        if (activeCanvasRef.current !== canvas || !canvas.isConnected) return;
        const context = gl.getContext?.();
        if (context?.isContextLost?.()) {
          // A transient mobile GPU reset can recover if the renderer is recreated
          // at the cheap tier. Give it one bounded retry instead of leaving the
          // player with an invisible Canvas forever. If the replacement also loses
          // its context, keep the fallback visible and stop retrying.
          if (contextRecoveryRef.current < 1) {
            contextRecoveryRef.current += 1;
            setContextRecoveryMode(true);
            setWebglLost(false);
            setCanvasRevision(revision => revision + 1);
          } else {
            setWebglLost(true);
          }
        }
      }, 750);
    };
    const handleContextRestored = () => {
      clearContextTimer();
      setWebglLost(false);
    };
    canvas.addEventListener('webglcontextlost', handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', handleContextRestored, false);
    contextCleanupRef.current = () => {
      clearContextTimer();
      if (activeCanvasRef.current === canvas) {
        activeCanvasRef.current = null;
      }
      canvas.removeEventListener('webglcontextlost', handleContextLost, false);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored, false);
    };
    setWebglLost(false);
  }, [clearContextTimer]);

  return (
    <div className="absolute inset-0" style={{ background: fallbackBackground }}>
      <Canvas
        key={`${photoMode ? 'photo' : 'live'}-${canvasRevision}`}
        camera={{ position: [0, 25, 45], fov: THIRD_PERSON.fov }}
        dpr={dpr}
        shadows={false}
        // Photo mode freezes the scene for a clean still (roadmap 3.6): "demand" stops the
        // frameloop once the camera-fly settles, so particles/streams/weather/pulses pause for a
        // deliberate shot. OpenWorldPhotoCamera pumps invalidate() during the fly; capture renders
        // directly via gl.render(). Live mode keeps the always-on loop the dashboard relies on —
        // except while the tab is hidden, where "never" halts rendering entirely (issue #2592).
        // Photo mode always keeps its own demand loop so capture still works in a hidden tab.
        frameloop={photoMode ? 'demand' : (documentHidden ? 'never' : 'always')}
        onCreated={handleCanvasCreated}
        style={{ background: sceneClearColor, cursor: explorationMode ? 'crosshair' : 'auto', opacity: webglLost ? 0 : 1 }}
        // preserveDrawingBuffer is only needed while taking postcards. Keeping it
        // always-on makes Chromium's WebGL context much easier to lose in the live
        // dashboard, which reads as a blank white scene.
        gl={{ antialias: !contextRecoveryMode, preserveDrawingBuffer: Boolean(photoMode), alpha: false, powerPreference: contextRecoveryMode ? 'default' : 'high-performance' }}
      >
      {/* Re-provide the themed palette INSIDE the Canvas — react-three-fiber runs its
          own reconciler, so the provider in OpenWorldInner doesn't reach these scene
          components. Plain React Context.Provider works across the r3f tree. */}
      <OpenWorldPaletteProvider palette={palette}>
      {/* Exactly one owner for scene.background, written as a ternary so the invariant is
          structural rather than two conditions a reader has to De Morgan: the galaxy
          Environment (the equirectangular spheremap) and a solid <color attach="background">
          both write scene.background and would fight every frame. The galaxy mounts only for
          the neon-night style at night — which also keeps its 2.8MB panorama from being
          fetched/decoded (and PMREM-processed) in daylight, where it's faded out anyway.
          Suspense keeps the texture load from suspending the whole canvas while it streams
          in; the error boundary degrades to the plain solid sky if the texture is
          missing/corrupt (e.g. a partial checkout) instead of crashing. */}
      {neonLayers && !showGradientBackground ? (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <OpenWorldGalaxySky settings={renderSettings} />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <color attach="background" args={[sceneClearColor]} />
      )}
      <OpenWorldSky settings={renderSettings} />
      {/* `lightingTier` is the SETTLED tier, deliberately not the warm-up-clamped
          one: the accent-light gate changes the scene's light COUNT, which is part
          of three.js's shader program cache key, so letting the clamp toggle it
          would recompile every lit material 1.2s into each load. */}
      <OpenWorldLights settings={renderSettings} lightingTier={settings?.effectiveTier} />
      <OpenWorldLandscape settings={renderSettings} />
      {palette?.lowPoly && <OpenWorldClouds settings={renderSettings} />}
      <OpenWorldNature settings={renderSettings} />
      <OpenWorldGrass settings={renderSettings} />
      <OpenWorldWater settings={renderSettings} />
      <OpenWorldEnergyOverlay chronotype={chronotype} settings={renderSettings} />
      {neonLayers && <OpenWorldStarfield settings={renderSettings} />}
      {neonLayers && <OpenWorldShootingStars playSfx={playSfx} settings={renderSettings} />}
      {!explorationMode && !palette?.lowPoly && <OpenWorldCelestial settings={renderSettings} />}
      <OpenWorldSkyline settings={renderSettings} />
      <OpenWorldFederationHorizon instances={instances} settings={renderSettings} />
      <OpenWorldBackupVault backupStatus={backupStatus} settings={renderSettings} />
      <OpenWorldTaskQueue cosTasks={cosTasks} settings={renderSettings} />
      <OpenWorldHealthTower healthMetrics={healthMetrics} settings={renderSettings} />
      <OpenWorldProductivityDistrict productivityData={productivityData} settings={renderSettings} />
      <OpenWorldActivityHeatmap calendarData={activityCalendar} settings={renderSettings} />
      <OpenWorldTaskFlowRiver cosTasks={cosTasks} productivityData={productivityData} calendarData={activityCalendar} settings={renderSettings} />
      <OpenWorldGoalMonuments goals={goals} settings={renderSettings} />
      <OpenWorldArtifacts character={character} goals={goals} settings={renderSettings} />
      <OpenWorldEasterEggs character={character} goals={goals} settings={renderSettings} />
      <OpenWorldVoiceMarker voiceState={voiceState} settings={renderSettings} />
      <OpenWorldMemoryDistrict memoryGraph={memoryGraph} inboxDepth={inboxDepth} settings={renderSettings} />
      <OpenWorldDataHarbor introspection={introspection} settings={renderSettings} />
      {jiraFeatureEnabled && <OpenWorldJiraDistrict jiraTickets={jiraTickets} settings={renderSettings} />}
      <OpenWorldAiCore aiActivity={aiActivity} positions={positions} apps={apps} settings={renderSettings} />
      <WorldGround settings={renderSettings} />
      <OpenWorldStreets settings={renderSettings} />
      <OpenWorldStreetProps settings={renderSettings} />
      <OpenWorldSpeedPads settings={renderSettings} />
      <OpenWorldCollectibles
        collectedShardIds={collectedShardIds}
        activeBursts={activeBursts}
        settings={renderSettings}
        shards={collectibles}
      />
      <OpenWorldTransitLoop settings={renderSettings} />

      <BuildingCluster
        apps={apps}
        agentMap={agentMap}
        onBuildingClick={onBuildingClick}
        onPositionsReady={handlePositionsReady}
        playSfx={playSfx}
        settings={renderSettings}
        proximityAppId={proximityApp?.id}
        dimmedAppIds={dimmedAppIds}
        focusedAppId={focusedAppId}
        playback={playback}
      />
      <OpenWorldDataStreams positions={positions} apps={apps} agentMap={agentMap} />
      <OpenWorldTraffic positions={positions} />
      <OpenWorldBillboards
        positions={positions}
        apps={apps}
        cosStatus={cosStatus}
        reviewCounts={reviewCounts}
        instances={instances}
        productivityData={productivityData}
      />
      <OpenWorldSignalBeacons
        positions={positions}
        reviewCounts={reviewCounts}
        instances={instances}
        settings={renderSettings}
        activeRegionId={focusedRegion?.id}
        onTravelToRegion={onTravelToRegion}
        regions={warpRegions}
      />
      {neonLayers && <OpenWorldVolumetricLights positions={positions} settings={renderSettings} />}
      {neonLayers && <OpenWorldNeonSigns positions={positions} />}
      <OpenWorldWeather stoppedCount={stoppedCount} totalCount={totalCount} playSfx={playSfx} />
      {neonLayers && <OpenWorldDataRain settings={renderSettings} />}
      {neonLayers && <OpenWorldEmbers settings={renderSettings} />}
      <OpenWorldParticles settings={renderSettings} />
      {explorationMode && (
        <PlayerController
          keysRef={keysRef}
          positions={positions}
          onBuildingProximity={handleBuildingProximity}
          onWarpPadProximity={handleWarpPadProximity}
          onProximityChange={onProximityChange}
          onBuildingClick={onBuildingClick}
          onToggleCameraView={onToggleCameraView}
          apps={apps}
          active={explorationMode}
          transitioning={transitioning}
          cameraView={settings?.cameraView ?? 'third'}
          teleport={playerTeleport}
          warpPads={warpRegions}
          landmarks={landmarks}
          onWarpPadInteract={onTravelToRegion}
          easterEggs={easterEggsList.eggs}
          shards={collectibles}
          collectedShardIds={collectedShardIds}
          onCollectShard={onCollectShard}
          onPlayerPoseChange={onPlayerPoseChange}
          playSfx={playSfx}
          mobileInputRef={mobileInputRef}
          playerActionRef={playerActionRef}
        />
      )}
      {!explorationMode && !transitioning && !photoMode && (
        <OrbitControls
          // Map-style navigation: left-drag pans the camera across the city (so you can
          // reach off-center districts without first-person mode), right-drag rotates, scroll
          // zooms, arrow keys pan (wired via listenToKeyEvents in the effect above). On a Mac
          // trackpad, ctrl+drag registers as a right-click so it rotates. screenSpacePanning=
          // false keeps panning in the ground plane (map feel).
          ref={orbitRef}
          enablePan
          screenSpacePanning={false}
          panSpeed={1.0}
          keyPanSpeed={24}
          maxPolarAngle={Math.PI / 2.2}
          minDistance={5}
          // Shared with the framing math (see CITY_MAX_ORBIT_DISTANCE) so a fast-travel fly
          // never ends past a distance the controls would immediately snap back.
          maxDistance={CITY_MAX_ORBIT_DISTANCE}
          enableDamping
          dampingFactor={0.05}
          mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
          touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }}
        />
      )}
      {/* Auto quality mode: samples frame times inside the live loop and lifts tier
          changes back up to the page. Never mounted in photo mode (its demand loop
          isn't a steady-state signal). Renders nothing. */}
      {!photoMode && (
        <OpenWorldAdaptiveQuality
          enabled={autoQuality}
          startTier={autoStartTier}
          resumeToken={budgetRearmToken}
          resetToken={autoResetToken}
          onTierChange={onAutoTierChange}
        />
      )}
      <CameraTransition
        active={explorationMode}
        onTransitionComplete={handleTransitionComplete}
      />
      {/* URL-addressed building focus (issue #2593). Mounted only in the orbital overview (not
          exploration/photo, which own the camera). Placed AFTER CameraTransition so its per-frame
          camera write wins during any brief overlap on load. */}
      {!explorationMode && !photoMode && (
        <OpenWorldFocusCamera
          focusedAppId={focusedAppId}
          focusedRegion={focusedRegion}
          positions={positions}
          orbitRef={orbitRef}
          active={!explorationMode && !photoMode}
          hudSafe={hudSafe}
        />
      )}
      <OpenWorldPhotoCamera active={photoMode} presetId={photoPresetId} onReady={onPhotoCaptureReady} composerRef={photoComposerRef} />
      {/* Depth-of-field is photo-mode-only: mounting it here (never in the live dashboard) keeps the
          extra composer render targets off the always-on frameloop. It stays mounted for the whole
          photo session and toggles only the bokeh pass via `enabled` — mounting/unmounting per
          toggle would churn render-loop ownership and could strand a blurred frozen frame on screen
          when DoF flips off mid-freeze. */}
      {photoMode && <OpenWorldDepthOfField presetId={photoPresetId} enabled={photoDof} composerRef={photoComposerRef} />}
      </OpenWorldPaletteProvider>
      </Canvas>
    </div>
  );
}

// HUD telemetry (rover pose, clock, socket logs) updates much more often than scene
// inputs. Keep those parent renders out of the expensive r3f tree; React still
// re-enters the scene whenever any actual scene prop changes.
export default memo(OpenWorldScene);
