import { useCallback, useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useCityData } from '../hooks/useCityData';
import useCityAudio from '../hooks/useCityAudio';
import useKeyboardControls from '../hooks/useKeyboardControls';
import * as api from '../services/api';
import CityScene from '../components/city/CityScene';
import CityHud from '../components/city/CityHud';
import CityScanlines from '../components/city/CityScanlines';
import { CitySettingsProvider, useCitySettingsContext } from '../components/city/CitySettingsContext';
import CitySettingsPanel from '../components/city/CitySettingsPanel';
import { computeFilterResult } from '../utils/cityFilter';

function CyberCityInner() {
  const { apps, cosAgents, cosStatus, eventLogs, agentMap, reviewCounts, instances, systemHealth, notificationCounts, loading, connected } = useCityData();
  const { settings, updateSetting } = useCitySettingsContext();
  const { playSfx } = useCityAudio(settings);
  const navigate = useNavigate();
  const location = useLocation();
  const [productivityData, setProductivityData] = useState(null);
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

  // Fetch productivity data for HUD vitals and billboards
  useEffect(() => {
    const fetchProductivity = async () => {
      const data = await api.getCosQuickSummary().catch(() => null);
      setProductivityData(data);
    };
    fetchProductivity();
    const interval = setInterval(fetchProductivity, 60000);
    return () => clearInterval(interval);
  }, []);

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
        productivityData={productivityData}
        settings={settings}
        playSfx={playSfx}
        keysRef={keysRef}
        dimmedAppIds={filterResult.dimmed}
      />
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
        filter={filter}
        onFilterChange={setFilter}
        onJumpToFirst={handleJumpToFirst}
        matchCount={filterResult.matches.length}
        onToggleExploration={handleToggleExploration}
        explorationMode={settings?.explorationMode}
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
