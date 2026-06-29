import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Sparkles,
  Users,
  FileSignature,
  Crosshair,
} from 'lucide-react';
import toast from '../ui/Toast';
import { generateImage } from '../../services/apiSystem';
import socket from '../../services/socket';
import useClickOutside from '../../hooks/useClickOutside';
import { WR_IMAGE_DEFAULTS, buildSceneRenderPayload } from '../../lib/wrImageDefaults';
import {
  buildScenePrompt,
  matchSceneCharacters,
  matchScenePlace,
  normCharKey,
} from '../../lib/scenePrompt';

const SceneCard = forwardRef(function SceneCard({
  scene,
  sceneNumber = null,
  workId,
  analysisId,
  workTitle,
  imageCfg = WR_IMAGE_DEFAULTS,
  imageStyle = null,
  initialImage = null,
  readingTheme = 'dark',
  charByKey = null,
  placeByKey = null,
  isActive = false,
  onJumpToProse = null,
  onDebug = null,
  hotRef = null,
  onHoverEnter = null,
  onHoverLeave = null,
  onRenderStart = null,
}, ref) {
  const light = readingTheme === 'light';
  const matchedCharacters = useMemo(
    () => matchSceneCharacters(scene.characters, charByKey),
    [scene.characters, charByKey]
  );
  const matchedPlace = useMemo(
    () => matchScenePlace(scene.slugline, placeByKey),
    [scene.slugline, placeByKey]
  );
  // Per-chip lookup map — name/alias keys → matched character profile. Built
  // once so the chip render is O(1) per chip instead of an O(chars × aliases)
  // .find()+.some() scan for every chip on every render. Big casts can have
  // dozens of aliases per character; the inner double-loop showed up in
  // perf traces.
  const chipProfileByKey = useMemo(() => {
    const map = new Map();
    for (const profile of matchedCharacters) {
      map.set(normCharKey(profile.name), profile);
      for (const alias of profile.aliases || []) map.set(normCharKey(alias), profile);
    }
    return map;
  }, [matchedCharacters]);
  const [genStatus, setGenStatus] = useState(initialImage ? 'done' : 'idle');
  const [generated, setGenerated] = useState(initialImage
    ? { path: `/data/images/${initialImage.filename}`, jobId: initialImage.jobId, prompt: initialImage.prompt }
    : null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [showDebugMenu, setShowDebugMenu] = useState(false);
  const jobIdRef = useRef(null);
  // The jobId a just-fired `onFailed` cleared, kept so a cancel that arrives
  // immediately after (a running render canceled from the queue emits
  // image-gen:failed THEN image-gen:canceled) can still reconcile to a clean
  // cancel instead of leaving the card stuck in the error state (#1791/#1796).
  const recentlyFailedRef = useRef(null);
  const debugMenuRef = useRef(null);

  // Sync local image state when parent reloads analyses (e.g. post-re-Adapt)
  // so a fresh image appears without forcing the user to re-click Generate.
  useEffect(() => {
    if (!initialImage) return;
    setGenerated({
      path: `/data/images/${initialImage.filename}`,
      jobId: initialImage.jobId,
      prompt: initialImage.prompt,
    });
    setGenStatus('done');
  }, [initialImage?.filename]);

  useClickOutside(debugMenuRef, showDebugMenu, () => setShowDebugMenu(false));

  useEffect(() => {
    const onStarted = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      setProgress((prev) => ({
        ...(prev || {}),
        progress: 0,
        step: 0,
        totalSteps: data.totalSteps ?? prev?.totalSteps ?? null,
        currentImage: null,
      }));
    };
    const onProgress = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      setProgress((prev) => ({
        ...(prev || {}),
        progress: data.progress ?? prev?.progress ?? 0,
        step: data.step ?? prev?.step ?? 0,
        totalSteps: data.totalSteps ?? prev?.totalSteps ?? null,
        eta: data.eta ?? prev?.eta ?? null,
        currentImage: data.currentImage ?? prev?.currentImage ?? null,
      }));
    };
    const onCompleted = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      // The optimistic preview already shows this render; the durable attach
      // onto the analysis snapshot is filed server-side by writersRoomSceneImageHook
      // off the same job's `writersRoom` tag (#1363), so no client round-trip here.
      setGenerated((prev) => prev ? { ...prev, path: data.path || prev.path } : prev);
      setGenStatus('done');
      setProgress(null);
      jobIdRef.current = null;
    };
    const onFailed = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      // Remember the job so a cancel arriving right after (running-cancel) can
      // override the error below; cleared on the next render start (see generate).
      recentlyFailedRef.current = data.generationId;
      setError(data.error || data.message || 'Generation failed');
      setGenStatus('error');
      setProgress(null);
      jobIdRef.current = null;
    };
    // A canceled render (dropped while queued, OR canceled while running — which
    // reaches us as image-gen:failed first, then this) is not an error: roll back
    // to idle / the prior image so the spinner clears and any error state shown by
    // a preceding onFailed is retracted, instead of sticking until remount
    // (#1791). The `*-gen:canceled` event is bridged from mediaJobEvents, keyed by
    // the same generationId as completed/failed.
    const onCanceled = (data) => {
      const isActive = jobIdRef.current && data.generationId === jobIdRef.current;
      const isJustFailed = data.generationId === recentlyFailedRef.current;
      if (!isActive && !isJustFailed) return;
      jobIdRef.current = null;
      recentlyFailedRef.current = null;
      setProgress(null);
      setError(null);
      setGenerated(initialImage
        ? { path: `/data/images/${initialImage.filename}`, jobId: initialImage.jobId, prompt: initialImage.prompt }
        : null);
      setGenStatus(initialImage ? 'done' : 'idle');
    };
    socket.on('image-gen:started', onStarted);
    socket.on('image-gen:progress', onProgress);
    socket.on('image-gen:completed', onCompleted);
    socket.on('image-gen:failed', onFailed);
    socket.on('image-gen:canceled', onCanceled);
    return () => {
      socket.off('image-gen:started', onStarted);
      socket.off('image-gen:progress', onProgress);
      socket.off('image-gen:completed', onCompleted);
      socket.off('image-gen:failed', onFailed);
      socket.off('image-gen:canceled', onCanceled);
    };
  }, [workId, analysisId, scene.id, initialImage]);

  const generate = async () => {
    if (genStatus === 'running') return;
    if (!scene.visualPrompt?.trim()) {
      toast('No visual prompt for this scene', { icon: '⚠️' });
      return;
    }
    setGenStatus('running');
    setError(null);
    setProgress(null);
    setGenerated(null);
    // A new render supersedes any prior failure — drop the stale correlation so a
    // late cancel for the old job can't retract this render's state.
    recentlyFailedRef.current = null;
    const prompt = buildScenePrompt(workTitle, scene, matchedCharacters, imageStyle?.prompt || '', matchedPlace);
    const res = await generateImage(buildSceneRenderPayload({
      prompt,
      negativePrompt: imageStyle?.negativePrompt || '',
      imageCfg,
      writersRoom: workId && analysisId && scene.id
        ? { workId, analysisId, sceneId: scene.id }
        : null,
    }), { silent: true }).catch((err) => {
      setError(err.message);
      setGenStatus('error');
      return null;
    });
    if (!res) return;
    jobIdRef.current = res.jobId || res.generationId || null;
    if (jobIdRef.current && onRenderStart) {
      // The script-shaper output doesn't include a `number` field; the
      // canonical 1-based index is passed from StoryboardPanel as
      // sceneNumber. Fall back to scene.number for any external caller
      // that does set it, then to a generic label.
      const num = scene.number ?? sceneNumber;
      const numLabel = Number.isFinite(num) ? `S${String(num).padStart(2, '0')}` : '';
      const sceneLabel = `${numLabel} ${scene.heading || ''}`.trim()
        || scene.heading
        || 'Scene';
      onRenderStart({
        jobId: jobIdRef.current,
        sceneId: scene.id,
        sceneLabel,
      });
    }
    setGenerated({ path: res.path, jobId: res.jobId, prompt });
    if (res.status !== 'queued' && res.status !== 'running') {
      setGenStatus('done');
    }
  };

  // Drops jobIdRef so late socket events for the cancelled job are ignored,
  // and rolls state back to idle (or to the prior image if there was one).
  // Server-side cancellation is issued in bulk by the parent.
  const cancelLocal = () => {
    jobIdRef.current = null;
    setProgress(null);
    setError(null);
    setGenerated(initialImage
      ? { path: `/data/images/${initialImage.filename}`, jobId: initialImage.jobId, prompt: initialImage.prompt }
      : null);
    setGenStatus(initialImage ? 'done' : 'idle');
  };

  // canGenerate() returns false for cards that already have an image, are
  // mid-render, or lack a visualPrompt — the parent uses it to skip
  // ineligible scenes silently when batch-queueing renders after Adapt.
  useImperativeHandle(ref, () => ({
    generate,
    cancel: cancelLocal,
    canGenerate: () => genStatus === 'idle' && !!scene.visualPrompt?.trim(),
    isRunning: () => genStatus === 'running',
  }), [genStatus, scene.visualPrompt, initialImage?.filename]);

  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;
  const view = progress?.currentImage ? 'live'
    : genStatus === 'done' && generated?.path ? 'final'
    : genStatus === 'running' ? 'spinner'
    : genStatus === 'error' ? 'error'
    : 'placeholder';

  const cardBorder = isActive
    ? 'border-port-accent ring-2 ring-port-accent/20 shadow-[0_0_0_3px_rgba(59,130,246,0.08)]'
    : light ? 'border-gray-300' : 'border-port-border';
  const cardBg = isActive
    ? (light ? 'bg-port-accent/10 text-gray-900' : 'bg-port-accent/[0.06]')
    : (light ? 'bg-[var(--wr-reading-paper)] text-gray-900' : 'bg-port-card/40');

  // hotRef shape: {kind, refId} or null. Char hot state rings the matching
  // name chip; place hot state rings the slugline. Object hot state has no
  // SceneCard surface today (no per-scene object chip) — it only highlights
  // the matching ObjectsBible row in the sidebar; if a scene-card object
  // affordance is added later, plumb a hotObjectId here.
  const hotCharId = hotRef?.kind === 'char' ? hotRef.refId : null;
  const hotPlaceId = hotRef?.kind === 'place' ? hotRef.refId : null;

  return (
    <div
      data-scene-id={scene.id}
      onMouseEnter={onHoverEnter || undefined}
      onMouseLeave={onHoverLeave || undefined}
      className={`border rounded-lg p-2 space-y-1.5 transition-colors ${cardBorder} ${cardBg}`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onJumpToProse}
          disabled={!onJumpToProse}
          className="flex-1 min-w-0 text-left disabled:cursor-default"
          title={onJumpToProse ? 'Jump to this scene in the prose' : undefined}
        >
          <div className={`font-semibold truncate text-[12px] ${light ? 'text-gray-900' : 'text-white'}`}>
            {scene.heading}
          </div>
          {scene.slugline && (
            <div
              className={`text-[10px] uppercase tracking-wide truncate transition-all ${
                hotPlaceId && matchedPlace?.id === hotPlaceId
                  ? 'text-white bg-port-accent/30 ring-1 ring-port-accent rounded px-1 -mx-1'
                  : 'text-port-accent'
              }`}
            >
              {scene.slugline}
            </div>
          )}
        </button>
        <button
          onClick={generate}
          disabled={genStatus === 'running'}
          className="flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-[10px] text-gray-300 hover:border-port-accent hover:text-white disabled:opacity-50"
          title="Queue an image render using this scene's visual prompt"
        >
          {genStatus === 'running' ? <Loader2 size={10} className="animate-spin" /> : <ImageIcon size={10} />}
          {genStatus === 'running' ? '…' : genStatus === 'done' ? '↻' : 'Image'}
        </button>
        {onDebug && (
          <div className="relative" ref={debugMenuRef}>
            <button
              onClick={() => setShowDebugMenu((v) => !v)}
              className="p-1 text-gray-500 hover:text-white"
              aria-label="Debug this scene"
              title="Debug this scene"
            >
              <MoreHorizontal size={14} />
            </button>
            {showDebugMenu && (
              <div className="absolute right-0 top-full mt-1 z-30 w-48 rounded-md border border-port-border bg-port-card shadow-lg py-1 text-[11px]">
                <DebugMenuItem icon={Sparkles} label="Why this image?" onClick={() => { setShowDebugMenu(false); onDebug({ kind: 'why-image', scene }); }} />
                <DebugMenuItem icon={Users} label="Check characters" onClick={() => { setShowDebugMenu(false); onDebug({ kind: 'check-characters', scene }); }} />
                <DebugMenuItem icon={FileSignature} label="Editorial pass" onClick={() => { setShowDebugMenu(false); onDebug({ kind: 'editorial', scene }); }} />
                <DebugMenuItem icon={Crosshair} label="Jump to prose" onClick={() => { setShowDebugMenu(false); onJumpToProse?.(); }} />
              </div>
            )}
          </div>
        )}
      </div>

      <div
        style={{ aspectRatio: `${imageCfg.width} / ${imageCfg.height}` }}
        className="w-full bg-port-bg/60 border border-port-border rounded-lg overflow-hidden flex items-center justify-center relative">
        {view === 'live' && (
          <img
            src={`data:image/png;base64,${progress.currentImage}`}
            alt="Diffusing…"
            decoding="async"
            className="w-full h-full object-contain"
          />
        )}
        {view === 'final' && (
          <a href={generated.path} target="_blank" rel="noreferrer" className="block w-full h-full">
            <img
              src={generated.path}
              alt={scene.heading}
              loading="lazy"
              className="w-full h-full object-contain"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </a>
        )}
        {view === 'spinner' && (
          <div className="text-gray-500 text-[11px] flex flex-col items-center gap-2 px-3 text-center">
            <Loader2 size={20} className="animate-spin text-port-accent" />
            <span className="font-medium text-gray-300">
              {progress?.step != null && progress?.totalSteps
                ? `Step ${progress.step}/${progress.totalSteps}`
                : 'Queued…'}
            </span>
            {progress?.eta != null && (
              <span className="text-[10px] text-gray-500">~{Math.max(0, Math.round(progress.eta))}s</span>
            )}
          </div>
        )}
        {view === 'error' && (
          <div className="text-port-error text-[11px] px-3 text-center break-words">
            {error || 'Generation failed'}
          </div>
        )}
        {view === 'placeholder' && (
          <div className="text-gray-500 text-[10px] flex flex-col items-center gap-1 px-3 text-center">
            <ImageIcon size={18} className="opacity-40" />
            <span>No image yet — click Image</span>
          </div>
        )}

        {genStatus === 'running' && progressPct != null && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
            <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        )}
      </div>

      {scene.summary && (
        <div className={`text-[11px] ${light ? 'text-gray-700' : 'text-gray-400'}`}>{scene.summary}</div>
      )}

      {scene.characters?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {scene.characters.map((c, i) => {
            const matchedProfile = chipProfileByKey.get(normCharKey(c)) || null;
            const isMatched = !!matchedProfile;
            const isHot = isMatched && hotCharId && matchedProfile.id === hotCharId;
            return (
              <span
                key={i}
                title={isMatched ? 'Profile linked' : 'No matching profile'}
                className={`px-1.5 py-0.5 border rounded text-[9px] uppercase tracking-wider transition-all ${
                  isHot
                    ? 'border-port-accent text-white bg-port-accent/30 ring-1 ring-port-accent'
                    : isMatched
                      ? 'border-port-accent text-port-accent bg-port-accent/10'
                      : light ? 'bg-white border-gray-300 text-gray-700' : 'bg-port-bg border-port-border'
                }`}>
                {c}
              </span>
            );
          })}
        </div>
      )}

      {scene.visualPrompt && (
        <details className="text-[10px] text-gray-500">
          <summary className="cursor-pointer hover:text-white">Visual prompt</summary>
          <div className="mt-1 italic">{scene.visualPrompt}</div>
        </details>
      )}
    </div>
  );
});

export default SceneCard;

function DebugMenuItem({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-300 hover:bg-port-bg hover:text-white"
    >
      <Icon size={11} className="text-gray-500" /> {label}
    </button>
  );
}
