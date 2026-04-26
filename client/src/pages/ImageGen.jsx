import { useState, useEffect, useCallback } from 'react';
import { Image as ImageIcon, Sparkles, Download, RefreshCw, Settings as SettingsIcon, Dice5, Copy, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import { useImageGenProgress } from '../hooks/useImageGenProgress';
import { generateImage, getImageGenStatus } from '../services/api';

const RESOLUTIONS = [
  { label: '512×512 (square)', w: 512, h: 512 },
  { label: '768×512 (landscape)', w: 768, h: 512 },
  { label: '512×768 (portrait)', w: 512, h: 768 },
  { label: '832×1216 (Flux portrait)', w: 832, h: 1216 },
  { label: '1024×1024 (HD square)', w: 1024, h: 1024 },
  { label: '1216×832 (Flux landscape)', w: 1216, h: 832 }
];

const DEFAULT_NEGATIVE = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';
const HISTORY_KEY = 'portos-image-gen-history';
const MAX_HISTORY = 24;
const MAX_SEED = 0xFFFFFFFF;

function loadHistory() {
  const raw = localStorage.getItem(HISTORY_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function saveHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
}

export default function ImageGen() {
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE);
  const [width, setWidth] = useState(768);
  const [height, setHeight] = useState(512);
  const [steps, setSteps] = useState(25);
  const [cfgScale, setCfgScale] = useState(7);
  const [seed, setSeed] = useState('');

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(() => loadHistory());

  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const { progress, begin: beginGenerate, end: endGenerate } = useImageGenProgress();

  const refreshStatus = useCallback(() => {
    setStatusLoading(true);
    getImageGenStatus()
      .then(setStatus)
      .catch(() => setStatus({ connected: false, reason: 'Status check failed' }))
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const handleResolutionChange = (e) => {
    const r = RESOLUTIONS.find(r => r.label === e.target.value);
    if (r) { setWidth(r.w); setHeight(r.h); }
  };

  const handleRandomSeed = () => {
    setSeed(String(Math.floor(Math.random() * MAX_SEED)));
  };

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    if (!prompt.trim() || generating) return;

    setGenerating(true);
    setResult(null);
    beginGenerate();

    const payload = {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt.trim() || undefined,
      width,
      height,
      steps,
      cfgScale
    };
    if (seed && Number(seed) >= 0) payload.seed = Number(seed);

    try {
      const data = await generateImage(payload);
      const entry = {
        id: data.generationId || data.filename,
        filename: data.filename,
        path: data.path,
        prompt: payload.prompt,
        negativePrompt: payload.negativePrompt || '',
        width, height, steps, cfgScale,
        seed: payload.seed ?? null,
        createdAt: Date.now()
      };
      setResult(entry);
      setHistory(prev => {
        const next = [entry, ...prev.filter(h => h.id !== entry.id)].slice(0, MAX_HISTORY);
        saveHistory(next);
        return next;
      });
      toast.success('Image generated');
    } catch (err) {
      toast.error(err.message || 'Image generation failed');
    } finally {
      setGenerating(false);
      endGenerate();
    }
  };

  const handleReusePrompt = (entry) => {
    setPrompt(entry.prompt);
    setNegativePrompt(entry.negativePrompt || DEFAULT_NEGATIVE);
    setWidth(entry.width);
    setHeight(entry.height);
    setSteps(entry.steps);
    setCfgScale(entry.cfgScale);
    setSeed(entry.seed != null ? String(entry.seed) : '');
    toast.success('Settings copied to form');
  };

  const handleClearHistory = () => {
    setHistory([]);
    saveHistory([]);
  };

  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;
  const matchedResolution = RESOLUTIONS.find(r => r.w === width && r.h === height);
  const resolutionLabel = matchedResolution?.label || `${width}×${height}`;
  const notConnected = status && status.connected === false;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ImageIcon className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Image Gen</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshStatus}
            disabled={statusLoading}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-50 min-h-[40px] min-w-[40px] flex items-center justify-center"
            title="Refresh API status"
          >
            <RefreshCw className={`w-4 h-4 ${statusLoading ? 'animate-spin' : ''}`} />
          </button>
          <Link
            to="/settings/image-gen"
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white border border-port-border rounded-lg hover:bg-port-border/50 min-h-[40px]"
          >
            <SettingsIcon className="w-4 h-4" /> Settings
          </Link>
        </div>
      </div>

      {status && (
        <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${
          status.connected
            ? 'border-port-success/40 bg-port-success/10 text-port-success'
            : 'border-port-error/40 bg-port-error/10 text-port-error'
        }`}>
          {status.connected
            ? <><span className="w-2 h-2 rounded-full bg-port-success" /> Connected — model: {status.model}</>
            : <><AlertTriangle className="w-4 h-4" /> {status.reason || 'Not connected'} — configure in <Link to="/settings/image-gen" className="underline">Settings</Link></>
          }
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,1.2fr] gap-6">
        <form onSubmit={handleGenerate} className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Prompt</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
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
              onChange={e => setNegativePrompt(e.target.value)}
              rows={3}
              disabled={generating}
              className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
              placeholder="What to avoid..."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Resolution</label>
              <select
                value={resolutionLabel}
                onChange={handleResolutionChange}
                disabled={generating}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {RESOLUTIONS.map(r => <option key={r.label} value={r.label}>{r.label}</option>)}
                {!matchedResolution && <option value={resolutionLabel}>{resolutionLabel} (custom)</option>}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={seed}
                  onChange={e => setSeed(e.target.value)}
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
              <label className="block text-xs font-medium text-gray-400 mb-1">Steps ({steps})</label>
              <input
                type="range"
                min={5}
                max={75}
                value={steps}
                disabled={generating}
                onChange={e => setSteps(Number(e.target.value))}
                className="w-full accent-port-accent"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">CFG Scale ({cfgScale})</label>
              <input
                type="range"
                min={1}
                max={20}
                step={0.5}
                value={cfgScale}
                disabled={generating}
                onChange={e => setCfgScale(Number(e.target.value))}
                className="w-full accent-port-accent"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              disabled={generating || !prompt.trim() || notConnected}
              className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors min-h-[40px]"
            >
              {generating ? <BrailleSpinner /> : <Sparkles className="w-4 h-4" />}
              {generating ? 'Generating...' : 'Generate'}
            </button>
            {generating && progressPct != null && (
              <span className="text-xs text-port-accent">{progressPct}%</span>
            )}
          </div>
        </form>

        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300">Preview</h2>
            {result && !generating && (
              <a
                href={result.path}
                download
                className="flex items-center gap-1 text-xs text-port-accent hover:underline"
              >
                <Download className="w-3 h-3" /> Download
              </a>
            )}
          </div>

          <div className="aspect-square w-full bg-port-bg border border-port-border rounded-lg overflow-hidden flex items-center justify-center relative">
            {progress?.currentImage ? (
              <img
                src={`data:image/png;base64,${progress.currentImage}`}
                alt="Diffusing..."
                className="w-full h-full object-contain"
              />
            ) : result ? (
              <img src={result.path} alt={result.prompt} className="w-full h-full object-contain" />
            ) : generating ? (
              <div className="text-gray-500 text-sm flex flex-col items-center gap-2">
                <BrailleSpinner />
                <span>Starting diffusion...</span>
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

          {generating && (
            <div className="text-xs text-gray-400 flex items-center justify-between">
              <span>
                {progress?.step != null && progress?.totalSteps
                  ? `Step ${progress.step}/${progress.totalSteps}`
                  : 'Waiting for first preview...'}
              </span>
              {progress?.eta != null && progress.eta > 0 && (
                <span>ETA: {progress.eta.toFixed(1)}s</span>
              )}
            </div>
          )}

          {result && !generating && (
            <div className="text-xs text-gray-400 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{result.filename}</span>
                <span className="shrink-0">{result.width}×{result.height}</span>
              </div>
              <div className="text-gray-500 line-clamp-2" title={result.prompt}>{result.prompt}</div>
            </div>
          )}
        </div>
      </div>

      {history.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300">Session History ({history.length})</h2>
            <button
              onClick={handleClearHistory}
              className="text-xs text-gray-500 hover:text-port-error transition-colors"
            >
              Clear
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {history.map(item => (
              <div key={item.id} className="group relative bg-port-bg border border-port-border rounded-lg overflow-hidden">
                <div className="aspect-square w-full">
                  <img src={item.path} alt={item.prompt} className="w-full h-full object-cover" loading="lazy" />
                </div>
                <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity p-2 flex flex-col justify-between">
                  <p className="text-xs text-gray-200 line-clamp-3" title={item.prompt}>{item.prompt}</p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleReusePrompt(item)}
                      className="flex-1 px-2 py-1 text-xs bg-port-accent/80 hover:bg-port-accent text-white rounded flex items-center justify-center gap-1 min-h-[32px]"
                      title="Reuse settings"
                    >
                      <Copy className="w-3 h-3" /> Reuse
                    </button>
                    <a
                      href={item.path}
                      download
                      className="px-2 py-1 text-xs bg-port-border hover:bg-port-border/70 text-white rounded flex items-center justify-center min-h-[32px]"
                      title="Download"
                    >
                      <Download className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            History is stored in your browser only. Files persist on the server in <code className="text-gray-400">./data/images/</code>.
          </p>
        </div>
      )}
    </div>
  );
}
