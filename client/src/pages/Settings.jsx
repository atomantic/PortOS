import { useParams, Navigate } from 'react-router-dom';
import { AutofixerTab } from '../components/settings/AutofixerTab';
import AiAssignmentsTab from '../components/settings/AiAssignmentsTab';
import { BackupTab } from '../components/settings/BackupTab';
import { CatalogTypesTab } from '../components/settings/CatalogTypesTab';
import { DatabaseTab } from '../components/settings/DatabaseTab';
import EmbeddingsTab from '../components/settings/EmbeddingsTab';
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
      case 'ai-assignments': return <AiAssignmentsTab />;
      case 'autofixer': return <AutofixerTab />;
      case 'backup': return <BackupTab />;
      case 'catalog': return <CatalogTypesTab />;
      case 'database': return <DatabaseTab />;
      case 'embeddings': return <EmbeddingsTab />;
      case 'local-llm': return <LocalLlmTab />;
      case 'sharing': return <SharingTab />;
      case 'voice': return <VoiceTab />;
      case 'telegram': return <TelegramTab />;
      case 'mortalloom': return <MortalLoomTab />;
      default: return <GeneralTab />;
    }
  };

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex items-center gap-3 p-4 border-b border-port-border shrink-0">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
      </div>

      <SettingsTabsHeader activeTab={activeTab} />

      <div className="flex-1 min-w-0 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
