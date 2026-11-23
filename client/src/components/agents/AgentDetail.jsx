import TabPills from '../ui/TabPills';
import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import LoadFailedState from '../ui/LoadFailedState';
import ListLoadError from '../ui/ListLoadError';
import { getAgentPersonality, toggleAgentPersonality } from '../../services/apiPersonalities.js';
import { getPlatformAccounts } from '../../services/apiAccounts.js';
import { AGENT_DETAIL_TABS } from './constants';
import { DEFAULT_AVATAR_COLOR } from '../../themes/portosThemes';
import { lazyWithReload } from '../../utils/lazyWithReload';

const OverviewTab = lazyWithReload(() => import('./tabs/OverviewTab'));
const ToolsTab = lazyWithReload(() => import('./tabs/ToolsTab'));
const WorldTab = lazyWithReload(() => import('./tabs/WorldTab'));
const PublishedTab = lazyWithReload(() => import('./tabs/PublishedTab'));
const SchedulesTab = lazyWithReload(() => import('./tabs/SchedulesTab'));
const ActivityTab = lazyWithReload(() => import('./tabs/ActivityTab'));

const NAV_TABS = AGENT_DETAIL_TABS.map(({ icon, ...tab }) => ({
  ...tab, icon: () => <span aria-hidden="true">{icon}</span>,
}));

export default function AgentDetail() {
  const { agentId } = useParams();
  return <AgentDetailContent key={agentId} />;
}

function AgentDetailContent() {
  const { agentId, tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'overview';

  const [agent, setAgent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [platformAccounts, setPlatformAccounts] = useState([]);
  const [platformAccountsError, setPlatformAccountsError] = useState(null);
  const mountedRef = useRef(false);
  const latestAgentIdRef = useRef(agentId);
  const agentRequestRef = useRef(0);
  const platformRequestRef = useRef(0);

  latestAgentIdRef.current = agentId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchAgent = useCallback(async (isCurrent = () => true) => {
    const requestId = ++agentRequestRef.current;
    const requestedAgentId = agentId;
    const result = await getAgentPersonality(requestedAgentId, { silent: true })
      .then(data => ({ data }), error => ({ error }));
    if (
      !isCurrent() ||
      !mountedRef.current ||
      requestId !== agentRequestRef.current ||
      latestAgentIdRef.current !== requestedAgentId
    ) {
      return;
    }
    if (result.error) {
      // Only a 404 means the agent is gone; anything else is a retryable load failure.
      if (result.error.status === 404) setNotFound(true);
      else setLoadError(result.error);
      setLoading(false);
      return;
    }
    setLoadError(null);
    setNotFound(false);
    setAgent(result.data);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    setAgent(null);
    setPlatformAccounts([]);
    setLoading(true);
    setNotFound(false);
    setLoadError(null);
    fetchAgent(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchAgent]);

  const fetchPlatformAccounts = useCallback(() => {
    const requestId = ++platformRequestRef.current;
    const requestedAgentId = agentId;
    getPlatformAccounts(requestedAgentId, null, { silent: true }).then(accounts => {
      if (!mountedRef.current || requestId !== platformRequestRef.current) return;
      setPlatformAccountsError(null);
      setPlatformAccounts(accounts);
    }, error => {
      if (!mountedRef.current || requestId !== platformRequestRef.current) return;
      setPlatformAccountsError(error);
    });
  }, [agentId]);

  useEffect(() => {
    setPlatformAccountsError(null);
    fetchPlatformAccounts();
    return () => {
      platformRequestRef.current += 1;
    };
  }, [fetchPlatformAccounts]);

  const hasMoltbookAccount = useMemo(
    () => platformAccounts.some(a => a.platform === 'moltbook'),
    [platformAccounts]
  );

  const hasMoltworldAccount = useMemo(
    () => platformAccounts.some(a => a.platform === 'moltworld'),
    [platformAccounts]
  );

  const visibleTabs = useMemo(
    () => NAV_TABS.filter(t =>
      (t.id !== 'tools' || hasMoltbookAccount) &&
      (t.id !== 'world' || hasMoltworldAccount)
    ),
    [hasMoltbookAccount, hasMoltworldAccount]
  );

  // Redirect bare /agents/:id to /agents/:id/overview
  useEffect(() => {
    if (!tab && agentId) {
      navigate(`/agents/${agentId}/overview`, { replace: true });
    }
  }, [tab, agentId, navigate]);

  const handleToggle = async () => {
    await toggleAgentPersonality(agent.id, !agent.enabled);
    fetchAgent();
  };

  if (loading) {
    return <div className="p-6"><BrailleSpinner text="Loading agent" /></div>;
  }

  if (loadError) {
    return (
      <LoadFailedState
        title="Could not load agent."
        hint={loadError.message}
        onRetry={() => { setLoadError(null); setLoading(true); fetchAgent(); }}
      />
    );
  }

  if (notFound) {
    return (
      <div className="p-6 text-center">
        <p className="text-lg text-gray-400 mb-4">Agent not found</p>
        <Link to="/agents" className="text-port-accent hover:text-port-accent/80">
          Back to Agents
        </Link>
      </div>
    );
  }

  const renderTab = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab agentId={agentId} agent={agent} onAgentUpdate={fetchAgent} />;
      case 'tools':
        return <ToolsTab agentId={agentId} agent={agent} />;
      case 'world':
        return <WorldTab agentId={agentId} agent={agent} />;
      case 'published':
        return <PublishedTab agentId={agentId} />;
      case 'schedules':
        return <SchedulesTab agentId={agentId} />;
      case 'activity':
        return <ActivityTab agentId={agentId} />;
      default:
        return <OverviewTab agentId={agentId} agent={agent} onAgentUpdate={fetchAgent} />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-port-border px-6 py-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <Link
            to="/agents"
            aria-label="Back to Social Agents"
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] pointer-fine:sm:min-h-0 pointer-fine:sm:min-w-0 p-1.5 text-gray-400 hover:text-white transition-colors rounded hover:bg-port-border/50 shrink-0"
          >
            <ArrowLeft size={20} />
          </Link>
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0"
            style={{ backgroundColor: agent.avatar?.color || DEFAULT_AVATAR_COLOR }}
          >
            {agent.avatar?.emoji || '🤖'}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="line-clamp-2 break-words text-xl font-bold text-white" title={agent.name}>
              {agent.name}
            </h1>
            {agent.description && (
              <p className="text-sm text-gray-400 truncate">{agent.description}</p>
            )}
          </div>
          <button
            onClick={handleToggle}
            className={`shrink-0 pointer-coarse:min-h-11 px-3 py-1.5 text-sm rounded ${
              agent.enabled
                ? 'bg-port-success/20 text-port-success hover:bg-port-success/30'
                : 'bg-port-border text-gray-400 hover:bg-port-border/80'
            }`}
          >
            {agent.enabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
      </div>

      <TabPills tabs={visibleTabs} activeTab={activeTab} onChange={(tab) => navigate(`/agents/${agentId}/${tab}`)}
        ariaLabel="Social agent sections" mobileCompact className="shrink-0 min-w-0" />

      {platformAccountsError && (
        <ListLoadError
          what="platform accounts (Moltbook and World tabs may be hidden)"
          error={platformAccountsError}
          onRetry={fetchPlatformAccounts}
          className="mx-6 mt-3"
        />
      )}

      {/* Tab Content */}
      <div className="flex-1 overflow-auto bg-port-bg">
        <Suspense fallback={<div className="p-6"><BrailleSpinner text="Loading tab" /></div>}>
          {renderTab()}
        </Suspense>
      </div>
    </div>
  );
}
