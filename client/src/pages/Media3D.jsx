import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, CheckCircle2, Download, AlertTriangle, Loader2, ExternalLink, ImagePlus, Sparkles, KeyRound } from 'lucide-react';
import { getImageTo3dTargets, createImageTo3dModel, getImageTo3dModel } from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import useMounted from '../hooks/useMounted';
import { nameFromImageFilename } from '../utils/formatters';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import GlbViewer from '../components/media/GlbViewer';
import MediaImage from '../components/MediaImage';

// Poll cadence while a render is in flight (a real TRELLIS.2 render is multi-minute).
const POLL_INTERVAL_MS = 2500;

// Targets that download gated Hugging Face models on first run. Keyed by target id
// so the page can warn about the (free, one-time) HF sign-in + terms acceptance
// BEFORE a render fails opaquely. TRELLIS.2 pulls DINOv3 (image conditioning) and
// RMBG-2.0 (background removal), both gated Meta/BRIA repos.
const HF_GATED_MODELS = {
  trellis2: [
    { label: 'facebook/dinov3-vitl16-pretrain-lvd1689m', url: 'https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m' },
    { label: 'briaai/RMBG-2.0', url: 'https://huggingface.co/briaai/RMBG-2.0' },
  ],
};

// Prerequisite notice for a target that needs gated Hugging Face access. Shown once
// the gated target is selectable so the user accepts terms + signs in up front.
function HfAccessNotice({ models }) {
  if (!models?.length) return null;
  return (
    <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 p-3 text-xs text-gray-300">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-port-warning">
        <KeyRound className="h-3.5 w-3.5" /> Needs a free Hugging Face account
      </div>
      <p className="text-gray-400">
        On first render this downloads two <strong>gated</strong> models. Accept their terms (signed in to Hugging Face), then
        authenticate the machine with <code className="rounded bg-port-bg px-1">huggingface-cli login</code> or an{' '}
        <code className="rounded bg-port-bg px-1">HF_TOKEN</code>:
      </p>
      <ul className="mt-1.5 space-y-1">
        {models.map((m) => (
          <li key={m.url}>
            <a href={m.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-port-accent hover:underline">
              <ExternalLink className="h-3 w-3" /> {m.label}
            </a>
          </li>
        ))}
      </ul>
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
          {canInstall && (
            <button
              onClick={() => onInstall(target)}
              className="inline-flex items-center gap-1.5 rounded-md bg-port-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
            >
              <Download className="w-3.5 h-3.5" /> Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Media3D() {
  const [searchParams, setSearchParams] = useSearchParams();
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
  const mountedRef = useMounted(); // gate setState after the create/poll awaits

  const load = useCallback(() => {
    setLoading(true);
    getImageTo3dTargets()
      .then((data) => { setTargets(data?.targets || []); setError(null); })
      .catch((err) => setError(err?.message || 'Failed to load 3D targets'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

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

  // Keep the URL honest: if a bare `/media/3d` resolved a default target, reflect
  // it so the selection is shareable/reload-safe (URL as source of truth). The
  // functional updater reads the freshest params, so this effect depends only on
  // the resolved target — not on every unrelated `?image=`/`?glb=` change.
  useEffect(() => {
    if (!selectedTarget || targetFromRoute === selectedTarget.id) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('target', selectedTarget.id);
      return next;
    }, { replace: true });
  }, [selectedTarget, targetFromRoute, setSearchParams]);

  const setParam = useCallback((key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    });
  }, [setSearchParams]);

  const handlePick = (item) => { setParam('image', item.filename); setPickerOpen(false); };

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
    if (model.status === 'ready' && model.assetPath) {
      setGenPercent(100); setParam('glb', model.assetPath); setGenerating(false);
    } else if (model.status === 'failed' || model.status === 'canceled') {
      // model.error carries the runner's actionable message (e.g. the HF-auth guidance).
      setGenError(model.error || 'The render did not finish.'); setGenerating(false);
    }
    // else still draft/generating → the hook re-polls after POLL_INTERVAL_MS.
  }, [modelId, setParam, mountedRef]);

  useAutoRefetch(pollTick, POLL_INTERVAL_MS, { pollOnly: true, enabled: generating && !!modelId });

  const handleGenerate = useCallback(async () => {
    if (!selectedImage || !selectedTarget) return;
    setGenError(null); setGenPercent(0); setModelId(null);
    setParam('glb', ''); // clear any previously-previewed mesh
    const created = await createImageTo3dModel(
      { name: nameFromImageFilename(selectedImage.filename), filename: selectedImage.filename, target: selectedTarget.id },
      { silent: true },
    ).catch((err) => {
      if (mountedRef.current) setGenError(err?.message || 'Could not start the render.');
      return null;
    });
    if (created && mountedRef.current) { setModelId(created.id); setGenerating(true); }
  }, [selectedImage, selectedTarget, setParam, mountedRef]);

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

  const gatedHfModels = selectedTarget?.available ? HF_GATED_MODELS[selectedTarget?.id] : null;

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
            <span className="absolute inset-x-2 bottom-2 rounded bg-black/70 px-2 py-1 text-center text-xs text-white">
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
                      onClick={() => setParam('target', t.id)}
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

          {gatedHfModels && <HfAccessNotice models={gatedHfModels} />}

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
      <GalleryImagePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={handlePick} />

      {/* TRELLIS.2 (and any future local-install target) streams its clone +
          setup.sh install through the shared runtime-install modal. */}
      <RuntimeInstallModal
        open={!!installTarget}
        runtime={installTarget?.id}
        label={installTarget?.label}
        installUrlBase="/api/image-to-3d/trellis2/install"
        description="Cloning the TRELLIS.2 (Apple Silicon) port and installing its Python environment (~15 GB on first run). It also pulls two gated Hugging Face models on first render — accept their terms and sign in with huggingface-cli login / HF_TOKEN (see the note on the 3D page)."
        onClose={() => setInstallTarget(null)}
        onComplete={() => { setInstallTarget(null); load(); }}
      />
    </div>
  );
}
