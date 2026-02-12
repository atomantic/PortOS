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
    navigate('/apps');
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: '#030308' }}>
        <div className="font-pixel text-cyan-400 text-sm tracking-widest animate-pulse">
          INITIALIZING CYBERCITY...
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full" style={{ background: '#030308' }}>
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
