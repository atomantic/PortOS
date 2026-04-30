import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {Target, TreePine, List} from 'lucide-react';
import * as api from '../services/api';
import GoalsTreeView from '../components/goals/GoalsTreeView';
import GoalsListView from '../components/goals/GoalsListView';
import MortalLoomBanner from '../components/MortalLoomBanner';
import BrailleSpinner from '../components/BrailleSpinner';

const TABS = [
  { id: 'list', label: 'List', icon: List },
  { id: 'tree', label: 'Tree', icon: TreePine }
];

const VALID_TABS = new Set(TABS.map(t => t.id));

export default function Goals() {
  const { tab: rawTab } = useParams();
  const tab = VALID_TABS.has(rawTab) ? rawTab : 'list';
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
      navigate('/goals/list', { replace: true });
    }
  }, [rawTab, navigate]);

  const handleTabChange = (tabId) => {
    navigate(`/goals/${tabId}`, { replace: true });
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <MortalLoomBanner section="Goals" />

      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-port-border bg-port-card">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Target className="w-5 h-5 sm:w-6 sm:h-6 text-port-accent shrink-0" />
          <h1 className="text-lg sm:text-xl font-semibold text-white">Goals</h1>
          {data && (
            <span className="text-xs sm:text-sm text-gray-500">
              {data.flat?.length || 0}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex bg-port-bg rounded-lg p-0.5">
            {TABS.map(t => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => handleTabChange(t.id)}
                  className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    active
                      ? 'bg-port-accent text-white'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{t.label}</span>
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
            <BrailleSpinner text="Loading" />
          </div>
        ) : tab === 'list' ? (
          <GoalsListView data={data} onRefresh={loadData} />
        ) : (
          <GoalsTreeView data={data} onRefresh={loadData} />
        )}
      </div>
    </div>
  );
}
