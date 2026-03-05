import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Wand2, ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../services/api';
import socket from '../services/socket';
import { TABS, VALID_TAB_IDS } from '../components/feature-agents/constants';
import OverviewTab from '../components/feature-agents/OverviewTab';
import ConfigTab from '../components/feature-agents/ConfigTab';
import RunsTab from '../components/feature-agents/RunsTab';
import OutputTab from '../components/feature-agents/OutputTab';
import GitTab from '../components/feature-agents/GitTab';
import BrailleSpinner from '../components/BrailleSpinner';

export default function FeatureAgentDetail() {
  const { id, tab } = useParams();
  const navigate = useNavigate();
  const isCreate = !id;
  const activeTab = VALID_TAB_IDS.has(tab) ? tab : 'overview';

  const [agent, setAgent] = useState(null);
  const [loading, setLoading] = useState(!isCreate);
  const [apps, setApps] = useState([]);

  useEffect(() => {
    api.getApps().then(data => setApps((data || []).filter(a => !a.archived))).catch(() => {});
  }, []);

  const fetchAgent = useCallback(() => {
    if (isCreate) return;
    api.getFeatureAgent(id).then(data => {
      setAgent(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [id, isCreate]);

  useEffect(() => {
    fetchAgent();
    const handler = (data) => { if (data.id === id) fetchAgent(); };
    socket.on('cos:feature-agent:status', handler);
    socket.on('cos:feature-agent:run-complete', handler);
    return () => {
      socket.off('cos:feature-agent:status', handler);
      socket.off('cos:feature-agent:run-complete', handler);
    };
  }, [fetchAgent, id]);

  const handleStart = useCallback((agentId) => {
    api.startFeatureAgent(agentId).then(data => { setAgent(prev => ({ ...prev, ...data })); toast.success('Activated'); }).catch(() => {});
  }, []);
  const handlePause = useCallback((agentId) => {
    api.pauseFeatureAgent(agentId).then(data => { setAgent(prev => ({ ...prev, ...data })); toast.success('Paused'); }).catch(() => {});
  }, []);
  const handleResume = useCallback((agentId) => {
    api.resumeFeatureAgent(agentId).then(data => { setAgent(prev => ({ ...prev, ...data })); toast.success('Resumed'); }).catch(() => {});
  }, []);
  const handleStop = useCallback((agentId) => {
    api.stopFeatureAgent(agentId).then(data => { setAgent(prev => ({ ...prev, ...data })); toast.success('Stopped'); }).catch(() => {});
  }, []);
  const handleTrigger = useCallback((agentId) => {
    api.triggerFeatureAgent(agentId).then(() => toast.success('Run triggered')).catch(() => {});
  }, []);

  const handleSave = useCallback((saved) => {
    if (isCreate) {
      navigate(`/feature-agents/${saved.id}/overview`);
    } else {
      setAgent(prev => ({ ...prev, ...saved }));
    }
  }, [isCreate, navigate]);

  if (loading) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <BrailleSpinner text="Loading agent" />
      </div>
    );
  }

  if (!isCreate && !agent) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <p className="text-gray-400">Feature agent not found</p>
        <Link to="/feature-agents" className="text-port-accent text-sm mt-2 hover:underline">Back to list</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-port-border">
        <div className="flex items-center gap-3 mb-3">
          <Link to="/feature-agents" className="p-1.5 text-gray-400 hover:text-white hover:bg-port-border/50 rounded-lg transition-colors">
            <ArrowLeft size={18} />
          </Link>
          <Wand2 size={22} className="text-port-accent" />
          <div>
            <h1 className="text-lg font-bold text-white">
              {isCreate ? 'Create Feature Agent' : agent.name}
            </h1>
            {!isCreate && (
              <p className="text-xs text-gray-500">{agent.id} &middot; {agent.appId}</p>
            )}
          </div>
        </div>

        {!isCreate && (
          <div className="flex gap-1 overflow-x-auto">
            {TABS.map(({ id: tabId, label, icon: Icon }) => (
              <button
                key={tabId}
                onClick={() => navigate(`/feature-agents/${id}/${tabId}`)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  activeTab === tabId
                    ? 'bg-port-accent/10 text-port-accent'
                    : 'text-gray-400 hover:text-white hover:bg-port-border/50'
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {(isCreate || activeTab === 'config') && (
          <ConfigTab agent={agent} isCreate={isCreate} apps={apps} onSave={handleSave} />
        )}
        {!isCreate && activeTab === 'overview' && (
          <OverviewTab agent={agent} onStart={handleStart} onPause={handlePause} onResume={handleResume} onStop={handleStop} onTrigger={handleTrigger} />
        )}
        {!isCreate && activeTab === 'runs' && <RunsTab agent={agent} />}
        {!isCreate && activeTab === 'output' && <OutputTab agent={agent} />}
        {!isCreate && activeTab === 'git' && <GitTab agent={agent} />}
      </div>
    </div>
  );
}
