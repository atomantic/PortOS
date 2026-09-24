import IntegrationInstancesPage from '../components/integrations/IntegrationInstancesPage';

const SITE_OPTIONS = [
  { value: 'api.datadoghq.com', label: 'US1 (api.datadoghq.com)' },
  { value: 'api.datadoghq.eu', label: 'EU (api.datadoghq.eu)' },
  { value: 'api.us3.datadoghq.com', label: 'US3 (api.us3.datadoghq.com)' },
  { value: 'api.us5.datadoghq.com', label: 'US5 (api.us5.datadoghq.com)' },
  { value: 'api.ap1.datadoghq.com', label: 'AP1 (api.ap1.datadoghq.com)' },
  { value: 'custom', label: 'Custom...' }
];

const fields = [
  { name: 'site', label: 'Site', options: SITE_OPTIONS, customPlaceholder: 'e.g., api.custom-datadog.com' },
  { name: 'apiKey', label: 'API Key', type: 'password', secret: true, placeholder: 'Enter your DataDog API Key', help: <>Found in DataDog Organization Settings &rarr; API Keys</> },
  { name: 'appKey', label: 'Application Key', type: 'password', secret: true, placeholder: 'Enter your DataDog Application Key', help: <>Found in DataDog Organization Settings &rarr; Application Keys</> }
];
const initialForm = { id: '', name: '', site: 'api.datadoghq.com', apiKey: '', appKey: '' };

export default function DataDog() {
  return <IntegrationInstancesPage
    title="DataDog" apiBase="/datadog" feature="datadog" fields={fields} initialForm={initialForm}
    heading={<h1 className="text-xl sm:text-2xl font-bold text-white">DataDog Integration</h1>}
    skeletonWidth="w-56" emptyDescription="Add a DataDog instance to enable error monitoring for your apps."
    deleteDescription="This will remove the stored keys."
    summarize={instance => <>
      <p className="text-gray-400 text-sm mt-1 break-all">Site: {instance.site}</p>
      <p className="text-gray-500 text-sm">API Key: {instance.hasApiKey ? 'Configured' : 'Not set'}</p>
      <p className="text-gray-500 text-sm">App Key: {instance.hasAppKey ? 'Configured' : 'Not set'}</p>
    </>}
    testSuccessDetail={() => <p className="text-port-success font-medium">API key validated</p>}
    helpSteps={<>
      <p>1. Add one or more DataDog instances above</p>
      <p>2. Go to Apps and enable DataDog monitoring in each app&apos;s settings</p>
      <p>3. The error monitor job will periodically check for new errors:</p>
      <ul className="list-disc list-inside ml-2 sm:ml-4 space-y-1 text-gray-400">
        <li>Query DataDog for recent error events matching the app&apos;s service name</li>
        <li>Surface new errors in notifications and app insights</li>
        <li>Track error trends over time</li>
      </ul>
    </>}
  />;
}
