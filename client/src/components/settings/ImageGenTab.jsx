/**
 * Image Gen Settings — backend picker (External SD API / local mflux / Codex
 * CLI), per-mode configuration, and the "expose A1111 API on the tailnet"
 * toggle so other machines can use this PortOS as their image/video backend.
 * Codex appears as a backend tile only after the user enables it; the toggle
 * lives in the always-visible Codex CLI Imagegen section.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Save, Image as ImageIcon, Zap, Wrench, Cloud, Cpu, Globe, AlertTriangle,
  Sparkles, Terminal
} from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import LocalSetupPanel from './LocalSetupPanel';
import {
  getSettings, updateSettings, getImageGenStatus, generateImage,
  registerTool, updateTool, getToolsList,
} from '../../services/api';

const SDAPI_TOOL_ID = 'sdapi';
const CODEX_TOOL_ID = 'codex-imagegen';
const DEFAULT_TEST_PROMPT = 'a small cyberpunk fox sitting on a neon-lit rooftop at night, cinematic, highly detailed';
const normalizeUrl = (url) => (url || '').trim().replace(/\/+$/, '');

export function ImageGenTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Mode + per-mode config
  const [mode, setMode] = useState('external');
  const [sdapiUrl, setSdapiUrl] = useState('');
  const [pythonPath, setPythonPath] = useState('');
  const [exposeA1111, setExposeA1111] = useState(false);
  // Codex CLI provider config — gated by `codexEnabled` so users without
  // a paid Codex plan that includes image_gen can hide the option entirely.
  const [codexEnabled, setCodexEnabled] = useState(false);
  const [codexPath, setCodexPath] = useState('');
  const [codexModel, setCodexModel] = useState('');

  // Snapshot of saved values so we can show the "dirty" state
  const [saved, setSaved] = useState({
    mode: 'external', sdapiUrl: '', pythonPath: '', exposeA1111: false,
    codexEnabled: false, codexPath: '', codexModel: '',
  });

  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [toolRegistered, setToolRegistered] = useState(false);
  const [codexToolRegistered, setCodexToolRegistered] = useState(false);

  const [testPrompt, setTestPrompt] = useState(DEFAULT_TEST_PROMPT);
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState(null);
  const renderEsRef = useRef(null);

  // Close any in-flight test-render SSE on unmount so we don't fire setState
  // on a torn-down component if the user navigates away mid-render.
  useEffect(() => () => renderEsRef.current?.close(), []);

  useEffect(() => {
    Promise.all([getSettings(), getToolsList()])
      .then(([s, tools]) => {
        const ig = s?.imageGen || {};
        const m = ig.mode || 'external';
        const url = normalizeUrl(ig.external?.sdapiUrl || ig.sdapiUrl);
        const py = ig.local?.pythonPath || '';
        const expose = ig.expose?.a1111 === true;
        const cx = ig.codex || {};
        const cxEnabled = cx.enabled === true;
        const cxPath = cx.codexPath || '';
        const cxModel = cx.model || '';
        setMode(m);
        setSdapiUrl(url);
        setPythonPath(py);
        setExposeA1111(expose);
        setCodexEnabled(cxEnabled);
        setCodexPath(cxPath);
        setCodexModel(cxModel);
        setSaved({
          mode: m, sdapiUrl: url, pythonPath: py, exposeA1111: expose,
          codexEnabled: cxEnabled, codexPath: cxPath, codexModel: cxModel,
        });
        setToolRegistered(tools.some((t) => t.id === SDAPI_TOOL_ID));
        setCodexToolRegistered(tools.some((t) => t.id === CODEX_TOOL_ID));
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

  const isDirty = mode !== saved.mode
    || normalizeUrl(sdapiUrl) !== saved.sdapiUrl
    || pythonPath !== saved.pythonPath
    || exposeA1111 !== saved.exposeA1111
    || codexEnabled !== saved.codexEnabled
    || codexPath !== saved.codexPath
    || codexModel !== saved.codexModel;

  const handleSave = async () => {
    setSaving(true);
    const url = normalizeUrl(sdapiUrl) || undefined;
    const cxPath = codexPath?.trim() || undefined;
    const cxModel = codexModel?.trim() || undefined;
    const patch = {
      imageGen: {
        mode,
        external: { sdapiUrl: url },
        local: { pythonPath: pythonPath || undefined },
        codex: { enabled: codexEnabled, codexPath: cxPath, model: cxModel },
        expose: { a1111: exposeA1111 },
        // Keep the legacy field populated so anything still reading
        // `imageGen.sdapiUrl` directly stays working.
        sdapiUrl: url,
      },
    };
    try {
      await updateSettings(patch);
      setSaved({
        mode, sdapiUrl: url || '', pythonPath, exposeA1111,
        codexEnabled, codexPath, codexModel,
      });
      toast.success('Image gen settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
      setSaving(false);
      return;
    }

    // Both tool entries are independent — sync them in parallel so a
    // tailnet save doesn't pay two sequential HTTP round-trips.
    const sdEnabled = mode === 'external' ? !!url : (mode === 'local' ? !!pythonPath : false);
    const sdToolData = {
      name: mode === 'external' ? 'Stable Diffusion (External)' : (mode === 'local' ? 'Stable Diffusion (Local mflux)' : 'Stable Diffusion'),
      category: 'image-generation',
      description: 'Generate images via the active PortOS image gen backend',
      enabled: sdEnabled,
      config: { mode, sdapiUrl: url, pythonPath },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, negativePrompt, width, height, steps }. Use POST /api/image-gen/avatar for character portraits.',
    };
    const codexToolData = {
      name: 'Codex Imagegen',
      category: 'image-generation',
      description: 'Generate images via the Codex CLI built-in image_gen tool ($imagegen prompt prefix). Requires a Codex plan that includes image_gen.',
      enabled: codexEnabled,
      config: { codexPath: cxPath, model: cxModel },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, mode: "codex" } — or call the image_generate voice tool with provider: "codex".',
    };

    const syncTool = async ({ id, registered, data, shouldCreate, onCreated, errLabel }) => {
      if (registered) {
        return updateTool(id, data).catch((err) => toast.error(err.message || `Failed to update ${errLabel}`));
      }
      if (shouldCreate) {
        try {
          await registerTool({ id, ...data });
          onCreated?.();
        } catch (err) {
          toast.error(err.message || `Failed to register ${errLabel}`);
        }
      }
    };

    await Promise.all([
      syncTool({
        id: SDAPI_TOOL_ID, registered: toolRegistered, data: sdToolData,
        shouldCreate: sdEnabled, onCreated: () => setToolRegistered(true),
        errLabel: 'CoS tools registry',
      }),
      syncTool({
        id: CODEX_TOOL_ID, registered: codexToolRegistered, data: codexToolData,
        shouldCreate: codexEnabled, onCreated: () => setCodexToolRegistered(true),
        errLabel: 'Codex Imagegen tool',
      }),
    ]);

    setSaving(false);
  };

  const handleRenderTest = async () => {
    if (!testPrompt.trim() || rendering) return;
    setRendering(true);
    setRenderResult(null);
    try {
      // Use the saved mode for the test render. Codex is async like local
      // (returns a job descriptor immediately) so the SSE branch handles it.
      const result = await generateImage({ prompt: testPrompt.trim(), mode });
      // Local + Codex modes return immediately after spawning the child —
      // the PNG isn't on disk yet. Subscribe to the per-job SSE and only
      // mark the render complete on the `complete` event (or fail on
      // `error`). External mode awaits internally and the file is on disk
      // by the time generateImage resolves, so we can short-circuit.
      const isAsync = (result?.mode === 'local' || result?.mode === 'codex');
      if (isAsync && result?.generationId) {
        await new Promise((resolve, reject) => {
          const es = new EventSource(`/api/image-gen/${result.generationId}/events`);
          renderEsRef.current = es;
          const closeEs = () => { es.close(); renderEsRef.current = null; };
          es.onmessage = (e) => {
            const msg = (() => { try { return JSON.parse(e.data); } catch { return null; } })();
            if (!msg) return;
            if (msg.type === 'complete') {
              closeEs();
              setRenderResult({ ...result, ...msg.result });
              resolve();
            } else if (msg.type === 'error') {
              closeEs();
              reject(new Error(msg.error || 'Generation failed'));
            }
          };
          es.onerror = () => { closeEs(); reject(new Error('Lost connection during test render')); };
        });
      } else {
        setRenderResult(result);
      }
      toast.success('Test render complete');
    } catch (err) {
      toast.error(err.message || 'Test render failed');
    } finally {
      setRendering(false);
    }
  };

  if (loading) return <BrailleSpinner text="Loading image gen settings" />;

  // The advertised A1111 URL must be the canonical user-facing endpoint
  // (`<tailscale-host>.<tailnet>.ts.net:5555` / `<tailscale-ip>:5555`), not
  // the loopback HTTP mirror at :5553 or a localhost dev URL — those aren't
  // reachable from other tailnet machines.
  const advertisedA1111Url = (() => {
    if (typeof window === 'undefined') return null;
    const h = window.location.hostname;
    // Local dev / loopback mirror — we can't infer the tailnet hostname
    // from the browser; tell the user to look it up.
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return null;
    // Real tailnet host — use the canonical user-facing port (:5555) and
    // match the currently-active scheme so the hint works in both HTTPS-on
    // (Tailscale cert provisioned) and HTTP-only PortOS deployments.
    const scheme = window.location.protocol === 'http:' ? 'http' : 'https';
    return `${scheme}://${h}:5555`;
  })();

  return (
    <div className="space-y-5">
      {/* Mode picker */}
      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <ImageIcon size={18} />
          <h2 className="text-lg font-semibold">Backend</h2>
        </div>
        <p className="text-xs text-gray-500">
          PortOS can either talk to a remote AUTOMATIC1111 / Forge server or run image
          generation locally with mflux on this Mac. Pick whichever fits — you can also
          expose this PortOS as an A1111-compatible endpoint for other tailnet boxes.
        </p>
        <div className={`grid grid-cols-1 sm:grid-cols-2 ${codexEnabled ? 'lg:grid-cols-3' : ''} gap-3`}>
          <button
            type="button"
            onClick={() => setMode('external')}
            className={`text-left p-4 rounded-lg border transition-colors ${mode === 'external' ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-400 hover:bg-port-border/30 hover:text-white'}`}
          >
            <div className="flex items-center gap-2">
              <Cloud className="w-4 h-4" />
              <span className="font-medium text-sm">External SD API</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">Forward to a remote AUTOMATIC1111 / Forge server (e.g. another tailnet box).</p>
          </button>
          <button
            type="button"
            onClick={() => setMode('local')}
            className={`text-left p-4 rounded-lg border transition-colors ${mode === 'local' ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-400 hover:bg-port-border/30 hover:text-white'}`}
          >
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4" />
              <span className="font-medium text-sm">Local (mflux)</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">Run Flux + LTX models on this machine. Apple Silicon recommended.</p>
          </button>
          {codexEnabled && (
            <button
              type="button"
              onClick={() => setMode('codex')}
              className={`text-left p-4 rounded-lg border transition-colors ${mode === 'codex' ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-400 hover:bg-port-border/30 hover:text-white'}`}
            >
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4" />
                <span className="font-medium text-sm">Codex CLI</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Route through the Codex CLI built-in image_gen tool. Counts against your Codex plan.</p>
            </button>
          )}
        </div>
      </div>

      {/* External-mode config */}
      {mode === 'external' && (
        <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-medium text-gray-300">External AUTOMATIC1111 / Forge URL</h3>
          <input
            type="text"
            value={sdapiUrl}
            onChange={(e) => setSdapiUrl(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
            placeholder="http://localhost:7860"
          />
          <p className="text-xs text-gray-500">Base URL for the SD WebUI server PortOS should send generation requests to.</p>
        </div>
      )}

      {/* Local-mode config */}
      {mode === 'local' && (
        <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-medium text-gray-300">Local Python (mflux + mlx_video)</h3>
          <p className="text-xs text-gray-500">
            Pick a Python 3.10+ interpreter — PortOS auto-detects venvs and conda installs and can install
            missing packages directly. HF model weights stream into the standard <code>~/.cache/huggingface</code>
            and are surfaced in <a href="/media/models" className="text-port-accent hover:underline">Media → Models</a>.
          </p>
          <LocalSetupPanel pythonPath={pythonPath} onPythonPathChange={setPythonPath} />
        </div>
      )}

      {/* Codex CLI config — always visible (the toggle that enables the
          option lives here). Codex appears as a backend tile only after
          the user flips this on. */}
      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <Terminal size={18} />
          <h2 className="text-lg font-semibold">Codex CLI Imagegen</h2>
        </div>
        <p className="text-xs text-gray-500">
          Route image generation through the Codex CLI's built-in
          <code className="text-gray-400"> image_gen </code> tool — invoked headlessly with a
          <code className="text-gray-400"> $imagegen </code> prompt. Uses your logged-in Codex session, no
          OPENAI_API_KEY required. Not every Codex plan exposes
          <code className="text-gray-400"> image_gen </code>; if yours doesn't, leave this off.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={codexEnabled}
            onChange={(e) => {
              const v = e.target.checked;
              setCodexEnabled(v);
              // If the user just disabled Codex while it was the active
              // backend, fall back to external so saving doesn't leave the
              // dispatcher pointing at a disabled provider.
              if (!v && mode === 'codex') setMode('external');
            }}
            className="rounded"
          />
          <span className="text-sm text-gray-300">Enable Codex Imagegen</span>
        </label>
        {codexEnabled && (
          <div className="space-y-3 pl-6 border-l-2 border-port-border">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Codex binary path (optional)</label>
              <input
                type="text"
                value={codexPath}
                onChange={(e) => setCodexPath(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                placeholder="codex (uses $PATH)"
              />
              <p className="text-xs text-gray-500 mt-1">Leave empty to invoke <code>codex</code> from $PATH.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Model override (optional)</label>
              <input
                type="text"
                value={codexModel}
                onChange={(e) => setCodexModel(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                placeholder="gpt-5.4"
              />
              <p className="text-xs text-gray-500 mt-1">Passed as <code>codex exec -m &lt;model&gt;</code>. Leave empty to use Codex's default.</p>
            </div>
          </div>
        )}
      </div>

      {/* Save + status */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
        >
          {saving ? <BrailleSpinner /> : <Save size={14} />}
          Save
        </button>
        <button
          type="button"
          onClick={checkStatus}
          disabled={checking || isDirty}
          className="flex items-center gap-2 px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
          title={isDirty ? 'Save settings first to test' : 'Probe the active backend'}
        >
          {checking ? <BrailleSpinner /> : <Zap size={14} />}
          Test Connection
        </button>
        {status && (
          <span className={`text-sm ${status.connected ? 'text-port-success' : 'text-port-error'}`}>
            {status.connected
              ? `${status.mode} — ${status.model || status.pythonPath}`
              : status.reason || 'Not connected'}
          </span>
        )}
      </div>

      {/* Tailnet expose */}
      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <Globe size={18} />
          <h2 className="text-lg font-semibold">Expose as A1111 API on the Tailnet</h2>
        </div>
        <p className="text-xs text-gray-500">
          When enabled, PortOS mounts an AUTOMATIC1111-compatible surface at
          <code className="text-gray-400"> /sdapi/v1/* </code> so other machines on your tailnet can point any A1111 client at this box and use whichever backend you picked above. Off by default — flip on only when you actually want to share this server.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={exposeA1111}
            onChange={(e) => setExposeA1111(e.target.checked)}
            className="rounded"
          />
          <span className="text-sm text-gray-300">Enable <code className="text-gray-400">/sdapi/v1/*</code></span>
        </label>
        {exposeA1111 && (
          <div className="text-xs space-y-1 bg-port-bg border border-port-border rounded-lg p-3">
            <div className="flex items-center gap-1 text-port-warning">
              <AlertTriangle className="w-3 h-3" /> Anyone with tailnet access to this host can hit the API. PortOS does not authenticate.
            </div>
            <div className="text-gray-400">
              {advertisedA1111Url ? (
                <>Other machines should set their SD API URL to <code className="text-gray-300">{advertisedA1111Url}</code></>
              ) : (
                <>Other machines should set their SD API URL to <code className="text-gray-300">https://&lt;your-tailscale-host&gt;:5555</code> (run <code className="text-gray-300">tailscale status</code> on this machine to see the hostname).</>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Test render */}
      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <Sparkles size={18} />
          <h2 className="text-lg font-semibold">Test Render</h2>
        </div>
        <p className="text-xs text-gray-500">
          Send a prompt through the active backend to verify end-to-end. For richer controls, visit the
          <a href="/media/image" className="text-port-accent hover:underline ml-1">Image Gen</a> page.
        </p>
        <textarea
          value={testPrompt}
          onChange={(e) => setTestPrompt(e.target.value)}
          rows={2}
          disabled={rendering}
          className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
          placeholder="Describe the image you want..."
        />
        <button
          type="button"
          onClick={handleRenderTest}
          disabled={rendering || isDirty || !testPrompt.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
          title={isDirty ? 'Save settings first' : 'Generate a test image'}
        >
          {rendering ? <BrailleSpinner /> : <Sparkles size={14} />}
          {rendering ? 'Rendering...' : 'Render Test Image'}
        </button>
        {renderResult && (
          <div className="border border-port-border rounded-lg overflow-hidden bg-port-bg">
            <img
              src={renderResult.path}
              alt="Test render"
              className="w-full max-w-md mx-auto object-contain"
            />
            <div className="px-3 py-2 text-xs text-gray-400 flex items-center justify-between border-t border-port-border">
              <span className="truncate">Saved: {renderResult.filename}</span>
              <a href={renderResult.path} download className="text-port-accent hover:underline ml-2 shrink-0">Download</a>
            </div>
          </div>
        )}
      </div>

      {/* CoS integration footer */}
      <div className="text-xs text-gray-500 px-1 flex items-center gap-2">
        {toolRegistered && (
          <>
            <Wrench className="w-3 h-3" />
            Registered as CoS tool — agents can use this backend for briefings, avatars, and visual content.
          </>
        )}
      </div>
    </div>
  );
}

export default ImageGenTab;
