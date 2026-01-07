import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Apps from './pages/Apps';
import CreateApp from './pages/CreateApp';
import Templates from './pages/Templates';
import AIProviders from './pages/AIProviders';
import { HistoryPage, RunsHistoryPage, RunnerPage, GitPage, UsagePage, ProcessesPage, AgentsPage } from './pages/DevTools';
import PromptManager from './pages/PromptManager';
import ChiefOfStaff from './pages/ChiefOfStaff';

export default function App() {
  return (
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
        <Route path="apps/create" element={<CreateApp />} />
        <Route path="templates" element={<Templates />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
