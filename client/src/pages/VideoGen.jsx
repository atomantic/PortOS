/**
 * Video Generation page (LTX models via mlx_video on macOS, diffusers on
 * Windows). Local-only — there is no external A1111 equivalent for video.
 *
 * Accepts a source image either via direct upload or via the
 * `?sourceImageFile=` query param so the Image Gen page can pipe a generation
 * straight into video.
 *
 * Modes (UI state, also forwarded to the backend as `mode`):
 *   - text:   pure text-to-video
 *   - image:  image-to-video (one source image, current I2V behavior)
 *   - fflf:   first frame + last frame (two images — backend support is
 *             experimental; mlx_video only supports a single conditioning
 *             frame, so when both are provided the last is ignored)
 *   - extend: pick a previous render → its last frame becomes the source
 *             image for a new image-to-video generation
 *
 * Batch queue: client-side serial executor. The form's "Add to queue" button
 * appends a job to the queue (preserving the current params). When no job is
 * actively generating, the head of the queue is dequeued and submitted via
 * the same generate path as the inline button — so SSE progress, history
 * refresh, and error handling are all reused.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import Drawer from '../components/Drawer';
import { ImageGenTab } from '../components/settings/ImageGenTab';
import MediaCard from '../components/media/MediaCard';
import MediaLightbox from '../components/media/MediaLightbox';
import { normalizeVideo } from '../components/media/normalize';
import {
  Film, Sparkles, Settings as SettingsIcon, RefreshCw, AlertTriangle,
  Dice5, X, Upload, Type, Image as ImageIcon, GitBranch, ListPlus,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import BatchQueuePanel from '../components/media/BatchQueuePanel';
import {
  getVideoGenStatus, generateVideo, cancelVideoGen,
  listVideoHistory, deleteVideoHistoryItem, setVideoHidden, extractLastFrame,
  listImageGallery,
} from '../services/api';
import { randomSeed, safeParseJSON } from '../lib/genUtils';

const RESOLUTIONS = [
  { label: '512×320 (16:10)', w: 512, h: 320 },
  { label: '640×384 (5:3)', w: 640, h: 384 },
  { label: '704×448 (16:10)', w: 704, h: 448 },
  { label: '768×512 (3:2 default)', w: 768, h: 512 },
  { label: '1024×576 (16:9)', w: 1024, h: 576 },
  { label: '512×768 (portrait)', w: 512, h: 768 },
];

const FRAME_OPTIONS = [25, 49, 73, 97, 121, 145, 169, 193, 217, 241];
const FPS_OPTIONS = [16, 24, 30];
const TILING_OPTIONS = [
  { value: 'auto', label: 'Auto (recommended)' },
  { value: 'none', label: 'None (fastest, more VRAM)' },
  { value: 'spatial', label: 'Spatial only' },
  { value: 'temporal', label: 'Temporal only' },
];

const MODES = [
  { id: 'text',   label: 'Text',   icon: Type,       desc: 'Text-to-video' },
  { id: 'image',  label: 'Image',  icon: ImageIcon,  desc: 'Image-to-video (start frame)' },
  { id: 'fflf',   label: 'FFLF',   icon: GitBranch,  desc: 'First frame + last frame' },
  { id: 'extend', label: 'Extend', icon: Film,       desc: 'Continue from a prior render' },
];

const newQueueId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export default function VideoGen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const incomingSourceImage = searchParams.get('sourceImageFile');
  const incomingPrompt = searchParams.get('prompt');
  const incomingNegativePrompt = searchParams.get('negativePrompt');
  const settingsOpen = searchParams.get('settings') === '1';
  const openSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('settings', '1'); return n; });
  const closeSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('settings'); return n; });

  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [models, setModels] = useState([]);

  const [mode, setMode] = useState(incomingSourceImage ? 'image' : 'text');
  const [prompt, setPrompt] = useState(incomingPrompt || '');
  const [negativePrompt, setNegativePrompt] = useState(incomingNegativePrompt || '');
  const [modelId, setModelId] = useState('');
  const [width, setWidth] = useState(768);
  const [height, setHeight] = useState(512);
  const [numFrames, setNumFrames] = useState(121);
  const [fps, setFps] = useState(24);
  const [steps, setSteps] = useState('');
  const [guidanceScale, setGuidanceScale] = useState('');
  const [seed, setSeed] = useState('');
  const [tiling, setTiling] = useState('auto');
  const [disableAudio, setDisableAudio] = useState(false);
  const [sourceImageFile, setSourceImageFile] = useState(incomingSourceImage || null);
  const [sourceImageUpload, setSourceImageUpload] = useState(null);
  const [lastImageFile, setLastImageFile] = useState(null);
  const [extendFromVideoId, setExtendFromVideoId] = useState('');
  const [extendingFrame, setExtendingFrame] = useState(false);

  // Image gallery for the FFLF end-frame picker (gallery only — no upload
  // for the second image so the multipart parser stays single-file).
  const [imageGallery, setImageGallery] = useState([]);

  // Re-sync when ImageGen pipes a new image via ?sourceImageFile=...
  useEffect(() => {
    if (incomingSourceImage) {
      setSourceImageFile(incomingSourceImage);
      setSourceImageUpload(null);
      setMode((m) => (m === 'text' ? 'image' : m));
    }
  }, [incomingSourceImage]);
  useEffect(() => {
    if (incomingPrompt) setPrompt(incomingPrompt);
  }, [incomingPrompt]);
  useEffect(() => {
    if (incomingNegativePrompt) setNegativePrompt(incomingNegativePrompt);
  }, [incomingNegativePrompt]);

  const [history, setHistory] = useState([]);
  const [preview, setPreview] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const navigate = useNavigate();

  const refreshHistory = useCallback(() => {
    listVideoHistory().then((items) => setHistory(Array.isArray(items) ? items : [])).catch(() => {});
  }, []);
  useEffect(() => { refreshHistory(); }, [refreshHistory]);
  useEffect(() => { listImageGallery().then(setImageGallery).catch(() => {}); }, []);

  const { visibleHistory, hiddenHistory } = useMemo(() => ({
    visibleHistory: history.filter((v) => !v.hidden),
    hiddenHistory: history.filter((v) => v.hidden),
  }), [history]);

  const handleDeleteHistory = async (item) => {
    await deleteVideoHistoryItem(item.id).catch((err) => toast.error(err.message || 'Delete failed'));
    setHistory((h) => h.filter((v) => v.id !== item.id));
  };
  const handleToggleHistoryHidden = async (item) => {
    const nextHidden = !item.hidden;
    setHistory((h) => h.map((v) => (v.id === item.id ? { ...v, hidden: nextHidden } : v)));
    const result = await setVideoHidden(item.id, nextHidden).catch((err) => {
      toast.error(err.message || 'Failed to update visibility');
      setHistory((h) => h.map((v) => (v.id === item.id ? { ...v, hidden: !nextHidden } : v)));
      return null;
    });
    if (result) toast.success(nextHidden ? 'Video hidden' : 'Video unhidden');
  };
  const handleContinueHistory = async (item) => {
    const { filename } = await extractLastFrame(item.id).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return {};
    });
    if (filename) navigate(`/media/video?sourceImageFile=${encodeURIComponent(filename)}`);
  };

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);
  // Hold the reject() of the in-flight runGeneration Promise so cancel can
  // settle it. Without this, handleCancel() closes the EventSource but the
  // outstanding Promise dangles forever — and the queue worker's .finally()
  // never runs, leaving runningQueueId stuck and freezing further dequeue.
  const runRejectRef = useRef(null);
  // Per-run abort token. Bumped at the start of each runGeneration() and
  // again on cancel; runGeneration captures the value at start and bails
  // when the token has moved on (e.g. POST resolves after cancel).
  const runTokenRef = useRef(0);

  // Batch queue. Each item snapshots the params at enqueue time so the user
  // can keep editing the form while jobs are in flight without affecting the
  // queued ones. The active generation is held in `generating`/`progress`;
  // `runningQueueId` (if set) marks which queued item it represents.
  const [queue, setQueue] = useState([]);
  const [runningQueueId, setRunningQueueId] = useState(null);

  const refreshStatus = useCallback(() => {
    setStatusLoading(true);
    getVideoGenStatus()
      .then((s) => {
        setStatus(s);
        setModels(s.models || []);
        if (s.defaultModel) setModelId((prev) => prev || s.defaultModel);
      })
      .catch(() => setStatus({ connected: false, reason: 'Status check failed' }))
      .finally(() => setStatusLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshStatus();
    return () => eventSourceRef.current?.close();
  }, [refreshStatus]);

  const currentModel = models.find((m) => m.id === modelId);
  const matchedResolution = RESOLUTIONS.find((r) => r.w === width && r.h === height);
  const resolutionLabel = matchedResolution?.label || `${width}×${height}`;
  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;

  const handleResolutionChange = (e) => {
    const r = RESOLUTIONS.find((r) => r.label === e.target.value);
    if (r) { setWidth(r.w); setHeight(r.h); }
  };
  const handleRandomSeed = () => setSeed(randomSeed());

  const clearSourceImage = () => {
    setSourceImageFile(null);
    setSourceImageUpload(null);
    if (incomingSourceImage) {
      const next = new URLSearchParams(searchParams);
      next.delete('sourceImageFile');
      setSearchParams(next, { replace: true });
    }
  };
  const clearLastImage = () => setLastImageFile(null);

  // Switching mode resets the now-irrelevant fields so a stale choice from
  // a prior mode can't sneak into the next generation. (Prompt/seed/etc.
  // carry over because they apply to all modes.)
  const handleModeChange = (next) => {
    setMode(next);
    if (next === 'text') {
      clearSourceImage();
      setLastImageFile(null);
      setExtendFromVideoId('');
    } else if (next === 'image') {
      setLastImageFile(null);
      setExtendFromVideoId('');
    } else if (next === 'fflf') {
      setExtendFromVideoId('');
    } else if (next === 'extend') {
      setLastImageFile(null);
      // Drop any source image carried over from a prior mode — extend will
      // populate sourceImageFile fresh from the picked video's last frame
      // via handleExtendPick. Without this, switching from image/fflf into
      // extend leaves a stale source that gets silently submitted alongside
      // an empty extendFromVideoId.
      clearSourceImage();
    }
  };

  // Extend mode: the user picks a prior video; we extract its last frame
  // (lazily — only when picked, since extraction shells out to ffmpeg) and
  // use that as the source image for image-to-video.
  //
  // The pick token guards against a slow-then-fast race: if the user picks
  // video A, then quickly switches to video B, A's extract response could
  // arrive after B's and overwrite sourceImageFile with the wrong frame.
  // Capture the token at request time and only apply the result when it
  // still matches the latest pick.
  const extendPickTokenRef = useRef(0);
  const handleExtendPick = async (videoId) => {
    // Bumping the token cancels any in-flight extract from a prior pick:
    // the awaited promise still resolves, but the result-application block
    // sees the mismatch and bails. Clearing the spinner here too means a
    // fast-clear (`videoId === ''`) doesn't strand the "Extracting…" UI
    // when an earlier extract is mid-flight.
    const token = ++extendPickTokenRef.current;
    setExtendFromVideoId(videoId);
    if (!videoId) {
      clearSourceImage();
      setExtendingFrame(false);
      return;
    }
    setExtendingFrame(true);
    const res = await extractLastFrame(videoId).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return null;
    });
    // Stale completion: a newer pick (or clear) is now authoritative. Do
    // nothing — the newer call already set/will set the spinner correctly,
    // and the clear-path above resets it on empty pick. Touching it from
    // the stale request could prematurely hide "Extracting…" while the
    // current pick (B) is still in flight after a fast pick A → pick B.
    if (token !== extendPickTokenRef.current) return;
    setExtendingFrame(false);
    if (res?.filename) {
      setSourceImageFile(res.filename);
      setSourceImageUpload(null);
    }
  };

  // Snapshot the current form into a generate-payload. Used both by the
  // inline Generate button and by enqueue, so the two paths stay in lockstep.
  const buildGeneratePayload = () => ({
    prompt: prompt.trim(),
    negativePrompt: negativePrompt.trim() || '',
    modelId,
    width, height,
    numFrames,
    fps,
    steps: steps || '',
    guidanceScale: guidanceScale || '',
    seed: seed || '',
    tiling,
    disableAudio: disableAudio ? 'true' : 'false',
    mode,
    sourceImageFile: (mode === 'image' || mode === 'fflf' || mode === 'extend') ? (sourceImageFile || '') : '',
    sourceImage: (mode === 'image' || mode === 'fflf') ? (sourceImageUpload || '') : '',
    lastImageFile: mode === 'fflf' ? (lastImageFile || '') : '',
  });

  // Run a single payload through the SSE pipeline. Returns a promise that
  // resolves when the job completes (or rejects on error / cancel). Shared
  // by the inline submit and the queue worker.
  //
  // Per-run abort token: the user can press Cancel during the brief window
  // between generateVideo() POST and its `.then()` resolving with a jobId.
  // Without a guard, the late `.then()` would still open an EventSource and
  // start applying SSE updates for a job the UI considers cancelled, AND
  // could clobber a queue item that's already advanced. handleCancel bumps
  // runTokenRef; runGeneration captures the token at start and ignores the
  // POST response (and any SSE messages) when the token no longer matches.
  const runGeneration = (payload) => new Promise((resolve, reject) => {
    setGenerating(true);
    setProgress({ progress: 0 });
    setStatusMsg('Starting...');
    setResult(null);
    setError(null);

    const myToken = ++runTokenRef.current;
    const isCurrent = () => myToken === runTokenRef.current;

    // Wrap settle so the cancel ref is cleared exactly once when the Promise
    // transitions to a final state — guarantees the queue worker's .finally()
    // always runs and stale rejects can't fire after a successful complete.
    const settleResolve = (value) => { runRejectRef.current = null; resolve(value); };
    const settleReject = (err) => { runRejectRef.current = null; reject(err); };
    runRejectRef.current = settleReject;

    generateVideo(payload).then((data) => {
      // The user cancelled while we were waiting for the POST to return —
      // don't open an EventSource at all, and don't touch any state. The
      // earlier handleCancel() already settled the Promise via runRejectRef.
      if (!isCurrent()) return;
      const jobId = data.jobId || data.generationId;
      const es = new EventSource(`/api/video-gen/${jobId}/events`);
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
        // A cancel that landed after the EventSource opened would have closed
        // it, but a stray buffered message could still fire — bail before
        // touching component state for a run we no longer own.
        if (!isCurrent()) { es.close(); return; }
        const msg = safeParseJSON(ev.data);
        if (!msg) return;
        if (msg.type === 'status') setStatusMsg(msg.message);
        if (msg.type === 'progress') {
          setProgress({ progress: msg.progress });
          setStatusMsg(msg.message);
        }
        if (msg.type === 'complete') {
          setResult(msg.result);
          setGenerating(false);
          setProgress({ progress: 1 });
          setStatusMsg('Complete');
          es.close();
          toast.success('Video generated');
          refreshHistory();
          settleResolve(msg.result);
        }
        if (msg.type === 'error') {
          setError(msg.error);
          setGenerating(false);
          es.close();
          toast.error(msg.error);
          settleReject(new Error(msg.error));
        }
      };
      es.onerror = () => {
        if (!isCurrent()) { es.close(); return; }
        setError('Lost connection to server');
        setGenerating(false);
        es.close();
        settleReject(new Error('Lost connection to server'));
      };
    }).catch((err) => {
      if (!isCurrent()) return;
      setError(err.message || 'Video generation failed');
      setGenerating(false);
      toast.error(err.message || 'Video generation failed');
      settleReject(err);
    });
  });

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    // Mirror the inline submit-button's disabled rules: blank prompt,
    // already generating, or backend disconnected. Without the disconnected
    // guard the user could press Enter in the prompt textarea and fire a
    // request that's guaranteed to fail (and the disabled button would
    // otherwise have prevented).
    if (!prompt.trim() || generating || (status && status.connected === false)) return;
    await runGeneration(buildGeneratePayload()).catch(() => {});
  };

  const handleEnqueue = () => {
    if (!prompt.trim() || (status && status.connected === false)) return;
    const payload = buildGeneratePayload();
    // Strip the File blob for snapshot — re-using a File across multiple
    // queued submissions is fine, but we need a stable JSON-ish summary
    // for the queue UI display. Hold the File in `_blob` separately.
    const { sourceImage, ...summary } = payload;
    setQueue((q) => [...q, {
      id: newQueueId(),
      status: 'pending',
      params: summary,
      _blob: sourceImage instanceof File ? sourceImage : null,
      enqueuedAt: Date.now(),
    }]);
    toast.success('Added to queue');
  };

  const removeFromQueue = (id) => {
    setQueue((q) => q.filter((item) => item.id !== id || item.status === 'running'));
  };
  // Drops both successful and errored items — the panel surfaces this as
  // "Clear finished" so the label matches the behavior.
  const clearFinishedQueue = () => {
    setQueue((q) => q.filter((item) => item.status !== 'complete' && item.status !== 'error'));
  };

  // Queue worker — pumps the head of the queue when nothing's running.
  // Runs as an effect so it picks up any newly-enqueued item even while
  // the user is interacting with the form.
  //
  // BUSY backoff: the server's `cancel()` keeps `activeProcess` set until
  // the SIGKILL'd child actually exits (up to ~8s), so a freshly-cancelled
  // item leaving the running slot here will often hit a 409 VIDEO_GEN_BUSY
  // when the worker tries to dispatch the next pending item. Treat that as
  // "not yet" (return the item to pending) instead of marking it errored.
  useEffect(() => {
    if (generating || runningQueueId) return;
    const next = queue.find((item) => item.status === 'pending');
    if (!next) return;
    setRunningQueueId(next.id);
    setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'running', startedAt: Date.now() } : item));
    const payload = { ...next.params };
    if (next._blob) payload.sourceImage = next._blob;
    let busyRetry = false;
    runGeneration(payload).then((res) => {
      setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'complete', result: res } : item));
    }).catch((err) => {
      const isBusy = /already in progress|VIDEO_GEN_BUSY|409/i.test(err?.message || '');
      if (isBusy) {
        // Bounce the item back to pending after a short delay so the worker
        // re-tries once the server's previous child has finished cleaning up.
        busyRetry = true;
        setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'pending', startedAt: undefined } : item));
        setTimeout(() => setRunningQueueId((curr) => (curr === next.id ? null : curr)), 1500);
        return;
      }
      setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'error', error: err.message } : item));
    }).finally(() => {
      // For the BUSY branch the timeout above releases the slot — releasing
      // it here too would let the worker immediately re-fire and hit the
      // same 409 before the server's old child has exited.
      if (!busyRetry) setRunningQueueId(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, generating, runningQueueId]);

  const handleCancel = async () => {
    // Bump the run token FIRST so any late `.then()` from the in-flight
    // generateVideo() POST sees a stale token and bails before opening an
    // EventSource for a job we've already declared cancelled.
    runTokenRef.current += 1;
    eventSourceRef.current?.close();
    await cancelVideoGen().catch(() => {});
    setGenerating(false);
    setStatusMsg('Cancelled');
    // Settle the in-flight runGeneration Promise so the queue worker's
    // .finally() releases runningQueueId and the next pending item can run.
    // Without this the Promise would dangle and the worker would stay parked.
    if (runRejectRef.current) {
      const reject = runRejectRef.current;
      runRejectRef.current = null;
      reject(new Error('Cancelled'));
    }
    if (runningQueueId) {
      setQueue((q) => q.map((item) => item.id === runningQueueId ? { ...item, status: 'error', error: 'Cancelled' } : item));
      setRunningQueueId(null);
    }
  };

  const notConnected = status && status.connected === false;
  const canEnqueue = prompt.trim() && !notConnected;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2 text-xs">
        {status ? (
          <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border ${
            status.connected
              ? 'border-port-success/40 bg-port-success/10 text-port-success'
              : 'border-port-error/40 bg-port-error/10 text-port-error'
          }`}>
            {status.connected ? (
              <><span className="w-2 h-2 rounded-full bg-port-success" /> {status.pythonPath || 'local Python'}</>
            ) : (
              <>
                <AlertTriangle className="w-3 h-3" />
                {status.reason || 'Local Python not configured'} —
                <button type="button" onClick={openSettings} className="underline">Settings</button>
              </>
            )}
          </span>
        ) : (
          <span className="text-gray-500">Checking…</span>
        )}
        <div className="flex items-center gap-1">
          <button
            onClick={refreshStatus}
            disabled={statusLoading}
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
            title="Refresh status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={openSettings}
            className="flex items-center gap-1.5 px-2 py-1 text-gray-300 hover:text-white border border-port-border rounded hover:bg-port-border/50"
            title="Video Gen settings"
          >
            <SettingsIcon className="w-3.5 h-3.5" /> Settings
          </button>
        </div>
      </div>

      {/* Mode switch — segmented control above the form. Sets state that
          both the form rendering and the submit payload react to.
          Implemented as plain toggle buttons with `aria-pressed` rather than
          WAI-ARIA Tabs, since the mode-specific inputs aren't structured as
          tabpanels and we don't implement roving-tabindex/arrow-key focus. */}
      <div className="bg-port-card border border-port-border rounded-xl p-1.5 flex flex-wrap gap-1" role="group" aria-label="Video generation mode">
        {MODES.map(({ id, label, icon: Icon, desc }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => handleModeChange(id)}
              disabled={generating}
              className={`flex-1 min-w-[140px] flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                active
                  ? 'bg-port-accent text-white shadow'
                  : 'text-gray-400 hover:text-white hover:bg-port-border/40'
              }`}
              title={desc}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      <form onSubmit={handleGenerate} className="grid grid-cols-1 lg:grid-cols-[1fr,1.2fr] gap-6">
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              disabled={generating}
              className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
              placeholder="Describe the video you want to generate..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Negative Prompt</label>
            <textarea
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              rows={2}
              disabled={generating}
              className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
              placeholder="What to avoid..."
            />
          </div>

          {/* Mode-specific image / video pickers */}
          {(mode === 'image' || mode === 'fflf') && (
            <div className="border border-port-border/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-400">
                  {mode === 'fflf' ? 'First frame (start image)' : 'Source image (image-to-video)'}
                </span>
                {(sourceImageFile || sourceImageUpload) && (
                  <button type="button" onClick={clearSourceImage} className="text-xs text-port-error hover:underline">Clear</button>
                )}
              </div>
              {sourceImageFile && (
                <div className="flex items-center gap-2">
                  <img src={`/data/images/${sourceImageFile}`} alt="Source" className="w-16 h-16 object-cover rounded border border-port-border" />
                  <span className="text-xs text-gray-500 truncate">{sourceImageFile}</span>
                </div>
              )}
              {!sourceImageFile && (
                <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer hover:text-white">
                  <Upload className="w-4 h-4" />
                  <span>{sourceImageUpload ? sourceImageUpload.name : 'Upload an image'}</span>
                  <input
                    type="file"
                    accept="image/*"
                    disabled={generating}
                    onChange={(e) => setSourceImageUpload(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                </label>
              )}
            </div>
          )}

          {mode === 'fflf' && (
            <div className="border border-port-border/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-400">Last frame (end image)</span>
                {lastImageFile && (
                  <button type="button" onClick={clearLastImage} className="text-xs text-port-error hover:underline">Clear</button>
                )}
              </div>
              {lastImageFile ? (
                <div className="flex items-center gap-2">
                  <img src={`/data/images/${lastImageFile}`} alt="End frame" className="w-16 h-16 object-cover rounded border border-port-border" />
                  <span className="text-xs text-gray-500 truncate">{lastImageFile}</span>
                </div>
              ) : (
                <select
                  value=""
                  disabled={generating}
                  onChange={(e) => setLastImageFile(e.target.value || null)}
                  className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                >
                  <option value="">Pick an image from gallery…</option>
                  {imageGallery.filter((img) => !img.hidden).slice(0, 50).map((img) => (
                    <option key={img.filename} value={img.filename}>{img.filename}</option>
                  ))}
                </select>
              )}
              <p className="text-[11px] text-gray-500 leading-snug">
                Note: FFLF (two-keyframe) backend support is experimental — current
                LTX/mlx_video CLI consumes the start frame and treats the last frame
                as advisory. Generate the end image first via Image Gen, then pick it here.
              </p>
            </div>
          )}

          {mode === 'extend' && (
            <div className="border border-port-border/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-400">Continue from a prior render</span>
                {extendFromVideoId && (
                  <button type="button" onClick={() => handleExtendPick('')} className="text-xs text-port-error hover:underline">Clear</button>
                )}
              </div>
              <select
                value={extendFromVideoId}
                disabled={generating || extendingFrame}
                onChange={(e) => handleExtendPick(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                <option value="">Pick a previous video…</option>
                {visibleHistory.slice(0, 50).map((v) => (
                  <option key={v.id} value={v.id}>
                    {(v.prompt || v.filename || v.id).slice(0, 80)}
                  </option>
                ))}
              </select>
              {extendingFrame && (
                <span className="text-[11px] text-gray-500">Extracting last frame…</span>
              )}
              {sourceImageFile && extendFromVideoId && !extendingFrame && (
                <div className="flex items-center gap-2">
                  <img src={`/data/images/${sourceImageFile}`} alt="Last frame" className="w-16 h-16 object-cover rounded border border-port-border" />
                  <span className="text-xs text-gray-500 truncate">Starts from: {sourceImageFile}</span>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {models.length > 0 && (
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-400 mb-1">Model</label>
                <select
                  value={modelId}
                  onChange={(e) => { setModelId(e.target.value); setSteps(''); setGuidanceScale(''); }}
                  disabled={generating}
                  className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                >
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Resolution</label>
              <select
                value={resolutionLabel}
                onChange={handleResolutionChange}
                disabled={generating}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {RESOLUTIONS.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Frames</label>
              <select
                value={numFrames}
                onChange={(e) => setNumFrames(Number(e.target.value))}
                disabled={generating}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {FRAME_OPTIONS.map((f) => <option key={f} value={f}>{f} ({(f / fps).toFixed(1)}s @ {fps}fps)</option>)}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">FPS</label>
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                disabled={generating}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {FPS_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  disabled={generating}
                  placeholder="Random"
                  className="flex-1 bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={handleRandomSeed}
                  disabled={generating}
                  className="p-2 text-gray-400 hover:text-white border border-port-border rounded-lg hover:bg-port-border/50 disabled:opacity-50 min-h-[40px] min-w-[40px] flex items-center justify-center"
                  title="Randomize seed"
                >
                  <Dice5 className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">
                Steps {currentModel?.steps && `(default: ${currentModel.steps})`}
              </label>
              <input
                type="number" min={1} max={150}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                placeholder={String(currentModel?.steps || 25)}
                disabled={generating}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">
                CFG Scale {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}
              </label>
              <input
                type="number" min={0} max={20} step={0.5}
                value={guidanceScale}
                onChange={(e) => setGuidanceScale(e.target.value)}
                placeholder={String(currentModel?.guidance ?? 3.0)}
                disabled={generating}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-400 mb-1">Tiling</label>
              <select
                value={tiling}
                onChange={(e) => setTiling(e.target.value)}
                disabled={generating}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {TILING_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            <label className="col-span-2 flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={disableAudio}
                onChange={(e) => setDisableAudio(e.target.checked)}
                disabled={generating}
                className="rounded"
              />
              Disable audio (LTX-2 only — speeds up generation)
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            {generating ? (
              <button
                type="button"
                onClick={handleCancel}
                className="flex items-center gap-2 px-4 py-2 bg-port-error hover:bg-port-error/80 text-white text-sm font-medium rounded-lg min-h-[40px]"
              >
                <X className="w-4 h-4" /> Cancel
              </button>
            ) : (
              <button
                type="submit"
                disabled={!prompt.trim() || notConnected}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg min-h-[40px]"
              >
                <Sparkles className="w-4 h-4" /> Generate
              </button>
            )}
            <button
              type="button"
              onClick={handleEnqueue}
              disabled={!canEnqueue}
              className="flex items-center gap-2 px-4 py-2 border border-port-border text-gray-200 hover:text-white hover:bg-port-border/40 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium rounded-lg min-h-[40px]"
              title="Add this configuration to the batch queue"
            >
              <ListPlus className="w-4 h-4" /> Add to queue
            </button>
            {progressPct != null && <span className="text-xs text-port-accent">{progressPct}%</span>}
          </div>

          {(generating || error) && (
            <div className={`text-xs ${error ? 'text-port-error' : 'text-gray-400'}`}>
              {error || statusMsg || 'Working...'}
            </div>
          )}
        </div>

        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-medium text-gray-300">Preview</h2>
          <div className="aspect-video w-full bg-port-bg border border-port-border rounded-lg overflow-hidden flex items-center justify-center relative">
            {result ? (
              <video src={result.path || `/data/videos/${result.filename}`} controls autoPlay loop className="w-full h-full" />
            ) : generating ? (
              <div className="text-gray-500 text-sm flex flex-col items-center gap-2">
                <BrailleSpinner />
                <span>{statusMsg || 'Starting...'}</span>
              </div>
            ) : (
              <div className="text-gray-600 text-sm flex flex-col items-center gap-2">
                <Film className="w-12 h-12" />
                <span>Your generated video will appear here</span>
              </div>
            )}
            {generating && progressPct != null && (
              <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
              </div>
            )}
          </div>
          {result && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span className="truncate flex-1">{result.filename}</span>
              <a
                href={result.path || `/data/videos/${result.filename}`}
                download
                className="text-port-accent hover:underline"
              >
                Download
              </a>
            </div>
          )}
        </div>
      </form>

      <BatchQueuePanel
        queue={queue}
        onRemove={removeFromQueue}
        onClear={clearFinishedQueue}
        summarize={(item) => (
          <>
            <span className="uppercase mr-2">{item.params.mode}</span>
            {item.params.width}×{item.params.height} · {item.params.numFrames}f
          </>
        )}
      />

      {visibleHistory.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300">Recent renders ({Math.min(visibleHistory.length, 6)} of {visibleHistory.length})</h2>
            {visibleHistory.length > 6 && (
              <Link to="/media/history" className="text-xs text-port-accent hover:underline">View all →</Link>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {visibleHistory.slice(0, 6).map((v) => {
              const item = normalizeVideo(v);
              return (
                <MediaCard
                  key={item.key}
                  item={item}
                  onPreview={() => setPreview(item)}
                  onContinue={() => handleContinueHistory(v)}
                  onDelete={() => handleDeleteHistory(v)}
                  onToggleHidden={() => handleToggleHistoryHidden(v)}
                />
              );
            })}
          </div>
        </div>
      )}

      {hiddenHistory.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
          <button
            type="button"
            onClick={() => setShowHidden((s) => !s)}
            className="flex items-center justify-between w-full text-sm font-medium text-gray-300 hover:text-white"
          >
            <span>{showHidden ? 'Hide' : 'Show'} hidden ({hiddenHistory.length})</span>
            <span className="text-xs text-gray-500">{showHidden ? '▾' : '▸'}</span>
          </button>
          {showHidden && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {hiddenHistory.map((v) => {
                const item = normalizeVideo(v);
                return (
                  <MediaCard
                    key={item.key}
                    item={item}
                    onPreview={() => setPreview(item)}
                    onContinue={() => handleContinueHistory(v)}
                    onDelete={() => handleDeleteHistory(v)}
                    onToggleHidden={() => handleToggleHistoryHidden(v)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      <MediaLightbox
        item={preview}
        onClose={() => setPreview(null)}
        onContinue={(item) => handleContinueHistory(item.raw)}
      />

      <Drawer open={settingsOpen} onClose={closeSettings} title="Media Generation Settings">
        <ImageGenTab />
      </Drawer>
    </div>
  );
}

