import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { BackupTab } from '../components/settings/BackupTab';
import { DatabaseTab } from '../components/settings/DatabaseTab';
import { TelegramTab } from '../components/settings/TelegramTab';
import { GeneralTab } from '../components/settings/GeneralTab';
import { MortalLoomTab } from '../components/settings/MortalLoomTab';
import { VoiceTab } from '../components/settings/VoiceTab';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'backup', label: 'Backup' },
  { id: 'database', label: 'Database' },
  { id: 'voice', label: 'Voice' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'mortalloom', label: 'MortalLoom' }
];

// Settings pages now host themselves as drawers on their feature pages where
// it makes sense. Redirect old direct URLs to the new home so bookmarks and
// stale palette entries keep working.
const REDIRECTS = {
  'image-gen': '/media/image?settings=1'
};

export default function Settings() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'general';

  if (REDIRECTS[activeTab]) {
    return <Navigate to={REDIRECTS[activeTab]} replace />;
  }

  const handleTabChange = (tabId) => {
    navigate(`/settings/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general': return <GeneralTab />;
      case 'backup': return <BackupTab />;
      case 'database': return <DatabaseTab />;
      case 'voice': return <VoiceTab />;
      case 'telegram': return <TelegramTab />;
      case 'mortalloom': return <MortalLoomTab />;
      default: return <GeneralTab />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-port-border">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
      </div>

      <div className="flex border-b border-port-border overflow-x-auto" role="tablist">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => handleTabChange(id)}
            role="tab"
            aria-selected={activeTab === id}
            className={`px-4 py-3 text-sm font-medium transition-colors whitespace-nowrap border-b-2 -mb-px ${
              activeTab === id
                ? 'text-port-accent border-port-accent bg-port-accent/5'
                : 'text-gray-400 border-transparent hover:text-white hover:border-port-border'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
