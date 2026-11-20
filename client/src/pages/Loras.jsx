/**
 * LoRA Manager — install / browse / delete Civitai and HuggingFace LoRAs.
 *
 * Paste a Civitai or HuggingFace URL to download and install. Each LoRA card
 * shows the preview, base model (Flux.1 / Flux.2 / Z-Image / LTX / Other),
 * trigger words, recommended scale, and a "Test in Image Gen" / Video Gen
 * deep-link that preselects the LoRA on the generation page.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { Download, AlertTriangle, Check, Package, Compass } from 'lucide-react';
import EmptyState from '../components/EmptyState';
import TabPills from '../components/ui/TabPills';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import DownloadPreflightConfirm from '../components/models/DownloadPreflightConfirm.jsx';
import RetiredTrainingData from '../components/models/RetiredTrainingData';
import Banner from '../components/ui/Banner';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { isVideoLoraFamily } from '../lib/runnerFamilies';
import { listLorasFull, deleteLoraFull, getCivitaiAuth, getCivitaiSuggestions } from '../services/apiImageVideo.js';
import { installedHfKey } from '../components/loras/loraDisplay';
import HfDownloadProgress from '../components/loras/HfDownloadProgress';
import CivitaiAuthModal from '../components/loras/CivitaiAuthModal';
import SuggestionsPanel from '../components/loras/LoraDiscoverPanel';
import { InstalledGroups, LoraGrid } from '../components/loras/LoraCard';
import { CivitaiInstallForm, HfInstallForm } from '../components/loras/LoraInstallForms';
import useLoraInstalls from '../components/loras/useLoraInstalls';

// Top-level view split (#7231). Discovery — curated picks, six per-family
// Civitai lists, the video catalog, and two live searches — used to render
// ABOVE the installed grid, so managing an already-installed adapter meant
// scrolling past thousands of pixels of recommendations that grow as results
// arrive. Installed is now its own view and the default one; discovery is one
// labeled click away. The chosen view lives in `?loraView` (not local state) so
// it survives reload and Back/Forward, per the URL-is-the-source-of-truth
// convention in `client/src/AGENTS.md`.
const VIEW_PARAM = 'loraView';
const VIEW_INSTALLED = 'installed';
const VIEW_DISCOVER = 'discover';
const DEFAULT_VIEW = VIEW_INSTALLED;
const VIEW_IDS = [VIEW_INSTALLED, VIEW_DISCOVER];
// `id="tab-<view>"` / `aria-controls="lorapanel-<view>"` pairing for TabPills.
const VIEW_PANEL_PREFIX = 'lorapanel';

// Image/Video filter applied to BOTH the suggestion panel and the installed
// list (see the user request: filter suggestions + installed by media type).
const MEDIA_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
];

export default function Loras() {
  // Active view. An unknown/hand-edited `?loraView=` degrades to Installed
  // rather than rendering a blank panel.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawView = searchParams.get(VIEW_PARAM);
  const view = VIEW_IDS.includes(rawView) ? rawView : DEFAULT_VIEW;
  // A PUSH, not `replace` — switching views is a navigation the user expects
  // Back to undo (the acceptance criterion), unlike the in-view media filter.
  // Writing the default drops the param so a pristine URL stays clean.
  const setView = useCallback((next) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (!next || next === DEFAULT_VIEW) params.delete(VIEW_PARAM);
      else params.set(VIEW_PARAM, next);
      return params;
    });
  }, [setSearchParams]);
  const [loras, setLoras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);
  // Arms one installed card's delete at a time — a LoRA is a multi-gigabyte
  // file with no undo, so the trash icon only reveals an inline confirm pair
  // instead of deleting on the first click/tap (#3519).
  const deleteConfirm = useConfirmDelete();
  // Civitai auth — `{ hasKey, source }`, shown by the key badge and the modal.
  const [auth, setAuth] = useState({ hasKey: false, source: 'none' });
  // suggestions: { runners: { mflux: [...], flux2: [...], 'z-image': [...] }, video: [...], fetchedAt }
  const [suggestions, setSuggestions] = useState(null);
  // Stays true until the first fetch settles — nothing is requested before the
  // Discover view is opened, so this reads as "no catalog result yet" and the
  // panel's first frame shows the loader instead of flashing empty sections.
  const [loadingSuggestions, setLoadingSuggestions] = useState(true);
  // Image/Video media-type filter for both panels. 'all' | 'image' | 'video'.
  const [mediaFilter, setMediaFilter] = useState('all');

  // The install endpoints return the raw sidecar, not the library row: the row
  // adds server-derived fields (filename, sizeBytes, loraCompatKey, normalized
  // preview URL), so splicing the sidecar in would render a malformed card.
  // After an install the list is therefore re-read, but in the background — the
  // spinner only replaces the list for the first load and explicit retries.
  const refresh = useCallback(({ background = false } = {}) => {
    setError(null);
    if (!background) setLoading(true);
    // silent:true — the failure renders as a persistent inline error Banner;
    // the default toast would say the same thing a second time.
    listLorasFull({ silent: true })
      .then(setLoras)
      .catch((err) => setError(err?.message || 'Failed to load LoRAs'))
      .finally(() => setLoading(false));
  }, []);

  const installs = useLoraInstalls({ refresh, setView, discoverView: VIEW_DISCOVER });
  const { hfInstalling, hfProgress, installingVideoKey, lastInstalled, setLastInstalled, authPrompt, setAuthPrompt, downloadConfirm } = installs;

  const refreshSuggestions = useCallback(({ force = false } = {}) => {
    setLoadingSuggestions(true);
    getCivitaiSuggestions({ force }, { silent: true })
      .then(setSuggestions)
      .catch((err) => toast.error(err?.message || 'Failed to load suggestions'))
      .finally(() => setLoadingSuggestions(false));
  }, []);

  useEffect(() => {
    let active = true;
    refresh();
    getCivitaiAuth().then((a) => { if (active) setAuth(a); }).catch(() => {});
    return () => { active = false; };
  }, [refresh]);

  // Discovery is fetched the first time its view is opened, not on mount —
  // the default Installed view never needs it, and a ref (not `suggestions`)
  // gates the fetch so a legitimately empty catalog response isn't re-requested
  // on every switch back.
  const suggestionsRequested = useRef(false);
  useEffect(() => {
    // Reaching Installed retires the install hand-off — however the user got
    // there (the tab, the banner's own button, or Back), the banner has done
    // its job and must not reappear on the next visit to Discover.
    if (view === VIEW_INSTALLED) setLastInstalled(null);
    if (view !== VIEW_DISCOVER || suggestionsRequested.current) return;
    suggestionsRequested.current = true;
    refreshSuggestions();
  }, [view, refreshSuggestions]);

  // The measurement lives in the LIST, not in the card. The Installed section
  // swaps between LoraGrid and InstalledGroups when the media filter changes,
  // which unmounts every card — a badge held only in card state would vanish
  // right after the user ran the check. The server has cached the same report in
  // the sidecar, so this just keeps the page consistent without a refetch.
  const handleMeasured = useCallback((filename, effectReport) => {
    setLoras((prev) => prev.map((l) => (l.filename === filename ? { ...l, effectReport } : l)));
  }, []);

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

  return (
    <div className="space-y-6">
      {/* An h2, not an h1: this page is the LoRAs tab under the Models section
          (#4728), whose PageHeader already owns the page's h1. */}
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">LoRA Manager</h2>
        <p className="text-sm text-gray-400">
          Install LoRA fine-tunes from Civitai or HuggingFace and apply them to your Image Gen and Video Gen renders.
        </p>
      </div>

      {/* View switch + primary action, directly under the heading so both are
          above the fold on a phone. Discovery lives behind the second tab, so
          no amount of catalog growth can push the installed list down. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabPills
          tabs={[
            { id: VIEW_INSTALLED, label: 'Installed', icon: Package, count: loras.length },
            { id: VIEW_DISCOVER, label: 'Discover / install', icon: Compass },
          ]}
          activeTab={view}
          onChange={setView}
          variant="pills"
          size="sm"
          ariaLabel="LoRA view"
          controlsIdPrefix={VIEW_PANEL_PREFIX}
        />
        <div className="flex max-w-full flex-wrap items-center gap-2 sm:gap-3">
          <MediaFilter value={mediaFilter} onChange={setMediaFilter} />
          {view === VIEW_INSTALLED && (
            <button
              type="button"
              onClick={() => setView(VIEW_DISCOVER)}
              className="min-h-11 shrink-0 bg-port-accent text-white px-3 rounded text-sm font-medium hover:bg-port-accent/90 flex items-center justify-center gap-2"
            >
              <Download size={14} aria-hidden="true" />
              Install LoRA
            </button>
          )}
        </div>
      </div>

      {/* A HuggingFace download keeps running when the user leaves Discover,
          but every readout of it (the form's bar, the card's percent) lives in
          that panel — so a multi-gigabyte transfer would silently have no
          indicator anywhere. Mirror it here, and only while Discover is closed,
          so the two are never on screen at once. */}
      {view !== VIEW_DISCOVER && (hfInstalling || installingVideoKey) && (
        <div className="bg-port-card border border-port-border rounded-lg p-3">
          <HfDownloadProgress progress={hfProgress} />
        </div>
      )}

      {view === VIEW_DISCOVER && (
        <div id={`${VIEW_PANEL_PREFIX}-${VIEW_DISCOVER}`} role="tabpanel" aria-labelledby={`tab-${VIEW_DISCOVER}`} className="space-y-6">
          {lastInstalled && (
            <Banner
              tone="success"
              size="md"
              icon={Check}
              align="center"
              actions={(
                <button
                  type="button"
                  onClick={() => setView(VIEW_INSTALLED)}
                  className="text-xs font-medium px-3 py-1 rounded bg-port-success/20 hover:bg-port-success/30 whitespace-nowrap"
                >
                  View installed
                </button>
              )}
            >
              Installed {lastInstalled}.
            </Banner>
          )}

          <CivitaiInstallForm installs={installs} auth={auth} onManageKey={() => setAuthPrompt({ url: null, message: '' })} />
          <HfInstallForm installs={installs} />

          <SuggestionsPanel
            suggestions={suggestions}
            loading={loadingSuggestions}
            mediaFilter={mediaFilter}
            installedFilenames={new Set(loras.map((l) => l.filename))}
            installedHfKeys={new Set(loras.filter((l) => l.huggingface?.repo).map(installedHfKey))}
            installingSuggestionKey={installs.installingSuggestion}
            installingVideoKey={installingVideoKey}
            installingVideoProgress={hfProgress}
            videoInstallBusy={hfInstalling}
            onRefresh={() => refreshSuggestions({ force: true })}
            onInstallVideo={installs.installVideoSuggestion}
            onInstall={installs.installSuggestion}
          />
        </div>
      )}

      {view === VIEW_INSTALLED && (
        <div id={`${VIEW_PANEL_PREFIX}-${VIEW_INSTALLED}`} role="tabpanel" aria-labelledby={`tab-${VIEW_INSTALLED}`}>
          <h2 className="text-lg font-semibold text-white mb-3">Installed</h2>
          {loading && <PageSkeleton header="none" label="Loading installed LoRAs" layout="grid" cards={6} />}
          {error && (
            <Banner tone="error" size="md" icon={AlertTriangle} align="center">{error}</Banner>
          )}
          {/* The empty state names the next action rather than pointing at
              "the suggestions above" — discovery is now a view away, not a
              scroll away. */}
          {!loading && !error && visibleLoras.length === 0 && (
            <EmptyState
              icon={Package}
              title={loras.length === 0 ? 'No LoRAs installed yet' : `No ${mediaFilter} LoRAs installed`}
              message={loras.length === 0
                ? 'Browse curated picks and Civitai / HuggingFace search, or paste a model URL, to install your first adapter.'
                : `You have other LoRAs installed — switch the Show filter, or install a ${mediaFilter} LoRA.`}
              actionLabel="Discover LoRAs to install"
              onAction={() => setView(VIEW_DISCOVER)}
            />
          )}
          {/* On "All", split installed LoRAs into Video/Image subsections (with the
              same header style as the suggestion panel) so it's self-evident which
              renders each applies to. A specific filter already scopes the list, so
              render it flat. */}
          {visibleLoras.length > 0 && (
            mediaFilter === 'all'
              ? <InstalledGroups loras={visibleLoras} deleting={deleting} onDelete={handleDelete} onMeasured={handleMeasured} deleteConfirm={deleteConfirm} />
              : <LoraGrid loras={visibleLoras} deleting={deleting} onDelete={handleDelete} onMeasured={handleMeasured} deleteConfirm={deleteConfirm} />
          )}
        </div>
      )}

      {view === VIEW_INSTALLED && <RetiredTrainingData />}

      {/* Both overlays stay OUTSIDE the view gate: an install started in
          Discover can still hit a 401 (or finish its preflight) after the user
          has switched to Installed, and unmounting the dialog would strand
          that attempt with no way to recover the key. */}
      {authPrompt && (
        <CivitaiAuthModal
          pendingUrl={authPrompt.url}
          message={authPrompt.message}
          auth={auth}
          onClose={() => setAuthPrompt(null)}
          onSaved={(updatedAuth) => setAuth(updatedAuth)}
          onRetry={installs.retryAfterAuth}
        />
      )}
      <DownloadPreflightConfirm
        open={Boolean(downloadConfirm)}
        title={downloadConfirm?.title}
        loading={Boolean(downloadConfirm?.loading)}
        error={downloadConfirm?.error}
        assessment={downloadConfirm?.assessment}
        confirmLabel="Start download"
        onCancel={installs.handleCancelDownloadConfirm}
        onConfirm={installs.runDownloadConfirm}
      />
    </div>
  );
}

// Segmented All / Image / Video control. Pure presentational — the parent owns
// the `mediaFilter` state and applies it to both the suggestion panel and the
// installed list.
function MediaFilter({ value, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-500">Show</span>
      <div className="inline-flex max-w-full rounded-lg border border-port-border overflow-hidden">
        {MEDIA_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onChange(f.id)}
            aria-pressed={value === f.id}
            className={`min-h-11 px-3 text-xs font-medium transition-colors ${
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
