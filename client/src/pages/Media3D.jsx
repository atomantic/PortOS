import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, CheckCircle2, Download, AlertTriangle, Loader2, ExternalLink, ImagePlus, Sparkles, KeyRound } from 'lucide-react';
import { getImageTo3dTargets, createImageTo3dModel, getImageTo3dModel, listImageTo3dModels } from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import useMounted from '../hooks/useMounted';
import { nameFromImageFilename, timeAgo } from '../utils/formatters';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import GlbViewer from '../components/media/GlbViewer';
import HfTokenBanner, { GatedModelList, HF_SOURCE_LABEL } from '../components/imageGen/HfTokenBanner';
import { useHfTokenStatus } from '../hooks/useHfTokenStatus';
import useUrlParams from '../hooks/useUrlParams';
import MediaImage from '../components/MediaImage';
import { imageTo3dStatusMeta } from '../components/media/imageTo3dStatus';

// Poll cadence while a render is in flight (a real TRELLIS.2 render is multi-minute).
const POLL_INTERVAL_MS = 2500;

// Prerequisite notice for a target that needs gated Hugging Face access. Driven by
// the CENTRAL token store (GET /image-gen/setup/hf-token-status) — the same one the
// Image Gen page writes — so a user who already pasted a token isn't told to go set
// one up in a terminal. With no token, the inline paste-and-save banner appears
// instead of instructions. Either way the gated repos stay listed: a token doesn't
// grant access until their terms are accepted on the user's HF account.
function HfAccessNotice({ models, tokenPresent, tokenSource, onSaved }) {
  // Escape hatch for the stale/invalid-token case: `isHfAuthError` in the runner
  // also matches `401` / `Invalid user token`, and its guidance now says to add a
  // token *on this page* — so the paste form has to stay reachable even when one is
  // already configured, or that instruction is impossible to follow here. Mirrors
  // MidiGatedModal's "Use a different token".
  const [replacing, setReplacing] = useState(false);

  if (!models?.length) return null;
  // Status still loading (null) — don't flash a "needs setup" banner at a user who
  // already has a token.
  if (tokenPresent === null) return null;

  const handleSaved = () => { setReplacing(false); onSaved?.(); };

  if (!tokenPresent || replacing) {
    return <HfTokenBanner models={models} onSaved={handleSaved} />;
  }

  return (
    <div className="rounded-lg border border-port-border bg-port-bg/40 p-3 text-xs text-gray-400">
      <div className="flex items-center gap-1.5 font-medium text-port-success">
        <KeyRound className="h-3.5 w-3.5" />
        Hugging Face token configured
        {HF_SOURCE_LABEL[tokenSource] ? ` (${HF_SOURCE_LABEL[tokenSource]})` : ''}
      </div>
      <p className="mt-1">
        Accept the terms for these gated models on your Hugging Face account if you haven’t — a token alone
        doesn’t grant access:
      </p>
      <GatedModelList models={models} linkClassName="text-port-accent hover:underline" />
      <button
        type="button"
        onClick={() => setReplacing(true)}
        className="mt-2 text-xs underline text-gray-400 hover:text-white"
      >
        Use a different token
      </button>
    </div>
  );
}

// Human-readable reasons a target can't run on this host, keyed by the stable
// reason code the registry returns (server/services/imageTo3d/targets.js).
const REASON_LABEL = {
  'requires-apple-silicon': 'Requires an Apple Silicon Mac',
  'insufficient-memory': 'Needs 24 GB+ of unified memory',
  'requires-cuda': 'Requires an NVIDIA CUDA GPU',
  'unknown-target': 'Unavailable',
};

const LANE_LABEL = {
  'local-mps': 'Runs on-device (Apple Silicon)',
  'local-cuda': 'Runs on-device (CUDA)',
  'hosted-api': 'Hosted API',
};

// A target is generation-ready when it can run on this host and its local model
// is present (installed:null means "no install concept" — a hosted target that's
// ready as soon as it's available).
const isTargetReady = (t) => !!t && t.available && t.installed !== false;

