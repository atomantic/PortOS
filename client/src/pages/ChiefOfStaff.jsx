import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import { useEffect, lazy, Suspense } from 'react';
import { Link, useLocation, useParams, useNavigate, useSearchParams } from 'react-router';
import { useLocalStorageBool } from '../hooks/useLocalStorageBool';
import { useValidTab } from '../hooks/useValidTab';
import { useInstanceFeatures } from '../hooks/useInstanceFeatures.js';
import { filterNavByFeatures } from '../lib/navFeatures.js';
import { useAvatarCapabilities } from '../hooks/useAvatarCapabilities';
import { Brain, PanelLeftOpen } from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import TabPills from '../components/ui/TabPills';
import PageSkeleton from '../components/ui/PageSkeleton';
import { TABS } from '../components/cos/constants';
import StateLabel from '../components/cos/StateLabel';
import StatusIndicator from '../components/cos/StatusIndicator';
import ActionableInsightsBanner from '../components/cos/ActionableInsightsBanner';
import CosAgentPanel, { CosStatusPlaceholder } from '../components/cos/CosAgentPanel';
import CosStatsCards from '../components/cos/CosStatsCards';
import useCosPageData from '../components/cos/useCosPageData';

const AgentsTab = lazy(() => import('../components/cos/tabs/AgentsTab'));

// Task editing is not needed to view agents, so keep its forms and drag/drop
// dependencies out of the agents page's initial download.
const TasksTab = lazy(() => import('../components/cos/tabs/TasksTab'));

// The Runs tab (full AI run history + its log modal) is lazy-loaded so its weight
// stays out of the eager CoS chunk every /cos/* visit pays for — same reason the
// avatars in `CosAgentPanel` are not re-exported from the components/cos barrel.
const RunsTab = lazy(() => import('../components/cos/tabs/RunsTab'));
// The run-event diagnostic is lazy for the same reason as Runs: it is a
// post-mortem surface nobody opens on a normal day, and it pulls the whole
// ledger read path with it.
const RunEventsTab = lazy(() => import('../components/cos/tabs/RunEventsTab'));
const MindTab = lazy(() => import('../components/cos/tabs/MindTab'));
// Collection views and editors load only on their selected tab.
// Every other tab is loaded only when selected so the common queue view does
// not pay for charts, memory graphs, briefing readers, or configuration forms.
const JobsTab = lazy(() => import('../components/cos/tabs/JobsTab'));
const ScheduleTab = lazy(() => import('../components/cos/tabs/ScheduleTab'));
const WorkflowTab = lazy(() => import('../components/cos/tabs/WorkflowTab'));
const DigestTab = lazy(() => import('../components/cos/tabs/DigestTab'));
const GsdTab = lazy(() => import('../components/cos/tabs/GsdTab'));
const LearningTab = lazy(() => import('../components/cos/tabs/LearningTab'));
const MemoryTab = lazy(() => import('../components/cos/tabs/MemoryTab'));
const HealthTab = lazy(() => import('../components/cos/tabs/HealthTab'));
const ConfigTab = lazy(() => import('../components/cos/tabs/ConfigTab'));
const BriefingTab = lazy(() => import('../components/cos/tabs/BriefingTab'));

const LOCAL_VIEWS = {
  briefing: ['digest'],
  tasks: ['jobs', 'gsd'],
  runs: ['run-events'],
  schedule: ['workflow'],
  memory: ['learning'],
  config: ['health'],
};
const parentByView = new Map(Object.entries(LOCAL_VIEWS)
  .flatMap(([parent, views]) => views.map((view) => [view, parent])));
const primaryViewLabels = { runs: 'History', schedule: 'List', briefing: 'Daily' };

function TabLoadFallback({ label }) {
  return <div className="flex items-center justify-center py-12"><BrailleSpinner text={`Loading ${label}`} /></div>;
}

