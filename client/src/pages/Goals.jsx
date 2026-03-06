import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Target, TreePine, List, RefreshCw } from 'lucide-react';
import * as api from '../services/api';
import GoalsTreeView from '../components/goals/GoalsTreeView';
import GoalsListView from '../components/goals/GoalsListView';

const TABS = [
  { id: 'tree', label: 'Tree', icon: TreePine },
  { id: 'list', label: 'List', icon: List }
];

const VALID_TABS = new Set(TABS.map(t => t.id));

export default function Goals() {
  const { tab: rawTab } = useParams();
  const tab = VALID_TABS.has(rawTab) ? rawTab : 'tree';
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    const tree = await api.getGoalsTree().catch(() => null);
    setData(tree);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (rawTab && !VALID_TABS.has(rawTab)) {
      navigate('/goals/tree', { replace: true });
    }
  }, [rawTab, navigate]);

  const handleTabChange = (tabId) => {
    navigate(`/goals/${tabId}`, { replace: true });
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-port-border bg-port-card">
        <div className="flex items-center gap-3">
          <Target className="w-6 h-6 text-port-accent" />
          <h1 className="text-xl font-semibold text-white">Goals</h1>
          {data && (
            <span className="text-sm text-gray-500">
              {data.flat?.length || 0} goals
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setLoading(true); loadData(); }}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-port-border/50"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <div className="flex bg-port-bg rounded-lg p-0.5">
            {TABS.map(t => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => handleTabChange(t.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    active
                      ? 'bg-port-accent text-white'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
          </div>
        ) : tab === 'tree' ? (
          <GoalsTreeView data={data} onRefresh={loadData} />
        ) : (
          <GoalsListView data={data} onRefresh={loadData} />
        )}
      </div>
    </div>
  );
}
