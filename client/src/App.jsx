import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Apps from './pages/Apps';
import Logs from './pages/Logs';
import CreateApp from './pages/CreateApp';
import AIProviders from './pages/AIProviders';
import DevTools from './pages/DevTools';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="apps" element={<Apps />} />
        <Route path="logs" element={<Logs />} />
        <Route path="devtools" element={<Navigate to="/devtools/history" replace />} />
        <Route path="devtools/:tab" element={<DevTools />} />
        <Route path="ai" element={<AIProviders />} />
        <Route path="create" element={<CreateApp />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
