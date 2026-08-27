import { useParams, Navigate } from 'react-router';
import { Settings as SettingsIcon } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { ApiAccessTab } from '../components/settings/ApiAccessTab';
import { AutofixerTab } from '../components/settings/AutofixerTab';
import AiAssignmentsTab from '../components/settings/AiAssignmentsTab';
import { BackupTab } from '../components/settings/BackupTab';
import CodeReviewersTab from '../components/settings/CodeReviewersTab';
import { DatabaseTab } from '../components/settings/DatabaseTab';
import InstanceFeaturesTab from '../components/settings/InstanceFeaturesTab';
import { TelegramTab } from '../components/settings/TelegramTab';
import { GeneralTab } from '../components/settings/GeneralTab';
import { MortalLoomTab } from '../components/settings/MortalLoomTab';
import { SecurityTab } from '../components/settings/SecurityTab';
import { SharingTab } from '../components/settings/SharingTab';
import { SignalTab } from '../components/settings/SignalTab';
import { SpotifyTab } from '../components/settings/SpotifyTab';
import { YoutubeTab } from '../components/settings/YoutubeTab';
import { VoiceTab } from '../components/settings/VoiceTab';
import SettingsTabsHeader from '../components/settings/SettingsTabsHeader';

// Settings pages now host themselves as drawers on their feature pages where
// it makes sense. Redirect old direct URLs to the new home so bookmarks and
// stale palette entries keep working.
const REDIRECTS = {
  'image-gen': '/media/image?settings=1',
  imessage: '/messages/imessage?settings=1',
  catalog: '/catalog?settings=1',
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
      case 'api-access': return <ApiAccessTab />;
      case 'autofixer': return <AutofixerTab />;
      case 'backup': return <BackupTab />;
      case 'code-reviewers': return <CodeReviewersTab />;
      case 'database': return <DatabaseTab />;
      case 'features': return <InstanceFeaturesTab />;
      case 'security': return <SecurityTab />;
      case 'sharing': return <SharingTab />;
      case 'signal': return <SignalTab />;
      case 'spotify': return <SpotifyTab />;
      case 'youtube': return <YoutubeTab />;
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
