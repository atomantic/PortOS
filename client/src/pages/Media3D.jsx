import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Boxes, CheckCircle2, AlertTriangle, Loader2, ImagePlus, Sparkles, Settings2 } from 'lucide-react';
import { createImageTo3dModel, getImageTo3dModel, listImageTo3dModels } from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { useImageTo3dTargets } from '../hooks/useImageTo3dTargets';
import useMounted from '../hooks/useMounted';
import { nameFromImageFilename, timeAgo } from '../utils/formatters';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import GlbViewer from '../components/media/GlbViewer';
import Image3dHfAccessNotice from '../components/media/Image3dHfAccessNotice';
import { useHfTokenStatus } from '../hooks/useHfTokenStatus';
import useUrlParams from '../hooks/useUrlParams';
import MediaImage from '../components/MediaImage';
import { imageTo3dStatusMeta } from '../components/media/imageTo3dStatus';
import ImageTo3dRenderOptions from '../components/media/ImageTo3dRenderOptions';
import { renderOptionsBody, SUBJECT_SCALE_DEFAULT } from '../lib/imageTo3dRenderOptions';
import { isTargetReady, unavailableReasonLabel } from '../lib/imageTo3dReasons';

// Poll cadence while a render is in flight (a real TRELLIS.2 render is multi-minute).
const POLL_INTERVAL_MS = 2500;

