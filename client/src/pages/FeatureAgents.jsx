import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Wand2, Plus, RefreshCw } from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import socket from '../services/socket';
import FeatureAgentCard from '../components/feature-agents/FeatureAgentCard';
import BrailleSpinner from '../components/BrailleSpinner';

export default function FeatureAgents() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAgents = useCallback(() => {
    api.getFeatureAgents().then(data => {
      setAgents(data || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchAgents();
    const handler = () => fetchAgents();
    socket.on('cos:feature-agent:status', handler);
    socket.on('cos:feature-agent:run-complete', handler);
    return () => {
      socket.off('cos:feature-agent:status', handler);
      socket.off('cos:feature-agent:run-complete', handler);
    };
  }, [fetchAgents]);

  const handleStart = useCallback((id) => {
    api.startFeatureAgent(id).then(agent => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...agent } : a));
      toast.success('Feature agent activated');
    }).catch(() => {});
  }, []);

  const handlePause = useCallback((id) => {
    api.pauseFeatureAgent(id).then(agent => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...agent } : a));
      toast.success('Feature agent paused');
    }).catch(() => {});
  }, []);

  const handleResume = useCallback((id) => {
    api.resumeFeatureAgent(id).then(agent => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...agent } : a));
      toast.success('Feature agent resumed');
    }).catch(() => {});
  }, []);

  const handleStop = useCallback((id) => {
    api.stopFeatureAgent(id).then(agent => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...agent } : a));
      toast.success('Feature agent stopped');
    }).catch(() => {});
  }, []);

  const handleTrigger = useCallback((id) => {
    api.triggerFeatureAgent(id).then(() => {
      toast.success('Run triggered');
    }).catch(() => {});
  }, []);

  const handleDelete = useCallback((id) => {
    api.deleteFeatureAgent(id).then(() => {
      setAgents(prev => prev.filter(a => a.id !== id));
      toast.success('Feature agent deleted');
    }).catch(() => {});
  }, []);

  const activeCount = agents.filter(a => a.status === 'active').length;
  const totalRuns = agents.reduce((sum, a) => sum + (a.runCount || 0), 0);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-port-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Wand2 size={24} className="text-port-accent" />
            <div>
              <h1 className="text-xl font-bold text-white">Feature Agents</h1>
              <p className="text-sm text-gray-500">
                {agents.length} agent{agents.length !== 1 ? 's' : ''} &middot; {activeCount} active &middot; {totalRuns} total runs
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchAgents}
              className="p-2 text-gray-400 hover:text-white hover:bg-port-border/50 rounded-lg transition-colors"
              title="Refresh"
            >
              <RefreshCw size={16} />
            </button>
            <Link
              to="/feature-agents/create"
              className="flex items-center gap-2 px-3 py-2 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 transition-colors"
            >
              <Plus size={16} /> New Agent
            </Link>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <BrailleSpinner text="Loading agents" />
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-16">
            <Wand2 size={48} className="mx-auto text-gray-600 mb-4" />
            <h3 className="text-lg font-medium text-gray-400 mb-2">No Feature Agents</h3>
            <p className="text-sm text-gray-600 mb-4">
              Create a feature agent to have a persistent AI developer iterate on a specific feature.
            </p>
            <Link
              to="/feature-agents/create"
              className="inline-flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 transition-colors"
            >
              <Plus size={16} /> Create Feature Agent
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {agents.map(agent => (
              <FeatureAgentCard
                key={agent.id}
                agent={agent}
                onStart={handleStart}
                onPause={handlePause}
                onResume={handleResume}
                onStop={handleStop}
                onTrigger={handleTrigger}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
