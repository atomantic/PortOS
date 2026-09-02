import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Boxes, AlertTriangle, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { getImageTo3dModel, generateImageTo3dModel, deleteImageTo3dModel, imageTo3dAssetUrl, imageTo3dFullMeshUrl } from '../services/api';
import useMounted from '../hooks/useMounted';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { timeAgo } from '../utils/formatters';
import GlbViewer from '../components/media/GlbViewer';
import MediaImage from '../components/MediaImage';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import ImageTo3dRenderOptions from '../components/media/ImageTo3dRenderOptions';
import { fieldsFromRun, renderOptionsBody, runWantsTransparency } from '../lib/imageTo3dRenderOptions';
import { imageTo3dStatusMeta } from '../components/media/imageTo3dStatus';
import toast from '../components/ui/Toast';
import PageSkeleton from '../components/ui/PageSkeleton';

// Poll cadence while a render is in flight (a real TRELLIS.2 render is multi-minute).
const POLL_INTERVAL_MS = 2500;

// Per-record detail view for an image-to-3D model (`/3d/:id`). The record
// id is the URL, so a finished mesh is a shareable, reload-safe deep link. Mounts
// the reusable GlbViewer once the render lands (status `ready` + `assetPath`),
// with a Download .glb, and offers re-render / delete. Polls while generating.
export default function Media3DDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const mountedRef = useMounted();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Per-run knobs, seeded from the latest run once per id (NOT on every poll
  // tick — that would clobber in-progress edits). Seed stays blank by design:
  // see fieldsFromRun.
  const [steps, setSteps] = useState('');
  const [seed, setSeed] = useState('');
  const [keyBackground, setKeyBackground] = useState(false);
  const [detail, setDetail] = useState('auto');
  const [alphaMode, setAlphaMode] = useState('');
  const [normalMap, setNormalMap] = useState(false);
  const optionsSeededFor = useRef(null);

  const load = useCallback(async ({ initial = false } = {}) => {
    const next = await getImageTo3dModel(id, { silent: true }).catch((err) => {
      if (err?.status === 404) { if (mountedRef.current) setNotFound(true); }
      else if (initial) toast.error(err?.message || 'Failed to load 3D model');
      return null;
    });
    if (next && mountedRef.current) { setRecord(next); setNotFound(false); }
    if (initial && mountedRef.current) setLoading(false);
    return next;
  }, [id, mountedRef]);

  // Re-fetch from scratch whenever the routed id changes — reset loading/notFound
  // so switching between two `/3d/:id` records shows a spinner instead of
  // the previous record's content (and doesn't carry a stale not-found flag).
  useEffect(() => {
    setLoading(true); setNotFound(false);
    load({ initial: true });
  }, [load]);

  // Poll only while generating (the initial fetch above owns the first load, so
  // immediate:false); `load` owns its own state + error handling, so pollOnly.
  // Gate off notFound too: if the record is deleted out from under a live poll
  // (another tab / peer), stop polling instead of 404-ing every tick.
  useAutoRefetch(load, POLL_INTERVAL_MS, {
    pollOnly: true,
    immediate: false,
    enabled: !notFound && record?.status === 'generating',
  });

  // Seed the option fields from the latest run once per id.
  useEffect(() => {
    if (!record || optionsSeededFor.current === record.id) return;
    optionsSeededFor.current = record.id;
    const fields = fieldsFromRun(record.runs?.at?.(-1));
    setSteps(fields.steps);
    setSeed(fields.seed);
    setKeyBackground(fields.keyBackground);
    setDetail(fields.detail);
    setAlphaMode(fields.alphaMode);
    setNormalMap(fields.normalMap);
  }, [record]);

  const handleRegenerate = useCallback(async () => {
    if (busy || record?.status === 'generating') return;
    setBusy(true);
    const next = await generateImageTo3dModel(
      id,
      renderOptionsBody({ steps, seed, keyBackground, detail, alphaMode, normalMap }),
      { silent: true },
    ).catch((err) => {
      toast.error(err?.message || 'Could not start the render.');
      return null;
    });
    if (mountedRef.current) setBusy(false);
    if (next && mountedRef.current) setRecord(next);
  }, [busy, record?.status, id, steps, seed, keyBackground, detail, alphaMode, normalMap, mountedRef]);

  const handleDelete = useCallback(async () => {
    const ok = await deleteImageTo3dModel(id, { silent: true }).then(() => true).catch((err) => {
      toast.error(err?.message || 'Delete failed');
      return false;
    });
    if (ok) navigate('/3d');
  }, [id, navigate]);

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageSkeleton
          label="Loading 3D model"
          headerRowClass="flex flex-wrap items-center justify-between gap-3"
          titleWidthClass="w-56"
          cards={2}
          sidebar={false}
        />
      </div>
    );
  }

  if (notFound || !record) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center">
        <p className="text-sm text-gray-400">This 3D model no longer exists.</p>
        <Link to="/3d" className="mt-3 inline-flex items-center gap-1.5 text-sm text-port-accent hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to 3D
        </Link>
      </div>
    );
  }

  const isGenerating = record.status === 'generating';
  const latestRun = Array.isArray(record.runs) && record.runs.length ? record.runs[record.runs.length - 1] : null;
  const percent = Number.isFinite(latestRun?.percent) ? Math.round(latestRun.percent) : null;
  // Re-renders overwrite the same model.glb path. Key the fetch to the completed
  // generation so drei's URL cache loads the new bytes when this record is rendered
  // again, while old records without generatedAt retain their historical URL.
  // Read from the last run rather than the live form: the form is what the NEXT
  // render will use, while the mesh on screen came from the last one.
  const renderedTransparent = runWantsTransparency(record?.runs?.at?.(-1));
  const meshSrc = record.generatedAt
    ? `${record.assetPath}?v=${encodeURIComponent(record.generatedAt)}`
    : record.assetPath;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-4">
        <Link to="/3d" className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to 3D
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Boxes className="h-5 w-5 text-port-accent" />
            <h1 className="text-lg font-semibold text-white">{record.name || 'Untitled 3D model'}</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={busy || isGenerating}
              className="inline-flex items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs text-gray-300 hover:border-port-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> {record.status === 'ready' ? 'Re-render' : 'Retry'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-port-error/40 px-3 py-1.5 text-xs text-port-error hover:bg-port-error/10"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {imageTo3dStatusMeta(record.status).label}
          {isGenerating && percent !== null ? ` · ${percent}%` : ''}
          {Number.isInteger(latestRun?.seed) ? ` · seed ${latestRun.seed}` : ''}
          {Number.isInteger(latestRun?.steps) ? ` · ${latestRun.steps} steps` : ''}
          {latestRun?.sourceKeyed ? ' · background keyed' : ''}
          {' '}· updated {timeAgo(record.updatedAt)}
        </p>
      </header>

      <div className="mb-4 rounded-lg border border-port-border bg-port-card p-3">
        <ImageTo3dRenderOptions
          stepsSupported={record.supportsRenderOptions?.steps !== false}
          detailSupported={record.supportsRenderOptions?.detail !== false}
          alphaModeSupported={record.supportsRenderOptions?.alphaMode !== false}
          steps={steps}
          onStepsChange={setSteps}
          seed={seed}
          onSeedChange={setSeed}
          keyBackground={keyBackground}
          onKeyBackgroundChange={setKeyBackground}
          detail={detail}
          onDetailChange={setDetail}
          alphaMode={alphaMode}
          onAlphaModeChange={setAlphaMode}
          normalMapSupported={record.supportsRenderOptions?.normalMap !== false}
          normalMap={normalMap}
          onNormalMapChange={setNormalMap}
          disabled={busy || isGenerating}
        />
      </div>

      {confirmingDelete && (
        <InlineConfirmRow
          className="mb-4"
          question={`Delete "${record.name || 'this model'}"?`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {record.status === 'failed' && record.error && (
        <div className="mb-4 flex items-start gap-1.5 rounded-lg border border-port-error/30 bg-port-error/10 px-3 py-2 text-sm text-port-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {record.error}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-[200px_1fr]">
        <div>
          <span className="mb-1 block text-xs text-gray-400">Source image</span>
          <div className="aspect-square overflow-hidden rounded-lg border border-port-border bg-port-bg">
            {record.sourceImage?.path && (
              <MediaImage src={record.sourceImage.path} alt="Source image" className="h-full w-full object-cover" />
            )}
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs text-gray-400">Mesh</span>
          {record.status === 'ready' && record.assetPath ? (
            <>
              {/* The viewer is the THIRD layer that can flatten alpha, after the
                  exporter's own alpha_mode and PortOS's GLB rewrite. It has to agree
                  with the run's request, or a mesh exported as BLEND still renders
                  solid here and reads as a broken exporter. */}
              <GlbViewer
                src={meshSrc}
                downloadHref={imageTo3dAssetUrl(record.id)}
                forceOpaque={!renderedTransparent}
              />
              {/* The viewer loads the decimated GLB because that is what a browser
                  can render; the decoder's full mesh is an order of magnitude
                  larger. Offer it, but say what it actually is so nobody downloads
                  several hundred MB expecting a textured model. */}
              <a
                href={imageTo3dFullMeshUrl(record.id)}
                className="mt-2 inline-block text-xs text-gray-400 underline decoration-dotted hover:text-gray-200"
              >
                Download full-resolution mesh (.obj — geometry only, no textures)
              </a>
            </>
          ) : (
            <div className="flex aspect-square items-center justify-center rounded-xl border border-dashed border-port-border bg-port-bg text-center text-sm text-gray-500">
              {isGenerating ? (
                <span className="inline-flex items-center gap-2 text-port-accent">
                  <Loader2 className="h-4 w-4 animate-spin" /> Rendering{percent !== null ? ` ${percent}%` : '…'}
                </span>
              ) : (
                'No mesh yet — run a render to generate one.'
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
