import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useCityData } from '../hooks/useCityData';
import useCityAudio from '../hooks/useCityAudio';
import useKeyboardControls from '../hooks/useKeyboardControls';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import * as api from '../services/api';
import CityScene from '../components/city/CityScene';
import CityHud from '../components/city/CityHud';
import CityScanlines from '../components/city/CityScanlines';
import CityPhotoOverlay from '../components/city/CityPhotoOverlay';
import { CitySettingsProvider, useCitySettingsContext } from '../components/city/CitySettingsContext';
import CitySettingsPanel from '../components/city/CitySettingsPanel';
import { computeFilterResult } from '../utils/cityFilter';
import { DEFAULT_PRESET_ID, cyclePreset } from '../utils/cityPhotoMode';

function CyberCityInner() {
  const { apps, cosAgents, cosStatus, eventLogs, agentMap, reviewCounts, instances, systemHealth, notificationCounts, backupStatus, cosTasks, healthMetrics, voiceState, character, aiActivity, loading, connected } = useCityData();
  const { settings, updateSetting } = useCitySettingsContext();
  const { playSfx } = useCityAudio(settings);
  const navigate = useNavigate();
  const location = useLocation();
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

  const handleToggleExploration = useCallback(() => {
    updateSetting('explorationMode', !settings?.explorationMode);
  }, [updateSetting, settings?.explorationMode]);

  const keysRef = useKeyboardControls(handleToggleExploration);

  // Photo mode (roadmap 3.3): a cinematic capture mode with framing presets and a postcard
  // screenshot. The in-canvas CityPhotoCamera registers its capture function here via a ref so
  // the overlay (outside the Canvas) can trigger a grab. Exiting photo mode clears the fn.
  const [photoMode, setPhotoMode] = useState(false);
  const [photoPresetId, setPhotoPresetId] = useState(DEFAULT_PRESET_ID);
  const captureFnRef = useRef(null);
  const handlePhotoCaptureReady = useCallback((fn) => { captureFnRef.current = fn; }, []);

  // Entering photo mode leaves exploration; they're mutually exclusive camera modes.
  const enterPhotoMode = useCallback(() => {
    updateSetting('explorationMode', false);
    setPhotoPresetId(DEFAULT_PRESET_ID);
    setPhotoMode(true);
  }, [updateSetting]);
  const exitPhotoMode = useCallback(() => setPhotoMode(false), []);

  // Esc exits photo mode; ←/→ cycle the framing preset. Bound only while photo mode is on so it
  // doesn't shadow other shortcuts. Ignores key events while typing in an input.
  useEffect(() => {
    if (!photoMode) return;
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') setPhotoMode(false);
      else if (e.key === 'ArrowLeft') setPhotoPresetId(id => cyclePreset(id, -1));
      else if (e.key === 'ArrowRight') setPhotoPresetId(id => cyclePreset(id, 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photoMode]);

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

  const handleBuildingClick = useCallback((app) => {
    if (app?.id) {
      navigate(`/apps/${app.id}`);
    } else {
      navigate('/apps');
    }
  }, [navigate]);

  const handleJumpToFirst = useCallback(() => {
    const first = filterResult.matches[0];
    if (first?.id) navigate(`/apps/${first.id}`);
  }, [filterResult.matches, navigate]);

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

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4" style={{ background: '#030308' }}>
        <div className="font-pixel text-cyan-400 text-lg tracking-widest animate-pulse" style={{ textShadow: '0 0 12px rgba(6,182,212,0.5)' }}>
          INITIALIZING CYBERCITY
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
    <div className="relative w-full h-full" style={{ background: '#030308', isolation: 'isolate' }}>
      <CityScene
        apps={apps}
        agentMap={agentMap}
        onBuildingClick={handleBuildingClick}
        cosStatus={cosStatus}
        reviewCounts={reviewCounts}
        instances={instances}
        backupStatus={backupStatus}
        cosTasks={cosTasks}
        healthMetrics={healthMetrics}
        voiceState={voiceState}
        aiActivity={aiActivity}
        productivityData={productivityData}
        activityCalendar={activityCalendar}
        goals={goalsData}
        character={character}
        chronotype={chronotypeData}
        memoryGraph={memoryGraph}
        inboxDepth={inboxData?.counts?.needs_review ?? 0}
        photoMode={photoMode}
        photoPresetId={photoPresetId}
        onPhotoCaptureReady={handlePhotoCaptureReady}
        settings={settings}
        playSfx={playSfx}
        keysRef={keysRef}
        dimmedAppIds={filterResult.dimmed}
      />
      {/* The full HUD hides in photo mode so captures are clean; the photo overlay replaces it. */}
      {!photoMode && (
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
        />
      )}
      <CityPhotoOverlay
        active={photoMode}
        presetId={photoPresetId}
        onPresetChange={setPhotoPresetId}
        onExit={exitPhotoMode}
        captureFnRef={captureFnRef}
        statsSnapshot={photoStats}
      />
      <CityScanlines settings={settings} />
      {showSettings && <CitySettingsPanel />}
    </div>
  );
}

export default function CyberCity() {
  return (
    <CitySettingsProvider>
      <CyberCityInner />
    </CitySettingsProvider>
  );
}
