import { useCallback, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import { Heart } from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { sameJsonShape } from '../lib/sameJsonShape';

import { TABS, getHealthColor, getHealthLabel } from '../components/digital-twin/constants';

// Lazy-load tab bodies so opening any one tab doesn't pull in all 17 — a user
// typically views 1–2 of them. The page itself is already a lazy route chunk.
const OverviewTab = lazy(() => import('../components/digital-twin/tabs/OverviewTab'));
const DocumentsTab = lazy(() => import('../components/digital-twin/tabs/DocumentsTab'));
const TestTab = lazy(() => import('../components/digital-twin/tabs/TestTab'));
const PersonalityTab = lazy(() => import('../components/digital-twin/tabs/PersonalityTab'));
const EnrichTab = lazy(() => import('../components/digital-twin/tabs/EnrichTab'));
const TasteTab = lazy(() => import('../components/digital-twin/tabs/TasteTab'));
const AccountsTab = lazy(() => import('../components/digital-twin/tabs/AccountsTab'));
const InterviewTab = lazy(() => import('../components/digital-twin/tabs/InterviewTab'));
const VoiceStyleTab = lazy(() => import('../components/digital-twin/tabs/VoiceStyleTab'));
const AppearanceTab = lazy(() => import('../components/digital-twin/tabs/AppearanceTab'));
const IdentityTab = lazy(() => import('../components/digital-twin/tabs/IdentityTab'));
const PersonasTab = lazy(() => import('../components/digital-twin/tabs/PersonasTab'));
const GoalsTab = lazy(() => import('../components/digital-twin/tabs/GoalsTab'));
const AutobiographyTab = lazy(() => import('../components/digital-twin/tabs/AutobiographyTab'));
const ImportTab = lazy(() => import('../components/digital-twin/tabs/ImportTab'));
const AvatarBioTab = lazy(() => import('../components/digital-twin/tabs/AvatarBioTab'));
const ExportTab = lazy(() => import('../components/digital-twin/tabs/ExportTab'));
const LegacyExportTab = lazy(() => import('../components/digital-twin/tabs/LegacyExportTab'));
const TimeCapsuleTab = lazy(() => import('../components/digital-twin/tabs/TimeCapsuleTab'));

export default function DigitalTwin() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'overview';

  // Let errors throw — `useAutoRefetch` preserves the last-good data on
  // transient failures. `silent: true` keeps the 30s poll from spamming
  // toasts when a single blip would otherwise fire two of them.
  const fetchData = useCallback(async () => {
    const [status, settings] = await Promise.all([
      api.getDigitalTwinStatus({ silent: true }),
      api.getDigitalTwinSettings({ silent: true })
    ]);
    return { status, settings };
  }, []);

  const { data, loading, refetch } = useAutoRefetch(fetchData, 30_000, {
    compare: sameJsonShape,
  });
  const status = data?.status ?? null;
  const settings = data?.settings ?? null;

  const handleTabChange = (tabId) => {
    navigate(`/digital-twin/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab status={status} settings={settings} onRefresh={refetch} />;
      case 'documents':
        return <DocumentsTab onRefresh={refetch} />;
      case 'test':
        return <TestTab onRefresh={refetch} />;
      case 'personality':
        return <PersonalityTab />;
      case 'enrich':
        return <EnrichTab onRefresh={refetch} />;
      case 'taste':
        return <TasteTab onRefresh={refetch} />;
      case 'accounts':
        return <AccountsTab />;
      case 'identity':
        return <IdentityTab onRefresh={refetch} />;
      case 'personas':
        return <PersonasTab onRefresh={refetch} />;
      case 'goals':
        return <GoalsTab onRefresh={refetch} />;
      case 'interview':
        return <InterviewTab onRefresh={refetch} />;
      case 'voice':
        return <VoiceStyleTab onRefresh={refetch} />;
      case 'appearance':
        return <AppearanceTab onRefresh={refetch} />;
      case 'autobiography':
        return <AutobiographyTab onRefresh={refetch} />;
      case 'import':
        return <ImportTab onRefresh={refetch} />;
      case 'avatar-bio':
        return <AvatarBioTab />;
      case 'export':
        return <ExportTab onRefresh={refetch} />;
      case 'legacy':
        return <LegacyExportTab />;
      case 'time-capsule':
        return <TimeCapsuleTab onRefresh={refetch} />;
      default:
        return <OverviewTab status={status} settings={settings} onRefresh={refetch} />;
    }
  };

  if (loading) {
    return (
      <div className="absolute inset-0">
        <PageSkeleton
          header="bar"
          label="Loading digital twin"
          fullHeight
          padded
          barClassName="p-4"
          bodyClassName="p-4"
          titleWidthClass="w-40"
          showSubtitle
          subtitleOnMobile
          tabs={TABS.length}
          cards={3}
          sidebar={false}
        />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-4 gap-3 border-b border-port-border">
        <div className="flex items-center gap-3">
          <Heart className="w-8 h-8 text-pink-500 shrink-0" />
          <div>
            <h1 className="text-xl font-bold text-white">Digital Twin</h1>
            <p className="text-sm text-gray-500">Identity scaffold for AI interactions</p>
          </div>
        </div>

        {/* Quick stats */}
        {status && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Health:</span>
              <span className={`font-medium ${getHealthColor(status.healthScore)}`}>
                {status.healthScore}% ({getHealthLabel(status.healthScore)})
              </span>
            </div>
            <span className="text-gray-500">
              {status.enabledDocuments}/{status.documentCount} docs
            </span>
            {status.lastTestRun && (
              <span className="text-gray-500">
                Last test: {Math.round(status.lastTestRun.score * 100)}%
              </span>
            )}
          </div>
        )}
      </div>

      <TabPills
        tabs={TABS}
        activeTab={activeTab}
        onChange={handleTabChange}
        hideLabelOnMobile
        ariaLabel="Digital Twin sections"
      />

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-4">
        <Suspense fallback={<div className="flex justify-center py-12"><BrailleSpinner text="Loading" /></div>}>
          {renderTabContent()}
        </Suspense>
      </div>
    </div>
  );
}
