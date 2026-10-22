import { useParams } from 'react-router';
import { GitBranch } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import RouteTabsHeader from '../components/ui/RouteTabsHeader';
import GitHubAccountsTab from '../components/github/GitHubAccountsTab';
import GitHubAuditTab from '../components/github/GitHubAuditTab';
import GitHubAutomationsTab from '../components/github/GitHubAutomationsTab';
import GitHubInboxTab from '../components/github/GitHubInboxTab';
import GitHubReposTab from '../components/github/GitHubReposTab';

export const GITHUB_PAGE_TABS = Object.freeze([
  { id: 'inbox', label: 'Inbox', to: '/devtools/github/inbox' },
  { id: 'automations', label: 'Automations', to: '/devtools/github/automations' },
  { id: 'audit', label: 'Audit', to: '/devtools/github/audit' },
  { id: 'repos', label: 'Repos', to: '/devtools/github/repos' },
  { id: 'accounts', label: 'Accounts', to: '/devtools/github/accounts' },
]);

export default function GitHub() {
  const { tab } = useParams();
  const activeTab = GITHUB_PAGE_TABS.some((entry) => entry.id === tab) ? tab : 'inbox';

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={GitBranch}
        title="GitHub"
        actions={<RouteTabsHeader tabs={GITHUB_PAGE_TABS} activeTab={activeTab} ariaLabel="GitHub views" />}
      />
      <div className="@container/page min-w-0 flex-1 min-h-0 overflow-auto p-4 md:p-6">
      {activeTab === 'inbox' && <GitHubInboxTab />}
      {activeTab === 'automations' && <GitHubAutomationsTab />}
      {activeTab === 'audit' && <GitHubAuditTab />}
      {activeTab === 'repos' && <GitHubReposTab />}
      {activeTab === 'accounts' && <GitHubAccountsTab />}
      </div>
    </div>
  );
}
