import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import BrailleSpinner from './components/BrailleSpinner';
import Dashboard from './pages/Dashboard';
import Ambient from './pages/Ambient';
import Apps from './pages/Apps';
import CreateApp from './pages/CreateApp';
import Templates from './pages/Templates';
import PromptManager from './pages/PromptManager';
import ChiefOfStaff from './pages/ChiefOfStaff';
import Brain from './pages/Brain';
import Security from './pages/Security';
import DigitalTwin from './pages/DigitalTwin';
import Agents from './pages/Agents';
import Uploads from './pages/Uploads';
import Settings from './pages/Settings';
import Shell from './pages/Shell';
import BrowserPage from './pages/Browser';
import Jira from './pages/Jira';
import JiraReports from './pages/JiraReports';
import DataManager from './pages/DataManager';
import Insights from './pages/Insights';
import Instances from './pages/Instances';
import MeatSpace from './pages/MeatSpace';
import Post from './pages/Post';
import Review from './pages/Review';
import Loops from './pages/Loops';
import CharacterSheet from './pages/CharacterSheet';

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

// Loading fallback for lazy-loaded pages
const PageLoader = () => (
  <div className="flex items-center justify-center h-64">
    <BrailleSpinner text="Loading" />
  </div>
);

// Force full reload on HMR — partial hot-replacement of the route tree
// causes stale lazy imports and React Router errors on nested paths
if (import.meta.hot) {
  import.meta.hot.decline();
}

export default function App() {
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
          <Route path="agents" element={<Agents />} />
          <Route path="agents/:agentId" element={<Agents />} />
          <Route path="agents/:agentId/:tab" element={<Agents />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
