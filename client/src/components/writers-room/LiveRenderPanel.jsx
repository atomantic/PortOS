import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { generateImage } from '../../services/apiSystem';
import {
  attachWritersRoomSceneImage,
  reserveWritersRoomRenderPreview,
} from '../../services/apiWritersRoom';
import socket from '../../services/socket';
import useMounted from '../../hooks/useMounted';
import { WR_IMAGE_DEFAULTS, buildSceneRenderPayload } from '../../lib/wrImageDefaults';
import { sceneAtCursor } from '../../lib/wrSceneCursor';
import {
  buildScenePrompt,
  matchSceneCharacters,
  matchScenePlace,
} from '../../lib/scenePrompt';

// Phase 5 live render preview. While the work has live mode opted in, the
// writer can trigger a quick reference render for the scene their cursor sits
// in — reusing the existing image-gen route (`generateImage`) and the shared
// image-gen socket queue (registered via `registerQueue` so the render dock
// labels + tracks it exactly like a storyboard render). A DISTINCT per-work
// daily render budget (separate from the text-suggest budget) is enforced
// server-side: we reserve a slot first, and only kick the render off if the
// reservation succeeds. On completion the image is persisted onto the script
// analysis via the same `scene-image` attach path the storyboard uses.
//
// Like LiveContinuationPanel this is a presentation + fetch shell: WorkEditor
// owns the textarea/cursor and the scene/analysis context, and feeds them in.
export default function LiveRenderPanel({
  workId,
  liveMode,
  getCursorOffset,
  body,
  renderContext,
  registerQueue,
  onSceneImageAttached,
  workTitle,
}) {
  const [reserving, setReserving] = useState(false);
  const [notice, setNotice] = useState(null);
  // Local render-usage so a fresh reservation updates the "N left today"
  // readout immediately; re-synced from the prop on a parent-driven change
  // (budget edit, work swap) so it isn't shadowed.
  const [renderUsage, setRenderUsage] = useState(liveMode?.renderUsage || null);
  useEffect(() => { setRenderUsage(liveMode?.renderUsage || null); }, [liveMode?.renderUsage]);
  const mountedRef = useMounted();

  // Track the live job so late socket events for a superseded/cancelled render
  // are ignored, mirroring SceneCard. `sceneIdRef` remembers which scene the
  // in-flight job renders so onCompleted can attach without re-resolving the
  // (possibly moved) cursor.
  const jobIdRef = useRef(null);
  const sceneIdRef = useRef(null);
  const [genStatus, setGenStatus] = useState('idle');

  // Read the attach callback through a ref so the socket effect (and the
  // shared persist helper) stay identity-stable as the parent re-renders.
  const onAttachedRef = useRef(onSceneImageAttached);
  useEffect(() => { onAttachedRef.current = onSceneImageAttached; }, [onSceneImageAttached]);

  // Stabilize the derived context so it doesn't re-create the render callback's
  // deps on every parent render (renderContext is a fresh object each time).
  const ctx = useMemo(() => renderContext || {}, [renderContext]);
  const analysisId = ctx.analysisId || null;
  const scenes = useMemo(() => (Array.isArray(ctx.scenes) ? ctx.scenes : []), [ctx.scenes]);
  const imageCfg = ctx.imageCfg || WR_IMAGE_DEFAULTS;
  // The async render can finish (socket completion / fast sync result) after the
  // user has moved the cursor and the context has changed, so read the analysis
  // id the job was reserved against through a ref rather than the live value.
  const analysisIdRef = useRef(analysisId);
  useEffect(() => { analysisIdRef.current = analysisId; }, [analysisId]);

  // Persist a finished render onto the script analysis (best-effort, mirroring
  // SceneCard) AND fold the returned sceneImages map up so the storyboard
  // updates reactively without a refetch. Shared by the socket-completion path
  // and the fast synchronous-completion path. { silent: true } because we own
  // the error UI here (a console.warn) — without it the helper would also toast.
  const persistAttach = useCallback((sceneId, jobId, prompt) => {
    const aid = analysisIdRef.current;
    if (!workId || !aid || !jobId || !sceneId) return;
    attachWritersRoomSceneImage(workId, aid, {
      sceneId,
      filename: `${jobId}.png`,
      jobId,
      prompt: prompt || null,
    }, { silent: true }).then((res) => {
      if (mountedRef.current && res?.analysis) onAttachedRef.current?.(res.analysis);
    }).catch((err) => {
      console.warn(`live render persist failed: ${err.message}`);
    });
  }, [workId, mountedRef]);

  // Resolve the scene under the caret so the button can name its target (and
  // disable when there's nothing to render). Recomputed cheaply on each render;
  // the caret read happens lazily inside the click handler so this is just for
  // the label/enabled state on the latest known offset.
  const [cursorOffset, setCursorOffset] = useState(null);
  const target = sceneAtCursor(scenes, body, cursorOffset);

  useEffect(() => {
    const onCompleted = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      const completedJobId = jobIdRef.current;
      const sceneId = sceneIdRef.current;
      jobIdRef.current = null;
      sceneIdRef.current = null;
      if (mountedRef.current) setGenStatus('idle');
      persistAttach(sceneId, completedJobId, data.prompt);
    };
    const onFailed = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      jobIdRef.current = null;
      sceneIdRef.current = null;
      if (mountedRef.current) setGenStatus('idle');
    };
    socket.on('image-gen:completed', onCompleted);
    socket.on('image-gen:failed', onFailed);
    return () => {
      socket.off('image-gen:completed', onCompleted);
      socket.off('image-gen:failed', onFailed);
    };
    // sceneId comes from sceneIdRef (set when we kicked the job off); the
    // persist target inputs are read through refs inside persistAttach.
  }, [persistAttach, mountedRef]);

  const renderCursorScene = useCallback(async () => {
    if (reserving || genStatus === 'running') return;
    const offset = getCursorOffset?.();
    setCursorOffset(offset ?? null);
    const hit = sceneAtCursor(scenes, body, offset);
    if (!hit) {
      setNotice('Place your cursor inside a script scene, then try again. (Run Adapt to script if you have no scenes yet.)');
      return;
    }
    const { scene } = hit;
    if (!scene.visualPrompt?.trim()) {
      setNotice('That scene has no visual prompt yet — re-run Adapt to script to refresh it.');
      return;
    }
    if (!analysisId) {
      setNotice('No script analysis to attach the render to yet — run Adapt to script first.');
      return;
    }

    setNotice(null);
    setReserving(true);
    // Reserve a render slot against the per-work daily render budget BEFORE
    // spending the GPU/provider. 409 → live mode off, 429 → budget spent; both
    // are expected control-flow shown inline, not red toasts.
    const reservation = await reserveWritersRoomRenderPreview(workId, { silent: true }).catch((err) => {
      if (mountedRef.current) {
        if (err?.status === 429) setNotice('Daily render budget reached — resets at UTC midnight.');
        else if (err?.status === 409) setNotice('Live mode is off for this work.');
        else toast.error(`Render reservation failed: ${err.message}`);
      }
      return null;
    });
    if (!mountedRef.current) return;
    setReserving(false);
    if (!reservation) return;
    if (reservation.renderUsage) setRenderUsage(reservation.renderUsage);

    const matchedCharacters = matchSceneCharacters(scene.characters, ctx.charByKey);
    const matchedPlace = matchScenePlace(scene.slugline, ctx.placeByKey);
    const prompt = buildScenePrompt(workTitle, scene, matchedCharacters, ctx.imageStyle?.prompt || '', matchedPlace);

    setGenStatus('running');
    const res = await generateImage(buildSceneRenderPayload({
      prompt,
      negativePrompt: ctx.imageStyle?.negativePrompt || '',
      imageCfg,
    }), { silent: true }).catch((err) => {
      if (mountedRef.current) {
        toast.error(`Render failed: ${err.message}`);
        setGenStatus('idle');
      }
      return null;
    });
    if (!mountedRef.current) return;
    if (!res) return;
    const jobId = res.jobId || res.generationId || null;
    if (!jobId) {
      setGenStatus('idle');
      return;
    }
    // A fast/synchronous backend (some external SD-API / Codex paths) can return
    // a finished result whose image-gen:completed socket event already fired
    // before we could set jobIdRef — so the socket handler ignored it and would
    // leave the button stuck on "Rendering…" with no attach. Detect the
    // already-done case from the HTTP result and finalize inline. Only register
    // into the render dock + wait on the socket for jobs that are still running.
    const alreadyDone = res.status && res.status !== 'queued' && res.status !== 'running';
    if (alreadyDone) {
      setGenStatus('idle');
      persistAttach(scene.id, jobId, prompt);
      return;
    }
    jobIdRef.current = jobId;
    sceneIdRef.current = scene.id;
    // Register into the shared render dock so the job shows alongside storyboard
    // renders.
    const num = hit.sceneNumber;
    const numLabel = Number.isFinite(num) ? `S${String(num).padStart(2, '0')}` : '';
    const sceneLabel = `${numLabel} ${scene.heading || ''}`.trim() || scene.heading || 'Scene';
    registerQueue?.({ jobId, sceneId: scene.id, sceneLabel: `Preview · ${sceneLabel}` });
    toast('Live preview rendering — see the render dock', { icon: '🎬' });
  }, [reserving, genStatus, getCursorOffset, scenes, body, analysisId, workId, workTitle, imageCfg, ctx, registerQueue, persistAttach, mountedRef]);

  if (!liveMode?.enabled) return null;

  const budget = liveMode?.dailyRenderBudget ?? 0;
  const spent = renderUsage?.count ?? 0;
  const remainingLabel = budget > 0 ? `${Math.max(0, budget - spent)} / ${budget} left today` : 'unlimited';
  const busy = reserving || genStatus === 'running';
  const targetLabel = target
    ? `S${String(target.sceneNumber).padStart(2, '0')} ${target.scene.heading || ''}`.trim()
    : null;

  return (
    <div className="px-3 py-2 border-b border-port-border">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-port-success">
          <ImagePlus size={12} /> Live Render
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500" title="Daily render-preview budget">{remainingLabel}</span>
          <button
            type="button"
            onClick={renderCursorScene}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-port-bg border border-port-border text-gray-300 hover:text-white disabled:opacity-50"
            title="Render a quick reference image for the scene at your cursor"
          >
            {busy ? <Loader2 size={10} className="animate-spin" /> : <ImagePlus size={10} />}
            {genStatus === 'running' ? 'Rendering…' : 'Render scene'}
          </button>
        </div>
      </div>
      {notice ? (
        <div className="mt-1.5 text-[10px] text-gray-400">{notice}</div>
      ) : (
        <div className="mt-1 text-[10px] text-gray-500 truncate" title={targetLabel || undefined}>
          {targetLabel ? `Cursor scene: ${targetLabel}` : 'Place your cursor in a scene to render it.'}
        </div>
      )}
    </div>
  );
}
