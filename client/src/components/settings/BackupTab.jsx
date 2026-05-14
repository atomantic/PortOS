import { useState, useEffect } from 'react';
import { Save, Plus, X, Play, ShieldOff } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import useAsyncAction from '../../hooks/useAsyncAction';
import { getSettings, updateSettings, getBackupStatus, triggerBackup } from '../../services/api';

export function BackupTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [destPath, setDestPath] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [cronExpression, setCronExpression] = useState('0 2 * * *');
  const [excludePaths, setExcludePaths] = useState([]);
  const [defaultExcludes, setDefaultExcludes] = useState([]);
  const [newExclude, setNewExclude] = useState('');

  useEffect(() => {
    Promise.all([getSettings(), getBackupStatus().catch(() => null)])
      .then(([settings, status]) => {
        const backup = settings?.backup || {};
        setDestPath(backup.destPath || '');
        setEnabled(backup.enabled ?? false);
        setCronExpression(backup.cronExpression || '0 2 * * *');
        setExcludePaths(backup.excludePaths || []);
        setDefaultExcludes(status?.defaultExcludes || []);
      })
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings({ backup: { destPath, enabled, cronExpression, excludePaths } });
      toast.success('Settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const [handleRunNow, running] = useAsyncAction(async () => {
    const result = await triggerBackup();
    if (result?.skipped) {
      toast('Backup already running');
    } else {
      toast.success(`Backup complete — ${result?.filesChanged ?? 0} files changed`, { icon: '💾' });
    }
    return result;
  }, { errorMessage: 'Backup failed' });

  const addExclude = () => {
    const trimmed = newExclude.trim();
    if (!trimmed || excludePaths.includes(trimmed)) return;
    setExcludePaths([...excludePaths, trimmed]);
    setNewExclude('');
  };

  const removeExclude = (index) => {
    setExcludePaths(excludePaths.filter((_, i) => i !== index));
  };

  if (loading) {
    return <BrailleSpinner text="Loading backup settings" />;
  }

  const canRun = !!destPath && !running;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5">
      <div className="space-y-1">
        <label className="block text-sm text-gray-400">Destination Path</label>
        <input
          type="text"
          value={destPath}
          onChange={e => setDestPath(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          placeholder="/path/to/backups"
        />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-400">Enabled</label>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-port-accent' : 'bg-port-border'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      <div className="space-y-1">
        <label className="block text-sm text-gray-400">Schedule (cron)</label>
        <input
          type="text"
          value={cronExpression}
          onChange={e => setCronExpression(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          placeholder="0 2 * * *"
        />
        <p className="text-xs text-gray-500">Default: 2:00 AM daily</p>
      </div>

      {defaultExcludes.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ShieldOff size={14} className="text-gray-500" />
            <label className="block text-sm text-gray-400">Default Exclusions (always skipped)</label>
          </div>
          <p className="text-xs text-gray-500">Built-in paths that are never backed up — they hold large or ephemeral data that would bloat snapshots.</p>
          <ul className="space-y-1 mt-1">
            {defaultExcludes.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <code className="px-1.5 py-0.5 bg-port-bg border border-port-border rounded text-gray-300 shrink-0">{d.path}</code>
                <span className="text-gray-500">{d.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <label className="block text-sm text-gray-400">Additional Exclude Paths</label>
        <p className="text-xs text-gray-500">Custom directories/patterns to skip during backup (relative to data/)</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={newExclude}
            onChange={e => setNewExclude(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addExclude()}
            className="flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
            placeholder="repos/"
          />
          <button
            onClick={addExclude}
            disabled={!newExclude.trim()}
            aria-label="Add exclude path"
            className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] px-3 py-2 bg-port-border hover:bg-port-border/70 text-white rounded-lg transition-colors disabled:opacity-50 shrink-0"
          >
            <Plus size={16} />
          </button>
        </div>
        {excludePaths.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {excludePaths.map((path, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-port-bg border border-port-border rounded-lg text-sm text-gray-300">
                <code className="text-xs">{path}</code>
                <button onClick={() => removeExclude(i)} className="text-gray-500 hover:text-port-error transition-colors">
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-port-border">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? <BrailleSpinner /> : <Save size={16} />}
          Save
        </button>
        <button
          onClick={handleRunNow}
          disabled={!canRun}
          title={destPath ? 'Run a backup snapshot now using saved settings' : 'Configure a destination path first'}
          className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? <BrailleSpinner /> : <Play size={16} />}
          {running ? 'Running…' : 'Run Backup Now'}
        </button>
      </div>
    </div>
  );
}

export default BackupTab;
