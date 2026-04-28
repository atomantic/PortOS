/**
 * Video Generation page (LTX models via mlx_video on macOS, diffusers on
 * Windows). Local-only — there is no external A1111 equivalent for video.
 *
 * Accepts a source image either via direct upload or via the
 * `?sourceImageFile=` query param so the Image Gen page can pipe a generation
 * straight into video.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import Drawer from '../components/Drawer';
import { ImageGenTab } from '../components/settings/ImageGenTab';
import MediaCard from '../components/media/MediaCard';
import MediaLightbox from '../components/media/MediaLightbox';
import { normalizeVideo } from '../components/media/normalize';
import {
  Film, Sparkles, Settings as SettingsIcon, RefreshCw, AlertTriangle,
  Dice5, X, Upload
} from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import {
  getVideoGenStatus, generateVideo, cancelVideoGen,
  listVideoHistory, deleteVideoHistoryItem, extractLastFrame,
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
  // Re-sync when ImageGen pipes a new image via ?sourceImageFile=...
  // React Router doesn't remount on query-string-only navigation, so the
  // initial useState capture would otherwise stick.
  useEffect(() => {
    if (incomingSourceImage) {
      setSourceImageFile(incomingSourceImage);
      setSourceImageUpload(null);
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
  const navigate = useNavigate();

  const refreshHistory = useCallback(() => {
    listVideoHistory().then((items) => setHistory(Array.isArray(items) ? items : [])).catch(() => {});
  }, []);
  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const handleDeleteHistory = async (item) => {
    await deleteVideoHistoryItem(item.id).catch((err) => toast.error(err.message || 'Delete failed'));
    setHistory((h) => h.filter((v) => v.id !== item.id));
  };
  const handleContinueHistory = async (item) => {
    try {
      const { filename } = await extractLastFrame(item.id);
      navigate(`/media/video?sourceImageFile=${encodeURIComponent(filename)}`);
    } catch (err) {
      toast.error(err.message || 'Failed to extract last frame');
    }
  };

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);

  const refreshStatus = useCallback(() => {
    setStatusLoading(true);
    getVideoGenStatus()
      .then((s) => {
        setStatus(s);
        setModels(s.models || []);
        // Functional update so a stale `modelId` closure can't reset the
        // user's selected model on a refresh — only set when no choice yet.
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

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setProgress({ progress: 0 });
    setStatusMsg('Starting...');
    setResult(null);
    setError(null);

    try {
      const data = await generateVideo({
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
        sourceImageFile: sourceImageFile || '',
        sourceImage: sourceImageUpload || '',
      });

      const jobId = data.jobId || data.generationId;
      const es = new EventSource(`/api/video-gen/${jobId}/events`);
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
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
        }
        if (msg.type === 'error') {
          setError(msg.error);
          setGenerating(false);
          es.close();
          toast.error(msg.error);
        }
      };
      es.onerror = () => {
        setError('Lost connection to server');
        setGenerating(false);
        es.close();
      };
    } catch (err) {
      setError(err.message || 'Video generation failed');
      setGenerating(false);
      toast.error(err.message || 'Video generation failed');
    }
  };

  const handleCancel = async () => {
    eventSourceRef.current?.close();
    await cancelVideoGen().catch(() => {});
    setGenerating(false);
    setStatusMsg('Cancelled');
  };

  const notConnected = status && status.connected === false;

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

          {/* Source image (image-to-video) */}
          <div className="border border-port-border/50 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-400">Source Image (optional, image-to-video)</span>
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

          <div className="flex items-center gap-2 pt-2">
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

      {history.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300">Recent renders ({Math.min(history.length, 6)} of {history.length})</h2>
            {history.length > 6 && (
              <Link to="/media/history" className="text-xs text-port-accent hover:underline">View all →</Link>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {history.slice(0, 6).map((v) => {
              const item = normalizeVideo(v);
              return (
                <MediaCard
                  key={item.key}
                  item={item}
                  onPreview={() => setPreview(item)}
                  onContinue={() => handleContinueHistory(v)}
                  onDelete={() => handleDeleteHistory(v)}
                />
              );
            })}
          </div>
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
