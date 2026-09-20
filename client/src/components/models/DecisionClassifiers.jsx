import { Navigate, useNavigate } from 'react-router';
import { Scale, FlaskConical } from 'lucide-react';
import TabPills from '../ui/TabPills';
import JevPanel from './JevPanel';
import LayaMlxPanel from './LayaMlxPanel';

// Selection is route-backed and stays discoverable while integrations are off.
export const CLASSIFIERS = [
  { id: 'jev', label: 'Jev', icon: Scale },
  { id: 'laya-mlx', label: 'Laya-MLX', icon: FlaskConical },
];

export default function DecisionClassifiers({ view }) {
  const navigate = useNavigate();
  if (!view) return <Navigate to="/models/decision-classifiers/jev" replace />;
  if (!CLASSIFIERS.some(item => item.id === view)) return (
    <div role="alert">Unknown decision classifier. <button type="button" className="text-port-accent underline"
      onClick={() => navigate('/models/decision-classifiers/jev')}>Open Jev</button></div>
  );
  return (
    <div className="space-y-4 min-w-0">
      <div>
        <h2 className="text-lg font-semibold text-white">Decision Classifiers</h2>
        <p className="text-sm text-gray-400">Manage local systems that choose between fixed answers. Selecting a system here does not change automated integrations.</p>
      </div>
      <TabPills tabs={CLASSIFIERS} activeTab={view} onChange={id => navigate(`/models/decision-classifiers/${id}`)}
        ariaLabel="Decision classifiers" controlsIdPrefix="decision-classifier" mobileCompact />
      <div role="tabpanel" id={`decision-classifier-${view}`} aria-labelledby={`tab-${view}`}>
        {view === 'jev' ? <JevPanel /> : <LayaMlxPanel />}
      </div>
    </div>
  );
}
