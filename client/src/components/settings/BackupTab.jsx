import { useState, useEffect } from 'react';
import { Save, Plus, X } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { getSettings, updateSettings } from '../../services/api';

export function BackupTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [destPath, setDestPath] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [cronExpression, setCronExpression] = useState('0 2 * * *');
  const [excludePaths, setExcludePaths] = useState([]);
  const [newExclude, setNewExclude] = useState('');

  useEffect(() => {
    getSettings()
      .then(settings => {
        const backup = settings?.backup || {};
        setDestPath(backup.destPath || '');
        setEnabled(backup.enabled ?? false);
        setCronExpression(backup.cronExpression || '0 2 * * *');
        setExcludePaths(backup.excludePaths || []);
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

      <div className="space-y-2">
        <label className="block text-sm text-gray-400">Exclude Paths</label>
        <p className="text-xs text-gray-500">Directories/patterns to skip during backup (relative to data/)</p>
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

      <button
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
      >
        {saving ? <BrailleSpinner /> : <Save size={16} />}
        Save
      </button>
    </div>
  );
}

export default BackupTab;
