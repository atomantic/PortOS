import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router';
import {Target, TreePine, List} from 'lucide-react';
import * as api from '../services/api';
import GoalsListView from '../components/goals/GoalsListView';
import MortalLoomBanner from '../components/MortalLoomBanner';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import PageSkeleton from '../components/ui/PageSkeleton';
import LoadFailedState from '../components/ui/LoadFailedState';
import { useValidTab } from '../hooks/useValidTab';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';
import { buildPageNavTabs } from '../lib/pageNavTabs.js';

const GoalsTreeView = lazy(() => import('../components/goals/GoalsTreeView'));

// Icon per tab id. The manifest (`tabGroup: 'goals'`) owns id/label/order —
// this page owns only how each tab looks; the short page-local labels
// ("List"/"Tree" vs. the manifest's "Goals"/"Goals Tree") come from the
// manifest's `tabLabel`. Throws at import time on drift.
const TAB_PRESENTATION = {
  list: { icon: List },
  tree: { icon: TreePine },
};

export const TABS = buildPageNavTabs(getPageNavTabs('goals'), TAB_PRESENTATION, 'Goals');

export default function Goals() {
  // `/goals/list/:goalId` carries no `:tab` segment, so `useValidTab` falls back to
  // 'list' — the only view with a routed per-goal detail panel today.
  const { tab: rawTab, goalId } = useParams();
  const tab = useValidTab(TABS, 'list');
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  // Children call onRefresh after every mutation, so reads can overlap; only
  // the newest one may write.
  const loadGeneration = useRef(0);

  // A failed read is not an empty goal list. The request helper toasts the
  // failure; a refresh that fails keeps the goals already shown, and a first
  // read that fails renders a retry instead of "No goals yet".
  const loadData = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const result = await api.getGoalsTree().then((tree) => ({ tree }), (error) => ({ error }));
    if (generation !== loadGeneration.current) return;
    if (result.error) {
      setLoadError(result.error);
    } else {
      setData(result.tree);
      setLoadError(null);
    }
    setLoading(false);
  }, []);
  const retryLoad = () => {
    setLoading(true);
    loadData();
  };

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
        ) : !data && loadError ? (
          <LoadFailedState title="Could not load goals" hint={loadError.message} onRetry={retryLoad} />
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
