import { useState, useEffect, useCallback } from 'react';
import { Save, Image, Zap, Wrench, Wand2, Sparkles } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { useImageGenProgress } from '../../hooks/useImageGenProgress';
import {
  getSettings, updateSettings, getImageGenStatus, generateImage,
  registerTool, updateTool, getToolsList
} from '../../services/api';

const SDAPI_TOOL_ID = 'sdapi';
const DEFAULT_TEST_PROMPT = 'a small cyberpunk fox sitting on a neon-lit rooftop at night, cinematic, highly detailed';

const normalizeUrl = (url) => (url || '').trim().replace(/\/+$/, '');

export function ImageGenTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sdapiUrl, setSdapiUrl] = useState('');
  const [savedUrl, setSavedUrl] = useState('');
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [toolRegistered, setToolRegistered] = useState(false);

  const [testPrompt, setTestPrompt] = useState(DEFAULT_TEST_PROMPT);
  const [testNegativePrompt, setTestNegativePrompt] = useState('');
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState(null);
  const { progress: renderProgress, begin: beginRender, end: endRender } = useImageGenProgress();

  useEffect(() => {
    Promise.all([getSettings(), getToolsList()])
      .then(([settings, tools]) => {
        const url = normalizeUrl(settings?.imageGen?.sdapiUrl);
        setSdapiUrl(url);
        setSavedUrl(url);
        setToolRegistered(tools.some(t => t.id === SDAPI_TOOL_ID));
      })
      .catch(() => toast.error('Failed to load image gen settings'))
      .finally(() => setLoading(false));
  }, []);

  const checkStatus = useCallback(() => {
    setChecking(true);
    getImageGenStatus()
      .then(setStatus)
      .catch(() => setStatus({ connected: false, reason: 'Check failed' }))
      .finally(() => setChecking(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const url = normalizeUrl(sdapiUrl) || undefined;

    try {
      await updateSettings({ imageGen: { sdapiUrl: url } });
      setSavedUrl(url || '');
      toast.success('Image gen settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
      setSaving(false);
      return;
    }

    const toolData = {
      name: 'Stable Diffusion',
      category: 'image-generation',
      description: 'Generate images via Stable Diffusion API (AUTOMATIC1111 / Forge WebUI)',
      enabled: !!url,
      config: { sdapiUrl: url },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, negativePrompt, width, height, steps, cfgScale }. Use POST /api/image-gen/avatar for character portraits.'
    };
    if (toolRegistered) {
      await updateTool(SDAPI_TOOL_ID, toolData).catch(err => {
        toast.error(err.message || 'Failed to update CoS tools registry');
      });
    } else if (url) {
      try {
        await registerTool({ id: SDAPI_TOOL_ID, ...toolData });
        setToolRegistered(true);
      } catch (err) {
        toast.error(err.message || 'Failed to register in CoS tools registry');
      }
    }

    setSaving(false);
  };

  const handleRenderTest = async () => {
    if (!testPrompt.trim() || rendering) return;
    setRendering(true);
    setRenderResult(null);
    beginRender();

    try {
      const result = await generateImage({
        prompt: testPrompt.trim(),
        negativePrompt: testNegativePrompt.trim() || undefined
      });
      setRenderResult(result);
      toast.success('Test render complete');
    } catch (err) {
      toast.error(err.message || 'Test render failed');
    } finally {
      setRendering(false);
      endRender();
    }
  };

  if (loading) return <BrailleSpinner text="Loading image gen settings" />;

  const isDirty = normalizeUrl(sdapiUrl) !== savedUrl;
  const canRender = !!savedUrl && status?.connected !== false;
  const progressPct = renderProgress?.progress != null ? Math.round(renderProgress.progress * 100) : null;

  return (
    <div className="space-y-5">
      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-2 text-white">
          <Image size={18} />
          <h2 className="text-lg font-semibold">Stable Diffusion API</h2>
        </div>

        <div className="space-y-1">
          <label className="block text-sm text-gray-400">API URL</label>
          <p className="text-xs text-gray-500 mb-1">
            Base URL for AUTOMATIC1111 / Forge WebUI (e.g. http://localhost:7860)
          </p>
          <input
            type="text"
            value={sdapiUrl}
            onChange={e => setSdapiUrl(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
            placeholder="http://localhost:7860"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
          >
            {saving ? <BrailleSpinner /> : <Save size={14} />}
            Save
          </button>

          <button
            onClick={checkStatus}
            disabled={checking || !sdapiUrl.trim() || isDirty}
            className="flex items-center gap-2 px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
            title={isDirty ? 'Save settings first to test' : 'Test connection to SD API'}
          >
            {checking ? <BrailleSpinner /> : <Zap size={14} />}
            Test Connection
          </button>
        </div>

        {status && (
          <div className={`flex items-center gap-2 text-sm ${status.connected ? 'text-port-success' : 'text-port-error'}`}>
            <span className={`w-2 h-2 rounded-full ${status.connected ? 'bg-port-success' : 'bg-port-error'}`} />
            {status.connected ? `Connected — model: ${status.model}` : status.reason || 'Not connected'}
          </div>
        )}

        <div className="border-t border-port-border pt-4 space-y-2">
          <h3 className="text-sm font-medium text-gray-300">CoS Integration</h3>
          <p className="text-xs text-gray-500">
            When configured, this tool is registered with the CoS tools registry. Agents can use it to generate
            images for briefings, character avatars, and other visual content. Images are stored in <code className="text-gray-400">./data/images/</code>.
          </p>
          {toolRegistered && (
            <div className="flex items-center gap-2 text-xs text-port-success">
              <Wrench size={12} />
              Registered as CoS tool
            </div>
          )}
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <Wand2 size={18} />
          <h2 className="text-lg font-semibold">Test Render</h2>
        </div>
        <p className="text-xs text-gray-500">
          Send a real prompt to your SD API to verify generation end-to-end. For a richer experience visit the <a href="/image-gen" className="text-port-accent hover:underline">Image Gen</a> page.
        </p>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-400">Prompt</label>
          <textarea
            value={testPrompt}
            onChange={e => setTestPrompt(e.target.value)}
            rows={2}
            disabled={rendering}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
            placeholder="Describe the image you want..."
          />
        </div>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-400">Negative Prompt (optional)</label>
          <textarea
            value={testNegativePrompt}
            onChange={e => setTestNegativePrompt(e.target.value)}
            rows={2}
            disabled={rendering}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
            placeholder="What to avoid (uses sensible default if blank)..."
          />
        </div>

        <button
          onClick={handleRenderTest}
          disabled={rendering || !canRender || !testPrompt.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
          title={!canRender ? 'Save settings and verify connection first' : 'Generate a test image'}
        >
          {rendering ? <BrailleSpinner /> : <Sparkles size={14} />}
          {rendering ? 'Rendering...' : 'Render Test Image'}
        </button>

        {(rendering || renderResult) && (
          <div className="border border-port-border rounded-lg overflow-hidden bg-port-bg">
            <div className="aspect-square w-full max-w-md mx-auto relative">
              {renderProgress?.currentImage ? (
                <img
                  src={`data:image/png;base64,${renderProgress.currentImage}`}
                  alt="Diffusing..."
                  className="w-full h-full object-contain"
                />
              ) : renderResult ? (
                <img
                  src={renderResult.path}
                  alt="Test render"
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm">
                  Waiting for first preview...
                </div>
              )}
              {rendering && progressPct != null && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40">
                  <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
                </div>
              )}
            </div>
            {rendering && (
              <div className="px-3 py-2 text-xs text-gray-400 flex items-center justify-between border-t border-port-border">
                <span>
                  {renderProgress?.step != null && renderProgress?.totalSteps
                    ? `Step ${renderProgress.step}/${renderProgress.totalSteps}`
                    : 'Starting diffusion...'}
                </span>
                {progressPct != null && <span className="text-port-accent">{progressPct}%</span>}
              </div>
            )}
            {!rendering && renderResult && (
              <div className="px-3 py-2 text-xs text-gray-400 flex items-center justify-between border-t border-port-border">
                <span className="truncate">Saved: {renderResult.filename}</span>
                <a href={renderResult.path} download className="text-port-accent hover:underline ml-2 shrink-0">Download</a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ImageGenTab;
