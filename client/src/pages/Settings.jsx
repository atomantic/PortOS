import { Suspense } from 'react';
import { useParams, Navigate } from 'react-router';
import { Settings as SettingsIcon } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { GeneralTab } from '../components/settings/GeneralTab';
import SettingsTabsHeader from '../components/settings/SettingsTabsHeader';
import { lazyWithReload } from '../utils/lazyWithReload';
import BrailleSpinner from '../components/BrailleSpinner';

// GeneralTab stays static as the default tab; every other tab is fetched on first visit.
const ApiAccessTab = lazyWithReload(() => import('../components/settings/ApiAccessTab').then(m => ({ default: m.ApiAccessTab })));
const AutofixerTab = lazyWithReload(() => import('../components/settings/AutofixerTab').then(m => ({ default: m.AutofixerTab })));
const AiAssignmentsTab = lazyWithReload(() => import('../components/settings/AiAssignmentsTab'));
const BackupTab = lazyWithReload(() => import('../components/settings/BackupTab').then(m => ({ default: m.BackupTab })));
const DatabaseTab = lazyWithReload(() => import('../components/settings/DatabaseTab').then(m => ({ default: m.DatabaseTab })));
const InstanceFeaturesTab = lazyWithReload(() => import('../components/settings/InstanceFeaturesTab'));
const CredentialsTab = lazyWithReload(() => import('../components/settings/CredentialsTab'));
const TelegramTab = lazyWithReload(() => import('../components/settings/TelegramTab').then(m => ({ default: m.TelegramTab })));
const MortalLoomTab = lazyWithReload(() => import('../components/settings/MortalLoomTab').then(m => ({ default: m.MortalLoomTab })));
const SecurityTab = lazyWithReload(() => import('../components/settings/SecurityTab').then(m => ({ default: m.SecurityTab })));
const SharingTab = lazyWithReload(() => import('../components/settings/SharingTab').then(m => ({ default: m.SharingTab })));
const SoftwareTab = lazyWithReload(() => import('../components/settings/SoftwareTab'));
const VoiceTab = lazyWithReload(() => import('../components/settings/VoiceTab').then(m => ({ default: m.VoiceTab })));
const OrchestrationTab = lazyWithReload(() => import('../components/settings/OrchestrationTab'));

// Settings pages now host themselves as drawers on their feature pages where
// it makes sense. Redirect old direct URLs to the new home so bookmarks and
// stale palette entries keep working.
const REDIRECTS = {
  'image-gen': '/media/image?settings=1',
  render: '/media/image?settings=1',
  imessage: '/messages/imessage?settings=1',
  signal: '/messages/signal',
  catalog: '/catalog?settings=1',
  spotify: '/brain/spotify',
  youtube: '/brain/youtube',
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
      case 'database': return <DatabaseTab />;
      case 'credentials': return <CredentialsTab />;
      case 'features': return <InstanceFeaturesTab />;
      case 'security': return <SecurityTab />;
      case 'sharing': return <SharingTab />;
      case 'software': return <SoftwareTab />;
      case 'voice': return <VoiceTab />;
      case 'telegram': return <TelegramTab />;
      case 'mortalloom': return <MortalLoomTab />;
      case 'orchestration': return <OrchestrationTab />;
      default: return <GeneralTab />;
    }
  };

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <PageHeader icon={SettingsIcon} title="Settings" />

      <SettingsTabsHeader activeTab={activeTab} />

      <div className="flex-1 min-w-0 overflow-auto p-4">
        <Suspense fallback={<BrailleSpinner text="Loading tab" />}>
          {renderTabContent()}
        </Suspense>
      </div>
    </div>
  );
}
