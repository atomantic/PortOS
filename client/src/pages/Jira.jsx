import { Link } from 'react-router';
import IntegrationInstancesPage from '../components/integrations/IntegrationInstancesPage';

// PAT lifetimes vary by Jira edition and token settings. Test is the reliable signal.
const TOKEN_STALE_WARN_DAYS = 60;
const getTokenAgeDays = tokenUpdatedAt => tokenUpdatedAt
  ? Math.floor((Date.now() - new Date(tokenUpdatedAt).getTime()) / 86400000)
  : null;

const fields = [
  { name: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://jira.example.com' },
  { name: 'email', label: 'Email', type: 'email', placeholder: 'your.email@example.com' },
  { name: 'apiToken', label: 'API Token (Personal Access Token)', type: 'password', secret: true, placeholder: 'Enter your JIRA Personal Access Token', help: 'Generate this from your JIRA profile → Personal Access Tokens' }
];
const initialForm = { id: '', name: '', baseUrl: '', email: '', apiToken: '' };

export default function Jira() {
  return <IntegrationInstancesPage
    title="JIRA" apiBase="/jira" feature="jira" fields={fields} initialForm={initialForm}
    heading={<h1 className="text-xl sm:text-2xl font-bold text-white">JIRA Integration</h1>}
    skeletonWidth="w-52" emptyDescription="Add a JIRA instance to enable ticket creation for your apps."
    deleteDescription="This will not affect existing tickets."
    headerActions={<Link to="/devtools/jira/reports" className="px-4 py-2 border border-port-border hover:border-port-accent text-gray-300 hover:text-white rounded text-sm">Status Reports</Link>}
    summarize={instance => {
      const ageDays = instance.hasApiToken ? getTokenAgeDays(instance.tokenUpdatedAt) : null;
      return <>
        <p className="text-gray-400 text-sm mt-1 break-all">{instance.baseUrl}</p>
        <p className="text-gray-500 text-sm truncate">Email: {instance.email}</p>
        <p className="text-gray-500 text-sm">API Token: {instance.hasApiToken ? '✓ Configured' : '✗ Not set'}</p>
        {instance.hasApiToken && ageDays === null && <p className="text-port-warning text-sm mt-1">Token age unknown — re-save to start tracking age</p>}
        {instance.hasApiToken && ageDays >= TOKEN_STALE_WARN_DAYS && <p className="text-port-warning text-sm mt-1">Token saved {ageDays} days ago — click Test to confirm it&apos;s still valid</p>}
      </>;
    }}
    testSuccessDetail={result => <div>
      <p className="text-port-success font-medium">✓ Connection successful</p>
      <p className="text-port-success/80 text-sm mt-1">Authenticated as: {result.user} ({result.email})</p>
    </div>}
    helpSteps={<>
      <p>1. Add one or more JIRA instances above</p>
      <p>2. Go to Apps and configure JIRA settings for each app</p>
      <p>3. When the Chief of Staff works on an app with JIRA enabled, it will:</p>
      <ul className="list-disc list-inside ml-2 sm:ml-4 space-y-1 text-gray-400">
        <li>Create a JIRA ticket for the work</li>
        <li>Create a feature branch (e.g., feature/PROJ-1234)</li>
        <li>Make commits to that branch</li>
        <li>Create a pull request with ticket link</li>
      </ul>
    </>}
  />;
}
