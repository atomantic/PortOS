import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  attachWritersRoomSceneImage,
} from '../../services/apiWritersRoom';
import socket from '../../services/socket';
import useClickOutside from '../../hooks/useClickOutside';
import {
  WR_IMAGE_DEFAULTS,
  buildScenePromptWithCharacters,
  matchSceneCharacters,
  normCharKey,
} from './sceneCardHelpers';

export default function SceneCard({
  scene,
  workId,
  analysisId,
  workTitle,
  imageCfg = WR_IMAGE_DEFAULTS,
  initialImage = null,
  readingTheme = 'dark',
  charByKey = null,
  isActive = false,
  onJumpToProse = null,
  onDebug = null,
}) {
  const light = readingTheme === 'light';
  const matchedCharacters = useMemo(
    () => matchSceneCharacters(scene.characters, charByKey),
    [scene.characters, charByKey]
  );
  const matchedNameKeys = useMemo(() => {
    const keys = new Set();
    for (const c of matchedCharacters) {
      keys.add(normCharKey(c.name));
      for (const a of c.aliases || []) keys.add(normCharKey(a));
    }
    return keys;
  }, [matchedCharacters]);

  const [genStatus, setGenStatus] = useState(initialImage ? 'done' : 'idle');
  const [generated, setGenerated] = useState(initialImage
    ? { path: `/data/images/${initialImage.filename}`, jobId: initialImage.jobId, prompt: initialImage.prompt }
    : null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [showDebugMenu, setShowDebugMenu] = useState(false);
  const jobIdRef = useRef(null);
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
      const completedJobId = jobIdRef.current;
      setGenerated((prev) => prev ? { ...prev, path: data.path || prev.path } : prev);
      setGenStatus('done');
      setProgress(null);
      jobIdRef.current = null;
      if (workId && analysisId && scene.id) {
        attachWritersRoomSceneImage(workId, analysisId, {
          sceneId: scene.id,
          filename: `${completedJobId}.png`,
          jobId: completedJobId,
          prompt: data.prompt || null,
        }).catch((err) => {
          console.warn(`scene-image persist failed: ${err.message}`);
        });
      }
    };
    const onFailed = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      setError(data.error || data.message || 'Generation failed');
      setGenStatus('error');
      setProgress(null);
      jobIdRef.current = null;
    };
    socket.on('image-gen:started', onStarted);
    socket.on('image-gen:progress', onProgress);
    socket.on('image-gen:completed', onCompleted);
    socket.on('image-gen:failed', onFailed);
    return () => {
      socket.off('image-gen:started', onStarted);
      socket.off('image-gen:progress', onProgress);
      socket.off('image-gen:completed', onCompleted);
      socket.off('image-gen:failed', onFailed);
    };
  }, [workId, analysisId, scene.id]);

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
    const prompt = buildScenePromptWithCharacters(workTitle, scene, matchedCharacters);
    const res = await generateImage({
      prompt,
      modelId: imageCfg.modelId,
      mode: imageCfg.mode,
      width: imageCfg.width,
      height: imageCfg.height,
    }).catch((err) => {
      setError(err.message);
      setGenStatus('error');
      return null;
    });
    if (!res) return;
    jobIdRef.current = res.jobId || res.generationId || null;
    setGenerated({ path: res.path, jobId: res.jobId, prompt });
    if (res.status !== 'queued' && res.status !== 'running') {
      setGenStatus('done');
    }
  };

  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;
  const view = progress?.currentImage ? 'live'
    : genStatus === 'done' && generated?.path ? 'final'
    : genStatus === 'running' ? 'spinner'
    : genStatus === 'error' ? 'error'
    : 'placeholder';

  const cardBorder = isActive
    ? 'border-port-accent shadow-[0_0_0_1px_rgba(59,130,246,0.5)]'
    : light ? 'border-gray-300' : 'border-port-border';

  return (
    <div
      data-scene-id={scene.id}
      className={`border rounded-lg p-2 space-y-1.5 transition-colors ${cardBorder} ${
        light ? 'bg-[var(--wr-reading-paper)] text-gray-900' : 'bg-port-card/40'
      }`}
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
            <div className="text-[10px] text-port-accent uppercase tracking-wide truncate">
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
            const isMatched = matchedNameKeys.has(normCharKey(c));
            return (
              <span
                key={i}
                title={isMatched ? 'Profile linked' : 'No matching profile'}
                className={`px-1.5 py-0.5 border rounded text-[9px] uppercase tracking-wider ${
                  isMatched
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
}

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
