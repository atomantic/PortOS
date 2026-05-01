import { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { getSettings, updateSettings } from './services/api';
import BrailleSpinner from './components/BrailleSpinner';
import Dashboard from './pages/Dashboard';
import Apps from './pages/Apps';
import Ambient from './pages/Ambient';

// Auto-reload on stale chunk errors (e.g., after a rebuild changes chunk hashes)
// Uses sessionStorage to prevent infinite reload loops (max 1 reload per session)
const lazyWithReload = (importFn) => lazy(() =>
  importFn().catch(err => {
    if (err.message?.includes('MIME type') || err.message?.includes('Failed to fetch dynamically imported module')) {
      const key = 'lazyReloadAttempted';
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
        return new Promise(() => {}); // hang until reload completes
      }
    }
    throw err;
  })
);

// Lazy load heavier pages for code splitting
// DevTools pages are large (~2300 lines total) so lazy load them
const AIProviders = lazyWithReload(() => import('./pages/AIProviders'));
const HistoryPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.HistoryPage })));
const RunsHistoryPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.RunsHistoryPage })));
const RunnerPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.RunnerPage })));
const UsagePage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.UsagePage })));
const ProcessesPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.ProcessesPage })));
const AgentsPage = lazyWithReload(() => import('./pages/DevTools').then(m => ({ default: m.AgentsPage })));
const DataDog = lazyWithReload(() => import('./pages/DataDog'));
const GitHub = lazyWithReload(() => import('./pages/GitHub'));
const CyberCity = lazyWithReload(() => import('./pages/CyberCity'));
const AppDetail = lazyWithReload(() => import('./pages/AppDetail'));
const FeatureAgents = lazyWithReload(() => import('./pages/FeatureAgents'));
const FeatureAgentDetail = lazyWithReload(() => import('./pages/FeatureAgentDetail'));
const CalendarPage = lazyWithReload(() => import('./pages/Calendar'));
const Messages = lazyWithReload(() => import('./pages/Messages'));
const Goals = lazyWithReload(() => import('./pages/Goals'));
const OpenClawPage = lazyWithReload(() => import('./pages/OpenClaw'));
const Submodules = lazyWithReload(() => import('./pages/Submodules'));
const ChiefOfStaff = lazyWithReload(() => import('./pages/ChiefOfStaff'));
const Ask = lazyWithReload(() => import('./pages/Ask'));
const MediaGen = lazyWithReload(() => import('./pages/MediaGen'));
const ImageGen = lazyWithReload(() => import('./pages/ImageGen'));
const VideoGen = lazyWithReload(() => import('./pages/VideoGen'));
const MediaHistory = lazyWithReload(() => import('./pages/MediaHistory'));
const MediaCollections = lazyWithReload(() => import('./pages/MediaCollections'));
const MediaCollectionDetail = lazyWithReload(() => import('./pages/MediaCollectionDetail'));
const MediaModels = lazyWithReload(() => import('./pages/MediaModels'));
const VideoTimeline = lazyWithReload(() => import('./pages/VideoTimeline'));
const VideoTimelineEditor = lazyWithReload(() => import('./pages/VideoTimelineEditor'));
const CreativeDirector = lazyWithReload(() => import('./pages/CreativeDirector'));
const CreativeDirectorDetail = lazyWithReload(() => import('./pages/CreativeDirectorDetail'));
const RenderQueue = lazyWithReload(() => import('./pages/RenderQueue'));
const CreateApp = lazyWithReload(() => import('./pages/CreateApp'));
const Templates = lazyWithReload(() => import('./pages/Templates'));
const PromptManager = lazyWithReload(() => import('./pages/PromptManager'));
const Brain = lazyWithReload(() => import('./pages/Brain'));
const Security = lazyWithReload(() => import('./pages/Security'));
const DigitalTwin = lazyWithReload(() => import('./pages/DigitalTwin'));
const Agents = lazyWithReload(() => import('./pages/Agents'));
const Uploads = lazyWithReload(() => import('./pages/Uploads'));
const Settings = lazyWithReload(() => import('./pages/Settings'));
const Shell = lazyWithReload(() => import('./pages/Shell'));
const BrowserPage = lazyWithReload(() => import('./pages/Browser'));
const Jira = lazyWithReload(() => import('./pages/Jira'));
const JiraReports = lazyWithReload(() => import('./pages/JiraReports'));
const DataManager = lazyWithReload(() => import('./pages/DataManager'));
const Insights = lazyWithReload(() => import('./pages/Insights'));
const Instances = lazyWithReload(() => import('./pages/Instances'));
const SystemHealthPage = lazyWithReload(() => import('./pages/SystemHealthPage'));
const MeatSpace = lazyWithReload(() => import('./pages/MeatSpace'));
const Post = lazyWithReload(() => import('./pages/Post'));
const Review = lazyWithReload(() => import('./pages/Review'));
const Loops = lazyWithReload(() => import('./pages/Loops'));
const CharacterSheet = lazyWithReload(() => import('./pages/CharacterSheet'));
const Wiki = lazyWithReload(() => import('./pages/Wiki'));
const RapidReaderPage = lazyWithReload(() => import('./pages/RapidReader'));

