import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCityData } from '../hooks/useCityData';
import CityScene from '../components/city/CityScene';
import CityHud from '../components/city/CityHud';
import CityScanlines from '../components/city/CityScanlines';

export default function CyberCity() {
  const { apps, cosAgents, cosStatus, eventLogs, agentMap, loading, connected } = useCityData();
  const navigate = useNavigate();

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
      />
      <CityHud
        cosStatus={cosStatus}
        cosAgents={cosAgents}
        agentMap={agentMap}
        eventLogs={eventLogs}
        connected={connected}
        apps={apps}
      />
      <CityScanlines />
    </div>
  );
}
