import { useCallback, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import {Brain as BrainIcon} from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import PageSkeleton from '../components/ui/PageSkeleton';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { sameJsonShape } from '../lib/sameJsonShape';

import { TABS, FULL_BLEED_TAB_IDS } from '../components/brain/constants';
import { timeAgo } from '../utils/formatters';

// Lazy-load tab bodies so opening one tab doesn't pull in all ten. BrainGraph in
// particular drags in the three.js stack, so it must stay out of the eager set.
const InboxTab = lazy(() => import('../components/brain/tabs/InboxTab'));
const LinksTab = lazy(() => import('../components/brain/tabs/LinksTab'));
const MemoryTab = lazy(() => import('../components/brain/tabs/MemoryTab'));
const DigestTab = lazy(() => import('../components/brain/tabs/DigestTab'));
const FeedsTab = lazy(() => import('../components/brain/tabs/FeedsTab'));
const TrustTab = lazy(() => import('../components/brain/tabs/TrustTab'));
const NotesTab = lazy(() => import('../components/brain/tabs/NotesTab'));
const DailyLogTab = lazy(() => import('../components/brain/tabs/DailyLogTab'));
const ConfigTab = lazy(() => import('../components/brain/tabs/ConfigTab'));
const ImportTab = lazy(() => import('../components/brain/tabs/ImportTab'));
const BrainGraph = lazy(() => import('../components/brain/tabs/BrainGraph'));

export default function Brain() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'inbox';
  // Full-bleed tabs own their internal scroll and fill height, so the shared
  // wrapper must NOT add padding or a second scrollbar (issue #1177). The set
  // is derived from the TABS registry so it can't drift from the tab list.
  const fullBleed = FULL_BLEED_TAB_IDS.has(activeTab);

  // Let errors throw — `useAutoRefetch` preserves the last-good data on
  // transient failures. `silent: true` keeps the 30s poll from spamming
  // toasts when a single blip would otherwise fire two of them.
  const fetchData = useCallback(async () => {
    const [summary, settings] = await Promise.all([
      api.getBrainSummary({ silent: true }),
      api.getBrainSettings({ silent: true })
    ]);
    return { summary, settings };
  }, []);

  const { data, loading, refetch } = useAutoRefetch(fetchData, 30_000, {
    compare: sameJsonShape,
  });
  const summary = data?.summary ?? null;
  const settings = data?.settings ?? null;

  const handleTabChange = (tabId) => {
    navigate(`/brain/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'inbox':
        return <InboxTab onRefresh={refetch} settings={settings} />;
      case 'links':
        return <LinksTab onRefresh={refetch} />;
      case 'memory':
        return <MemoryTab onRefresh={refetch} />;
      case 'notes':
        return <NotesTab onRefresh={refetch} />;
      case 'daily-log':
        return <DailyLogTab />;
      case 'graph':
        return <BrainGraph />;
      case 'digest':
        return <DigestTab onRefresh={refetch} />;
      case 'feeds':
        return <FeedsTab onRefresh={refetch} />;
      case 'trust':
        return <TrustTab onRefresh={refetch} />;
      case 'import':
        return <ImportTab />;
      case 'config':
        return <ConfigTab onRefresh={refetch} />;
      default:
        return <InboxTab onRefresh={refetch} settings={settings} />;
    }
  };

  if (loading) {
    return (
      <PageSkeleton
        header="bar"
        fullHeight
        padded
        titleWidthClass="w-28"
        showSubtitle
        tabs={TABS.length}
        cards={3}
        sidebar={false}
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        icon={BrainIcon}
        title="Brain"
        subtitle="Second brain for capturing and organizing thoughts"
        actions={summary && (
          // Quick stats — wrap on small screens; only "needs review" stays loud
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm">
            {summary.needsReview > 0 && (
              <span className="px-2 py-0.5 rounded bg-port-warning/20 text-port-warning">
                {summary.needsReview} needs review
              </span>
            )}
            <span className="text-gray-500">
              {summary.counts?.links || 0} links
            </span>
            <span className="text-gray-500">
              {summary.counts?.projects || 0} projects
            </span>
            <span className="hidden sm:inline text-gray-500">
              {summary.counts?.people || 0} people
            </span>
            {summary.lastDailyDigest && (
              <span className="hidden md:inline text-gray-500">
                Last digest: {timeAgo(summary.lastDailyDigest)}
              </span>
            )}
          </div>
        )}
      />

      <TabPills
        tabs={TABS}
        activeTab={activeTab}
        onChange={handleTabChange}
        hideLabelOnMobile
        ariaLabel="Brain sections"
      />

      {/* Tab content — full-bleed tabs own their own scroll and fill height;
          document-style tabs scroll inside a padded wrapper. */}
      <div className={`flex-1 min-h-0 ${fullBleed ? 'overflow-hidden' : 'overflow-auto p-3 sm:p-4'}`}>
        <Suspense fallback={<div className="flex items-center justify-center h-64"><BrailleSpinner text="Loading" /></div>}>
          {renderTabContent()}
        </Suspense>
      </div>
    </div>
  );
}
