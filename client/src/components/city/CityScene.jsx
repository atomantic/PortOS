import { useState, useCallback, useRef, useEffect, useMemo, Suspense } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import CityGround from './CityGround';
import CityLights from './CityLights';
import CityParticles from './CityParticles';
import CityStarfield from './CityStarfield';
import CityCelestial from './CityCelestial';
import BuildingCluster from './BuildingCluster';
import CityDataStreams from './CityDataStreams';
import CityTraffic from './CityTraffic';
import CityWeather from './CityWeather';
import CityBillboards from './CityBillboards';
import CityShootingStars from './CityShootingStars';
import CityVolumetricLights from './CityVolumetricLights';
import CitySkyline from './CitySkyline';
import CityFederationHorizon from './CityFederationHorizon';
import CityBackupVault from './CityBackupVault';
import CityTaskQueue from './CityTaskQueue';
import CityHealthTower from './CityHealthTower';
import CityProductivityDistrict from './CityProductivityDistrict';
import CityActivityHeatmap from './CityActivityHeatmap';
import CityTaskFlowRiver from './CityTaskFlowRiver';
import CityGoalMonuments from './CityGoalMonuments';
import CityArtifacts from './CityArtifacts';
import CitySeasonalDecor from './CitySeasonalDecor';
import CityEasterEggs from './CityEasterEggs';
import CityVoiceMarker from './CityVoiceMarker';
import CityMemoryDistrict from './CityMemoryDistrict';
import CityDataHarbor from './CityDataHarbor';
import CityJiraDistrict from './CityJiraDistrict';
import CityAiCore from './CityAiCore';
import CityDataRain from './CityDataRain';
import CityNeonSigns from './CityNeonSigns';
import CityEmbers from './CityEmbers';
import CitySignalBeacons from './CitySignalBeacons';
import CitySky from './CitySky';
import CityGalaxySky from './CityGalaxySky';
import CityLandscape from './CityLandscape';
import CityWater from './CityWater';
import CityStreets from './CityStreets';
import CityStreetProps from './CityStreetProps';
import CityTransitLoop from './CityTransitLoop';
import CityEnergyOverlay from './CityEnergyOverlay';
import PlayerController from './PlayerController';
import CameraTransition from './CameraTransition';
import CityFocusCamera from './CityFocusCamera';
import CityPhotoCamera from './CityPhotoCamera';
import CityDepthOfField from './CityDepthOfField';
import { cityDayMix } from './cityConstants';
import { CityPaletteProvider } from './CityPaletteContext';
import ErrorBoundary from '../ErrorBoundary';

const STARTUP_PARTICLE_DENSITY = 0.49;

