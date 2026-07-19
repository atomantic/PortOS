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
import { Trash2, Download, ExternalLink, Sparkles, AlertTriangle, KeyRound, Check, X, RefreshCw, Wand2, Search } from 'lucide-react';
import toast from '../components/ui/Toast';
import Modal from '../components/ui/Modal';
import Banner from '../components/ui/Banner';
import { FormField } from '../components/ui/FormField';
import { formatBytes } from '../utils/formatters';
import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES, isVideoLoraFamily } from '../lib/runnerFamilies';
import {
  listLorasFull,
  installLoraFromCivitai,
  installLoraFromHuggingfaceStream,
  deleteLoraFull,
  getCivitaiAuth,
  setCivitaiAuth,
  clearCivitaiAuth,
  getCivitaiSuggestions,
  searchCivitaiLoras,
} from '../services/api';

const RUNNER_LABEL = {
  [RUNNER_FAMILIES.MFLUX]: 'Flux 1',
  [RUNNER_FAMILIES.FLUX2]: 'Flux 2',
  [RUNNER_FAMILIES.Z_IMAGE]: 'Z-Image',
  [RUNNER_FAMILIES.ERNIE]: 'ERNIE',
  [RUNNER_FAMILIES.HIDREAM]: 'HiDream',
  [RUNNER_FAMILIES.QWEN]: 'Qwen',
  [VIDEO_LORA_FAMILIES.LTX_VIDEO]: 'LTX-Video',
};
const RUNNER_BADGE_CLASS = {
  [RUNNER_FAMILIES.MFLUX]: 'bg-port-accent/20 text-port-accent border-port-accent/30',
  [RUNNER_FAMILIES.FLUX2]: 'bg-purple-600/20 text-purple-300 border-purple-500/30',
  [RUNNER_FAMILIES.Z_IMAGE]: 'bg-emerald-600/20 text-emerald-300 border-emerald-500/30',
  [RUNNER_FAMILIES.ERNIE]: 'bg-amber-600/20 text-amber-300 border-amber-500/30',
  [RUNNER_FAMILIES.HIDREAM]: 'bg-rose-600/20 text-rose-300 border-rose-500/30',
  [RUNNER_FAMILIES.QWEN]: 'bg-sky-600/20 text-sky-300 border-sky-500/30',
  [VIDEO_LORA_FAMILIES.LTX_VIDEO]: 'bg-fuchsia-600/20 text-fuchsia-300 border-fuchsia-500/30',
};

// Image/Video filter applied to BOTH the suggestion panel and the installed
// list (see the user request: filter suggestions + installed by media type).
const MEDIA_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
];

// Stable identity for a suggestion's specific model+version — used for React
// keys, install-in-flight tracking, and "Load more" dedup. Curated cards pass
// a family-specific versionId that differs from the card's primary, so the key
// takes the two ids explicitly rather than a whole card.
const suggestionKey = (modelId, versionId) => `${modelId}-${versionId}`;
const cardKey = (card) => suggestionKey(card.modelId, card.versionId);

// Integer download percent (0..100) from an SSE progress frame, or null when
// the frame carries no numeric ratio (server sent no Content-Length → the UI
// shows an indeterminate bar). Shared by the HF install form button, the
// progress bar, and the curated video quick-install button.
const pctOf = (progress) => (progress && typeof progress.progress === 'number' ? Math.round(progress.progress * 100) : null);