export default function Media3D() {
  const [searchParams, updateParams] = useUrlParams();
  // URL is the source of truth for what's open: the source image, the chosen
  // target, and (once the runner lands #2952) the generated mesh to preview.
  const imageFromRoute = searchParams.get('image') || '';
  const targetFromRoute = searchParams.get('target') || '';
  const glbFromRoute = searchParams.get('glb') || '';

  const { targets, loading, error, reload: reloadTargets } = useImageTo3dTargets();
  const [pickerOpen, setPickerOpen] = useState(false);
  // Render lifecycle: a create kicks off an on-device render, then we poll the
  // record (via useAutoRefetch below) until it lands (ready → preview) or fails
  // (error → surfaced inline, where the runner's actionable HF-auth message shows).
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const [genPercent, setGenPercent] = useState(null);
  const [modelId, setModelId] = useState(null);
  // Per-run sampler knobs (see ImageTo3dRenderOptions for the value conventions).
  const [steps, setSteps] = useState('');
  const [seed, setSeed] = useState('');
  const [keyBackground, setKeyBackground] = useState(false);
  const [detail, setDetail] = useState('auto');
  const [alphaMode, setAlphaMode] = useState('');
  const [normalMap, setNormalMap] = useState(false);
  const [subjectScale, setSubjectScale] = useState(SUBJECT_SCALE_DEFAULT);
  // Existing image-to-3D records (newest-first) so the page doubles as a library:
  // each links to its `/3d/:id` detail view.
  const [records, setRecords] = useState([]);
  // Central HF-token status (stored / env / cli) for the gated-model notice. `present`
  // is tri-state — see useHfTokenStatus; `null` means unknown, not absent.
  const { present: hfTokenPresent, source: hfTokenSource, refresh: refreshHfToken } = useHfTokenStatus();
  const mountedRef = useMounted(); // gate setState after the create/poll awaits

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
      {
        name: nameFromImageFilename(selectedImage.filename),
        filename: selectedImage.filename,
        target: selectedTarget.id,
        ...renderOptionsBody({
          steps, seed, keyBackground, detail, alphaMode, normalMap, subjectScale,
        }),
      },
      { silent: true },
    ).catch((err) => {
      if (mountedRef.current) setGenError(err?.message || 'Could not start the render.');
      return null;
    });
    if (created && mountedRef.current) { setModelId(created.id); setGenerating(true); patchRecord(created); }
  }, [selectedImage, selectedTarget, steps, seed, keyBackground, detail, alphaMode, normalMap,
    subjectScale, updateParams, mountedRef, patchRecord]);

  // Why the Generate action is blocked, or null when it's ready to run. The runner
  // (POST create → on-device render → landed .glb) is wired, so the terminal state
  // is "ready", not a placeholder.
  const generateGatedReason = (() => {
    if (!selectedImage) return 'Pick a source image to continue.';
    if (!selectedTarget) return 'No image-to-3D model is registered.';
    if (!selectedTarget.available) return unavailableReasonLabel(selectedTarget.unavailableReason, 'This model can’t run on this host.');
    if (selectedTarget.installed === false) return `Install ${selectedTarget.label} from Models → 3D before generating.`;
    return null;
  })();

  // One sentence describing runtime availability. A failed registry read reports
  // the error rather than "0 registered" — a list that could not be READ is not an
  // empty list, and the remedy differs.
  const runtimeSummary = (() => {
    if (loading) return 'Checking which image-to-3D runtimes are installed…';
    if (error) return error;
    if (!targets.length) return 'No image-to-3D models are registered.';
    return `${targets.filter(isTargetReady).length} of ${targets.length} ready on this host.`;
  })();

  const gatedHfModels = selectedTarget?.available ? selectedTarget.gatedRepos : null;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-port-accent" />
          <h1 className="text-lg font-semibold text-white">3D</h1>
        </div>
        <p className="mt-1 text-sm text-gray-400">
          Turn a rendered image into a 3D mesh. Pick a source image and model, then render on-device.
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
            <span className="port-media-overlay-strong absolute inset-x-2 bottom-2 rounded px-2 py-1 text-center text-xs font-medium">
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
            <Image3dHfAccessNotice
              models={gatedHfModels}
              tokenPresent={hfTokenPresent}
              tokenSource={hfTokenSource}
              onSaved={refreshHfToken}
            />
          )}

          <ImageTo3dRenderOptions
            stepsSupported={selectedTarget?.supportsRenderOptions?.steps !== false}
            detailSupported={selectedTarget?.supportsRenderOptions?.detail !== false}
            alphaModeSupported={selectedTarget?.supportsRenderOptions?.alphaMode !== false}
            detail={detail}
            onDetailChange={setDetail}
            alphaMode={alphaMode}
            onAlphaModeChange={setAlphaMode}
            normalMapSupported={selectedTarget?.supportsRenderOptions?.normalMap !== false}
            normalMap={normalMap}
            onNormalMapChange={setNormalMap}
            steps={steps}
            onStepsChange={setSteps}
            seed={seed}
            onSeedChange={setSeed}
            keyBackground={keyBackground}
            onKeyBackgroundChange={setKeyBackground}
            subjectScale={subjectScale}
            onSubjectScaleChange={setSubjectScale}
            sourcePreviewUrl={selectedImage?.previewUrl || null}
            disabled={generating}
          />

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
                      <span className="port-media-overlay-strong absolute right-1.5 top-1.5 rounded p-1 text-port-success">
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

      {/* Install/repair lives under Models → 3D — these are on-device runtimes, not
          renders — so the generate flow just names the state and links there (#4728). */}
      <section className="rounded-xl border border-port-border bg-port-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">Runtimes</h2>
            <p className={`mt-1 text-xs ${error ? 'text-port-error' : 'text-gray-400'}`}>{runtimeSummary}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* A failed registry read also gates Generate (no target resolves), so
                the recovery has to be reachable from here — not only by reloading
                the page. */}
            {error && !loading && (
              <button
                type="button"
                onClick={reloadTargets}
                className="rounded-md border border-port-error/50 px-3 py-1.5 text-xs text-port-error hover:bg-port-error/20"
              >
                Retry
              </button>
            )}
            <Link
              to="/models/3d"
              className="inline-flex items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs text-gray-300 hover:border-port-accent hover:text-white"
            >
              <Settings2 className="h-3.5 w-3.5" /> Manage runtimes
            </Link>
          </div>
        </div>
      </section>

      {/* Searchable render-history picker (reused from Image Gen). Selecting an
          image drives `?image=` so the choice is deep-linkable. */}
      <GalleryImagePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={handlePick} allowUpload />
    </div>
  );
}
