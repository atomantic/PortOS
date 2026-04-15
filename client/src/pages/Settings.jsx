import { useParams, useNavigate } from 'react-router-dom';
import { BackupTab } from '../components/settings/BackupTab';
import { DatabaseTab } from '../components/settings/DatabaseTab';
import { TelegramTab } from '../components/settings/TelegramTab';
import { GeneralTab } from '../components/settings/GeneralTab';
import { ImageGenTab } from '../components/settings/ImageGenTab';
import { MortalLoomTab } from '../components/settings/MortalLoomTab';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'backup', label: 'Backup' },
  { id: 'database', label: 'Database' },
  { id: 'image-gen', label: 'Image Gen' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'mortalloom', label: 'MortalLoom' }
];

export default function Settings() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'general';

  const handleTabChange = (tabId) => {
    navigate(`/settings/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general': return <GeneralTab />;
      case 'backup': return <BackupTab />;
      case 'database': return <DatabaseTab />;
      case 'image-gen': return <ImageGenTab />;
      case 'telegram': return <TelegramTab />;
      case 'mortalloom': return <MortalLoomTab />;
      default: return <GeneralTab />;
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Settings</h1>

      <div className="flex gap-1 border-b border-port-border">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => handleTabChange(id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === id
                ? 'text-port-accent border-port-accent'
                : 'text-gray-400 border-transparent hover:text-white hover:border-port-border'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {renderTabContent()}
    </div>
  );
}
