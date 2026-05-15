import { useState, useEffect } from 'react';
import { Save, Plus, X, Play, ShieldOff } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import useAsyncAction from '../../hooks/useAsyncAction';
import { getSettings, updateSettings, getBackupStatus, triggerBackup } from '../../services/api';

// Set equality — rsync --exclude flags are order-independent, so reordering
// is NOT a dirty state; only membership changes (added/removed entries) are.
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// settings.json is hand-editable and the GET /settings endpoint is unvalidated,
// so an incoming `excludePaths`/`disabledDefaultExcludes` value can be a string,
// null, or any other shape. Normalize before it reaches React state — otherwise
// downstream `.some` / `.includes` / `.filter` calls crash the Backup tab.
const asArray = (v) => Array.isArray(v) ? v : [];

// Whether a user-supplied custom rsync exclude pattern covers (shadows) a default
// exclude path — broader than a bare `===` check so the UI doesn't mark a default
// as "included" while a custom entry like `loras/`, `loras/**`, or `/cos/` is
// still effectively excluding it via rsync. Strips leading `/`, trailing `/`, and
// a trailing `**`/`*` glob from both sides, then compares directory prefixes:
// the custom path shadows the default when the default's normalized form equals
// the custom's OR lives inside the custom's subtree.
const normalizePattern = (p) =>
  String(p ?? '').replace(/^\/+/, '').replace(/\/+\*+$/, '').replace(/\*+$/, '').replace(/\/+$/, '');
const shadowsDefault = (customPath, defaultPath) => {
  if (customPath === defaultPath) return true;
  const c = normalizePattern(customPath);
  const d = normalizePattern(defaultPath);
  if (!c || !d) return false;
  return d === c || d.startsWith(c + '/');
};

