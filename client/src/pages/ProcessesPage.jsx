import { useState, useMemo, useCallback } from 'react';
import { Save } from 'lucide-react';
import ProcessesTab from '../components/apps/tabs/ProcessesTab';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import { executeCommand } from '../services/api';
import useListResource from '../hooks/useListResource.js';
import ListLoadError from '../components/ui/ListLoadError';

export function ProcessesPage() {
  const [saving, setSaving] = useState(false);

  const fetchApps = useCallback(async () => {
    const list = await api.getApps({ silent: true });
    return Array.isArray(list) ? list : [];
  }, []);
  const appsResource = useListResource(fetchApps);
  const { items: apps, state: appsState, error: appsError, retry: retryApps } = appsResource;

  const managedProcessNames = useMemo(() => {
    const names = new Set();
    apps.forEach(app => {
      (app.pm2ProcessNames || []).forEach(name => names.add(name));
    });
    return names;
  }, [apps]);

  const isPortOSManaged = useCallback((procName) => {
    if (procName.startsWith('portos-')) return true;
    return managedProcessNames.has(procName);
  }, [managedProcessNames]);

  const handlePm2Save = async () => {
    setSaving(true);
    // executeCommand returns { commandId, status: 'started' } on success.
    // silent: true — this handler owns the error UI (toast.error below);
    // without it the request() helper would also toast, double-toasting.
    const result = await executeCommand('pm2 save', undefined, { silent: true }).catch(() => null);
    setSaving(false);
    if (result?.commandId) {
      toast.success('PM2 save queued');
    } else {
      toast.error('Failed to save PM2 process list');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-2xl font-bold text-white">PM2 Processes</h1>
        <button
          onClick={handlePm2Save}
          disabled={saving}
          className="px-3 sm:px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 text-sm sm:text-base"
        >
          <Save size={16} className={saving ? 'animate-pulse' : ''} />
          <span className="hidden sm:inline">{saving ? 'Saving...' : 'PM2 Save'}</span>
          <span className="sm:hidden">{saving ? '...' : 'Save'}</span>
        </button>
      </div>

      {appsState === 'error' && (
        <ListLoadError what="managed apps" error={appsError} onRetry={retryApps} />
      )}
      {appsState === 'ready' && apps.length === 0 && (
        <p className="text-xs text-gray-500">No managed apps configured.</p>
      )}

      <ProcessesTab filterFn={isPortOSManaged} />
    </div>
  );
}

export default ProcessesPage;
