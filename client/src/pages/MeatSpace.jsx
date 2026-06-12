import { useParams, useNavigate } from 'react-router-dom';
import { Skull } from 'lucide-react';

import { TABS } from '../components/meatspace/constants';
import MortalLoomBanner from '../components/MortalLoomBanner';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';

import OverviewTab from '../components/meatspace/tabs/OverviewTab';
import AgeTab from '../components/meatspace/tabs/AgeTab';
import AlcoholTab from '../components/meatspace/tabs/AlcoholTab';
import BloodTab from '../components/meatspace/tabs/BloodTab';
import BodyTab from '../components/meatspace/tabs/BodyTab';
import ExportTab from '../components/meatspace/tabs/ExportTab';
import GenomeTab from '../components/meatspace/tabs/GenomeTab';
import HealthTab from '../components/meatspace/tabs/HealthTab';
import SettingsTab from '../components/meatspace/tabs/SettingsTab';
import LifestyleTab from '../components/meatspace/tabs/LifestyleTab';
import NicotineTab from '../components/meatspace/tabs/NicotineTab';

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
        {renderTabContent()}
      </div>
    </div>
  );
}
