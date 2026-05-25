import { useParams, Navigate } from 'react-router-dom';
import { BackupTab } from '../components/settings/BackupTab';
import { DatabaseTab } from '../components/settings/DatabaseTab';
import { LocalLlmTab } from '../components/settings/LocalLlmTab';
import { TelegramTab } from '../components/settings/TelegramTab';
import { GeneralTab } from '../components/settings/GeneralTab';
import { MortalLoomTab } from '../components/settings/MortalLoomTab';
import { SharingTab } from '../components/settings/SharingTab';
import { VoiceTab } from '../components/settings/VoiceTab';
import SettingsTabsHeader from '../components/settings/SettingsTabsHeader';

// Settings pages now host themselves as drawers on their feature pages where
// it makes sense. Redirect old direct URLs to the new home so bookmarks and
// stale palette entries keep working.
const REDIRECTS = {
  'image-gen': '/media/image?settings=1'
};

export default function Settings() {
  const { tab } = useParams();
  const activeTab = tab || 'general';

  if (REDIRECTS[activeTab]) {
    return <Navigate to={REDIRECTS[activeTab]} replace />;
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general': return <GeneralTab />;
      case 'backup': return <BackupTab />;
      case 'database': return <DatabaseTab />;
      case 'local-llm': return <LocalLlmTab />;
      case 'sharing': return <SharingTab />;
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

      <SettingsTabsHeader activeTab={activeTab} />

      <div className="flex-1 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
