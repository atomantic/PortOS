import { useParams, useNavigate } from 'react-router-dom';
import { Skull } from 'lucide-react';

import { TABS } from '../components/meatspace/constants';

import OverviewTab from '../components/meatspace/tabs/OverviewTab';
import AgeTab from '../components/meatspace/tabs/AgeTab';
import AlcoholTab from '../components/meatspace/tabs/AlcoholTab';
import BloodTab from '../components/meatspace/tabs/BloodTab';
import BodyTab from '../components/meatspace/tabs/BodyTab';
import EyesTab from '../components/meatspace/tabs/EyesTab';
import GenomeTab from '../components/meatspace/tabs/GenomeTab';
import HealthTab from '../components/meatspace/tabs/HealthTab';
import ImportTab from '../components/meatspace/tabs/ImportTab';
import LifestyleTab from '../components/meatspace/tabs/LifestyleTab';

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
      case 'eyes':
        return <EyesTab />;
      case 'genome':
        return <GenomeTab />;
      case 'health':
        return <HealthTab />;
      case 'import':
        return <ImportTab />;
      case 'lifestyle':
        return <LifestyleTab />;
      default:
        return <OverviewTab />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-port-border">
        <div className="flex items-center gap-3 mb-4">
          <Skull size={24} className="text-port-error" />
          <h1 className="text-2xl font-bold text-white">MeatSpace</h1>
          <span className="text-sm text-gray-500">Physical Health Dashboard</span>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => handleTabChange(id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === id
                  ? 'bg-port-accent/10 text-port-accent'
                  : 'text-gray-400 hover:text-white hover:bg-port-border/50'
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-6">
        {renderTabContent()}
      </div>
    </div>
  );
}