export default function CityScene({ apps, agentMap, onBuildingClick, onToggleCameraView, cosStatus, reviewCounts, instances, backupStatus, cosTasks, healthMetrics, voiceState, aiActivity, productivityData, activityCalendar, goals, character, chronotype, memoryGraph, inboxDepth, jiraTickets, introspection, playback = false, photoMode, photoPresetId, photoDof, onPhotoCaptureReady, settings, playSfx, keysRef, dimmedAppIds, focusedAppId, hudSafe, background, palette }) {
  const [positions, setPositions] = useState(null);
  const [proximityApp, setProximityApp] = useState(null);
  const [transitioning, setTransitioning] = useState(false);
  const [webglLost, setWebglLost] = useState(false);
  const [startupSettled, setStartupSettled] = useState(false);
  const prevExplorationRef = useRef(false);
  const orbitRef = useRef(null);
  const contextCleanupRef = useRef(null);
  const contextLostTimerRef = useRef(null);
  const activeCanvasRef = useRef(null);
  // Shared between CityDepthOfField (which owns the EffectComposer while photo mode is on) and
  // CityPhotoCamera (whose capture path renders through that composer so the postcard matches the
  // DoF preview). Null whenever DoF isn't mounted — capture then falls back to a plain render.
  const photoComposerRef = useRef(null);

  const explorationMode = settings?.explorationMode || false;

  useEffect(() => {
    if (photoMode) {
      setStartupSettled(true);
      return undefined;
    }

    setStartupSettled(false);
    const timer = window.setTimeout(() => setStartupSettled(true), 1200);
    return () => window.clearTimeout(timer);
  }, [apps.length, photoMode]);

  const renderSettings = useMemo(() => {
    if (photoMode || startupSettled) return settings;
    return {
      ...settings,
      reflectionsEnabled: false,
      particleDensity: Math.min(settings?.particleDensity ?? 1, STARTUP_PARTICLE_DENSITY),
      dpr: [1, 1],
    };
  }, [photoMode, settings, startupSettled]);

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

  // Set transitioning=true when exploration mode toggles
  useEffect(() => {
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
  const showGradientBackground = cityDayMix(renderSettings) > 0.5;
  const sceneClearColor = background || '#030308';
  const fallbackBackground = showGradientBackground
    ? 'linear-gradient(180deg, #0f4f9a 0%, #1e78bf 48%, #58a9dc 100%)'
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
          setWebglLost(true);
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
        key={photoMode ? 'photo' : 'live'}
        camera={{ position: [0, 25, 45], fov: 50 }}
        dpr={dpr}
        shadows={false}
        // Photo mode freezes the scene for a clean still (roadmap 3.6): "demand" stops the
        // frameloop once the camera-fly settles, so particles/streams/weather/pulses pause for a
        // deliberate shot. CityPhotoCamera pumps invalidate() during the fly; capture renders
        // directly via gl.render(). Live mode keeps the always-on loop the dashboard relies on.
        frameloop={photoMode ? 'demand' : 'always'}
        onCreated={handleCanvasCreated}
        style={{ background: sceneClearColor, cursor: explorationMode ? 'crosshair' : 'auto', opacity: webglLost ? 0 : 1 }}
        // preserveDrawingBuffer is only needed while taking postcards. Keeping it
        // always-on makes Chromium's WebGL context much easier to lose in the live
        // dashboard, which reads as a blank white scene.
        gl={{ antialias: true, preserveDrawingBuffer: Boolean(photoMode), alpha: false, powerPreference: 'high-performance' }}
      >
      {/* Re-provide the themed palette INSIDE the Canvas — react-three-fiber runs its
          own reconciler, so the provider in CyberCityInner doesn't reach these scene
          components. Plain React Context.Provider works across the r3f tree. */}
      <CityPaletteProvider palette={palette}>
      {/* By day, the solid clear color is the scene background. At night, the galaxy
          Environment below owns scene.background (the equirectangular spheremap), so we
          must NOT also drive <color attach="background"> — both write scene.background and
          would fight every frame. */}
      {showGradientBackground && <color attach="background" args={[sceneClearColor]} />}
      {/* Mount the galaxy environment only at night — keeps its 2.8MB panorama from being
          fetched/decoded (and PMREM-processed) in full daylight, where it's faded out
          anyway. Suspense keeps the texture load from suspending the whole canvas while it
          streams in; the error boundary degrades to the plain dark sky if the texture is
          missing/corrupt (e.g. a partial checkout) instead of crashing. */}
      {!showGradientBackground && (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <CityGalaxySky settings={renderSettings} />
          </Suspense>
        </ErrorBoundary>
      )}
      <CitySky settings={renderSettings} />
      <CityLights settings={renderSettings} />
      <CityLandscape settings={renderSettings} />
      <CityWater settings={renderSettings} />
      <CityEnergyOverlay chronotype={chronotype} settings={renderSettings} />
      <CityStarfield settings={renderSettings} />
      <CityShootingStars playSfx={playSfx} settings={renderSettings} />
      {!explorationMode && <CityCelestial settings={renderSettings} />}
      <CitySkyline settings={renderSettings} />
      <CityFederationHorizon instances={instances} settings={renderSettings} />
      <CityBackupVault backupStatus={backupStatus} settings={renderSettings} />
      <CityTaskQueue cosTasks={cosTasks} settings={renderSettings} />
      <CityHealthTower healthMetrics={healthMetrics} settings={renderSettings} />
      <CityProductivityDistrict productivityData={productivityData} settings={renderSettings} />
      <CityActivityHeatmap calendarData={activityCalendar} settings={renderSettings} />
      <CityTaskFlowRiver cosTasks={cosTasks} productivityData={productivityData} calendarData={activityCalendar} settings={renderSettings} />
      <CityGoalMonuments goals={goals} settings={renderSettings} />
      <CityArtifacts character={character} goals={goals} productivityData={productivityData} settings={renderSettings} />
      <CitySeasonalDecor settings={renderSettings} />
      <CityEasterEggs character={character} goals={goals} productivityData={productivityData} settings={renderSettings} />
      <CityVoiceMarker voiceState={voiceState} settings={renderSettings} />
      <CityMemoryDistrict memoryGraph={memoryGraph} inboxDepth={inboxDepth} settings={renderSettings} />
      <CityDataHarbor introspection={introspection} settings={renderSettings} />
      <CityJiraDistrict jiraTickets={jiraTickets} settings={renderSettings} />
      <CityAiCore aiActivity={aiActivity} positions={positions} apps={apps} settings={renderSettings} />
      <CityGround settings={renderSettings} />
      <CityStreets settings={renderSettings} />
      <CityStreetProps settings={renderSettings} />
      <CityTransitLoop settings={renderSettings} />

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
      <CityDataStreams positions={positions} apps={apps} agentMap={agentMap} />
      <CityTraffic positions={positions} />
      <CityBillboards
        positions={positions}
        apps={apps}
        cosStatus={cosStatus}
        reviewCounts={reviewCounts}
        instances={instances}
        productivityData={productivityData}
      />
      <CitySignalBeacons positions={positions} reviewCounts={reviewCounts} instances={instances} settings={renderSettings} />
      <CityVolumetricLights positions={positions} settings={renderSettings} />
      <CityNeonSigns positions={positions} />
      <CityWeather stoppedCount={stoppedCount} totalCount={totalCount} playSfx={playSfx} />
      <CityDataRain />
      <CityEmbers />
      <CityParticles settings={renderSettings} />
      {explorationMode && (
        <PlayerController
          keysRef={keysRef}
          positions={positions}
          onBuildingProximity={handleBuildingProximity}
          onBuildingClick={onBuildingClick}
          onToggleCameraView={onToggleCameraView}
          apps={apps}
          active={explorationMode}
          transitioning={transitioning}
          cameraView={settings?.cameraView ?? 'third'}
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
          maxDistance={120}
          enableDamping
          dampingFactor={0.05}
          mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
          touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }}
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
        <CityFocusCamera
          focusedAppId={focusedAppId}
          positions={positions}
          orbitRef={orbitRef}
          active={!explorationMode && !photoMode}
          hudSafe={hudSafe}
        />
      )}
      <CityPhotoCamera active={photoMode} presetId={photoPresetId} onReady={onPhotoCaptureReady} composerRef={photoComposerRef} />
      {/* Depth-of-field is photo-mode-only: mounting it here (never in the live dashboard) keeps the
          extra composer render targets off the always-on frameloop. It stays mounted for the whole
          photo session and toggles only the bokeh pass via `enabled` — mounting/unmounting per
          toggle would churn render-loop ownership and could strand a blurred frozen frame on screen
          when DoF flips off mid-freeze. */}
      {photoMode && <CityDepthOfField presetId={photoPresetId} enabled={photoDof} composerRef={photoComposerRef} />}
      </CityPaletteProvider>
      </Canvas>
    </div>
  );
}
