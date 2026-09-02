/**
 * Inline HF_TOKEN entry for any gated HuggingFace image model (FLUX.1-dev,
 * FLUX.2-klein, etc.). Replaces the static "export HF_TOKEN=… before running
 * PortOS" instruction with a paste-and-save form that stores the token in
 * settings.json (which the local-image worker reads when spawning mflux /
 * flux2_macos.py).
 *
 * Single-user app behind Tailscale — see AGENTS.md security model — so a
 * plaintext settings entry is the appropriate trade-off vs. a separate
 * keystore.
 */

import { useState } from 'react';
import { ExternalLink, Key, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import apiCore from '../../services/apiCore';

/**
 * Where a resolved token came from, phrased for the user — keyed by the `source`
 * `server/services/hfToken.js` reports. Shared so every gated surface names the same
 * command: three separate copies had drifted, and one still told users to run the
 * deprecated `huggingface-cli login` while its neighbor said `hf auth login`.
 */
export const HF_SOURCE_LABEL = {
  stored: 'stored in settings',
  env: 'from the HF_TOKEN environment variable',
  cli: 'from `hf auth login`',
};

/**
 * The gated repos whose terms must be accepted, as deep links. Rendered wherever
 * gated access is explained — including the token-present case, since a token alone
 * doesn't grant access. `linkClassName` lets a caller match its surrounding box
 * (warning banner vs. neutral confirmation) without forking the markup.
 * @param {{models: {label: string, url: string, linkLabel?: string}[], linkClassName?: string}} props
 */
export function GatedModelList({ models, linkClassName = 'underline text-white' }) {
  if (!models?.length) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {models.map((m) => (
        <li key={m.url}>
          <a
            href={m.url}
            target="_blank"
            rel="noreferrer"
            className={`inline-flex items-center gap-1 ${linkClassName}`}
          >
            <ExternalLink className="h-3 w-3" /> {m.linkLabel || m.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * @param {object} props
 * @param {string} [props.modelLabel] Single gated model's display name.
 * @param {string} [props.licenseUrl] That model's HF license page.
 * @param {{label: string, url: string}[]} [props.models] Several gated repos (the
 *   3D page's TRELLIS.2 pulls two). Takes precedence over modelLabel/licenseUrl —
 *   the terms must be accepted on EACH repo, so all of them are listed.
 * @param {() => void} [props.onSaved] Re-check token status after a successful save.
 */
export default function HfTokenBanner({ modelLabel, licenseUrl, models, onSaved }) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setSaving(true);
    // apiCore.post toasts the error itself on non-2xx; swallow the throw so
    // we leave saving=false either way and don't double-toast.
    const result = await apiCore.post('/image-gen/setup/hf-token', { token: trimmed }).catch(() => null);
    setSaving(false);
    if (!result?.ok) return;
    setToken('');
    toast.success('HuggingFace token saved');
    onSaved?.();
  };

  const list = models?.length ? models : (modelLabel ? [{ label: modelLabel, url: licenseUrl }] : []);

  const tokenLink = (
    <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer" className="underline text-white">
      huggingface.co/settings/tokens
    </a>
  );

  return (
    <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-3 text-xs text-port-warning space-y-2">
      <div>
        This needs a free Hugging Face account. Open each gated model card below, submit any required
        usage/access request, and accept its terms (while signed in to Hugging Face). Then create a read
        token at {tokenLink} and paste it here.
        <GatedModelList models={list} />
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
        <div className="flex items-center gap-1.5 flex-1 bg-port-bg border border-port-border rounded-lg px-2 py-1.5 focus-within:border-port-accent">
          <Key size={14} className="text-gray-400 flex-shrink-0" />
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
            disabled={saving}
            placeholder="hf_…"
            aria-label="Hugging Face read token"
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
