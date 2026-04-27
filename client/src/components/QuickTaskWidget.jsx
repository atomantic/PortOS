import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../services/api';
import TaskAddForm from './cos/TaskAddForm';

export default function QuickTaskWidget() {
  const [providers, setProviders] = useState([]);
  const [apps, setApps] = useState([]);

  useEffect(() => {
    api.getProviders().then(data => setProviders(data.providers || [])).catch(() => setProviders([]));
    api.getApps().then(setApps).catch(() => setApps([]));
  }, []);

  // Tiles render with overflow-hidden + a fixed pixel height (h * ROW_HEIGHT)
  // — fill the cell and let the form area scroll if the user shrank the
  // tile below the expanded form's natural height.
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h3 className="text-sm font-semibold text-white">Quick Task</h3>
        <Link to="/cos/tasks" className="text-xs text-gray-500 hover:text-port-accent transition-colors">
          Tasks &rarr;
        </Link>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <TaskAddForm providers={providers} apps={apps} onTaskAdded={() => {}} compact defaultExpanded />
      </div>
    </div>
  );
}
