/**
 * Image Generation page.
 *
 * Works against either an external SD API (default) or PortOS's local mflux
 * backend, picked in Settings → Image Gen. The external mode uses the
 * /api/image-gen/generate JSON endpoint; the local mode kicks off a job and
 * subscribes to /api/image-gen/:jobId/events SSE for streaming progress and
 * additional knobs (model picker, LoRAs, quantization).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import Drawer from '../components/Drawer';
import { ImageGenTab } from '../components/settings/ImageGenTab';
import MediaCard from '../components/media/MediaCard';
import MediaLightbox from '../components/media/MediaLightbox';
import { normalizeImage } from '../components/media/normalize';
import {
  Image as ImageIcon, Sparkles, Download, RefreshCw, Settings as SettingsIcon,
  Dice5, AlertTriangle, X, Film
} from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import { useImageGenProgress } from '../hooks/useImageGenProgress';
import {
  getImageGenStatus, generateImage, listImageModels, listLoras, listImageGallery,
  cancelImageGen, deleteImage, getActiveImageJob,
} from '../services/api';

const RESOLUTIONS = [
  { label: '512×512', w: 512, h: 512 },
  { label: '768×512', w: 768, h: 512 },
  { label: '512×768', w: 512, h: 768 },
  { label: '768×768', w: 768, h: 768 },
  { label: '1024×1024', w: 1024, h: 1024 },
  { label: '832×1216 (Flux portrait)', w: 832, h: 1216 },
  { label: '1216×832 (Flux landscape)', w: 1216, h: 832 },
  { label: '1024×576 (16:9)', w: 1024, h: 576 },
  { label: '576×1024 (9:16)', w: 576, h: 1024 },
];

const DEFAULT_NEGATIVE = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';
const MAX_SEED = 0xFFFFFFFF;

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export default function ImageGen() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsOpen = searchParams.get('settings') === '1';
  const openSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('settings', '1'); return n; });
  const closeSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('settings'); return n; });
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [models, setModels] = useState([]);
  const [availableLoras, setAvailableLoras] = useState([]);
  const [gallery, setGallery] = useState([]);
  const [preview, setPreview] = useState(null);

  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE);
  const [modelId, setModelId] = useState('');
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState('');
  const [guidance, setGuidance] = useState('');
  const [cfgScale, setCfgScale] = useState(7);
  const [quantize, setQuantize] = useState('8');
  const [seed, setSeed] = useState('');
  const [selectedLoras, setSelectedLoras] = useState([]);

  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [localProgress, setLocalProgress] = useState(null); // local mode SSE-driven 0..1
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);

  // External-mode socket-driven progress (kept for backward compat with
  // existing AUTOMATIC1111 wiring; the local mode also feeds the same hook
  // via imageGenEvents so the same UI bits light up).
  const { progress: externalProgress, begin: beginGenerate, end: endGenerate, resume: resumeGenerate } = useImageGenProgress();

  const isLocalMode = status?.mode === 'local';
  // Prefer the socket-driven hook (carries currentImage for both modes since
  // local mflux now writes stepwise frames). Fall back to the local SSE's
  // simpler progress shape if the hook hasn't received its first event yet.
  const progress = externalProgress || localProgress;
  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;

  const refreshStatus = useCallback(() => {
    setStatusLoading(true);
    getImageGenStatus()
      .then(setStatus)
      .catch(() => setStatus({ connected: false, reason: 'Status check failed' }))
      .finally(() => setStatusLoading(false));
  }, []);

  const refreshGallery = useCallback(() => {
    listImageGallery().then(setGallery).catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    listImageModels().then((m) => {
      setModels(m);
      if (m.length && !modelId) setModelId(m[0].id);
    }).catch(() => {});
    listLoras().then(setAvailableLoras).catch(() => {});
    refreshGallery();
    // Resume an in-flight job so the user can navigate away mid-render and
    // come back to the same prompt + settings + live preview frame.
    getActiveImageJob().then(({ activeJob }) => {
      if (!activeJob) return;
      if (activeJob.prompt) setPrompt(activeJob.prompt);
      if (activeJob.negativePrompt != null) setNegativePrompt(activeJob.negativePrompt);
      if (activeJob.modelId) setModelId(activeJob.modelId);
      if (activeJob.width) setWidth(activeJob.width);
      if (activeJob.height) setHeight(activeJob.height);
      if (activeJob.steps != null) setSteps(activeJob.steps);
      if (activeJob.guidance != null) setGuidance(activeJob.guidance);
      if (activeJob.seed != null) setSeed(activeJob.seed);
      if (activeJob.quantize != null) setQuantize(String(activeJob.quantize));
      setGenerating(true);
      setStatusMsg('Resuming…');
      resumeGenerate(activeJob);
      // Re-attach the per-job SSE so raw status text resumes too.
      const es = new EventSource(`/api/image-gen/${activeJob.generationId}/events`);
      eventSourceRef.current = es;
      es.onmessage = (e) => {
        if (typeof e.data !== 'string' || !e.data.startsWith('{')) return;
        const msg = safeParseJSON(e.data);
        if (!msg) return;
        if (msg.type === 'status') setStatusMsg(msg.message);
        if (msg.type === 'progress') setLocalProgress({ progress: msg.progress });
        if (msg.type === 'complete' || msg.type === 'error') {
          setGenerating(false);
          es.close();
        }
      };
    }).catch(() => {});
    return () => eventSourceRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentModel = models.find((m) => m.id === modelId);
  const matchedResolution = RESOLUTIONS.find((r) => r.w === width && r.h === height);
  const resolutionLabel = matchedResolution?.label || `${width}×${height}`;

  const handleResolutionChange = (e) => {
    const r = RESOLUTIONS.find((r) => r.label === e.target.value);
    if (r) { setWidth(r.w); setHeight(r.h); }
  };

  const handleRandomSeed = () => setSeed(String(Math.floor(Math.random() * MAX_SEED)));

  const startLocalGeneration = async () => {
    setLocalProgress({ progress: 0 });
    const payload = {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt.trim() || undefined,
      modelId: modelId || undefined,
      width, height,
      steps: steps ? Number(steps) : undefined,
      guidance: guidance ? Number(guidance) : undefined,
      seed: seed && Number(seed) >= 0 ? Number(seed) : undefined,
      quantize,
      loraPaths: selectedLoras.map((l) => l.path),
      loraScales: selectedLoras.map((l) => l.scale),
    };
    const data = await generateImage(payload);

    return new Promise((resolve, reject) => {
      const jobId = data.jobId || data.generationId;
      const es = new EventSource(`/api/image-gen/${jobId}/events`);
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
        if (typeof ev.data !== 'string' || !ev.data.startsWith('{')) return;
        const msg = safeParseJSON(ev.data);
        if (!msg) return;
        if (msg.type === 'status') setStatusMsg(msg.message);
        if (msg.type === 'progress') {
          setLocalProgress({ progress: msg.progress });
          setStatusMsg(msg.message);
        }
        if (msg.type === 'complete') {
          setResult({
            ...data,
            ...msg.result,
            prompt: payload.prompt,
            negativePrompt: payload.negativePrompt,
            width, height,
            steps: payload.steps ?? currentModel?.steps,
            guidance: payload.guidance ?? currentModel?.guidance,
          });
          es.close();
          resolve(msg.result);
        }
        if (msg.type === 'error') {
          es.close();
          reject(new Error(msg.error));
        }
      };
      es.onerror = () => {
        es.close();
        reject(new Error('Lost connection to server'));
      };
    });
  };

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setStatusMsg('Starting...');
    setError(null);
    setResult(null);
    // Both modes go through the socket-driven progress hook now — local mflux
    // emits stepwise frames via the imageGenEvents bus the same way external
    // SD API does, so the same hook drives the live preview for both.
    beginGenerate();

    try {
      if (isLocalMode) {
        await startLocalGeneration();
      } else {
        const payload = {
          prompt: prompt.trim(),
          negativePrompt: negativePrompt.trim() || undefined,
          width, height,
          steps: steps ? Number(steps) : 25,
          cfgScale,
        };
        if (seed && Number(seed) >= 0) payload.seed = Number(seed);
        const data = await generateImage(payload);
        setResult({ ...data, prompt: payload.prompt, negativePrompt: payload.negativePrompt, width, height, steps: payload.steps, cfgScale });
      }
      toast.success('Image generated');
      refreshGallery();
    } catch (err) {
      setError(err.message || 'Image generation failed');
      toast.error(err.message || 'Image generation failed');
    } finally {
      setGenerating(false);
      setLocalProgress(null);
      endGenerate();
    }
  };

  const handleCancel = async () => {
    eventSourceRef.current?.close();
    await cancelImageGen().catch(() => {});
    setGenerating(false);
    setStatusMsg('Cancelled');
  };

  const handleDelete = async (filename) => {
    await deleteImage(filename).catch(() => {});
    setGallery((g) => g.filter((img) => img.filename !== filename));
  };

  const sendToVideo = (filename) => {
    navigate(`/video-gen?sourceImageFile=${encodeURIComponent(filename)}`);
  };

  const handleRemix = (img) => {
    if (img.prompt) setPrompt(img.prompt);
    if (img.negativePrompt || img.negative_prompt) setNegativePrompt(img.negativePrompt || img.negative_prompt);
    if (img.seed != null) setSeed(String(img.seed));
    if (img.steps) setSteps(String(img.steps));
    if (img.guidance != null) setGuidance(String(img.guidance));
    if (img.quantize) setQuantize(String(img.quantize));
    if (img.width) setWidth(img.width);
    if (img.height) setHeight(img.height);
    if (img.modelId && models.some((m) => m.id === img.modelId)) setModelId(img.modelId);

    if (img.loraPaths?.length) {
      const restored = img.loraPaths.map((p, i) => {
        const match = availableLoras.find((l) => l.path === p);
        return match ? { path: match.path, name: match.name, scale: img.loraScales?.[i] ?? 1.0 } : null;
      }).filter(Boolean);
      setSelectedLoras(restored);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
              <><span className="w-2 h-2 rounded-full bg-port-success" /> {status.model || (status.mode === 'local' ? 'mflux/local' : 'external SD API')}</>
            ) : (
              <>
                <AlertTriangle className="w-3 h-3" />
                {status.reason || 'Not connected'} —
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
            title="Image Gen settings"
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
              placeholder="Describe the image you want to generate..."
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

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {isLocalMode && models.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Model</label>
                <select
                  value={modelId}
                  onChange={(e) => { setModelId(e.target.value); setSteps(''); setGuidance(''); }}
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
                {!matchedResolution && <option value={resolutionLabel}>{resolutionLabel} (custom)</option>}
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

            {isLocalMode ? (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">
                    Guidance {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}
                  </label>
                  <input
                    type="number" min={0} max={20} step={0.5}
                    value={guidance}
                    onChange={(e) => setGuidance(e.target.value)}
                    placeholder={String(currentModel?.guidance ?? '')}
                    disabled={generating}
                    className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">Quantize (bits)</label>
                  <select
                    value={quantize}
                    onChange={(e) => setQuantize(e.target.value)}
                    disabled={generating}
                    className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                  >
                    {['3', '4', '5', '6', '8'].map((q) => <option key={q} value={q}>{q}-bit{q === '8' ? ' (default)' : q === '4' ? ' (fast)' : ''}</option>)}
                  </select>
                </div>
              </>
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">CFG Scale ({cfgScale})</label>
                <input
                  type="range" min={1} max={20} step={0.5}
                  value={cfgScale}
                  disabled={generating}
                  onChange={(e) => setCfgScale(Number(e.target.value))}
                  className="w-full accent-port-accent"
                />
              </div>
            )}
          </div>

          {isLocalMode && availableLoras.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">LoRAs</label>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {availableLoras.map((lora) => {
                  const selected = selectedLoras.find((s) => s.path === lora.path);
                  return (
                    <div key={lora.path} className="flex items-center gap-3">
                      <label className="flex items-center gap-2 cursor-pointer flex-1">
                        <input
                          type="checkbox"
                          checked={!!selected}
                          disabled={generating}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedLoras((p) => [...p, { path: lora.path, name: lora.name, scale: 1.0 }]);
                            else setSelectedLoras((p) => p.filter((s) => s.path !== lora.path));
                          }}
                          className="rounded"
                        />
                        <span className="text-sm text-gray-300">{lora.name}</span>
                      </label>
                      {selected && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Scale</span>
                          <input
                            type="number" min={0} max={2} step={0.1}
                            value={selected.scale}
                            disabled={generating}
                            onChange={(e) => {
                              const scale = parseFloat(e.target.value) || 0;
                              setSelectedLoras((p) => p.map((s) => s.path === lora.path ? { ...s, scale } : s));
                            }}
                            className="w-20 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300">Preview</h2>
            {result && !generating && (
              <a href={result.path} download className="flex items-center gap-1 text-xs text-port-accent hover:underline">
                <Download className="w-3 h-3" /> Download
              </a>
            )}
          </div>

          <div className="aspect-square w-full bg-port-bg border border-port-border rounded-lg overflow-hidden flex items-center justify-center relative">
            {progress?.currentImage ? (
              <img src={`data:image/png;base64,${progress.currentImage}`} alt="Diffusing..." className="w-full h-full object-contain" />
            ) : result ? (
              <img src={result.path} alt={result.prompt} className="w-full h-full object-contain" />
            ) : generating ? (
              <div className="text-gray-500 text-sm flex flex-col items-center gap-2">
                <BrailleSpinner />
                <span>{statusMsg || 'Starting diffusion...'}</span>
              </div>
            ) : (
              <div className="text-gray-600 text-sm flex flex-col items-center gap-2">
                <ImageIcon className="w-12 h-12" />
                <span>Your generated image will appear here</span>
              </div>
            )}

            {generating && progressPct != null && (
              <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
              </div>
            )}
          </div>

          {result && !generating && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span className="truncate flex-1">{result.filename}</span>
              <span>{result.width}×{result.height}</span>
              {result.seed != null && <span>seed {result.seed}</span>}
              <button
                type="button"
                onClick={() => sendToVideo(result.filename)}
                className="flex items-center gap-1 px-2 py-1 bg-port-success/20 hover:bg-port-success/40 text-port-success rounded text-xs"
              >
                <Film className="w-3 h-3" /> Send to Video
              </button>
            </div>
          )}
        </div>
      </form>

      {gallery.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300">Recent renders ({Math.min(gallery.length, 6)} of {gallery.length})</h2>
            {gallery.length > 6 && (
              <Link to="/media/history" className="text-xs text-port-accent hover:underline">View all →</Link>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {gallery.slice(0, 6).map((img) => {
              const item = normalizeImage(img);
              return (
                <MediaCard
                  key={item.key}
                  item={item}
                  onPreview={() => setPreview(img)}
                  onRemix={() => handleRemix(img)}
                  onSendToVideo={() => sendToVideo(img.filename)}
                  onDelete={() => handleDelete(img.filename)}
                />
              );
            })}
          </div>
        </div>
      )}

      <MediaLightbox
        item={preview ? normalizeImage(preview) : null}
        onClose={() => setPreview(null)}
        onRemix={() => handleRemix(preview)}
        onSendToVideo={() => sendToVideo(preview.filename)}
      />


      <Drawer open={settingsOpen} onClose={closeSettings} title="Media Generation Settings">
        <ImageGenTab />
      </Drawer>
    </div>
  );
}
