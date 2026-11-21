import { useCallback } from 'react';
import { Link } from 'react-router';
import { Wand2, Plus, RefreshCw } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getFeatureAgents,
  startFeatureAgent,
  pauseFeatureAgent,
  resumeFeatureAgent,
  stopFeatureAgent,
  triggerFeatureAgent,
  deleteFeatureAgent,
} from '../services/apiAgents.js';
import { useSocketResource } from '../hooks/useSocketResource';
import FeatureAgentCard from '../components/feature-agents/FeatureAgentCard';
import PageSkeleton from '../components/ui/PageSkeleton';
import PageHeader from '../components/PageHeader';
import ListLoadError from '../components/ui/ListLoadError';
import { formatCount } from '../utils/formatters';

const AGENT_EVENTS = ['cos:feature-agent:status', 'cos:feature-agent:run-complete'];

const fetchAgentList = async () => {
  const data = await getFeatureAgents({ silent: true });
  if (!Array.isArray(data)) throw new Error('Invalid feature agents response');
  return data;
};

export default function FeatureAgents() {
  // Only a successful zero-record read counts as empty; a failed read keeps the header action.
  const { data, loading, error, refetch: fetchAgents, updateData } = useSocketResource(fetchAgentList, { events: AGENT_EVENTS });
  const agents = data ?? [];
  const loadFailed = error != null;
  const setAgents = useCallback(updater => updateData(prev => updater(prev ?? [])), [updateData]);

  const handleStart = useCallback((id) => {
    startFeatureAgent(id, { silent: true }).then(agent => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...agent } : a));
      toast.success('Feature agent activated');
    }).catch(err => toast.error(err.message || 'Action failed'));
  }, []);

  const handlePause = useCallback((id) => {
    pauseFeatureAgent(id, { silent: true }).then(agent => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...agent } : a));
      toast.success('Feature agent paused');
    }).catch(err => toast.error(err.message || 'Action failed'));
  }, []);

  const handleResume = useCallback((id) => {
    resumeFeatureAgent(id, { silent: true }).then(agent => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...agent } : a));
      toast.success('Feature agent resumed');
    }).catch(err => toast.error(err.message || 'Action failed'));
  }, []);

  const handleStop = useCallback((id) => {
    stopFeatureAgent(id, { silent: true }).then(agent => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...agent } : a));
      toast.success('Feature agent stopped');
    }).catch(err => toast.error(err.message || 'Action failed'));
  }, []);

  const handleTrigger = useCallback((id) => {
    triggerFeatureAgent(id, { silent: true }).then(result => {
      if (result?.triggered === false) {
        toast.error(result.reason || 'Run could not be started');
        return;
      }
      if (result?.agent) setAgents(prev => prev.map(a => a.id === id ? { ...a, ...result.agent } : a));
      toast.success('Run started');
    }).catch(err => toast.error(err.message || 'Action failed'));
  }, []);

  const handleDelete = useCallback((id) => {
    deleteFeatureAgent(id, { silent: true }).then(() => {
      setAgents(prev => prev.filter(a => a.id !== id));
      toast.success('Feature agent deleted');
    }).catch(err => toast.error(err.message || 'Action failed'));
  }, []);

  const activeCount = agents.filter(a => a.status === 'active').length;
  const totalRuns = agents.reduce((sum, a) => sum + (a.runCount || 0), 0);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={Wand2}
        title="Feature Agents"
        subtitle={`${formatCount(agents.length)} agent${agents.length !== 1 ? 's' : ''} · ${formatCount(activeCount)} active · ${formatCount(totalRuns)} total runs`}
        actions={
          <>
            <button
              onClick={fetchAgents}
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 text-gray-400 hover:text-white hover:bg-port-border/50 rounded-lg transition-colors"
              title="Refresh" aria-label="Refresh"
            >
              <RefreshCw size={16} />
            </button>
            {(loading || loadFailed || agents.length > 0) && (
              <Link
                to="/feature-agents/create"
                className="flex items-center gap-2 px-3 py-2 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 transition-colors"
              >
                <Plus size={16} /> New Agent
              </Link>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <PageSkeleton
            header="none"
            label="Loading agents"
            layout="grid"
            gridColsClass="lg:grid-cols-2 xl:grid-cols-3"
            cards={3}
          />
        ) : (
          <>
            {loadFailed && <ListLoadError what="feature agents" onRetry={fetchAgents} />}
            {agents.length === 0 && !loadFailed ? (
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
            ) : agents.length > 0 ? (
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
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
