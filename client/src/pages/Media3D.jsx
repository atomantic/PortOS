import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, CheckCircle2, Download, AlertTriangle, Loader2, ExternalLink, ImagePlus, Sparkles } from 'lucide-react';
import { getImageTo3dTargets } from '../services/api';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import GlbViewer from '../components/media/GlbViewer';
import MediaImage from '../components/MediaImage';

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
  // it so the selection is shareable/reload-safe (URL as source of truth).
  useEffect(() => {
    if (!selectedTarget || targetFromRoute === selectedTarget.id) return;
    const next = new URLSearchParams(searchParams);
    next.set('target', selectedTarget.id);
    setSearchParams(next, { replace: true });
  }, [selectedTarget, targetFromRoute, searchParams, setSearchParams]);

  const setParam = useCallback((key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const handlePick = (item) => { setParam('image', item.filename); setPickerOpen(false); };

  const ready = isTargetReady(selectedTarget);
  // The image→mesh runner (POST generate + landed .glb) lands with #2952; until
  // then the workspace lets the user stage the source image + target and preview
  // any produced mesh, but the Generate action stays gated rather than pretending.
  const generateGatedReason = !selectedImage
    ? 'Pick a source image to continue.'
    : !selectedTarget
      ? 'No image-to-3D model is registered.'
      : !selectedTarget.available
        ? (REASON_LABEL[selectedTarget.unavailableReason] || 'This model can’t run on this host.')
        : selectedTarget.installed === false
          ? `Install ${selectedTarget.label} below before generating.`
          : 'Generation lands with the on-device runner — coming next.';

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

      {/* Generation workspace — source image + target selection + preview. The
          create/generate call is wired when the runner (#2952) lands. */}
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

          <div className="mt-auto flex flex-col items-start gap-2">
            <button
              type="button"
              disabled={!ready || !selectedImage}
              title={generateGatedReason}
              className="inline-flex items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles className="h-4 w-4" /> Generate 3D
            </button>
            <p className="text-xs text-gray-500">{generateGatedReason}</p>
          </div>
        </div>
      </section>

      {/* Generated-mesh preview. Driven by `?glb=` so a finished render (#2952)
          is a shareable, reload-safe deep link; empty until one lands. */}
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
        description="Cloning the TRELLIS.2 (Apple Silicon) port and installing its Python environment. The model weights are a large download on first run (~15 GB)."
        onClose={() => setInstallTarget(null)}
        onComplete={() => { setInstallTarget(null); load(); }}
      />
    </div>
  );
}
