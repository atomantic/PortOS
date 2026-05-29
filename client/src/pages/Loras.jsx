/**
 * LoRA Manager — install / browse / delete Civitai LoRAs.
 *
 * Paste a Civitai URL to download and install. Each LoRA card shows the
 * Civitai preview, base model (Flux.1 / Flux.2 / Z-Image / Other), trigger
 * words, recommended scale, and a "Test in Image Gen" deep-link that
 * preselects the LoRA on the generation page.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Trash2, Download, ExternalLink, Sparkles, AlertTriangle, KeyRound, Check, X, RefreshCw, Wand2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import Modal from '../components/ui/Modal';
import Banner from '../components/ui/Banner';
import { formatBytes } from '../utils/formatters';
import { RUNNER_FAMILIES } from '../lib/runnerFamilies';
import {
  listLorasFull,
  installLoraFromCivitai,
  deleteLoraFull,
  getCivitaiAuth,
  setCivitaiAuth,
  clearCivitaiAuth,
  getCivitaiSuggestions,
} from '../services/api';

const RUNNER_LABEL = {
  [RUNNER_FAMILIES.MFLUX]: 'Flux 1',
  [RUNNER_FAMILIES.FLUX2]: 'Flux 2',
  [RUNNER_FAMILIES.Z_IMAGE]: 'Z-Image',
  [RUNNER_FAMILIES.ERNIE]: 'ERNIE',
  [RUNNER_FAMILIES.HIDREAM]: 'HiDream',
  [RUNNER_FAMILIES.QWEN]: 'Qwen',
};
const RUNNER_BADGE_CLASS = {
  [RUNNER_FAMILIES.MFLUX]: 'bg-port-accent/20 text-port-accent border-port-accent/30',
  [RUNNER_FAMILIES.FLUX2]: 'bg-purple-600/20 text-purple-300 border-purple-500/30',
  [RUNNER_FAMILIES.Z_IMAGE]: 'bg-emerald-600/20 text-emerald-300 border-emerald-500/30',
  [RUNNER_FAMILIES.ERNIE]: 'bg-amber-600/20 text-amber-300 border-amber-500/30',
  [RUNNER_FAMILIES.HIDREAM]: 'bg-rose-600/20 text-rose-300 border-rose-500/30',
  [RUNNER_FAMILIES.QWEN]: 'bg-sky-600/20 text-sky-300 border-sky-500/30',
};

export default function Loras() {
  const [loras, setLoras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [deleting, setDeleting] = useState(null);
  // Civitai auth — `auth` is `{ hasKey, source }`; `authPrompt` is set to a
  // pending install URL when a 401/403 redirects the user to the inline key
  // form. The form saves the key and retries the same install in one click
  // so users don't have to remember what they were installing.
  const [auth, setAuth] = useState({ hasKey: false, source: 'none' });
  const [authPrompt, setAuthPrompt] = useState(null);
  // suggestions: { runners: { mflux: [...], flux2: [...], 'z-image': [...] }, fetchedAt }
  const [suggestions, setSuggestions] = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(true);
  const [installingSuggestion, setInstallingSuggestion] = useState(null);

  const refresh = useCallback(() => {
    setError(null);
    setLoading(true);
    listLorasFull()
      .then(setLoras)
      .catch((err) => setError(err?.message || 'Failed to load LoRAs'))
      .finally(() => setLoading(false));
  }, []);

  const refreshSuggestions = useCallback(({ force = false } = {}) => {
    setLoadingSuggestions(true);
    getCivitaiSuggestions({ force })
      .then(setSuggestions)
      .catch((err) => toast.error(err?.message || 'Failed to load suggestions'))
      .finally(() => setLoadingSuggestions(false));
  }, []);

  useEffect(() => {
    refresh();
    getCivitaiAuth().then(setAuth).catch(() => {});
    refreshSuggestions();
  }, [refresh, refreshSuggestions]);

  // silent:true so the auth-error path goes through the modal instead of a
  // one-shot toast the user can't act on. Shared by the initial install
  // submit and the post-key-save retry so both behave identically.
  const performInstall = useCallback(async (url) => {
    if (!url || installing) return;
    setInstalling(true);
    await installLoraFromCivitai({ url, silent: true })
      .then((sidecar) => {
        toast.success(`Installed ${sidecar.name}`);
        setInstallUrl('');
        refresh();
      })
      .catch((err) => {
        // Early-access content is gated by Civitai membership, not by API
        // key — routing into the key-prompt modal would be misleading
        // because the user's key (saved or env) can't unlock it. Surface
        // the message (which already includes hours-remaining) as a toast.
        if (err?.code === 'CIVITAI_EARLY_ACCESS') {
          toast.error(err.message || 'LoRA is in Civitai early-access');
        } else if (err?.code === 'CIVITAI_AUTH') {
          setAuthPrompt({ url, message: err.message || 'This LoRA needs an API key.' });
        } else {
          toast.error(err?.message || 'Install failed');
        }
      })
      .finally(() => setInstalling(false));
  }, [installing]);

  const handleInstall = (e) => {
    e?.preventDefault?.();
    return performInstall(installUrl.trim());
  };

  const handleDelete = async (filename) => {
    setDeleting(filename);
    await deleteLoraFull(filename)
      .then(() => {
        toast.success('LoRA deleted');
        setLoras((prev) => prev.filter((l) => l.filename !== filename));
      })
      .catch((err) => toast.error(err?.message || 'Delete failed'))
      .finally(() => setDeleting(null));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">LoRA Manager</h1>
        <p className="text-sm text-gray-400">
          Install LoRA fine-tunes from Civitai and apply them to your Image Gen renders.
        </p>
      </div>

      <form
        onSubmit={handleInstall}
        className="bg-port-card border border-port-border rounded-lg p-4 space-y-3"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
            <Download size={16} />
            <span>Install from Civitai</span>
          </div>
          <CivitaiKeyBadge auth={auth} onManage={() => setAuthPrompt({ url: null, message: '' })} />
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            placeholder="https://civitai.com/models/2600698/realstagram"
            className="flex-1 bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600"
            disabled={installing}
            autoFocus
          />
          <button
            type="submit"
            disabled={installing || !installUrl.trim()}
            className="bg-port-accent text-white px-4 py-2 rounded text-sm font-medium hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {installing ? 'Downloading…' : 'Install'}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Paste any <code className="bg-port-bg px-1 rounded">civitai.com</code> /{' '}
          <code className="bg-port-bg px-1 rounded">civitai.red</code> model URL — or just the
          numeric model id. Restricted LoRAs need an API key — PortOS will prompt you for one if a download is rejected.
        </p>
      </form>

      {authPrompt && (
        <CivitaiAuthModal
          pendingUrl={authPrompt.url}
          message={authPrompt.message}
          auth={auth}
          onClose={() => setAuthPrompt(null)}
          onSaved={(updatedAuth) => setAuth(updatedAuth)}
          onRetry={() => {
            // After save, retry with the original URL — the server now reads
            // the freshly-saved key from settings. performInstall handles the
            // bad-key reopen by re-setting authPrompt.
            const url = authPrompt.url;
            setAuthPrompt(null);
            if (url) performInstall(url);
          }}
        />
      )}

      <SuggestionsPanel
        suggestions={suggestions}
        loading={loadingSuggestions}
        installedFilenames={new Set(loras.map((l) => l.filename))}
        installingSuggestionKey={installingSuggestion}
        onRefresh={() => refreshSuggestions({ force: true })}
        onInstall={async (card, url, versionId) => {
          // Curated cards pass a family-specific (url, versionId); non-curated
          // cards omit versionId and we fall back to the card's primary.
          const vid = versionId ?? card.versionId;
          const key = `${card.modelId}-${vid}`;
          setInstallingSuggestion(key);
          await performInstall(url || card.installUrl);
          setInstallingSuggestion(null);
        }}
      />

      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Installed</h2>
        {loading && <div className="text-sm text-gray-500">Loading…</div>}
        {error && (
          <Banner tone="error" size="md" icon={AlertTriangle} align="center">{error}</Banner>
        )}
        {!loading && !error && loras.length === 0 && (
          <div className="text-sm text-gray-500 italic">
            No LoRAs installed yet — pick one from the suggestions above, or paste a Civitai URL.
          </div>
        )}
        {loras.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {loras.map((lora) => (
              <LoraCard key={lora.filename} lora={lora} onDelete={() => handleDelete(lora.filename)} deleting={deleting === lora.filename} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SuggestionsPanel({ suggestions, loading, installedFilenames, installingSuggestionKey, onRefresh, onInstall }) {
  const curated = suggestions?.curated || [];
  const runners = suggestions?.runners || {};
  const sections = [
    { key: 'curated', label: 'Curated picks', cards: curated, hint: 'Hand-picked LoRAs that work across multiple base models.' },
    // The four runner-family sections always render, even when Civitai
    // search returns zero — `alwaysShow` lets the user see all four
    // headers at a glance instead of silently collapsing the empty ones.
    { key: RUNNER_FAMILIES.MFLUX,   label: 'Top for Flux 1',  cards: runners[RUNNER_FAMILIES.MFLUX] || [],   hint: 'Most-downloaded LoRAs trained against Flux.1 D / Flux.1 S.', alwaysShow: true },
    { key: RUNNER_FAMILIES.FLUX2,   label: 'Top for Flux 2',  cards: runners[RUNNER_FAMILIES.FLUX2] || [],   hint: 'Most-downloaded LoRAs trained against Flux.2 Klein 4B / 9B.', alwaysShow: true },
    { key: RUNNER_FAMILIES.Z_IMAGE, label: 'Top for Z-Image', cards: runners[RUNNER_FAMILIES.Z_IMAGE] || [], hint: 'Most-downloaded LoRAs trained against Z-Image / Z-Image-Turbo.', alwaysShow: true },
    { key: RUNNER_FAMILIES.ERNIE,   label: 'Top for ERNIE',   cards: runners[RUNNER_FAMILIES.ERNIE] || [],   hint: 'Most-downloaded LoRAs trained against ERNIE-Image.', alwaysShow: true },
    { key: RUNNER_FAMILIES.HIDREAM, label: 'Top for HiDream', cards: runners[RUNNER_FAMILIES.HIDREAM] || [], hint: 'Most-downloaded LoRAs trained against HiDream.', alwaysShow: true },
    { key: RUNNER_FAMILIES.QWEN,    label: 'Top for Qwen',    cards: runners[RUNNER_FAMILIES.QWEN] || [],    hint: 'Most-downloaded LoRAs trained against Qwen-Image.', alwaysShow: true },
  ];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Wand2 size={18} className="text-port-accent" />
          Suggested LoRAs
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1 disabled:opacity-50"
          title="Re-fetch from Civitai (busts the 1-hour cache)"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
      {loading && !suggestions && (
        <div className="text-sm text-gray-500">Loading suggestions…</div>
      )}
      {sections.map((section) => (
        <SuggestionsSection
          key={section.key}
          label={section.label}
          hint={section.hint}
          cards={section.cards}
          alwaysShow={section.alwaysShow}
          installedFilenames={installedFilenames}
          installingSuggestionKey={installingSuggestionKey}
          onInstall={onInstall}
        />
      ))}
    </div>
  );
}

function SuggestionsSection({ label, hint, cards, alwaysShow = false, installedFilenames, installingSuggestionKey, onInstall }) {
  const list = cards || [];
  if (list.length === 0 && !alwaysShow) return null;
  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <h3 className="text-sm font-medium text-gray-300">{label}</h3>
        <span className="text-xs text-gray-600">{list.length}</span>
      </div>
      {hint && <p className="text-xs text-gray-500 mb-2">{hint}</p>}
      {list.length === 0 ? (
        <p className="text-xs text-gray-600 italic">No LoRAs found on Civitai for this base model yet.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {list.map((card) => (
            <SuggestionCard
              key={`${card.modelId}-${card.versionId}`}
              card={card}
              installedFilenames={installedFilenames}
              installingSuggestionKey={installingSuggestionKey}
              onInstall={onInstall}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({ card, installedFilenames, installingSuggestionKey, onInstall }) {
  const installs = card.curated && card.installs && Object.keys(card.installs).length > 0 ? card.installs : null;
  // Badges: prefer the installs map's keys (per-family with versions), else
  // the runnerFamilies array, else the single primary-version family.
  const badgeFamilies = installs
    ? Object.keys(installs)
    : (Array.isArray(card.runnerFamilies) && card.runnerFamilies.length
      ? card.runnerFamilies
      : (card.runnerFamily ? [card.runnerFamily] : []));
  const isInstalled = (versionId) => versionId != null
    && [...installedFilenames].some((f) => f.endsWith(`-v${versionId}.safetensors`));
  const isInstalling = (versionId) => installingSuggestionKey === `${card.modelId}-${versionId}`;
  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col">
      {card.previewImageUrl ? (
        <img src={card.previewImageUrl} alt="" className="w-full h-64 object-cover bg-port-bg" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="w-full h-64 bg-port-bg flex items-center justify-center text-gray-700">
          <Sparkles size={32} />
        </div>
      )}
      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-semibold text-white text-sm flex-1 break-words">{card.name}</h4>
          {card.curated && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-port-warning/20 text-port-warning border border-port-warning/30 whitespace-nowrap">curated</span>
          )}
        </div>
        {badgeFamilies.length > 0 && !installs && (
          <div className="flex flex-wrap gap-1">
            {badgeFamilies.map((f) => (
              <span key={f} className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${RUNNER_BADGE_CLASS[f] || 'bg-gray-600/20 text-gray-300 border-gray-500/30'}`}>
                {RUNNER_LABEL[f] || f}
              </span>
            ))}
          </div>
        )}
        {card.note && <p className="text-[11px] text-gray-400 italic break-words">{card.note}</p>}
        {card.samplePrompt && (
          <details className="text-[11px] text-gray-500">
            <summary className="cursor-pointer hover:text-gray-300">Sample prompt</summary>
            <p className="mt-1 font-mono text-[10px] leading-snug bg-port-bg p-1.5 rounded border border-port-border line-clamp-4">{card.samplePrompt}</p>
          </details>
        )}
        <div className="text-[10px] text-gray-600 flex items-center gap-3 mt-auto">
          {card.creator && <span className="truncate" title={card.creator}>by {card.creator}</span>}
          {typeof card.downloads === 'number' && <span>↓ {card.downloads.toLocaleString()}</span>}
        </div>
        {installs ? (
          <div className="flex flex-col gap-1">
            <p className="text-[10px] uppercase tracking-wide text-gray-500">Install for</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(installs).map(([family, info]) => {
                const installed = isInstalled(info.versionId);
                const installing = isInstalling(info.versionId);
                const baseClass = installed
                  ? 'bg-port-success/20 text-port-success border-port-success/30'
                  : (RUNNER_BADGE_CLASS[family] || 'bg-port-accent/20 text-port-accent border-port-accent/30');
                return (
                  <button
                    key={family}
                    type="button"
                    onClick={() => onInstall(card, info.installUrl, info.versionId)}
                    disabled={installed || installing}
                    title={installed ? 'Already installed' : `Install ${info.baseModel || family} version`}
                    className={`text-[11px] px-2 py-1 rounded border flex items-center gap-1 ${baseClass} hover:brightness-125 disabled:opacity-60 disabled:cursor-not-allowed`}
                  >
                    {installed ? <Check size={11} /> : null}
                    {installing ? 'Installing…' : (RUNNER_LABEL[family] || family)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {isInstalled(card.versionId) ? (
              <button disabled className="flex-1 bg-port-success/20 text-port-success border border-port-success/30 px-3 py-1.5 rounded text-xs font-medium flex items-center justify-center gap-1">
                <Check size={12} /> Installed
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onInstall(card, card.installUrl, card.versionId)}
                disabled={isInstalling(card.versionId)}
                className="flex-1 bg-port-accent text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-port-accent/90 disabled:opacity-50"
              >
                {isInstalling(card.versionId) ? 'Installing…' : 'Quick install'}
              </button>
            )}
          </div>
        )}
        {card.civitaiUrl && (
          <a href={card.civitaiUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 self-start" title="Open on Civitai">
            <ExternalLink size={11} /> View on Civitai
          </a>
        )}
      </div>
    </div>
  );
}

function CivitaiKeyBadge({ auth, onManage }) {
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

function CivitaiAuthModal({ pendingUrl, message, auth, onClose, onSaved, onRetry }) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleSave = async (e) => {
    e?.preventDefault?.();
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    await setCivitaiAuth(apiKey.trim())
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
    await clearCivitaiAuth()
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
        <button onClick={onClose} className="text-gray-400 hover:text-gray-200" aria-label="Close">
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
        <label className="block text-xs font-medium text-gray-400">API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={auth?.hasKey ? '•••• key already set — paste a new one to replace' : 'paste your Civitai API key'}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 font-mono"
          disabled={saving}
          autoFocus
        />
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

function LoraCard({ lora, onDelete, deleting }) {
  const family = lora.runnerFamily;
  const familyLabel = family ? (RUNNER_LABEL[family] || family) : 'Unsupported base';
  const badgeClass = family ? (RUNNER_BADGE_CLASS[family] || 'bg-gray-600/20 text-gray-300 border-gray-500/30') : 'bg-port-warning/20 text-port-warning border-port-warning/30';
  const triggerWords = lora.triggerWords || [];
  const civitai = lora.civitai;
  // Image Gen page reads ?lora=<filename> as a preselect hint via query string;
  // keeps the manager → gen handoff URL-driven (deep-linkable).
  const testHref = `/media/image?lora=${encodeURIComponent(lora.filename)}`;

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col">
      {lora.previewImageUrl ? (
        <img
          src={lora.previewImageUrl}
          alt=""
          className="w-full h-64 object-cover bg-port-bg"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="w-full h-64 bg-port-bg flex items-center justify-center text-gray-700">
          <Sparkles size={32} />
        </div>
      )}
      <div className="p-3 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="font-semibold text-white text-sm flex-1 break-words">{lora.name}</h3>
          <span className={`text-[10px] px-2 py-0.5 rounded border whitespace-nowrap ${badgeClass}`} title={civitai?.baseModel || 'Unknown'}>
            {familyLabel}
          </span>
        </div>

        {triggerWords.length > 0 && (
          <div className="mb-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Trigger words</div>
            <div className="flex flex-wrap gap-1">
              {triggerWords.map((w) => (
                <code key={w} className="text-[11px] bg-port-bg px-1.5 py-0.5 rounded text-gray-300 border border-port-border">{w}</code>
              ))}
            </div>
          </div>
        )}

        <div className="text-[11px] text-gray-500 grid grid-cols-2 gap-x-2 gap-y-0.5 mb-3">
          <span>Recommended scale</span><span className="text-gray-300 font-mono text-right">{Number(lora.recommendedScale ?? 1).toFixed(2)}</span>
          <span>Size</span><span className="text-gray-300 font-mono text-right">{formatBytes(lora.sizeBytes)}</span>
          {civitai?.creator && (<><span>Creator</span><span className="text-gray-300 truncate text-right" title={civitai.creator}>{civitai.creator}</span></>)}
          {civitai?.baseModel && (<><span>Base model</span><span className="text-gray-300 truncate text-right" title={civitai.baseModel}>{civitai.baseModel}</span></>)}
        </div>

        <div className="mt-auto flex items-center gap-2">
          <Link
            to={testHref}
            className="flex-1 bg-port-accent text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-port-accent/90 text-center"
          >
            Test
          </Link>
          {civitai?.url && (
            <a
              href={civitai.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-200 p-1.5 rounded hover:bg-port-bg"
              title="Open on Civitai"
            >
              <ExternalLink size={14} />
            </a>
          )}
          <button
            onClick={onDelete}
            disabled={deleting}
            className="text-port-error hover:text-port-error/80 p-1.5 rounded hover:bg-port-error/10 disabled:opacity-50"
            title="Delete LoRA"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
