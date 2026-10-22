import { useParams } from 'react-router';
import RouteTabsHeader from '../components/ui/RouteTabsHeader';
import GitHubAccountsTab from '../components/github/GitHubAccountsTab';
import GitHubAutomationsTab from '../components/github/GitHubAutomationsTab';
import GitHubInboxTab from '../components/github/GitHubInboxTab';
import GitHubReposTab from '../components/github/GitHubReposTab';

// Audit joins when its phase ships (#12873).
export const GITHUB_PAGE_TABS = Object.freeze([
  { id: 'inbox', label: 'Inbox', to: '/devtools/github/inbox' },
  { id: 'automations', label: 'Automations', to: '/devtools/github/automations' },
  { id: 'repos', label: 'Repos', to: '/devtools/github/repos' },
  { id: 'accounts', label: 'Accounts', to: '/devtools/github/accounts' },
]);

export default function GitHub() {
  const { tab } = useParams();
  const activeTab = GITHUB_PAGE_TABS.some((entry) => entry.id === tab) ? tab : 'inbox';

  return (
    <div className="@container/page min-w-0 p-4 sm:p-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl sm:text-2xl font-bold text-white">GitHub</h1>
        <RouteTabsHeader tabs={GITHUB_PAGE_TABS} activeTab={activeTab} ariaLabel="GitHub views" />
      </div>
      {activeTab === 'inbox' && <GitHubInboxTab />}
      {activeTab === 'automations' && <GitHubAutomationsTab />}
      {activeTab === 'repos' && <GitHubReposTab />}
      {activeTab === 'accounts' && <GitHubAccountsTab />}
    </div>
  );
}