function StatusBadge({ target }) {
  if (!target.available) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-port-warning">
        <AlertTriangle className="w-3.5 h-3.5" />
        {REASON_LABEL[target.unavailableReason] || 'Unsupported on this host'}
      </span>
    );
  }
  if (target.installed) {
    // An installed target whose Metal texture bake is missing still renders — the
    // geometry is fine — but the surface comes out scrambled, so "Ready" alone
    // would be a lie. `quality:'unknown'` (the probe couldn't run) stays Ready
    // rather than crying wolf about an install that is probably fine.
    if (target.textureBake?.quality === 'fallback') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-port-warning">
          <AlertTriangle className="w-3.5 h-3.5" /> Ready · degraded textures
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-port-success">
        <CheckCircle2 className="w-3.5 h-3.5" /> Ready
      </span>
    );
  }
  return null;
}

function TargetCard({ target, onInstall }) {
  // Install only applies to targets with a local install concept (installed is a
  // boolean); hosted targets report installed:null and are Ready when available.
  const canInstall = target.available && target.installed === false;
  const degradedBake = target.textureBake?.quality === 'fallback';
  // Repair install re-runs setup, which now downloads the Metal Toolchain itself
  // (#3041) — but only offer it when the server says it can actually fix this. On a
  // Command-Line-Tools-only host `repairable` is false and the remedy is installing
  // Xcode, so a Repair button would just fail the same way and read as broken.
  const canRepair = degradedBake && target.textureBake?.repairable !== false;

  return (
    <div className="rounded-lg border border-port-border bg-port-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">{target.label}</h2>
            {target.executionLane && (
              <span className="rounded bg-port-bg px-1.5 py-0.5 text-[11px] text-gray-400">
                {LANE_LABEL[target.executionLane] || target.executionLane}
              </span>
            )}
          </div>
          {target.description && (
            <p className="mt-1 text-xs text-gray-400">{target.description}</p>
          )}
          {(target.upstream || target.port) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
              {target.upstream && (
                <a href={target.upstream} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-port-accent">
                  <ExternalLink className="w-3 h-3" /> Upstream
                </a>
              )}
              {target.port && (
                <a href={target.port} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-port-accent">
                  <ExternalLink className="w-3 h-3" /> Apple Silicon port
                </a>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge target={target} />
          {(canInstall || canRepair) && (
            <button
              onClick={() => onInstall(target)}
              className="inline-flex items-center gap-1.5 rounded-md bg-port-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
            >
              <Download className="w-3.5 h-3.5" /> {canInstall ? 'Install' : 'Repair install'}
            </button>
          )}
        </div>
      </div>
      {degradedBake && target.textureBake?.help && (
        <p className="mt-3 rounded border border-port-warning/40 bg-port-warning/10 p-2 text-[11px] leading-relaxed text-port-warning">
          {target.textureBake.help}
        </p>
      )}
    </div>
  );
}

export default function Media3D() {
  const [searchParams, updateParams] = useUrlParams();
  // URL is the source of truth for what's open: the source image, the chosen
  // target, and (once the runner lands #2952) the generated mesh to preview.
  const imageFromRoute = searchParams.get('image') || '';
  const targetFromRoute = searchParams.get('target') || '';
  const glbFromRoute = searchParams.get('glb') || '';

  const [targets, setTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The target whose install modal is open (only local-install targets); null = closed.
  const [installTarget, setInstallTarget] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Render lifecycle: a create kicks off an on-device render, then we poll the
  // record (via useAutoRefetch below) until it lands (ready → preview) or fails
  // (error → surfaced inline, where the runner's actionable HF-auth message shows).
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const [genPercent, setGenPercent] = useState(null);
  const [modelId, setModelId] = useState(null);
  // Existing image-to-3D records (newest-first) so the page doubles as a library:
  // each links to its `/3d/:id` detail view.
  const [records, setRecords] = useState([]);
  // Central HF-token status (stored / env / cli) for the gated-model notice. `present`
  // is tri-state — see useHfTokenStatus; `null` means unknown, not absent.
  const { present: hfTokenPresent, source: hfTokenSource, refresh: refreshHfToken } = useHfTokenStatus();
  const mountedRef = useMounted(); // gate setState after the create/poll awaits

  const load = useCallback(() => {
    setLoading(true);
    getImageTo3dTargets()
      .then((data) => { setTargets(data?.targets || []); setError(null); })
      .catch((err) => setError(err?.message || 'Failed to load 3D targets'))
      .finally(() => setLoading(false));
  }, []);

  const loadRecords = useCallback(() => {
    listImageTo3dModels({ silent: true })
      .then((data) => { if (mountedRef.current) setRecords(Array.isArray(data) ? data : []); })
      .catch(() => { /* the library section just stays empty on a transient failure */ });
  }, [mountedRef]);

  // Reactively fold a created/updated record into the library instead of
  // re-fetching the whole list (we already hold the fresh row).
  const patchRecord = useCallback((record) => {
    if (!record?.id || !mountedRef.current) return;
    setRecords((prev) => (prev.some((r) => r.id === record.id)
      ? prev.map((r) => (r.id === record.id ? { ...r, ...record } : r))
      : [record, ...prev]));
  }, [mountedRef]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadRecords(); }, [loadRecords]);

  const selectedImage = useMemo(
    () => (imageFromRoute
      ? { filename: imageFromRoute, previewUrl: `/data/images/${encodeURIComponent(imageFromRoute)}` }
      : null),
    [imageFromRoute],
  );

  // The active target: an explicit `?target=` when it matches a known target,
  // else the first generation-ready one, else the first registered.
  const selectedTarget = useMemo(() => {
    if (!targets.length) return null;
    return targets.find((t) => t.id === targetFromRoute)
      || targets.find(isTargetReady)
      || targets[0];
  }, [targets, targetFromRoute]);

  // Keep the URL honest: if a bare `/3d` resolved a default target, reflect
  // it so the selection is shareable/reload-safe (URL as source of truth).
  // `updateParams` reads the freshest params off a ref and is referentially
  // stable, so this effect depends only on the resolved target — not on every
  // unrelated `?image=`/`?glb=` change.
  useEffect(() => {
    if (!selectedTarget || targetFromRoute === selectedTarget.id) return;
    updateParams({ target: selectedTarget.id }, { replace: true });
  }, [selectedTarget, targetFromRoute, updateParams]);

  const handlePick = (item) => { updateParams({ image: item.filename }); setPickerOpen(false); };

  // One poll tick against the in-flight record. Let a transient GET *throw* so
  // useAutoRefetch logs and retries next tick — a multi-minute render must not be
  // abandoned on a single network blip; a genuine render failure comes back as a
  // `failed` record, handled below. Reaching a terminal state clears `generating`,
  // which flips the hook's `enabled` off and stops the interval.
  const pollTick = useCallback(async () => {
    if (!modelId) return;
    const model = await getImageTo3dModel(modelId, { silent: true });
    if (!mountedRef.current) return;
    const latest = Array.isArray(model.runs) && model.runs.length ? model.runs[model.runs.length - 1] : null;
    if (Number.isFinite(latest?.percent)) setGenPercent(latest.percent);
    // Patch the just-polled record into the library in place — we already hold
    // the fresh row, so re-fetching the whole list would be wasted I/O (the
    // repo's reactive-update convention).
    if (model.status === 'ready' && model.assetPath) {
      setGenPercent(100); updateParams({ glb: model.assetPath }); setGenerating(false); patchRecord(model);
    } else if (model.status === 'failed' || model.status === 'canceled') {
      // model.error carries the runner's actionable message (e.g. the HF-auth guidance).
      setGenError(model.error || 'The render did not finish.'); setGenerating(false); patchRecord(model);
    }
    // else still draft/generating → the hook re-polls after POLL_INTERVAL_MS.
  }, [modelId, updateParams, mountedRef, patchRecord]);

  useAutoRefetch(pollTick, POLL_INTERVAL_MS, { pollOnly: true, enabled: generating && !!modelId });

  const handleGenerate = useCallback(async () => {
    if (!selectedImage || !selectedTarget) return;
    setGenError(null); setGenPercent(0); setModelId(null);
    updateParams({ glb: '' }); // clear any previously-previewed mesh
    const created = await createImageTo3dModel(
      { name: nameFromImageFilename(selectedImage.filename), filename: selectedImage.filename, target: selectedTarget.id },
      { silent: true },
    ).catch((err) => {
      if (mountedRef.current) setGenError(err?.message || 'Could not start the render.');
      return null;
    });
    if (created && mountedRef.current) { setModelId(created.id); setGenerating(true); patchRecord(created); }
  }, [selectedImage, selectedTarget, updateParams, mountedRef, patchRecord]);

  // Why the Generate action is blocked, or null when it's ready to run. The runner
  // (POST create → on-device render → landed .glb) is wired, so the terminal state
  // is "ready", not a placeholder.
  const generateGatedReason = (() => {
    if (!selectedImage) return 'Pick a source image to continue.';
    if (!selectedTarget) return 'No image-to-3D model is registered.';
    if (!selectedTarget.available) return REASON_LABEL[selectedTarget.unavailableReason] || 'This model can’t run on this host.';
    if (selectedTarget.installed === false) return `Install ${selectedTarget.label} below before generating.`;
    return null;
  })();

  const gatedHfModels = selectedTarget?.available ? selectedTarget.gatedRepos : null;
  const gatedRepoCount = installTarget?.gatedRepos?.length || 0;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-port-accent" />
          <h1 className="text-lg font-semibold text-white">3D</h1>
        </div>
        <p className="mt-1 text-sm text-gray-400">
          Turn a rendered image into a 3D mesh. Pick a source image and model here, then install
          and manage the image-to-3D runtimes below.
        </p>
      </header>

      {/* Generation workspace — source image + target selection → on-device render. */}
      <section className="mb-6 grid gap-4 rounded-xl border border-port-border bg-port-card p-4 sm:grid-cols-[200px_1fr]">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="group relative aspect-square overflow-hidden rounded-lg border border-dashed border-port-border bg-port-bg hover:border-port-accent"
        >
          {selectedImage ? (
            <MediaImage
              src={selectedImage.previewUrl}
              alt="Selected source image"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full flex-col items-center justify-center gap-2 text-sm text-gray-500 group-hover:text-port-accent">
              <ImagePlus className="h-7 w-7" /> Pick source image
            </span>
          )}
          {selectedImage && (
            <span className="absolute inset-x-2 bottom-2 rounded bg-black/90 px-2 py-1 text-center text-xs font-medium text-white">
              Change image
            </span>
          )}
        </button>

        <div className="flex flex-col gap-3">
          <div>
            <span className="mb-1 block text-xs text-gray-400">Model</span>
            {loading ? (
              <span className="text-xs text-gray-500">Loading models…</span>
            ) : targets.length === 0 ? (
              <span className="text-xs text-gray-500">No image-to-3D models registered.</span>
            ) : (
              <div className="flex flex-wrap gap-2">
                {targets.map((t) => {
                  const active = selectedTarget?.id === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => updateParams({ target: t.id })}
                      className={`rounded-lg border px-3 py-1.5 text-xs ${active
                        ? 'border-port-accent bg-port-accent/10 text-white'
                        : 'border-port-border bg-port-bg text-gray-300 hover:border-port-accent'}`}
                    >
                      {t.label}
                      {isTargetReady(t) && <CheckCircle2 className="ml-1.5 inline h-3 w-3 text-port-success" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {gatedHfModels?.length > 0 && (
            <HfAccessNotice
              models={gatedHfModels}
              tokenPresent={hfTokenPresent}
              tokenSource={hfTokenSource}
              onSaved={refreshHfToken}
            />
          )}

          <div className="mt-auto flex flex-col items-start gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!!generateGatedReason || generating}
              title={generateGatedReason || undefined}
              className="inline-flex items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {generating
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating{Number.isFinite(genPercent) ? ` ${Math.round(genPercent)}%` : '…'}</>
                : <><Sparkles className="h-4 w-4" /> Generate 3D</>}
            </button>
            {genError ? (
              <p className="flex items-start gap-1.5 text-xs text-port-error">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {genError}
              </p>
            ) : (
              <p className="text-xs text-gray-500">
                {generating ? 'Rendering on-device — this takes a few minutes.' : (generateGatedReason || 'Ready to render on-device.')}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Generated-mesh preview. Driven by `?glb=` so a finished render is a
          shareable, reload-safe deep link; empty until one lands. */}
      {glbFromRoute && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Mesh preview</h2>
          <GlbViewer src={glbFromRoute} />
        </section>
      )}

      {/* Library of existing renders — each opens its `/3d/:id` detail
          view (GLB viewer + download). URL is the source of truth for what's
          open, so every card is a deep link. */}
      {records.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Your 3D models</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {records.map((record) => {
              const status = imageTo3dStatusMeta(record.status);
              return (
                <Link
                  key={record.id}
                  to={`/3d/${record.id}`}
                  className="group overflow-hidden rounded-lg border border-port-border bg-port-card hover:border-port-accent"
                >
                  <div className="relative aspect-square bg-port-bg">
                    {record.sourceImage?.path && (
                      <MediaImage
                        src={record.sourceImage.path}
                        alt={record.name || 'Source image'}
                        className="h-full w-full object-cover opacity-90 group-hover:opacity-100"
                      />
                    )}
                    {record.status === 'ready' && (
                      <span className="absolute right-1.5 top-1.5 rounded bg-black/80 p-1 text-port-success">
                        <Boxes className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </div>
                  <div className="p-2">
                    <p className="truncate text-xs font-medium text-white" title={record.name}>{record.name || 'Untitled'}</p>
                    <div className="mt-0.5 flex items-center justify-between gap-1">
                      <span className={`text-[11px] ${status.className}`}>{status.label}</span>
                      <span className="text-[11px] text-gray-500">{timeAgo(record.updatedAt)}</span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Models &amp; runtimes</h2>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading models…
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center justify-between rounded-lg border border-port-error/40 bg-port-error/10 p-4 text-sm text-port-error">
          <span>{error}</span>
          <button onClick={load} className="rounded-md border border-port-error/50 px-3 py-1 text-xs hover:bg-port-error/20">
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-3">
          {targets.length === 0 && (
            <p className="text-sm text-gray-500">No image-to-3D models are registered.</p>
          )}
          {targets.map((target) => (
            <TargetCard key={target.id} target={target} onInstall={setInstallTarget} />
          ))}
        </div>
      )}

      {/* Searchable render-history picker (reused from Image Gen). Selecting an
          image drives `?image=` so the choice is deep-linkable. */}
      <GalleryImagePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={handlePick} allowUpload />

      {/* TRELLIS.2 (and any future local-install target) streams its clone +
          setup.sh install through the shared runtime-install modal. */}
      <RuntimeInstallModal
        open={!!installTarget}
        runtime={installTarget?.id}
        label={installTarget?.label}
        installUrlBase={installTarget ? `/api/image-to-3d/targets/${installTarget.id}/install` : undefined}
        // Repairing an already-installed target must re-run setup.sh rather than
        // short-circuit on "already installed" — that re-run is what rebuilds the
        // Metal texture-baking backends once the Metal Toolchain is present (#2952).
        params={installTarget?.textureBake?.quality === 'fallback' ? { repair: '1' } : undefined}
        description={installTarget?.textureBake?.quality === 'fallback'
          ? 'Downloading the Xcode Metal Toolchain if it\'s missing, then re-running the TRELLIS.2 setup to rebuild its Metal texture-baking backends. Your already-downloaded models are kept, and no password is required.'
          : `Cloning the TRELLIS.2 (Apple Silicon) port and installing its Python environment (~15 GB on first run). If the Xcode Metal Toolchain is missing it is downloaded first, so textures bake at full quality.${gatedRepoCount ? ` It also pulls ${gatedRepoCount} gated Hugging Face ${gatedRepoCount === 1 ? 'model' : 'models'} on first render — accept their terms and add a Hugging Face token above (see the note on the 3D page).` : ''}`}
        onClose={() => setInstallTarget(null)}
        onComplete={() => { setInstallTarget(null); load(); }}
      />
    </div>
  );
}
