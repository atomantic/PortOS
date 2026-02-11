import { useNavigate } from 'react-router-dom';
import { useCityData } from '../hooks/useCityData';
import CityScene from '../components/city/CityScene';
import CityHud from '../components/city/CityHud';

export default function CyberCity() {
  const navigate = useNavigate();
  const { apps, cosAgents, cosStatus, eventLogs, agentMap, loading, connected } = useCityData();

  const handleBuildingClick = (app) => {
    navigate('/apps');
  };

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
    </div>
  );
}
