import { useCallback, useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useCityData } from '../hooks/useCityData';
import useCityAudio from '../hooks/useCityAudio';
import * as api from '../services/api';
import CityScene from '../components/city/CityScene';
import CityHud from '../components/city/CityHud';
import CityScanlines from '../components/city/CityScanlines';
import { CitySettingsProvider, useCitySettingsContext } from '../components/city/CitySettingsContext';
import CitySettingsPanel from '../components/city/CitySettingsPanel';

function CyberCityInner() {
  const { apps, cosAgents, cosStatus, eventLogs, agentMap, loading, connected } = useCityData();
  const { settings } = useCitySettingsContext();
  const { playSfx } = useCityAudio(settings);
  const navigate = useNavigate();
  const location = useLocation();
  const [productivityData, setProductivityData] = useState(null);

  const showSettings = location.pathname === '/city/settings';

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
        productivityData={productivityData}
        settings={settings}
        playSfx={playSfx}
      />
      <CityHud
        cosStatus={cosStatus}
        cosAgents={cosAgents}
        agentMap={agentMap}
        eventLogs={eventLogs}
        connected={connected}
        apps={apps}
        productivityData={productivityData}
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
