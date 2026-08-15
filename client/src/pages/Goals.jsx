import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router';
import {Target, TreePine, List} from 'lucide-react';
import * as api from '../services/api';
import GoalsListView from '../components/goals/GoalsListView';
import MortalLoomBanner from '../components/MortalLoomBanner';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import PageSkeleton from '../components/ui/PageSkeleton';
import { useValidTab } from '../hooks/useValidTab';

const GoalsTreeView = lazy(() => import('../components/goals/GoalsTreeView'));

// Exported for the nav-manifest tab-coverage guard (server/lib/navManifest.test.js).
export const TABS = [
  { id: 'list', label: 'List', icon: List },
  { id: 'tree', label: 'Tree', icon: TreePine }
];

export default function Goals() {
  // `/goals/list/:goalId` carries no `:tab` segment, so `useValidTab` falls back to
  // 'list' — the only view with a routed per-goal detail panel today.
  const { tab: rawTab, goalId } = useParams();
  const tab = useValidTab(TABS, 'list');
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
    // `tab !== rawTab` only when the param failed validation and fell back.
    if (rawTab && rawTab !== tab) {
      navigate('/goals/list', { replace: true });
    }
  }, [rawTab, tab, navigate]);

  const handleTabChange = (tabId) => {
    navigate(`/goals/${tabId}`, { replace: true });
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <MortalLoomBanner section="Goals" />

      <PageHeader
        icon={Target}
        title="Goals"
        className="bg-port-card"
        actions={(
          <>
            {data && (
              <span className="text-xs sm:text-sm text-gray-500">
                {data.flat?.length || 0}
              </span>
            )}
            <TabPills
              tabs={TABS}
              activeTab={tab}
              onChange={handleTabChange}
              variant="pills"
              size="sm"
              ariaLabel="Goals views"
            />
          </>
        )}
      />

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <PageSkeleton header="none" label="Loading goals" fullHeight cards={4} sidebar={false} />
        ) : tab === 'list' ? (
          <GoalsListView data={data} onRefresh={loadData} selectedGoalId={goalId} />
        ) : (
          // Same reserved shape the page's own load branch uses above — the tree
          // chunk arriving late shouldn't look different from the data arriving
          // late (#4147).
          <Suspense fallback={<PageSkeleton header="none" label="Loading goal tree" fullHeight cards={4} sidebar={false} />}>
            <GoalsTreeView data={data} onRefresh={loadData} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
