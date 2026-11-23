import TabPills from '../components/ui/TabPills';
import { useState, useEffect, useCallback } from 'react';
import useMounted from '../hooks/useMounted';
import { useParams, useNavigate, Link } from 'react-router';
import { Wand2, ArrowLeft } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getFeatureAgent,
  startFeatureAgent,
  pauseFeatureAgent,
  resumeFeatureAgent,
  stopFeatureAgent,
  triggerFeatureAgent,
} from '../services/apiAgents.js';
import { getApps } from '../services/apiApps.js';
import { useSocketResource } from '../hooks/useSocketResource';
import { TABS } from '../components/feature-agents/constants';
import { useValidTab } from '../hooks/useValidTab';
import OverviewTab from '../components/feature-agents/OverviewTab';
import ConfigTab from '../components/feature-agents/ConfigTab';
import RunsTab from '../components/feature-agents/RunsTab';
import OutputTab from '../components/feature-agents/OutputTab';
import GitTab from '../components/feature-agents/GitTab';
import PageSkeleton from '../components/ui/PageSkeleton';
import LoadFailedState from '../components/ui/LoadFailedState';

const AGENT_EVENTS = ['cos:feature-agent:status', 'cos:feature-agent:run-complete'];

const fetchAgentRecord = id => getFeatureAgent(id, { silent: true }).catch(err => {
  if (err?.status === 404) return null;
  throw err;
});

export default function FeatureAgentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isCreate = !id;
  const activeTab = useValidTab(TABS, 'overview');

  // Only a 404 means the agent is gone (null data); any other failed first read keeps a Retry.
  const matchesAgent = useCallback(payload => payload?.id === id, [id]);
  const { data: agent, loading: agentLoading, error: loadError, refetch, updateData: setAgent } = useSocketResource(
    () => fetchAgentRecord(id),
    { events: AGENT_EVENTS, resourceKey: id, matchesEvent: matchesAgent, enabled: !isCreate }
  );
  const loading = !isCreate && agentLoading;
  const [apps, setApps] = useState([]);

  // A failed background refresh keeps the record on screen and says so.
  useEffect(() => {
    if (loadError && agent) toast.error(`Couldn’t refresh feature agent: ${loadError.message || 'Request failed'}`);
  }, [loadError]);

  const mountedRef = useMounted();

  useEffect(() => {
    getApps().then(data => { if (mountedRef.current) setApps((data || []).filter(a => !a.archived)); }).catch(() => {});
  }, []);

  const handleStart = useCallback((agentId) => {
    startFeatureAgent(agentId, { silent: true }).then(data => { setAgent(prev => ({ ...prev, ...data })); toast.success('Activated'); }).catch(err => toast.error(err.message || 'Couldn’t activate feature agent'));
  }, []);
  const handlePause = useCallback((agentId) => {
    pauseFeatureAgent(agentId, { silent: true }).then(data => { setAgent(prev => ({ ...prev, ...data })); toast.success('Paused'); }).catch(err => toast.error(err.message || 'Couldn’t pause feature agent'));
  }, []);
  const handleResume = useCallback((agentId) => {
    resumeFeatureAgent(agentId, { silent: true }).then(data => { setAgent(prev => ({ ...prev, ...data })); toast.success('Resumed'); }).catch(err => toast.error(err.message || 'Couldn’t resume feature agent'));
  }, []);
  const handleStop = useCallback((agentId) => {
    stopFeatureAgent(agentId, { silent: true }).then(data => { setAgent(prev => ({ ...prev, ...data })); toast.success('Stopped'); }).catch(err => toast.error(err.message || 'Couldn’t stop feature agent'));
  }, []);
  const handleTrigger = useCallback((agentId) => {
    triggerFeatureAgent(agentId, { silent: true }).then(result => {
      if (result?.triggered === false) {
        toast.error(result.reason || 'Run could not be started');
        return;
      }
      if (result?.agent) setAgent(prev => ({ ...prev, ...result.agent }));
      toast.success('Run started');
    }).catch(err => toast.error(err.message || 'Couldn’t start feature agent run'));
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
      <PageSkeleton
        header="bar"
        label="Loading agent"
        fullHeight
        padded
        bodyClassName="p-6"
        titleWidthClass="w-56"
        showSubtitle
        subtitleOnMobile
        showAction={false}
        tabs={isCreate ? 0 : TABS.length}
        cards={3}
        sidebar={false}
      />
    );
  }

  if (!isCreate && !agent && loadError) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <LoadFailedState title="Couldn’t load this feature agent" hint={loadError.message} onRetry={refetch} />
        <Link to="/feature-agents" className="text-port-accent text-sm hover:underline">Back to list</Link>
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
      <div className="shrink-0 px-3 py-2 sm:px-4 sm:py-3 border-b border-port-border">
        <div className="flex items-center gap-3">
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
      </div>
      {!isCreate && (
        <TabPills tabs={TABS} activeTab={activeTab} onChange={(tab) => navigate(`/feature-agents/${id}/${tab}`)}
          ariaLabel="Feature agent sections" mobileCompact className="shrink-0 min-w-0" />
      )}

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