export function BackupTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [destPath, setDestPath] = useState('');
  const [savedDestPath, setSavedDestPath] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [cronExpression, setCronExpression] = useState('0 2 * * *');
  const [excludePaths, setExcludePaths] = useState([]);
  const [savedExcludePaths, setSavedExcludePaths] = useState([]);
  const [disabledDefaultExcludes, setDisabledDefaultExcludes] = useState([]);
  const [savedDisabledDefaultExcludes, setSavedDisabledDefaultExcludes] = useState([]);
  const [defaultExcludes, setDefaultExcludes] = useState([]);
  const [newExclude, setNewExclude] = useState('');

  useEffect(() => {
    Promise.all([getSettings(), getBackupStatus({ silent: true }).catch(() => null)])
      .then(([settings, status]) => {
        const backup = settings?.backup || {};
        const saved = backup.destPath || '';
        const savedExcludes = asArray(backup.excludePaths);
        const savedDisabled = asArray(backup.disabledDefaultExcludes);
        setDestPath(saved);
        setSavedDestPath(saved);
        setEnabled(backup.enabled ?? false);
        setCronExpression(backup.cronExpression || '0 2 * * *');
        setExcludePaths(savedExcludes);
        setSavedExcludePaths(savedExcludes);
        setDisabledDefaultExcludes(savedDisabled);
        setSavedDisabledDefaultExcludes(savedDisabled);
        setDefaultExcludes(asArray(status?.defaultExcludes));
      })
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings({ backup: { destPath, enabled, cronExpression, excludePaths, disabledDefaultExcludes } });
      setSavedDestPath(destPath);
      setSavedExcludePaths(excludePaths);
      setSavedDisabledDefaultExcludes(disabledDefaultExcludes);
      toast.success('Settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const toggleDefaultExclude = (path) => {
    const currentlyDisabled = disabledDefaultExcludes.includes(path);
    if (currentlyDisabled) {
      // Re-enabling the default exclude — path goes back to being excluded.
      setDisabledDefaultExcludes(prev => prev.filter(p => p !== path));
    } else {
      // Disabling the default — the user is opting this path back IN to backups.
      // Strip every shadowing custom entry (exact match AND broader patterns
      // like `loras/`, `loras/**`); otherwise rsync would still exclude it and
      // the toggle would lie about the actual behavior.
      setDisabledDefaultExcludes(prev => [...prev, path]);
      setExcludePaths(prev => prev.filter(p => !shadowsDefault(p, path)));
    }
  };

  const [handleRunNow, running] = useAsyncAction(async () => {
    const result = await triggerBackup({ silent: true });
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
    // A custom exclude that shadows a default would lie about toggle state
    // (toggle "included" but rsync still excludes via the custom entry).
    // Catches exact matches AND broader patterns like `loras/` or `loras/**`.
    const shadowed = defaultExcludes.find(d => shadowsDefault(trimmed, d.path));
    if (shadowed) {
      toast.error(`"${trimmed}" shadows the default exclusion "${shadowed.path}" — use the toggle above instead`);
      return;
    }
    setExcludePaths([...excludePaths, trimmed]);
    setNewExclude('');
  };

  const removeExclude = (index) => {
    setExcludePaths(excludePaths.filter((_, i) => i !== index));
  };

  if (loading) {
    return <BrailleSpinner text="Loading backup settings" />;
  }

  const dirty = destPath !== savedDestPath
    || !sameSet(excludePaths, savedExcludePaths)
    || !sameSet(disabledDefaultExcludes, savedDisabledDefaultExcludes);
  const canRun = !!savedDestPath && !running && !saving && !dirty;
  const runTitle = !savedDestPath
    ? 'Configure and save a destination path first'
    : saving
      ? 'Waiting for save to finish…'
      : dirty
        ? 'Save your changes before running — the backup uses saved settings.'
        : 'Run a backup snapshot now using saved settings';

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
            <label className="block text-sm text-gray-400">Default Exclusions</label>
          </div>
          <p className="text-xs text-gray-500">Built-in paths skipped by default to keep snapshots small. Overridable entries (large re-downloadable assets) can be re-enabled below; fixed entries hold ephemeral data and stay off.</p>
          <ul className="space-y-1.5 mt-1">
            {defaultExcludes.map((d, i) => {
              const isDisabled = disabledDefaultExcludes.includes(d.path);
              // Custom excludes can shadow a default via exact match (`loras/...`)
              // OR a broader pattern (`loras/`, `loras/**`, `/cos/`). The broader
              // check is necessary because rsync still applies the custom pattern
              // even when the default toggle says "included".
              const shadowingCustom = excludePaths.find(p => shadowsDefault(p, d.path));
              const defaultActive = !(d.overridable && isDisabled);
              const isExcluded = defaultActive || !!shadowingCustom;
              const shadowedByCustom = !defaultActive && !!shadowingCustom;
              return (
                <li key={i} className="flex items-start gap-2 text-xs">
                  {d.overridable ? (
                    <ToggleSwitch
                      enabled={!isExcluded}
                      onChange={() => toggleDefaultExclude(d.path)}
                      size="sm"
                      ariaLabel={isExcluded ? `Include ${d.path} in backups` : `Exclude ${d.path} from backups`}
                      className="mt-0.5"
                    />
                  ) : (
                    <span className="inline-flex items-center justify-center w-12 h-7 shrink-0 text-gray-600" title="Always excluded — cannot be backed up">
                      <ShieldOff size={14} />
                    </span>
                  )}
                  <code className={`px-1.5 py-0.5 bg-port-bg border rounded shrink-0 ${isExcluded ? 'text-gray-300 border-port-border' : 'text-port-success border-port-success/30'}`}>{d.path}</code>
                  <span className="text-gray-500">
                    {d.reason}
                    {!isExcluded && <span className="text-port-success/80 ml-1">(included)</span>}
                    {shadowedByCustom && <span className="text-port-warning ml-1">(still excluded via Additional Exclude Paths — remove <code>{shadowingCustom}</code> below)</span>}
                  </span>
                </li>
              );
            })}
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
          title={runTitle}
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
