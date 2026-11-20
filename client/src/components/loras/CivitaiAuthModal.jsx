import { useState } from 'react';
import { AlertTriangle, KeyRound, Check, X } from 'lucide-react';
import toast from '../ui/Toast';
import Modal from '../ui/Modal';
import Banner from '../ui/Banner';
import { FormField } from '../ui/FormField';
import { setCivitaiAuth, clearCivitaiAuth } from '../../services/apiImageVideo.js';

export function CivitaiKeyBadge({ auth, onManage }) {
  if (auth?.hasKey) {
    const label = auth.source === 'env' ? 'Key (env)' : 'Key saved';
    return (
      <button
        type="button"
        onClick={onManage}
        className="text-[11px] flex items-center gap-1 px-2 py-1 rounded border bg-port-success/10 text-port-success border-port-success/30 hover:bg-port-success/20"
        title={auth.source === 'env' ? 'CIVITAI_API_KEY env var is active' : 'API key saved in PortOS settings'}
      >
        <Check size={11} />
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onManage}
      className="text-[11px] flex items-center gap-1 px-2 py-1 rounded border bg-port-bg text-gray-400 border-port-border hover:text-gray-200 hover:border-port-accent/30"
    >
      <KeyRound size={11} />
      Add API key
    </button>
  );
}

export default function CivitaiAuthModal({ pendingUrl, message, auth, onClose, onSaved, onRetry }) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleSave = async (e) => {
    e?.preventDefault?.();
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    await setCivitaiAuth(apiKey.trim(), { silent: true })
      .then((updated) => {
        toast.success('Civitai API key saved');
        onSaved?.(updated);
        if (pendingUrl) {
          // Hand control back to the page so it can re-attempt the install
          // — the modal closes itself in the retry path.
          onRetry?.();
        } else {
          onClose?.();
        }
      })
      .catch((err) => toast.error(err?.message || 'Failed to save API key'))
      .finally(() => setSaving(false));
  };

  const handleClear = async () => {
    setClearing(true);
    await clearCivitaiAuth({ silent: true })
      .then((updated) => {
        toast.success(updated.hasKey ? 'Saved key cleared (env CIVITAI_API_KEY still active)' : 'Civitai API key cleared');
        onSaved?.(updated);
      })
      .catch((err) => toast.error(err?.message || 'Failed to clear API key'))
      .finally(() => setClearing(false));
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      ariaLabelledBy="civitai-auth-title"
      panelClassName="bg-port-card border border-port-border rounded-lg p-5 space-y-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound size={18} className="text-port-accent" />
          <h2 id="civitai-auth-title" className="text-base font-semibold text-white">Civitai API key</h2>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-200 min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {message && (
        <Banner icon={AlertTriangle}>{message}</Banner>
      )}

      <p className="text-xs text-gray-400 leading-relaxed">
        Some Civitai LoRAs require a logged-in token to download (adult or restricted content). Generate one at{' '}
        <a href="https://civitai.com/user/account" target="_blank" rel="noopener noreferrer" className="text-port-accent hover:underline">
          civitai.com/user/account
        </a>{' '}
        → API Keys. PortOS stores it in <code className="bg-port-bg px-1 rounded">data/settings.json</code>.
      </p>

      <form onSubmit={handleSave} className="space-y-2">
        <FormField label="API key" labelClassName="block text-xs font-medium text-gray-400" className="space-y-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={auth?.hasKey ? '•••• key already set — paste a new one to replace' : 'paste your Civitai API key'}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 font-mono"
            disabled={saving}
            autoFocus
          />
        </FormField>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={saving || !apiKey.trim()}
            className="flex-1 bg-port-accent text-white px-4 py-2 rounded text-sm font-medium hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : (pendingUrl ? 'Save key & retry install' : 'Save key')}
          </button>
          {auth?.hasKey && auth?.source === 'settings' && (
            <button
              type="button"
              onClick={handleClear}
              disabled={clearing}
              className="px-3 py-2 rounded text-xs text-port-error hover:bg-port-error/10 border border-port-error/30 disabled:opacity-50"
            >
              {clearing ? 'Clearing…' : 'Clear'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
