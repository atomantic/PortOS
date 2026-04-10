import { useState, useEffect } from 'react';
import { Save } from 'lucide-react';
import ProcessesTab from '../components/apps/tabs/ProcessesTab';
import toast from '../components/ui/Toast';
import * as api from '../services/api';

export function ProcessesPage() {
  const [managedProcessNames, setManagedProcessNames] = useState(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const loadManagedProcessNames = async () => {
      const apps = await api.getApps().catch(() => []);
      const names = new Set();
      apps.forEach(app => {
        (app.pm2ProcessNames || []).forEach(name => names.add(name));
      });
      setManagedProcessNames(names);
    };
    loadManagedProcessNames();
  }, []);

  const isPortOSManaged = (procName) => {
    if (procName.startsWith('portos-')) return true;
    return managedProcessNames.has(procName);
  };

  const handlePm2Save = async () => {
    setSaving(true);
    const result = await fetch('/api/commands/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'pm2 save' })
    }).then(r => r.json()).catch(() => ({ success: false }));
    setSaving(false);
    if (result.success) {
      toast.success('PM2 process list saved to startup');
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

      <ProcessesTab filterFn={isPortOSManaged} />
    </div>
  );
}

export default ProcessesPage;