export default function ChiefOfStaff() {
  const { tab } = useParams();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const selectedTask = searchParams.get('task') || undefined;
  const navigate = useNavigate();
  const routeTab = useValidTab(TABS, 'tasks');
  const requestedView = TABS.find(({ to }) => to === pathname.replace(/\/$/, ''))?.id;
  const activeTab = parentByView.get(requestedView) === routeTab ? requestedView : routeTab;
  const primaryTab = parentByView.get(activeTab) || activeTab;
  const { isFeatureEnabled } = useInstanceFeatures();
  const visibleTabs = filterNavByFeatures(TABS, isFeatureEnabled);
  const primaryTabs = visibleTabs.filter(({ id }) => !parentByView.has(id));
  const localViews = visibleTabs.filter(({ id }) => parentByView.get(id) === primaryTab);
  const primaryView = primaryTabs.find(({ id }) => id === primaryTab);
  const cos = useCosPageData({ activeTab, selectedTask });
  const {
    status, loading, agentState, insights, tasks, agents, agentsLoaded, agentsError, liveOutputs,
    providers, providersLoaded, activeProviderId, apps, health, healthLoaded, healthError,
    completedRevision, taskHistoryRevision, configAvatarStyle, avatarStyle, fetchData, fetchQueue,
    setAvatarStyle, handleForceEvaluate, handleHealthCheck, handleTaskUnblocked, handleTaskDeleted, handleUserTaskAdded,
  } = cos;
  const [desktopPanelCollapsed, setDesktopPanelCollapsed] = useLocalStorageBool(
    'cos-panel-collapsed',
    false,
    { format: 'true' },
  );
  const toggleDesktopPanel = () => setDesktopPanelCollapsed((prev) => !prev);

  // Verified animated records for the avatar selector and rigged playback (#5894).
  const { records: riggedAvatars } = useAvatarCapabilities();

  // Redirect unknown tab IDs to the default tab — `routeTab !== tab` only
  // when the param failed validation and fell back.
  useEffect(() => {
    if (tab && tab !== routeTab) {
      navigate('/cos/tasks', { replace: true });
    }
  }, [tab, routeTab, navigate]);

  const navigation = (
    <TabPills
      tabs={primaryTabs}
      activeTab={primaryTab}
      onChange={(id) => navigate(`/cos/${id}`)}
      mobileCompact
      ariaLabel="Chief of Staff sections"
      controlsIdPrefix={loading ? undefined : 'tabpanel'}
      className="w-full min-w-0 shrink-0"
    />
  );

  if (loading) {
    // Reserve the loaded two-pane shell (#4144) — `/cos` is an `isFullWidth`
    // route, so a centered spinner reserved nothing and the whole page jumped
    // into place on first paint. `desktopPanelCollapsed` comes from
    // localStorage, so the skeleton already knows which rail width to hold.
    return (
      <PageLayout className="@container/cos" bodyClassName="overflow-hidden"
        header={<PageHeader icon={Brain} title="Chief of Staff" />}
        navigation={navigation}
      >
        <PageSkeleton
          layout="split"
          label="Loading Chief of Staff"
          padded
          fullHeight
          bodyClassName="p-3 lg:p-4"
          sideCollapsed={desktopPanelCollapsed}
          splitContainer
          splitColsClass={desktopPanelCollapsed ? 'cos-wide:grid-cols-[0px_1fr]' : 'cos-wide:grid-cols-[320px_1fr]'}
          sideClassName="flex flex-col gap-3 border-b cos-wide:border-b-0 cos-wide:border-r border-port-accent-2/20 bg-gradient-to-b from-port-card/80 to-port-card/40 p-3 cos-wide:px-4 cos-wide:py-6 cos-wide:h-full cos-wide:overflow-hidden"
          sideHero
          sideBlocks={4}
          sideBlockColsClass="grid-cols-2"
        />
      </PageLayout>
    );
  }

  const statusKnown = typeof status?.running === 'boolean';

  return (
    <PageLayout className="@container/cos" bodyClassName="overflow-hidden"
      header={<PageHeader icon={Brain} title="Chief of Staff" />}
      navigation={navigation}
    >
    <div className={`relative flex flex-col cos-wide:grid ${desktopPanelCollapsed ? 'cos-wide:grid-cols-[0px_1fr]' : 'cos-wide:grid-cols-[320px_1fr]'} h-full overflow-hidden transition-[grid-template-columns] duration-200`}>
      <CosAgentPanel
        cos={cos}
        activeTab={activeTab}
        riggedAvatars={riggedAvatars}
        desktopCollapsed={desktopPanelCollapsed}
        onToggleDesktop={toggleDesktopPanel}
      />

      {/* Content Panel. Flex column so the Mind tab can fill leftover height
          on desktop (its chat pane owns the internal scroll); other tabs still
          grow this region and scroll here as before. */}
      <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden">
        {desktopPanelCollapsed && (
          <div className="hidden cos-wide:flex shrink-0 bg-port-bg items-center flex-wrap gap-3 px-3 lg:px-4 border-b border-port-border">
            <button onClick={toggleDesktopPanel} aria-label="Expand CoS panel"
              className="min-h-[44px] flex items-center gap-2 px-2 text-sm text-port-text">
              <PanelLeftOpen size={16} aria-hidden="true" /> CoS
            </button>
            {statusKnown ? <>
              <StatusIndicator running={status.running} paused={status.paused} />
              <StateLabel state={agentState} compact />
            </> : <CosStatusPlaceholder failed={cos.statusReadFailed} onRetry={fetchData} />}
          </div>
        )}
        <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden p-3 lg:p-4">
        {/* Stats Bar - hidden for SVG/canvas modes (now integrated into CoS sidebar);
            ascii/terminal mode keeps it because TerminalCoSPanel doesn't host the cards. */}
        <div className={`grid shrink-0 grid-cols-3 gap-1.5 sm:grid-cols-5 sm:gap-2 lg:gap-3 mb-3 sm:mb-4 lg:mb-6 ${avatarStyle !== 'ascii' ? 'hidden' : ''}`}>
          <CosStatsCards cos={cos} variant="bar" />
        </div>

        <div
          role="tabpanel"
          id={`tabpanel-${primaryTab}`}
          aria-labelledby={`tab-${primaryTab}`}
          className={activeTab === 'mind' ? 'flex min-h-0 flex-col xl:flex-1' : undefined}
        >
          {localViews.length > 0 && (
            <nav aria-label={`${primaryView.label} views`} className="mb-3 flex flex-wrap gap-2">
              {[primaryView, ...localViews].map(({ id, to, label }) => (
                <Link
                  key={id}
                  to={to}
                  aria-current={activeTab === id ? 'page' : undefined}
                  className={`inline-flex min-h-11 items-center rounded-lg border px-3 text-sm ${activeTab === id
                    ? 'border-port-accent/40 bg-port-accent/10 text-port-accent'
                    : 'border-port-border text-gray-400 hover:text-white'}`}
                >
                  {id === primaryTab ? primaryViewLabels[id] || label : label}
                </Link>
              ))}
            </nav>
          )}
          {activeTab === 'briefing' && (
            <Suspense fallback={<TabLoadFallback label="briefing" />}>
              <BriefingTab />
            </Suspense>
          )}
          {activeTab === 'tasks' && (
            <>
              <ActionableInsightsBanner insights={insights} onTaskUnblocked={handleTaskUnblocked} onRefresh={fetchData} />
              <Suspense fallback={<TabLoadFallback label="tasks" />}>
                <TasksTab completedRevision={taskHistoryRevision} tasks={tasks} agents={agents} agentsLoaded={agentsLoaded} agentsError={agentsError} liveOutputs={liveOutputs} onRefresh={fetchData} onTaskAdded={handleUserTaskAdded} onTaskUnblocked={handleTaskUnblocked} onTaskDeleted={handleTaskDeleted} providers={providers} providersLoaded={providersLoaded} apps={apps} />
              </Suspense>
            </>
          )}
          {activeTab === 'agents' && (
            <Suspense fallback={<TabLoadFallback label="agents" />}>
              <AgentsTab agentsLoaded={agentsLoaded} agentsError={agentsError} onRetryAgents={fetchQueue} completedRevision={completedRevision} agents={agents} onRefresh={fetchData} liveOutputs={liveOutputs} providers={providers} providersLoaded={providersLoaded} apps={apps} />
            </Suspense>
          )}
          {activeTab === 'jobs' && (
            <Suspense fallback={<TabLoadFallback label="jobs" />}>
              <JobsTab />
            </Suspense>
          )}
          {activeTab === 'runs' && (
            <Suspense fallback={<TabLoadFallback label="runs" />}>
              <RunsTab />
            </Suspense>
          )}
          {activeTab === 'run-events' && (
            <Suspense fallback={<TabLoadFallback label="run events" />}>
              <RunEventsTab />
            </Suspense>
          )}
          {activeTab === 'mind' && (
            <Suspense fallback={<TabLoadFallback label="mind" />}>
              <MindTab />
            </Suspense>
          )}
          {activeTab === 'schedule' && (
            <Suspense fallback={<TabLoadFallback label="schedule" />}>
              <ScheduleTab apps={apps} providers={providers} activeProviderId={activeProviderId} providersLoaded={providersLoaded} daemonRunning={status?.running} />
            </Suspense>
          )}
          {activeTab === 'workflow' && (
            <Suspense fallback={<TabLoadFallback label="workflow" />}>
              <WorkflowTab apps={apps} providers={providers} providersLoaded={providersLoaded} />
            </Suspense>
          )}
          {activeTab === 'digest' && (
            <Suspense fallback={<TabLoadFallback label="digest" />}>
              <DigestTab />
            </Suspense>
          )}
          {activeTab === 'gsd' && (
            <Suspense fallback={<TabLoadFallback label="GSD" />}>
              <GsdTab />
            </Suspense>
          )}
          {activeTab === 'learning' && (
            <Suspense fallback={<TabLoadFallback label="learning" />}>
              <LearningTab />
            </Suspense>
          )}
          {activeTab === 'memory' && (
            <Suspense fallback={<TabLoadFallback label="memory" />}>
              <MemoryTab apps={apps} />
            </Suspense>
          )}
          {activeTab === 'health' && (
            <Suspense fallback={<TabLoadFallback label="health" />}>
              <HealthTab health={health} healthLoading={!healthLoaded} healthError={healthError} onCheck={handleHealthCheck} />
            </Suspense>
          )}
          {activeTab === 'config' && (
            <Suspense fallback={<TabLoadFallback label="configuration" />}>
              <ConfigTab config={status?.config} onUpdate={fetchData} onEvaluate={handleForceEvaluate} avatarStyle={configAvatarStyle} setAvatarStyle={setAvatarStyle} riggedAvatars={riggedAvatars} />
            </Suspense>
          )}
        </div>
        </div>
      </div>
    </div>
    </PageLayout>
  );
}
