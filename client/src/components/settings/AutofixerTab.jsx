import { useCallback, useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../../services/apiSystem.js';
import { Wrench } from 'lucide-react';
import FeatureProviderPicker from '../FeatureProviderPicker';
import useSettingsForm from '../../hooks/useSettingsForm';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';

const INITIAL_FORM = { autoPromote: false, verifyCommand: '' };

/**
 * Settings tab for the PortOS Autofixer — picks which configured CLI provider
 * + model runs when a monitored PM2 process crashes. The autofixer reads this
 * (`settings.autofixer`) from the shared data file in its own process.
 */
export function AutofixerTab() {
  const { values, isDirty, set, load, markSaved } = useSettingsForm(INITIAL_FORM);
  const { autoPromote, verifyCommand } = values;
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const settings = await getSettings({ silent: true });
      const form = { autoPromote: settings.autofixer?.autoPromote === true, verifyCommand: settings.autofixer?.verifyCommand || '' };
      load(form);
      setLoaded(true);
    } catch { setError('Unable to load Autofixer settings.'); }
    finally { setLoading(false); }
  }, [load]);
  useEffect(() => { loadSettings(); }, [loadSettings]);
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await updateSettings({ autofixer: { autoPromote, verifyCommand } }, { silent: true });
      markSaved();
      toast.success('Autofixer promotion settings saved');
    } catch { setError('Unable to save Autofixer settings.'); }
    setSaving(false);
  };
  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Wrench size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Autofixer AI provider</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          When a monitored process crashes, the Autofixer runs this AI provider to read the logs,
          propose a fix in an isolated checkout. Fixes are staged for review by default; apply or discard
          them in the Autofixer History tab. Automatic application and restart require the toggle below.
          Repairs run only on a Claude Code or Codex CLI provider. Claude uses file-editing tools;
          Codex runs commands in a sandbox with network access disabled. Other CLI providers are skipped.
        </p>
        <FeatureProviderPicker
          featureKey="autofixer"
          hint="Defaults to Claude Code when unset. Configure providers under AI Providers."
        />
        <div className="mt-6 space-y-3">
          {loading && <BrailleSpinner text="Loading Autofixer settings" />}
          {error && !loaded && <button type="button" className="px-3 py-2 border border-port-border rounded hover:bg-port-border" onClick={loadSettings}>Retry</button>}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoPromote} disabled={!loaded || saving}
              onChange={event => set('autoPromote', event.target.checked)} />
            Apply fixes automatically
          </label>
          <p className="text-xs text-port-warning">Automatically applies validated patches to the live checkout and restarts the process.</p>
          <label className="block text-sm">
            Verify command
            <input className="mt-1 block w-full bg-port-bg border border-port-border rounded p-2"
              value={verifyCommand} maxLength={500} disabled={!loaded || saving}
              onChange={event => set('verifyCommand', event.target.value)} placeholder="npm test" />
          </label>
          <p className="text-xs text-gray-400">Optional command run in the isolated checkout before staging or automatic application. Verification requires Linux bubblewrap to contain files, network access, and child processes. On macOS and other unsupported systems, a configured check is refused and the fix is not applied.</p>
          <button type="button" className="px-3 py-2 bg-port-accent hover:bg-port-accent/80 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed" disabled={!loaded || saving || !isDirty} onClick={save}>
            {saving ? 'Saving…' : 'Save promotion settings'}
          </button>
          {error && <p role="alert" className="text-port-error text-sm">{error}</p>}
        </div>
      </div>
    </div>
  );
}
