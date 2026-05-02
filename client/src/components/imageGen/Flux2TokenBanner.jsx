/**
 * Inline HF_TOKEN entry for the Image Gen page. Replaces the static
 * "export HF_TOKEN=… before running PortOS" instruction with a paste-and-save
 * form that stores the token in settings.json (which the local-image worker
 * reads when spawning flux2_macos.py).
 *
 * Single-user app behind Tailscale — see CLAUDE.md security model — so a
 * plaintext settings entry is the appropriate trade-off vs. a separate
 * keystore.
 */

import { useState } from 'react';
import { Key, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import apiCore from '../../services/apiCore';

export default function Flux2TokenBanner({ licenseUrl, onSaved }) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setSaving(true);
    // apiCore.post toasts the error itself on non-2xx; swallow the throw so
    // we leave saving=false either way and don't double-toast.
    const result = await apiCore.post('/image-gen/setup/flux2-token', { token: trimmed }).catch(() => null);
    setSaving(false);
    if (!result?.ok) return;
    setToken('');
    toast.success('HuggingFace token saved');
    onSaved?.();
  };

  return (
    <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-3 text-xs text-port-warning space-y-2">
      <div>
        FLUX.2-klein is a gated model. Accept the license at{' '}
        <a href={licenseUrl} target="_blank" rel="noreferrer" className="underline text-white">
          huggingface.co/black-forest-labs/FLUX.2-klein-4B
        </a>
        , then create a read token at{' '}
        <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer" className="underline text-white">
          huggingface.co/settings/tokens
        </a>{' '}
        and paste it below.
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
        <div className="flex items-center gap-1.5 flex-1 bg-port-bg border border-port-border rounded-lg px-2 py-1.5">
          <Key size={14} className="text-gray-400 flex-shrink-0" />
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
            disabled={saving}
            placeholder="hf_…"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-transparent text-white text-xs focus:outline-none disabled:opacity-50"
          />
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !token.trim()}
          className="whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
          {saving ? 'Saving…' : 'Save token'}
        </button>
      </div>
    </div>
  );
}