// Loading fallback for lazy-loaded pages
const PageLoader = () => (
  <div className="flex items-center justify-center h-64">
    <BrailleSpinner text="Loading" />
  </div>
);

// Preserve query string when redirecting legacy media routes — Settings.jsx's
// /image-gen?settings=1 chain depends on ?settings=1 reaching the new path.
function RedirectWithSearch({ to }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

// Force full reload on HMR — partial hot-replacement of the route tree
// causes stale lazy imports and React Router errors on nested paths
if (import.meta.hot) {
  import.meta.hot.decline();
}

// Self-heal timezone on first load: the server process runs under TZ=UTC, so
// if settings.timezone was never set the server fallback resolves to UTC and
// date-scoped features (daily log, schedulers) land on the wrong day. Push
// the browser's IANA zone once so remote/VPN clients don't need to visit
// Settings before their first entry is correct.
function useTimezoneBootstrap() {
  useEffect(() => {
    getSettings().then((s) => {
      if (s?.timezone) return;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tz || tz === 'UTC') return;
      return updateSettings({ timezone: tz });
    }).catch(() => null);
  }, []);
}

export default function App() {
  useTimezoneBootstrap();
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/ambient" element={<Ambient />} />
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="apps" element={<Apps />} />
          <Route path="devtools" element={<Navigate to="/devtools/runs" replace />} />
          <Route path="devtools/datadog" element={<DataDog />} />
          <Route path="devtools/github" element={<GitHub />} />
          <Route path="devtools/history" element={<HistoryPage />} />
          <Route path="devtools/runs" element={<RunsHistoryPage />} />
          <Route path="devtools/runner" element={<RunnerPage />} />
          <Route path="devtools/submodules" element={<Submodules />} />
          <Route path="devtools/usage" element={<UsagePage />} />
          <Route path="devtools/processes" element={<ProcessesPage />} />
          <Route path="devtools/agents" element={<AgentsPage />} />
          <Route path="ai" element={<AIProviders />} />
          <Route path="prompts" element={<PromptManager />} />
          <Route path="cos" element={<Navigate to="/cos/tasks" replace />} />
          <Route path="cos/:tab" element={<ChiefOfStaff />} />
          <Route path="calendar" element={<Navigate to="/calendar/agenda" replace />} />
          <Route path="calendar/:tab" element={<CalendarPage />} />
          <Route path="brain" element={<Navigate to="/brain/inbox" replace />} />
          <Route path="brain/:tab" element={<Brain />} />
          <Route path="digital-twin" element={<Navigate to="/digital-twin/overview" replace />} />
          <Route path="digital-twin/:tab" element={<DigitalTwin />} />
          <Route path="goals" element={<Navigate to="/goals/tree" replace />} />
          <Route path="goals/:tab" element={<Goals />} />
          <Route path="feature-agents" element={<FeatureAgents />} />
          <Route path="feature-agents/create" element={<FeatureAgentDetail />} />
          <Route path="feature-agents/:id" element={<Navigate to="overview" replace />} />
          <Route path="feature-agents/:id/:tab" element={<FeatureAgentDetail />} />
          <Route path="apps/create" element={<CreateApp />} />
          <Route path="apps/:appId" element={<AppDetail />} />
          <Route path="apps/:appId/:tab" element={<AppDetail />} />
          <Route path="templates" element={<Templates />} />
          <Route path="security" element={<Security />} />
          <Route path="settings" element={<Navigate to="/settings/backup" replace />} />
          <Route path="settings/:tab" element={<Settings />} />
          <Route path="uploads" element={<Uploads />} />
          <Route path="shell" element={<Shell />} />
          <Route path="browser" element={<BrowserPage />} />
          <Route path="insights" element={<Navigate to="/insights/overview" replace />} />
          <Route path="insights/:tab" element={<Insights />} />
          <Route path="instances" element={<Instances />} />
          <Route path="system-health" element={<SystemHealthPage />} />
          <Route path="loops" element={<Loops />} />
          <Route path="meatspace" element={<Navigate to="/meatspace/overview" replace />} />
          <Route path="meatspace/:tab" element={<MeatSpace />} />
          <Route path="post" element={<Navigate to="/post/launcher" replace />} />
          <Route path="post/:tab" element={<Post />} />
          <Route path="post/:tab/:subtab" element={<Post />} />
          <Route path="review" element={<Review />} />
          <Route path="messages" element={<Navigate to="/messages/inbox" replace />} />
          <Route path="messages/:tab" element={<Messages />} />
          <Route path="openclaw" element={<OpenClawPage />} />
          <Route path="datadog" element={<Navigate to="/devtools/datadog" replace />} />
          <Route path="jira" element={<Navigate to="/devtools/jira" replace />} />
          <Route path="devtools/jira" element={<Jira />} />
          <Route path="devtools/jira/reports" element={<JiraReports />} />
          <Route path="city" element={<CyberCity />} />
          <Route path="city/settings" element={<CyberCity />} />
          <Route path="data" element={<DataManager />} />
          <Route path="character" element={<CharacterSheet />} />
          <Route path="ask" element={<Ask />} />
          <Route path="ask/:conversationId" element={<Ask />} />
          <Route path="media" element={<MediaGen />}>
            <Route index element={<Navigate to="/media/image" replace />} />
            <Route path="image" element={<ImageGen />} />
            <Route path="video" element={<VideoGen />} />
            <Route path="history" element={<MediaHistory />} />
            <Route path="collections" element={<MediaCollections />} />
            <Route path="collections/:id" element={<MediaCollectionDetail />} />
            <Route path="creative-director" element={<CreativeDirector />} />
            <Route path="creative-director/:id" element={<Navigate to="overview" replace />} />
            <Route path="creative-director/:id/:tab" element={<CreativeDirectorDetail />} />
            <Route path="queue" element={<RenderQueue />} />
            <Route path="timeline" element={<VideoTimeline />} />
            <Route path="timeline/:projectId" element={<VideoTimelineEditor />} />
            <Route path="models" element={<MediaModels />} />
          </Route>
          <Route path="image-gen" element={<RedirectWithSearch to="/media/image" />} />
          <Route path="video-gen" element={<RedirectWithSearch to="/media/video" />} />
          <Route path="media-history" element={<RedirectWithSearch to="/media/history" />} />
          <Route path="media-models" element={<RedirectWithSearch to="/media/models" />} />
          <Route path="wiki" element={<Navigate to="/wiki/overview" replace />} />
          <Route path="wiki/:tab" element={<Wiki />} />
          <Route path="rapid-reader" element={<RapidReaderPage />} />
          <Route path="agents" element={<Agents />} />
          <Route path="agents/:agentId" element={<Agents />} />
          <Route path="agents/:agentId/:tab" element={<Agents />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