export default function Loras() {
  const [loras, setLoras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  // HuggingFace video-LoRA import (fal / Lightricks LTX LoRAs) — separate from
  // the Civitai installer above because video LoRAs live on HF.
  const [hfUrl, setHfUrl] = useState('');
  const [hfInstalling, setHfInstalling] = useState(false);
  // Byte-level download progress for the in-flight HF install (form OR curated
  // quick-install — only one runs at a time). `{ received, total, progress }`
  // where progress is 0..1, or null when the server had no Content-Length.
  const [hfProgress, setHfProgress] = useState(null);
  // When autodetection can't classify the repo (HF_UNKNOWN_FAMILY), hold the
  // URL here to render an inline "install as LTX-Video?" confirm row — the API
  // supports an explicit family override, so a valid LTX LoRA with an
  // unrecognizable id shouldn't dead-end at an error toast.
  const [hfFamilyPrompt, setHfFamilyPrompt] = useState(null);
  const [deleting, setDeleting] = useState(null);
  // Civitai auth — `auth` is `{ hasKey, source }`; `authPrompt` is set to a
  // pending install URL when a 401/403 redirects the user to the inline key
  // form. The form saves the key and retries the same install in one click
  // so users don't have to remember what they were installing.
  const [auth, setAuth] = useState({ hasKey: false, source: 'none' });
  const [authPrompt, setAuthPrompt] = useState(null);
  // suggestions: { runners: { mflux: [...], flux2: [...], 'z-image': [...] }, video: [...], fetchedAt }
  const [suggestions, setSuggestions] = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(true);
  const [installingSuggestion, setInstallingSuggestion] = useState(null);
  // Repo of the video suggestion currently installing (HF installs key off
  // repo, not modelId/versionId like the Civitai path).
  const [installingVideoRepo, setInstallingVideoRepo] = useState(null);
  // Image/Video media-type filter for both panels. 'all' | 'image' | 'video'.
  const [mediaFilter, setMediaFilter] = useState('all');

  const refresh = useCallback(() => {
    setError(null);
    setLoading(true);
    // silent:true — the failure renders as a persistent inline error Banner;
    // the default toast would say the same thing a second time.
    listLorasFull({ silent: true })
      .then(setLoras)
      .catch((err) => setError(err?.message || 'Failed to load LoRAs'))
      .finally(() => setLoading(false));
  }, []);

  const refreshSuggestions = useCallback(({ force = false } = {}) => {
    setLoadingSuggestions(true);
    getCivitaiSuggestions({ force }, { silent: true })
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

  // Install a video LoRA from a HuggingFace repo. The family is auto-detected
  // server-side from the repo id/tags (LTX-Video → ltx-video); HF_UNKNOWN_FAMILY
  // surfaces as a toast asking the user to confirm it's an LTX LoRA.
  // Shared install runner: `family` is undefined for the first attempt
  // (server autodetects) and set to the override on the inline-confirm retry.
  const runHfInstall = useCallback(async (url, family) => {
    // Cross-guard against the curated video quick-install: both write the shared
    // hfProgress, so allowing them to overlap makes both progress readouts show
    // interleaved byte counts. Only one HF install runs at a time.
    if (!url || hfInstalling || installingVideoRepo) return;
    setHfInstalling(true);
    setHfProgress(null);
    await installLoraFromHuggingfaceStream({ url, family, onProgress: setHfProgress })
      .then((sidecar) => {
        toast.success(`Installed ${sidecar.name}`);
        setHfUrl('');
        setHfFamilyPrompt(null);
        refresh();
      })
      .catch((err) => {
        // Autodetection failed but the install is otherwise valid — offer an
        // inline confirm to retry with the LTX-Video family rather than toast a
        // dead-end. (Skip when we already tried with an explicit override.)
        if (err?.code === 'HF_UNKNOWN_FAMILY' && !family) {
          setHfFamilyPrompt(url);
        } else {
          toast.error(err?.message || 'HuggingFace install failed');
        }
      })
      .finally(() => { setHfInstalling(false); setHfProgress(null); });
  }, [hfInstalling, installingVideoRepo, refresh]);

  const handleHfInstall = useCallback((e) => {
    e?.preventDefault?.();
    setHfFamilyPrompt(null);
    return runHfInstall(hfUrl.trim(), undefined);
  }, [hfUrl, runHfInstall]);

  // Quick-install a curated video LoRA suggestion. Routes through the HF
  // installer (not the Civitai one) with the card's known family. Tracks the
  // in-flight repo in its own state because the Civitai `installingSuggestion`
  // key is modelId/versionId-based — video installs have neither.
  const installVideoSuggestion = useCallback(async (card) => {
    // Cross-guard against the form install (see runHfInstall) — one HF install
    // at a time so they don't clobber the shared hfProgress.
    if (!card?.installUrl || installingVideoRepo || hfInstalling) return;
    setInstallingVideoRepo(card.repo);
    setHfProgress(null);
    await installLoraFromHuggingfaceStream({ url: card.installUrl, family: card.runnerFamily, onProgress: setHfProgress })
      .then((sidecar) => {
        toast.success(`Installed ${sidecar.name}`);
        refresh();
      })
      .catch((err) => toast.error(err?.message || 'HuggingFace install failed'))
      .finally(() => { setInstallingVideoRepo(null); setHfProgress(null); });
  }, [installingVideoRepo, hfInstalling, refresh]);

  const handleDelete = async (filename) => {
    setDeleting(filename);
    await deleteLoraFull(filename, { silent: true })
      .then(() => {
        toast.success('LoRA deleted');
        setLoras((prev) => prev.filter((l) => l.filename !== filename));
      })
      .catch((err) => toast.error(err?.message || 'Delete failed'))
      .finally(() => setDeleting(null));
  };

  // Installed list narrowed to the active media filter. Video families
  // (ltx-video) are video; everything else (image families + legacy null) is
  // image.
  const visibleLoras = loras.filter((l) => {
    if (mediaFilter === 'image') return !isVideoLoraFamily(l.runnerFamily);
    if (mediaFilter === 'video') return isVideoLoraFamily(l.runnerFamily);
    return true;
  });

  // Download percent for the in-flight HF install (drives the form button label
  // and progress bar), or null when the total is unknown.
  const hfPct = pctOf(hfProgress);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">LoRA Manager</h1>
        <p className="text-sm text-gray-400">
          Install LoRA fine-tunes from Civitai (image) or HuggingFace (video) and apply them to your Image Gen and Video Gen renders.
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

      <form
        onSubmit={handleHfInstall}
        className="bg-port-card border border-port-border rounded-lg p-4 space-y-3"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
          <Download size={16} />
          <span>Install video LoRA from HuggingFace</span>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={hfUrl}
            onChange={(e) => setHfUrl(e.target.value)}
            placeholder="https://huggingface.co/fal/ltx2.3-audio-reactive-lora"
            className="flex-1 bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600"
            disabled={hfInstalling}
          />
          <button
            type="submit"
            disabled={hfInstalling || !!installingVideoRepo || !hfUrl.trim()}
            className="bg-port-accent text-white px-4 py-2 rounded text-sm font-medium hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {hfInstalling ? (hfPct != null ? `Downloading ${hfPct}%` : 'Downloading…') : 'Install'}
          </button>
        </div>
        {hfInstalling && <HfDownloadProgress progress={hfProgress} />}
        <p className="text-xs text-gray-500">
          Paste a <code className="bg-port-bg px-1 rounded">huggingface.co</code> repo URL — or an{' '}
          <code className="bg-port-bg px-1 rounded">org/name</code> id — for an LTX-Video LoRA
          (e.g. <code className="bg-port-bg px-1 rounded">fal/ltx2.3-audio-reactive-lora</code>).
          These apply to <Link to="/media/video" className="text-port-accent hover:underline">Video Gen</Link> renders on an LTX-2 (ltx2) model. Gated repos use your HuggingFace token from Image Gen settings.
        </p>
        {hfFamilyPrompt && (
          <div className="flex items-center justify-between gap-3 rounded border border-port-warning/40 bg-port-warning/10 px-3 py-2">
            <span className="text-xs text-gray-300">
              Couldn&apos;t detect the model family for <code className="bg-port-bg px-1 rounded">{hfFamilyPrompt}</code>. Install it as an LTX-Video LoRA?
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => runHfInstall(hfFamilyPrompt, VIDEO_LORA_FAMILIES.LTX_VIDEO)}
                disabled={hfInstalling}
                className="bg-port-accent text-white px-3 py-1 rounded text-xs font-medium hover:bg-port-accent/90 disabled:opacity-50"
              >
                {hfInstalling ? (hfPct != null ? `Installing ${hfPct}%` : 'Installing…') : 'Install as LTX-Video'}
              </button>
              <button
                type="button"
                onClick={() => setHfFamilyPrompt(null)}
                disabled={hfInstalling}
                className="text-gray-400 hover:text-gray-200 px-2 py-1 rounded text-xs disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
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

      <MediaFilter value={mediaFilter} onChange={setMediaFilter} />

      <SuggestionsPanel
        suggestions={suggestions}
        loading={loadingSuggestions}
        mediaFilter={mediaFilter}
        installedFilenames={new Set(loras.map((l) => l.filename))}
        installedHfRepos={new Set(loras.map((l) => l.huggingface?.repo).filter(Boolean))}
        installingSuggestionKey={installingSuggestion}
        installingVideoRepo={installingVideoRepo}
        installingVideoProgress={hfProgress}
        videoInstallBusy={hfInstalling}
        onRefresh={() => refreshSuggestions({ force: true })}
        onInstallVideo={installVideoSuggestion}
        onInstall={async (card, url, versionId) => {
          // Curated cards pass a family-specific (url, versionId); non-curated
          // cards omit versionId and we fall back to the card's primary.
          const vid = versionId ?? card.versionId;
          const key = suggestionKey(card.modelId, vid);
          setInstallingSuggestion(key);
          await performInstall(url || card.installUrl);
          setInstallingSuggestion(null);
        }}
      />

      {/* Border-top divides "Installed" from the suggestion panel above — the
          curated "Video LoRAs" suggestions used to butt straight up against a
          flat Installed grid, making installed image LoRAs read as if they were
          part of the video section. */}
      <div className="border-t border-port-border pt-6">
        <h2 className="text-lg font-semibold text-white mb-3">Installed</h2>
        {loading && <div className="text-sm text-gray-500">Loading…</div>}
        {error && (
          <Banner tone="error" size="md" icon={AlertTriangle} align="center">{error}</Banner>
        )}
        {!loading && !error && visibleLoras.length === 0 && (
          <div className="text-sm text-gray-500 italic">
            {loras.length === 0
              ? 'No LoRAs installed yet — pick one from the suggestions above, or paste a Civitai URL.'
              : `No ${mediaFilter} LoRAs installed.`}
          </div>
        )}
        {/* On "All", split installed LoRAs into Video/Image subsections (with the
            same header style as the suggestion panel) so it's self-evident which
            renders each applies to. A specific filter already scopes the list, so
            render it flat. */}
        {visibleLoras.length > 0 && (
          mediaFilter === 'all'
            ? <InstalledGroups loras={visibleLoras} deleting={deleting} onDelete={handleDelete} />
            : <LoraGrid loras={visibleLoras} deleting={deleting} onDelete={handleDelete} />
        )}
      </div>
    </div>
  );
}

// Byte-level download progress bar for an in-flight HuggingFace LoRA install.
// `progress` is `{ received, total, progress }` (progress 0..1) or null. When
// the server had no Content-Length (total 0 / progress null) the bar renders an
// indeterminate pulse instead of a fill.
function HfDownloadProgress({ progress }) {
  const pct = pctOf(progress);
  const total = progress?.total || 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-gray-400">
        <span>{pct != null ? `Downloading… ${pct}%` : 'Downloading…'}</span>
        {total > 0 && (
          <span className="font-mono text-gray-500">{formatBytes(progress.received)} / {formatBytes(total)}</span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-port-bg" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`h-full bg-port-accent ${pct != null ? 'transition-[width] duration-200' : 'w-1/3 animate-pulse'}`}
          style={pct != null ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}

// Segmented All / Image / Video control. Pure presentational — the parent owns
// the `mediaFilter` state and applies it to both the suggestion panel and the
// installed list.
function MediaFilter({ value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500">Show</span>
      <div className="inline-flex rounded-lg border border-port-border overflow-hidden">
        {MEDIA_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onChange(f.id)}
            aria-pressed={value === f.id}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              value === f.id
                ? 'bg-port-accent text-white'
                : 'bg-port-card text-gray-400 hover:text-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SuggestionsPanel({ suggestions, loading, mediaFilter = 'all', installedFilenames, installedHfRepos, installingSuggestionKey, installingVideoRepo, installingVideoProgress, videoInstallBusy, onRefresh, onInstall, onInstallVideo }) {
  const curated = suggestions?.curated || [];
  const runners = suggestions?.runners || {};
  const video = suggestions?.video || [];
  const showImage = mediaFilter !== 'video';
  const showVideo = mediaFilter !== 'image';
  const sections = [
    { key: 'curated', label: 'Curated picks', cards: curated, hint: 'Hand-picked LoRAs that work across multiple base models.' },
    // The runner-family sections always render, even when Civitai search
    // returns zero — `alwaysShow` lets the user see every base-model header at
    // a glance instead of silently collapsing the empty ones. `runner` (the
    // family key) marks the section as searchable + paginated; it's tracked
    // separately from `alwaysShow` so the two concerns can't accidentally couple.
    { key: RUNNER_FAMILIES.MFLUX,   runner: RUNNER_FAMILIES.MFLUX,   label: 'Top for Flux 1',  cards: runners[RUNNER_FAMILIES.MFLUX] || [],   hint: 'Most-downloaded LoRAs trained against Flux.1 D / Flux.1 S.', alwaysShow: true },
    { key: RUNNER_FAMILIES.FLUX2,   runner: RUNNER_FAMILIES.FLUX2,   label: 'Top for Flux 2',  cards: runners[RUNNER_FAMILIES.FLUX2] || [],   hint: 'Most-downloaded LoRAs trained against Flux.2 Klein 4B / 9B.', alwaysShow: true },
    { key: RUNNER_FAMILIES.Z_IMAGE, runner: RUNNER_FAMILIES.Z_IMAGE, label: 'Top for Z-Image', cards: runners[RUNNER_FAMILIES.Z_IMAGE] || [], hint: 'Most-downloaded LoRAs trained against Z-Image / Z-Image-Turbo.', alwaysShow: true },
    { key: RUNNER_FAMILIES.ERNIE,   runner: RUNNER_FAMILIES.ERNIE,   label: 'Top for ERNIE',   cards: runners[RUNNER_FAMILIES.ERNIE] || [],   hint: 'Most-downloaded LoRAs trained against ERNIE-Image.', alwaysShow: true },
    { key: RUNNER_FAMILIES.HIDREAM, runner: RUNNER_FAMILIES.HIDREAM, label: 'Top for HiDream', cards: runners[RUNNER_FAMILIES.HIDREAM] || [], hint: 'Most-downloaded LoRAs trained against HiDream.', alwaysShow: true },
    { key: RUNNER_FAMILIES.QWEN,    runner: RUNNER_FAMILIES.QWEN,    label: 'Top for Qwen',    cards: runners[RUNNER_FAMILIES.QWEN] || [],    hint: 'Most-downloaded LoRAs trained against Qwen-Image.', alwaysShow: true },
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
      {showImage && sections.map((section) => (
        <SuggestionsSection
          key={section.key}
          label={section.label}
          hint={section.hint}
          cards={section.cards}
          alwaysShow={section.alwaysShow}
          // Runner-family sections carry a `runner` key → keyword search box +
          // "Load more" pagination; the curated section has none and stays static.
          runner={section.runner || null}
          resetSignal={suggestions?.fetchedAt}
          installedFilenames={installedFilenames}
          installingSuggestionKey={installingSuggestionKey}
          onInstall={onInstall}
        />
      ))}
      {showVideo && (
        <VideoSuggestionsSection
          cards={video}
          installedHfRepos={installedHfRepos}
          installingVideoRepo={installingVideoRepo}
          installingVideoProgress={installingVideoProgress}
          videoInstallBusy={videoInstallBusy}
          onInstall={onInstallVideo}
        />
      )}
    </div>
  );
}

// Curated HuggingFace video LoRAs (LTX-Video). No keyword search / pagination
// like the Civitai sections — it's a small hand-picked list installed via the
// HF path. Installed-state matches on the repo (HF installs carry no
// modelId/versionId).
function VideoSuggestionsSection({ cards, installedHfRepos, installingVideoRepo, installingVideoProgress, videoInstallBusy, onInstall }) {
  const list = cards || [];
  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <h3 className="text-sm font-medium text-gray-300">Video LoRAs</h3>
        <span className="text-xs text-gray-600">{list.length}</span>
      </div>
      <p className="text-xs text-gray-500 mb-2">
        Curated LTX-Video LoRAs from HuggingFace — apply on an LTX-2 (ltx2) model in{' '}
        <Link to="/media/video" className="text-port-accent hover:underline">Video Gen</Link>.
      </p>
      {list.length === 0 ? (
        <p className="text-xs text-gray-600 italic">No video LoRA suggestions yet.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {list.map((card) => (
            <VideoSuggestionCard
              key={card.repo}
              card={card}
              installed={installedHfRepos?.has(card.repo)}
              installing={installingVideoRepo === card.repo}
              progress={installingVideoRepo === card.repo ? installingVideoProgress : null}
              // Disable every quick-install button while ANY HF install is in
              // flight (this card's, another card's, or the form's) — one at a time.
              busy={!!installingVideoRepo || videoInstallBusy}
              onInstall={onInstall}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VideoSuggestionCard({ card, installed, installing, progress, busy, onInstall }) {
  const pct = pctOf(progress);
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
          <span className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${RUNNER_BADGE_CLASS[card.runnerFamily] || 'bg-gray-600/20 text-gray-300 border-gray-500/30'}`}>
            {RUNNER_LABEL[card.runnerFamily] || 'Video'}
          </span>
        </div>
        {card.note && <p className="text-[11px] text-gray-400 italic break-words">{card.note}</p>}
        {card.description && (
          <details className="text-[11px] text-gray-500">
            <summary className="cursor-pointer hover:text-gray-300">Details</summary>
            <p className="mt-1 text-[10px] leading-snug bg-port-bg p-1.5 rounded border border-port-border line-clamp-4">{card.description}</p>
          </details>
        )}
        <div className="flex items-center gap-2 mt-auto">
          {installed ? (
            <button disabled className="flex-1 bg-port-success/20 text-port-success border border-port-success/30 px-3 py-1.5 rounded text-xs font-medium flex items-center justify-center gap-1">
              <Check size={12} /> Installed
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onInstall(card)}
              disabled={installing || busy}
              className="flex-1 bg-port-accent text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {installing ? (pct != null ? `Installing ${pct}%` : 'Installing…') : 'Quick install'}
            </button>
          )}
        </div>
        {card.hfUrl && (
          <a href={card.hfUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 self-start" title="Open on HuggingFace">
            <ExternalLink size={11} /> View on HuggingFace
          </a>
        )}
      </div>
    </div>
  );
}

function SuggestionsSection({ label, hint, cards, alwaysShow = false, runner = null, resetSignal, installedFilenames, installingSuggestionKey, onInstall }) {
  const baseCards = cards || [];
  const searchable = !!runner;

  // Live state for keyword search + "Load more" pagination. `liveCards === null`
  // means we're showing the cached top-N from props; once the user searches or
  // pages, we switch to the live list. `activeQuery` is the last submitted
  // keyword ('' = top ranking); `cursor` is Civitai's next-page token.
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [liveCards, setLiveCards] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);

  // Drop any live search/pagination so the section falls back to the cached
  // top-N. Shared by Clear, the empty-box submit, and the Refresh effect.
  // Stable identity (setters never change) so the effect can depend on it.
  const resetToCached = useCallback(() => {
    setActiveQuery(''); setLiveCards(null); setCursor(null);
  }, []);

  // A global Refresh (new fetchedAt) re-seeds the cached top-N — drop live
  // results so the section doesn't show stale ones under the new header. Also
  // fires once harmlessly on mount (all setters are no-ops at their defaults).
  useEffect(() => { setQuery(''); resetToCached(); }, [resetSignal, resetToCached]);

  const fetchPage = useCallback(async (q, { append, useCursor }) => {
    setLoading(true);
    await searchCivitaiLoras({ runner, query: q, cursor: useCursor, limit: 12 })
      .then((res) => {
        const items = res?.items || [];
        setCursor(res?.nextCursor || null);
        setActiveQuery(q);
        setLiveCards((prev) => {
          if (!append || prev === null) return items;
          // Dedup by modelId-versionId — re-fetched leaders can repeat.
          const seen = new Set(prev.map(cardKey));
          return [...prev, ...items.filter((c) => !seen.has(cardKey(c)))];
        });
      })
      .catch((err) => toast.error(err?.message || 'Civitai search failed'))
      .finally(() => setLoading(false));
  }, [runner]);

  const handleSearch = (e) => {
    e?.preventDefault?.();
    if (loading) return; // Enter while a fetch is in flight → no overlapping requests
    const q = query.trim();
    if (!q) { resetToCached(); return; } // empty box → cached top-N
    fetchPage(q, { append: false, useCursor: null });
  };

  const clearSearch = () => { setQuery(''); resetToCached(); };

  const loadMore = () => {
    if (loading) return;
    // First click from the cached view fetches page 1 live (top ranking or the
    // active query); later clicks page forward with the cursor.
    if (liveCards === null) fetchPage(activeQuery, { append: false, useCursor: null });
    else fetchPage(activeQuery, { append: true, useCursor: cursor });
  };

  const list = liveCards !== null ? liveCards : baseCards;
  // "Load more" is available until we've gone live AND Civitai reports no
  // further cursor. In the cached view we assume more exists (only top-4 shown).
  const canLoadMore = searchable && (liveCards === null || cursor !== null);

  if (list.length === 0 && !alwaysShow && !searchable) return null;
  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <h3 className="text-sm font-medium text-gray-300">{label}</h3>
        <span className="text-xs text-gray-600">{list.length}</span>
        {activeQuery && (
          <span className="text-xs text-port-accent">results for “{activeQuery}”</span>
        )}
      </div>
      {hint && <p className="text-xs text-gray-500 mb-2">{hint}</p>}
      {searchable && (
        <form onSubmit={handleSearch} className="flex gap-2 mb-3">
          <div className="relative flex-1 max-w-md">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${RUNNER_LABEL[runner] || runner} LoRAs on Civitai…`}
              aria-label={`Search ${RUNNER_LABEL[runner] || runner} LoRAs on Civitai`}
              className="w-full bg-port-bg border border-port-border rounded pl-8 pr-3 py-1.5 text-xs text-gray-200 placeholder:text-gray-600"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="bg-port-accent/90 text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-port-accent disabled:opacity-50"
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
          {activeQuery && (
            <button
              type="button"
              onClick={clearSearch}
              className="px-2 py-1.5 rounded text-xs text-gray-400 hover:text-gray-200 border border-port-border"
              title="Clear search — back to top ranking"
            >
              Clear
            </button>
          )}
        </form>
      )}
      {list.length === 0 ? (
        <p className="text-xs text-gray-600 italic">
          {activeQuery
            ? `No LoRAs match “${activeQuery}” for this base model${canLoadMore ? ' on this page — try Load more.' : '.'}`
            : 'No LoRAs found on Civitai for this base model yet.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {list.map((card) => (
            <SuggestionCard
              key={cardKey(card)}
              card={card}
              installedFilenames={installedFilenames}
              installingSuggestionKey={installingSuggestionKey}
              onInstall={onInstall}
            />
          ))}
        </div>
      )}
      {/* "Load more" sits OUTSIDE the empty/non-empty branch on purpose: a live
          Civitai page can come back empty yet carry a nextCursor (later pages
          hold matches for some keyword + base-model combos), so the control
          must stay reachable to advance past empty pages instead of trapping
          the user on a false "no matches" state. */}
      {canLoadMore && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="text-xs text-gray-300 hover:text-white px-4 py-1.5 rounded border border-port-border hover:border-port-accent/40 disabled:opacity-50 flex items-center gap-1.5"
          >
            {loading ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
            {loading ? 'Loading…' : 'Load more'}
          </button>
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
  const isInstalling = (versionId) => installingSuggestionKey === suggestionKey(card.modelId, versionId);
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

// Responsive grid of installed LoRA cards. Extracted so the Installed section
// can render either one flat grid (filtered view) or several grouped grids
// (the "All" view) without duplicating the grid markup.
function LoraGrid({ loras, deleting, onDelete }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {loras.map((lora) => (
        <LoraCard key={lora.filename} lora={lora} onDelete={() => onDelete(lora.filename)} deleting={deleting === lora.filename} />
      ))}
    </div>
  );
}

// Installed LoRAs split into Video / Image subsections for the "All" view, each
// with a labeled header mirroring the suggestion panel's grouping. Empty groups
// are omitted. Video is listed first (fewer, and the source of the layout
// confusion this grouping resolves).
function InstalledGroups({ loras, deleting, onDelete }) {
  const video = loras.filter((l) => isVideoLoraFamily(l.runnerFamily));
  const image = loras.filter((l) => !isVideoLoraFamily(l.runnerFamily));
  const groups = [
    { key: 'video', label: 'Video LoRAs', items: video },
    { key: 'image', label: 'Image LoRAs', items: image },
  ].filter((g) => g.items.length > 0);
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.key}>
          <div className="flex items-baseline gap-3 mb-2">
            <h3 className="text-sm font-medium text-gray-300">{g.label}</h3>
            <span className="text-xs text-gray-600">{g.items.length}</span>
          </div>
          <LoraGrid loras={g.items} deleting={deleting} onDelete={onDelete} />
        </div>
      ))}
    </div>
  );
}

function LoraCard({ lora, onDelete, deleting }) {
  const family = lora.runnerFamily;
  const familyLabel = family ? (RUNNER_LABEL[family] || family) : 'Unsupported base';
  const badgeClass = family ? (RUNNER_BADGE_CLASS[family] || 'bg-gray-600/20 text-gray-300 border-gray-500/30') : 'bg-port-warning/20 text-port-warning border-port-warning/30';
  const triggerWords = lora.triggerWords || [];
  const civitai = lora.civitai;
  // The gen pages read ?lora=<filename> as a preselect hint via query string;
  // keeps the manager → gen handoff URL-driven (deep-linkable). Video-family
  // LoRAs (ltx-video) deep-link to Video Gen — routing them to Image Gen would
  // preselect an LTX adapter into an incompatible image render.
  const isVideoLora = family === VIDEO_LORA_FAMILIES.LTX_VIDEO;
  const testHref = `${isVideoLora ? '/media/video' : '/media/image'}?lora=${encodeURIComponent(lora.filename)}`;

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

        {/* Trained-in-PortOS lineage: character chip links back to the
            training dataset that produced this adapter. */}
        {lora.source === 'trained' && lora.character && (
          <div className="mb-2">
            <Link
              to={lora.trainedFromDatasetId ? `/media/training/${lora.trainedFromDatasetId}` : '/media/training'}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-port-success/15 text-port-success border border-port-success/30 hover:bg-port-success/25"
              title="Trained in PortOS — open the training dataset"
            >
              <Sparkles size={11} /> Character: {lora.character.name}
            </Link>
          </div>
        )}

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
          {lora.huggingface?.url && (
            <a
              href={lora.huggingface.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-200 p-1.5 rounded hover:bg-port-bg"
              title="Open on HuggingFace"
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
