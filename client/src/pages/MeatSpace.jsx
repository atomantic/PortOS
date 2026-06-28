import { lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Skull } from 'lucide-react';

import { TABS } from '../components/meatspace/constants';
import MortalLoomBanner from '../components/MortalLoomBanner';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import BrailleSpinner from '../components/BrailleSpinner';

// Lazy-load tab bodies so opening one tab doesn't pull in all eleven (GenomeTab
// in particular is heavy). The page itself is already a lazy route chunk.
const OverviewTab = lazy(() => import('../components/meatspace/tabs/OverviewTab'));
const AgeTab = lazy(() => import('../components/meatspace/tabs/AgeTab'));
const AlcoholTab = lazy(() => import('../components/meatspace/tabs/AlcoholTab'));
const BloodTab = lazy(() => import('../components/meatspace/tabs/BloodTab'));
const BodyTab = lazy(() => import('../components/meatspace/tabs/BodyTab'));
const ExportTab = lazy(() => import('../components/meatspace/tabs/ExportTab'));
const GenomeTab = lazy(() => import('../components/meatspace/tabs/GenomeTab'));
const HealthTab = lazy(() => import('../components/meatspace/tabs/HealthTab'));
const SettingsTab = lazy(() => import('../components/meatspace/tabs/SettingsTab'));
const LifestyleTab = lazy(() => import('../components/meatspace/tabs/LifestyleTab'));
const NicotineTab = lazy(() => import('../components/meatspace/tabs/NicotineTab'));

export default function MeatSpace() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'overview';

  const handleTabChange = (tabId) => {
    navigate(`/meatspace/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab />;
      case 'age':
        return <AgeTab />;
      case 'alcohol':
        return <AlcoholTab />;
      case 'blood':
        return <BloodTab />;
      case 'body':
        return <BodyTab />;
      case 'export':
        return <ExportTab />;
      case 'genome':
        return <GenomeTab />;
      case 'health':
        return <HealthTab />;
      case 'settings':
        return <SettingsTab />;
      case 'lifestyle':
        return <LifestyleTab />;
      case 'nicotine':
        return <NicotineTab />;
      default:
        return <OverviewTab />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="print:hidden">
        <MortalLoomBanner section="Meatspace health data" />
      </div>

      <PageHeader
        icon={Skull}
        iconColor="text-port-error"
        title="MeatSpace"
        subtitle="Physical Health Dashboard"
        className="print:hidden"
      />

      <TabPills
        tabs={TABS}
        activeTab={activeTab}
        onChange={handleTabChange}
        ariaLabel="MeatSpace sections"
        className="print:hidden"
      />

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-6 print:overflow-visible print:p-0">
        <Suspense fallback={<div className="flex justify-center py-12"><BrailleSpinner text="Loading" /></div>}>
          {renderTabContent()}
        </Suspense>
      </div>
    </div>
  );
}
