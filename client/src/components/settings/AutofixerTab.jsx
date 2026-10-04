import { useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../../services/api';
import { Wrench } from 'lucide-react';
import FeatureProviderPicker from '../FeatureProviderPicker';

/**
 * Settings tab for the PortOS Autofixer — picks which configured CLI provider
 * + model runs when a monitored PM2 process crashes. The autofixer reads this
 * (`settings.autofixer`) from the shared data file in its own process.
 */
export function AutofixerTab() {
  const [autoPromote, setAutoPromote] = useState(false);
  const [verifyCommand, setVerifyCommand] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getSettings({ silent: true }).then(settings => {
      if (!active) return;
      setAutoPromote(settings.autofixer?.autoPromote === true);
      setVerifyCommand(settings.autofixer?.verifyCommand || '');
      setLoaded(true);
    }).catch(() => { if (active) setError('Unable to load Autofixer settings.'); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    setSaving(true);
    setError('');
    await updateSettings({ autofixer: { autoPromote, verifyCommand } }, { silent: true })
      .catch(() => setError('Unable to save Autofixer settings.'));
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
          Only agentic CLI providers are listed —
          the fixer needs file-edit and shell access, which API chat providers can't do.
        </p>
        <FeatureProviderPicker
          featureKey="autofixer"
          hint="Defaults to Claude Code when unset. Configure providers under AI Providers."
        />
        <div className="mt-6 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoPromote} disabled={!loaded || saving}
              onChange={event => setAutoPromote(event.target.checked)} />
            Apply fixes automatically
          </label>
          <p className="text-xs text-port-warning">Automatically applies validated patches to the live checkout and restarts the process.</p>
          <label className="block text-sm">
            Verify command
            <input className="mt-1 block w-full bg-port-bg border border-port-border rounded p-2"
              value={verifyCommand} maxLength={500} disabled={!loaded || saving}
              onChange={event => setVerifyCommand(event.target.value)} placeholder="npm test" />
          </label>
          <p className="text-xs text-gray-400">Optional command run in the isolated checkout before staging or automatic application.</p>
          <button className="px-3 py-2 bg-port-accent rounded text-white" disabled={!loaded || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save promotion settings'}
          </button>
          {error && <p role="alert" className="text-port-error text-sm">{error}</p>}
        </div>
      </div>
    </div>
  );
}
