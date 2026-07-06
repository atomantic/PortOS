import { useParams, Navigate } from 'react-router-dom';
import { Settings as SettingsIcon } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { ApiAccessTab } from '../components/settings/ApiAccessTab';
import { AutofixerTab } from '../components/settings/AutofixerTab';
import AiAssignmentsTab from '../components/settings/AiAssignmentsTab';
import { BackupTab } from '../components/settings/BackupTab';
import { BranchReconcileTab } from '../components/settings/BranchReconcileTab';
import { CatalogTypesTab } from '../components/settings/CatalogTypesTab';
import { DatabaseTab } from '../components/settings/DatabaseTab';
import EmbeddingsTab from '../components/settings/EmbeddingsTab';
import { LocalLlmTab } from '../components/settings/LocalLlmTab';
import { TelegramTab } from '../components/settings/TelegramTab';
import { GeneralTab } from '../components/settings/GeneralTab';
import { IMessageTab } from '../components/settings/IMessageTab';
import { MortalLoomTab } from '../components/settings/MortalLoomTab';
import { SecurityTab } from '../components/settings/SecurityTab';
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
      case 'imessage': return <IMessageTab />;
      case 'ai-assignments': return <AiAssignmentsTab />;
      case 'api-access': return <ApiAccessTab />;
      case 'autofixer': return <AutofixerTab />;
      case 'backup': return <BackupTab />;
      case 'branch-reconcile': return <BranchReconcileTab />;
      case 'catalog': return <CatalogTypesTab />;
      case 'database': return <DatabaseTab />;
      case 'embeddings': return <EmbeddingsTab />;
      case 'local-llm': return <LocalLlmTab />;
      case 'security': return <SecurityTab />;
      case 'sharing': return <SharingTab />;
      case 'voice': return <VoiceTab />;
      case 'telegram': return <TelegramTab />;
      case 'mortalloom': return <MortalLoomTab />;
      default: return <GeneralTab />;
    }
  };

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <PageHeader icon={SettingsIcon} title="Settings" />

      <SettingsTabsHeader activeTab={activeTab} />

      <div className="flex-1 min-w-0 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
