import { Link } from 'react-router';
import * as api from '../services/api';
import TaskAddForm from './cos/TaskAddForm';
import ListLoadError from './ui/ListLoadError';
import useListResource from '../hooks/useListResource';

const fetchProviders = () => api.getProviders({ silent: true }).then(data => data?.providers || []);
const fetchApps = () => api.getApps({ silent: true }).then(data => (Array.isArray(data) ? data : data?.apps || []));

export default function QuickTaskWidget() {
  const providersList = useListResource(fetchProviders);
  const appsList = useListResource(fetchApps);

  // Tiles render with overflow-hidden + a fixed pixel height (h * ROW_HEIGHT)
  // — fill the cell and let the form area scroll if the user shrank the
  // tile below the expanded form's natural height.
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h3 className="text-sm font-semibold text-white">Quick Task</h3>
        <Link to="/cos/tasks" className="text-xs text-gray-500 hover:text-port-accent transition-colors">
          Tasks &rarr;
        </Link>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {providersList.state === 'error' && (
          <ListLoadError what="AI providers" error={providersList.error} onRetry={providersList.retry} />
        )}
        {appsList.state === 'error' && (
          <ListLoadError what="apps" error={appsList.error} onRetry={appsList.retry} className={providersList.state === 'error' ? 'mt-2' : ''} />
        )}
        {providersList.state !== 'error' && appsList.state !== 'error' && (
          <TaskAddForm providers={providersList.items} apps={appsList.items} onTaskAdded={() => {}} compact defaultExpanded />
        )}
      </div>
    </div>
  );
}
