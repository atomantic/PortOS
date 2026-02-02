import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Apps from './pages/Apps';
import CreateApp from './pages/CreateApp';
import Templates from './pages/Templates';
import PromptManager from './pages/PromptManager';
import ChiefOfStaff from './pages/ChiefOfStaff';
import Brain from './pages/Brain';
import Media from './pages/Media';
import DigitalTwin from './pages/DigitalTwin';
import Agents from './pages/Agents';

// Lazy load heavier pages for code splitting
// DevTools pages are large (~2300 lines total) so lazy load them
const AIProviders = lazy(() => import('./pages/AIProviders'));
const HistoryPage = lazy(() => import('./pages/DevTools').then(m => ({ default: m.HistoryPage })));
const RunsHistoryPage = lazy(() => import('./pages/DevTools').then(m => ({ default: m.RunsHistoryPage })));
const RunnerPage = lazy(() => import('./pages/DevTools').then(m => ({ default: m.RunnerPage })));
const GitPage = lazy(() => import('./pages/DevTools').then(m => ({ default: m.GitPage })));
const UsagePage = lazy(() => import('./pages/DevTools').then(m => ({ default: m.UsagePage })));
const ProcessesPage = lazy(() => import('./pages/DevTools').then(m => ({ default: m.ProcessesPage })));
const AgentsPage = lazy(() => import('./pages/DevTools').then(m => ({ default: m.AgentsPage })));

// Loading fallback for lazy-loaded pages
const PageLoader = () => (
  <div className="flex items-center justify-center h-64">
    <div className="text-gray-500">Loading...</div>
  </div>
);

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="apps" element={<Apps />} />
          <Route path="devtools" element={<Navigate to="/devtools/runs" replace />} />
          <Route path="devtools/history" element={<HistoryPage />} />
          <Route path="devtools/runs" element={<RunsHistoryPage />} />
          <Route path="devtools/runner" element={<RunnerPage />} />
          <Route path="devtools/git" element={<GitPage />} />
          <Route path="devtools/usage" element={<UsagePage />} />
          <Route path="devtools/processes" element={<ProcessesPage />} />
          <Route path="devtools/agents" element={<AgentsPage />} />
          <Route path="ai" element={<AIProviders />} />
          <Route path="prompts" element={<PromptManager />} />
          <Route path="cos" element={<Navigate to="/cos/tasks" replace />} />
          <Route path="cos/:tab" element={<ChiefOfStaff />} />
          <Route path="brain" element={<Navigate to="/brain/inbox" replace />} />
          <Route path="brain/:tab" element={<Brain />} />
          <Route path="digital-twin" element={<Navigate to="/digital-twin/overview" replace />} />
          <Route path="digital-twin/:tab" element={<DigitalTwin />} />
          <Route path="apps/create" element={<CreateApp />} />
          <Route path="templates" element={<Templates />} />
          <Route path="media" element={<Media />} />
          <Route path="agents" element={<Navigate to="/agents/personalities" replace />} />
          <Route path="agents/:tab" element={<Agents />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
