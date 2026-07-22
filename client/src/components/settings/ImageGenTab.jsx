/**
 * Image Gen Settings — backend picker (External SD API / local mflux / Codex
 * CLI), per-mode configuration, and the "expose A1111 API on the tailnet"
 * toggle so other machines can use this PortOS as their image/video backend.
 * Codex appears as a backend tile only after the user enables it; the toggle
 * lives in the always-visible Codex CLI Imagegen section.
 */

import { useState, useEffect, useCallback, useId } from 'react';
import {
  Save, Image as ImageIcon, Zap, Wrench, Cloud, Cpu, Globe, AlertTriangle,
  Sparkles, Terminal, Key, Check, Trash2
} from 'lucide-react';
import toast from '../ui/Toast';
import TabPills from '../ui/TabPills';
import BrailleSpinner from '../BrailleSpinner';
import LocalSetupPanel from './LocalSetupPanel';
import useDrawerTab from '../../hooks/useDrawerTab';
import { isLoopbackHost } from '../../lib/loopbackHost.js';
import {
  getSettings, updateSettings, getImageGenStatus, generateImage,
  registerTool, updateTool, getToolsList,
  getHfTokenStatus, saveHfToken, clearHfToken,
} from '../../services/api';
import { IMAGE_GEN_MODE, CODEX_IMAGEGEN_DEFAULT_EFFORT, GROK_ASPECT_RATIOS } from '../../lib/imageGenBackends';
import { resolveCleanersFromConfig } from '../../lib/imageCleaners';
import { useMediaJobSse } from '../../hooks/useMediaJobSse';
import { CODEX_EFFORT_LEVELS } from '../../utils/providers';

const SDAPI_TOOL_ID = 'sdapi';
const CODEX_TOOL_ID = 'codex-imagegen';
const GROK_TOOL_ID = 'grok-imagegen';
// Mirror of server/services/imageGen/modes.js — shown as placeholder/default
// hints so the user sees what a blank Model / Effort field will actually use.
// The server owns the real default; these are display-only. The effort default
// lives in the shared imageGenBackends lib (imported above) so the Render Queue
// and this settings form don't drift; the model default stays local (only used
// here as a placeholder string).
const CODEX_IMAGEGEN_DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_TEST_PROMPT = 'a small cyberpunk fox sitting on a neon-lit rooftop at night, cinematic, highly detailed';
const normalizeUrl = (url) => (url || '').trim().replace(/\/+$/, '');

// Fallback bounds used until /api/settings has been fetched once. The server
// is the source of truth (returns `imageGen.codex.parallelLimitBounds` with
// the real min/max/default), so these only matter for the first paint.
const PARALLEL_FALLBACK = { min: 1, max: 10, default: 1 };
const clampParallel = (n, bounds = PARALLEL_FALLBACK) =>
  Math.max(bounds.min, Math.min(bounds.max, Math.floor(Number(n) || bounds.default)));

// Sub-navigation for this settings surface. Rendered as internal TabPills
// (pills variant + mobile <select>) rather than a tabbed <Drawer>, so the same
// grouping works whether ImageGenTab is hosted in a plain Drawer (ImageGen /
// VideoGen / StoryboardPanel) or elsewhere — no tabs-within-tabs. The active
// tab deep-links via the `mediaTab` search param (useDrawerTab).
const MEDIA_TABS = [
  { id: 'backend', label: 'Backend', icon: ImageIcon },
  { id: 'external', label: 'External', icon: Cloud },
  { id: 'local', label: 'Local', icon: Cpu },
  { id: 'codex', label: 'Codex CLI', icon: Terminal },
  { id: 'grok', label: 'Grok CLI', icon: Sparkles },
  { id: 'tokens', label: 'Tokens', icon: Key },
  { id: 'expose', label: 'Expose', icon: Globe },
  { id: 'test', label: 'Test', icon: Sparkles },
];
const MEDIA_TAB_IDS = MEDIA_TABS.map((t) => t.id);

export function ImageGenTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Deep-linkable active sub-tab, backed by the `mediaTab` search param so the
  // open section survives reload/share and is reachable from a bookmark. A
  // stale/hand-edited value degrades to 'backend'.
  const [mediaTab, setMediaTab] = useDrawerTab('mediaTab', 'backend', MEDIA_TAB_IDS);

  // The Local tab hosts LocalSetupPanel, which owns a long-running pip-install
  // EventSource (`useInstallStream`) — a torch upgrade can run 10+ minutes.
  // The other tabs unmount when inactive, but unmounting the installer mid-run
  // closes its stream and the server treats `req.close` as cancellation,
  // killing pip. So the Local tab is lazily mounted on first visit (to avoid a
  // cold python-env probe before the user ever opens it) and then kept mounted,
  // hidden via CSS when inactive, so a tab switch never aborts an install.
  const [localMounted, setLocalMounted] = useState(false);
  useEffect(() => {
    if (mediaTab === 'local') setLocalMounted(true);
  }, [mediaTab]);

  // Mode + per-mode config
  const [mode, setMode] = useState(IMAGE_GEN_MODE.EXTERNAL);
  const [sdapiUrl, setSdapiUrl] = useState('');
  const [pythonPath, setPythonPath] = useState('');
  const [exposeA1111, setExposeA1111] = useState(false);
  // Codex CLI provider config — gated by `codexEnabled` so users without
  // a paid Codex plan that includes image_gen can hide the option entirely.
  const [codexEnabled, setCodexEnabled] = useState(false);
  const [codexPath, setCodexPath] = useState('');
  const [codexModel, setCodexModel] = useState('');
  // Empty = use the shipped default effort (CODEX_IMAGEGEN_DEFAULT_EFFORT).
  const [codexEffort, setCodexEffort] = useState('');
  const [codexParallelLimit, setCodexParallelLimit] = useState(1);
  // Grok Build CLI provider config — gated by `grokEnabled` the same way as
  // Codex (renders spend the user's Grok quota). No model/effort fields:
  // grok's image tools run on xAI's fixed image backend.
  const [grokEnabled, setGrokEnabled] = useState(false);
  const [grokPath, setGrokPath] = useState('');
  // Empty = let the caller's width/height (or the tool default) decide.
  const [grokAspectRatio, setGrokAspectRatio] = useState('');
  // Per-provider cleaner toggles. Both run after the PNG lands and before
  // the SSE complete event so subscribers see the cleaned bytes. SynthID
  // (the gpt-image / Imagen / Gemini pixel-level watermark) is unaffected
  // by either of these — a future "Clean SynthID" diffusion option will
  // address it separately.
  //   - cleanC2PA (default ON): byte-level strip of the gpt-image `caBX`
  //     provenance chunk. Lossless — pixels untouched.
  //   - denoise   (default OFF): median(3) + sharpen pass for AI-artifact
  //     reduction. LOSSY: blurs annotation text and small details.
  const [cleanC2PAByMode, setCleanC2PAByMode] = useState({ external: true, local: true, codex: true, grok: false });
  const [denoiseByMode, setDenoiseByMode] = useState({ external: false, local: false, codex: false, grok: false });
  const setCleanC2PAFor = (m) => (v) => setCleanC2PAByMode((p) => ({ ...p, [m]: v }));
  const setDenoiseFor = (m) => (v) => setDenoiseByMode((p) => ({ ...p, [m]: v }));
  // Raw string held while the user is typing in the parallel-limit input.
  // Clamping is deferred to onBlur so multi-digit entry isn't blocked.
  const [parallelLimitDraft, setParallelLimitDraft] = useState('1');
  // Server-authoritative bounds for the parallel-limit input. Populated from
  // /api/settings's `imageGen.codex.parallelLimitBounds`; falls back to local
  // constants until the first fetch resolves.
  const [parallelBounds, setParallelBounds] = useState(PARALLEL_FALLBACK);

  // Stable ids for label/input associations
  const codexPathId = useId();
  const codexModelId = useId();
  const codexEffortId = useId();
  const codexParallelId = useId();
  const grokPathId = useId();
  const grokRatioId = useId();

  // Snapshot of saved values so we can show the "dirty" state
  const [saved, setSaved] = useState({
    mode: IMAGE_GEN_MODE.EXTERNAL, sdapiUrl: '', pythonPath: '', exposeA1111: false,
    codexEnabled: false, codexPath: '', codexModel: '', codexEffort: '', codexParallelLimit: 1,
    grokEnabled: false, grokPath: '', grokAspectRatio: '',
    cleanC2PAByMode: { external: true, local: true, codex: true, grok: false },
    denoiseByMode: { external: false, local: false, codex: false, grok: false },
  });

  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [toolRegistered, setToolRegistered] = useState(false);
  const [codexToolRegistered, setCodexToolRegistered] = useState(false);
  const [grokToolRegistered, setGrokToolRegistered] = useState(false);

  const [testPrompt, setTestPrompt] = useState(DEFAULT_TEST_PROMPT);
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState(null);
  // Shared per-job SSE subscriber — same hook ImageGen/VideoGen use to await
  // an async render's terminal frame after the kickoff POST returns a jobId.
  const { attach: attachRenderSse, close: closeRenderSse } = useMediaJobSse('image');

  // HuggingFace token state — separate from the main settings save flow because
  // it has its own validated endpoints (POST /setup/hf-token + DELETE) and
  // applies to local Flux models regardless of which backend is active.
  // `source` is 'stored' | 'env' | 'cli' | 'none'; only 'stored' tokens can be
  // cleared from the UI (env/CLI come from outside settings.json).
  const [hfTokenInfo, setHfTokenInfo] = useState({ hfTokenPresent: null, source: null });
  const [hfTokenInput, setHfTokenInput] = useState('');
  // One busy flag covers both save and clear since they're mutually exclusive
  // (both disable the form + buttons). `busy` is the in-flight verb so the
  // Clear button can still show a Trash icon while the spinner is on Save.
  const [hfTokenBusy, setHfTokenBusy] = useState(null); // null | 'saving' | 'clearing'

  useEffect(() => {
    getHfTokenStatus()
      .then((s) => { if (s) setHfTokenInfo({ hfTokenPresent: !!s.hfTokenPresent, source: s.source || null }); })
      .catch((err) => { console.warn(`⚠️ Failed to load HF token status: ${err?.message || err}`); });
  }, []);

  const handleSaveHfToken = async () => {
    const trimmed = hfTokenInput.trim();
    if (!trimmed) return;
    setHfTokenBusy('saving');
    const result = await saveHfToken(trimmed).catch(() => null);
    setHfTokenBusy(null);
    if (!result?.ok) return;
    setHfTokenInput('');
    setHfTokenInfo({ hfTokenPresent: true, source: result.source || 'stored' });
    toast.success('HuggingFace token saved');
  };

  const handleClearHfToken = async () => {
    setHfTokenBusy('clearing');
    const result = await clearHfToken().catch(() => null);
    setHfTokenBusy(null);
    if (!result?.ok) return;
    setHfTokenInfo({ hfTokenPresent: !!result.hfTokenPresent, source: result.source || 'none' });
    toast.success(result.hfTokenPresent ? 'Stored token cleared (env / CLI token still active)' : 'HuggingFace token cleared');
  };

  // Close any in-flight test-render SSE on unmount so we don't fire setState
  // on a torn-down component if the user navigates away mid-render.
  useEffect(() => () => closeRenderSse(), [closeRenderSse]);

  useEffect(() => {
    Promise.all([getSettings({ silent: true }), getToolsList({ silent: true })])
      .then(([s, tools]) => {
        const ig = s?.imageGen || {};
        const m = ig.mode || IMAGE_GEN_MODE.EXTERNAL;
        const url = normalizeUrl(ig.external?.sdapiUrl || ig.sdapiUrl);
        const py = ig.local?.pythonPath || '';
        const expose = ig.expose?.a1111 === true;
        const cx = ig.codex || {};
        const cxEnabled = cx.enabled === true;
        const cxPath = cx.codexPath || '';
        const cxModel = cx.model || '';
        const cxEffort = cx.effort || '';
        const bounds = cx.parallelLimitBounds && Number.isFinite(cx.parallelLimitBounds.max)
          ? cx.parallelLimitBounds
          : PARALLEL_FALLBACK;
        setParallelBounds(bounds);
        const cxParallel = clampParallel(cx.parallelLimit, bounds);
        const gk = ig.grok || {};
        const gkEnabled = gk.enabled === true;
        const gkPath = gk.grokPath || '';
        const gkRatio = gk.aspectRatio || '';
        // Per-mode cleaner reads via the shared helper (mirrored from
        // server/lib/imageClean.js).
        const codexClean = resolveCleanersFromConfig(cx, IMAGE_GEN_MODE.CODEX);
        const grokClean = resolveCleanersFromConfig(gk, IMAGE_GEN_MODE.GROK);
        const localClean = resolveCleanersFromConfig(ig.local, IMAGE_GEN_MODE.LOCAL);
        const externalClean = resolveCleanersFromConfig(ig.external, IMAGE_GEN_MODE.EXTERNAL);
        const c2 = { codex: codexClean.cleanC2PA, grok: grokClean.cleanC2PA, local: localClean.cleanC2PA, external: externalClean.cleanC2PA };
        const dn = { codex: codexClean.denoise, grok: grokClean.denoise, local: localClean.denoise, external: externalClean.denoise };
        setMode(m);
        setSdapiUrl(url);
        setPythonPath(py);
        setExposeA1111(expose);
        setCodexEnabled(cxEnabled);
        setCodexPath(cxPath);
        setCodexModel(cxModel);
        setCodexEffort(cxEffort);
        setCodexParallelLimit(cxParallel);
        setParallelLimitDraft(String(cxParallel));
        setGrokEnabled(gkEnabled);
        setGrokPath(gkPath);
        setGrokAspectRatio(gkRatio);
        setCleanC2PAByMode(c2);
        setDenoiseByMode(dn);
        setSaved({
          mode: m, sdapiUrl: url, pythonPath: py, exposeA1111: expose,
          codexEnabled: cxEnabled, codexPath: cxPath, codexModel: cxModel, codexEffort: cxEffort,
          codexParallelLimit: cxParallel,
          grokEnabled: gkEnabled, grokPath: gkPath, grokAspectRatio: gkRatio,
          cleanC2PAByMode: c2, denoiseByMode: dn,
        });
        setToolRegistered(tools.some((t) => t.id === SDAPI_TOOL_ID));
        setCodexToolRegistered(tools.some((t) => t.id === CODEX_TOOL_ID));
        setGrokToolRegistered(tools.some((t) => t.id === GROK_TOOL_ID));
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
    || codexModel !== saved.codexModel
    || codexEffort !== saved.codexEffort
    || codexParallelLimit !== saved.codexParallelLimit
    || grokEnabled !== saved.grokEnabled
    || grokPath !== saved.grokPath
    || grokAspectRatio !== saved.grokAspectRatio
    || cleanC2PAByMode.grok !== saved.cleanC2PAByMode.grok
    || denoiseByMode.grok !== saved.denoiseByMode.grok
    || cleanC2PAByMode.codex !== saved.cleanC2PAByMode.codex
    || cleanC2PAByMode.local !== saved.cleanC2PAByMode.local
    || cleanC2PAByMode.external !== saved.cleanC2PAByMode.external
    || denoiseByMode.codex !== saved.denoiseByMode.codex
    || denoiseByMode.local !== saved.denoiseByMode.local
    || denoiseByMode.external !== saved.denoiseByMode.external;

  const handleSave = async () => {
    setSaving(true);
    const url = normalizeUrl(sdapiUrl) || undefined;
    const cxPath = codexPath?.trim() || undefined;
    const cxModel = codexModel?.trim() || undefined;
    const cxEffort = codexEffort?.trim() || undefined;
    const cxParallel = clampParallel(codexParallelLimit, parallelBounds);
    const gkPath = grokPath?.trim() || undefined;
    const gkRatio = grokAspectRatio?.trim() || undefined;
    const patch = {
      imageGen: {
        mode,
        external: { sdapiUrl: url, cleanC2PA: cleanC2PAByMode.external, denoise: denoiseByMode.external },
        local: { pythonPath: pythonPath || undefined, cleanC2PA: cleanC2PAByMode.local, denoise: denoiseByMode.local },
        codex: {
          enabled: codexEnabled, codexPath: cxPath, model: cxModel, effort: cxEffort, parallelLimit: cxParallel,
          cleanC2PA: cleanC2PAByMode.codex, denoise: denoiseByMode.codex,
        },
        grok: {
          enabled: grokEnabled, grokPath: gkPath, aspectRatio: gkRatio,
          cleanC2PA: cleanC2PAByMode.grok, denoise: denoiseByMode.grok,
        },
        expose: { a1111: exposeA1111 },
        // Keep the legacy field populated so anything still reading
        // `imageGen.sdapiUrl` directly stays working.
        sdapiUrl: url,
      },
    };
    try {
      await updateSettings(patch, { silent: true });
      // Store trimmed values to match what was persisted — otherwise
      // trailing whitespace in the inputs leaves isDirty stuck true even
      // after a successful save (state has " codex " but `saved` was
      // updated with the trimmed "codex").
      setSaved({
        mode, sdapiUrl: url || '', pythonPath, exposeA1111,
        codexEnabled, codexPath: cxPath || '', codexModel: cxModel || '', codexEffort: cxEffort || '',
        codexParallelLimit: cxParallel,
        grokEnabled, grokPath: gkPath || '', grokAspectRatio: gkRatio || '',
        cleanC2PAByMode, denoiseByMode,
      });
      if (cxParallel !== codexParallelLimit) {
        setCodexParallelLimit(cxParallel);
        setParallelLimitDraft(String(cxParallel));
      }
      // Reflect the normalization back into the inputs so what the user
      // sees matches what was saved.
      if (cxPath !== codexPath) setCodexPath(cxPath || '');
      if (cxModel !== codexModel) setCodexModel(cxModel || '');
      if (cxEffort !== codexEffort) setCodexEffort(cxEffort || '');
      if (gkPath !== grokPath) setGrokPath(gkPath || '');
      if (gkRatio !== grokAspectRatio) setGrokAspectRatio(gkRatio || '');
      toast.success('Image gen settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
      setSaving(false);
      return;
    }

    // Both tool entries are independent — sync them in parallel so a
    // tailnet save doesn't pay two sequential HTTP round-trips.
    const sdEnabled = mode === IMAGE_GEN_MODE.EXTERNAL ? !!url : (mode === IMAGE_GEN_MODE.LOCAL ? !!pythonPath : false);
    const sdToolData = {
      name: mode === IMAGE_GEN_MODE.EXTERNAL ? 'Stable Diffusion (External)' : (mode === IMAGE_GEN_MODE.LOCAL ? 'Stable Diffusion (Local mflux)' : 'Stable Diffusion'),
      category: 'image-generation',
      description: 'Generate images via the active PortOS image gen backend',
      enabled: sdEnabled,
      config: { mode, sdapiUrl: url, pythonPath },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, negativePrompt, width, height, steps }. Use POST /api/image-gen/avatar for character portraits.',
    };
    const grokToolData = {
      name: 'Grok Imagegen',
      category: 'image-generation',
      description: 'Generate images via the Grok Build CLI built-in image_gen tool. Requires a Grok plan that includes image generation.',
      enabled: grokEnabled,
      config: { grokPath: gkPath, aspectRatio: gkRatio },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, mode: "grok" } — or call the image_generate voice tool with provider: "grok".',
    };
    const codexToolData = {
      name: 'Codex Imagegen',
      category: 'image-generation',
      description: 'Generate images via the Codex CLI built-in image_gen tool ($imagegen prompt prefix). Requires a Codex plan that includes image_gen.',
      enabled: codexEnabled,
      config: { codexPath: cxPath, model: cxModel, effort: cxEffort },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, mode: "codex" } — or call the image_generate voice tool with provider: "codex".',
    };

    const syncTool = async ({ id, registered, data, shouldCreate, onCreated, errLabel }) => {
      if (registered) {
        return updateTool(id, data, { silent: true }).catch((err) => toast.error(err.message || `Failed to update ${errLabel}`));
      }
      if (shouldCreate) {
        try {
          await registerTool({ id, ...data }, { silent: true });
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
      syncTool({
        id: GROK_TOOL_ID, registered: grokToolRegistered, data: grokToolData,
        shouldCreate: grokEnabled, onCreated: () => setGrokToolRegistered(true),
        errLabel: 'Grok Imagegen tool',
      }),
    ]);

    setSaving(false);
  };

  const handleRenderTest = async () => {
    if (!testPrompt.trim() || rendering) return;
    setRendering(true);
    setRenderResult(null);
    try {
      // Use saved.mode (not the live `mode` state) so the test render
      // always reflects what's actually persisted server-side. The
      // disabled={isDirty} guard already prevents this branch from running
      // with unsaved changes, but reading from `saved` makes the contract
      // explicit. Codex is async like local (returns a job descriptor
      // immediately) so the SSE branch handles it.
      const result = await generateImage({ prompt: testPrompt.trim(), mode: saved.mode }, { silent: true });
      // Local + Codex modes return immediately after spawning the child —
      // the PNG isn't on disk yet. Subscribe to the per-job SSE and only
      // mark the render complete on the `complete` event (or fail on
      // `error`). External mode awaits internally and the file is on disk
      // by the time generateImage resolves, so we can short-circuit.
      const isAsync = (result?.mode === IMAGE_GEN_MODE.LOCAL || result?.mode === IMAGE_GEN_MODE.CODEX || result?.mode === IMAGE_GEN_MODE.GROK);
      if (isAsync && result?.generationId) {
        const jobResult = await attachRenderSse(result.generationId, {
          onError: (msg) => new Error(msg.error || 'Generation failed'),
        });
        setRenderResult({ ...result, ...jobResult });
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
    if (isLoopbackHost(h)) return null;
    // Real tailnet host — use the canonical user-facing port (:5555) and
    // match the currently-active scheme so the hint works in both HTTPS-on
    // (Tailscale cert provisioned) and HTTP-only PortOS deployments.
    const scheme = window.location.protocol === 'http:' ? 'http' : 'https';
    return `${scheme}://${h}:5555`;
  })();

  return (
    <div className="space-y-4">
      {/* Sub-navigation — groups this long settings surface into tabs so no
          single scroll is page-length. Internal to the component so it renders
          identically inside a plain Drawer or the Settings page. */}
      <TabPills
        tabs={MEDIA_TABS}
        activeTab={mediaTab}
        onChange={setMediaTab}
        variant="pills"
        mobileDropdown
        mobileSelectId="media-settings-tab-select"
        ariaLabel="Media generation settings sections"
        controlsIdPrefix="media-settings-tabpanel"
      />

      <div
        id={`media-settings-tabpanel-${mediaTab}`}
        role="tabpanel"
        aria-labelledby={`tab-${mediaTab}`}
        className="space-y-5"
      >
      {/* Mode picker */}
      {mediaTab === 'backend' && (
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
        <div className={`grid grid-cols-1 sm:grid-cols-2 ${(codexEnabled || grokEnabled) ? 'lg:grid-cols-3' : ''} gap-3`}>
          <button
            type="button"
            onClick={() => setMode(IMAGE_GEN_MODE.EXTERNAL)}
            className={`text-left p-4 rounded-lg border transition-colors ${mode === IMAGE_GEN_MODE.EXTERNAL ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-400 hover:bg-port-border/30 hover:text-white'}`}
          >
            <div className="flex items-center gap-2">
              <Cloud className="w-4 h-4" />
              <span className="font-medium text-sm">External SD API</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">Forward to a remote AUTOMATIC1111 / Forge server (e.g. another tailnet box).</p>
          </button>
          <button
            type="button"
            onClick={() => setMode(IMAGE_GEN_MODE.LOCAL)}
            className={`text-left p-4 rounded-lg border transition-colors ${mode === IMAGE_GEN_MODE.LOCAL ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-400 hover:bg-port-border/30 hover:text-white'}`}
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
              onClick={() => setMode(IMAGE_GEN_MODE.CODEX)}
              className={`text-left p-4 rounded-lg border transition-colors ${mode === IMAGE_GEN_MODE.CODEX ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-400 hover:bg-port-border/30 hover:text-white'}`}
            >
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4" />
                <span className="font-medium text-sm">Codex CLI</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Route through the Codex CLI built-in image_gen tool. Counts against your Codex plan.</p>
            </button>
          )}
          {grokEnabled && (
            <button
              type="button"
              onClick={() => setMode(IMAGE_GEN_MODE.GROK)}
              className={`text-left p-4 rounded-lg border transition-colors ${mode === IMAGE_GEN_MODE.GROK ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-400 hover:bg-port-border/30 hover:text-white'}`}
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4" />
                <span className="font-medium text-sm">Grok CLI</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Route through the Grok Build CLI built-in image_gen tool. Counts against your Grok plan.</p>
            </button>
          )}
        </div>
      </div>
      )}

      {mediaTab === 'external' && (
        <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
          <label htmlFor="sdapi-url" className="text-sm font-medium text-gray-300">External AUTOMATIC1111 / Forge URL</label>
          <input
            id="sdapi-url"
            type="text"
            value={sdapiUrl}
            onChange={(e) => setSdapiUrl(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
            placeholder="http://localhost:7860"
          />
          <p className="text-xs text-gray-500">Base URL for the SD WebUI server PortOS should send generation requests to.</p>
          <CleanersToggles
            cleanC2PA={cleanC2PAByMode.external}
            denoise={denoiseByMode.external}
            onCleanC2PAChange={setCleanC2PAFor(IMAGE_GEN_MODE.EXTERNAL)}
            onDenoiseChange={setDenoiseFor(IMAGE_GEN_MODE.EXTERNAL)}
          />
        </div>
      )}

      {localMounted && (
        <div className={`bg-port-card border border-port-border rounded-xl p-6 space-y-4 ${mediaTab === 'local' ? '' : 'hidden'}`}>
          <h3 className="text-sm font-medium text-gray-300">Local Python (mflux + mlx_video)</h3>
          <p className="text-xs text-gray-500">
            Pick a Python 3.10+ interpreter — PortOS auto-detects venvs and conda installs and can install
            missing packages directly. HF model weights stream into the standard <code>~/.cache/huggingface</code>
            and are surfaced in <a href="/media/models" className="text-port-accent hover:underline">Media → Models</a>.
          </p>
          <LocalSetupPanel pythonPath={pythonPath} onPythonPathChange={setPythonPath} />
          <CleanersToggles
            cleanC2PA={cleanC2PAByMode.local}
            denoise={denoiseByMode.local}
            onCleanC2PAChange={setCleanC2PAFor(IMAGE_GEN_MODE.LOCAL)}
            onDenoiseChange={setDenoiseFor(IMAGE_GEN_MODE.LOCAL)}
          />
        </div>
      )}

      {/* Codex CLI config — the toggle that enables the option lives here.
          Codex appears as a backend tile only after the user flips this on. */}
      {mediaTab === 'codex' && (
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
              // Disabling Codex while it's the active backend would leave
              // the saved mode pointing at a disabled provider. Pick the
              // best fallback: prefer local if Python is configured, else
              // external if a URL is set, else external as a last resort
              // (so the user lands on a non-broken default rather than
              // sticking with codex or hopping to an unconfigured backend).
              if (!v && mode === IMAGE_GEN_MODE.CODEX) {
                const hasLocal = !!pythonPath?.trim();
                setMode(hasLocal ? IMAGE_GEN_MODE.LOCAL : IMAGE_GEN_MODE.EXTERNAL);
              }
            }}
            className="rounded"
          />
          <span className="text-sm text-gray-300">Enable Codex Imagegen</span>
        </label>
        {codexEnabled && (
          <div className="space-y-3 pl-6 border-l-2 border-port-border">
            <div>
              <label htmlFor={codexPathId} className="block text-xs font-medium text-gray-400 mb-1">Codex binary path (optional)</label>
              <input
                id={codexPathId}
                type="text"
                value={codexPath}
                onChange={(e) => setCodexPath(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                placeholder="codex (uses $PATH)"
              />
              <p className="text-xs text-gray-500 mt-1">Leave empty to invoke <code>codex</code> from $PATH.</p>
            </div>
            <div>
              <label htmlFor={codexModelId} className="block text-xs font-medium text-gray-400 mb-1">Model override (optional)</label>
              <input
                id={codexModelId}
                type="text"
                value={codexModel}
                onChange={(e) => setCodexModel(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                placeholder={`${CODEX_IMAGEGEN_DEFAULT_MODEL} (default)`}
              />
              <p className="text-xs text-gray-500 mt-1">Passed as <code>codex exec -m &lt;model&gt;</code>. Leave empty to use the cheap default (<code>{CODEX_IMAGEGEN_DEFAULT_MODEL}</code>).</p>
            </div>
            <div>
              <label htmlFor={codexEffortId} className="block text-xs font-medium text-gray-400 mb-1">Reasoning effort (optional)</label>
              <select
                id={codexEffortId}
                value={codexEffort}
                onChange={(e) => setCodexEffort(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
              >
                <option value="">Default ({CODEX_IMAGEGEN_DEFAULT_EFFORT})</option>
                {CODEX_EFFORT_LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl}>{lvl}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">Passed as <code>codex exec -c model_reasoning_effort=&lt;level&gt;</code>. Lower effort is cheaper; leave on the shipped default (<code>{CODEX_IMAGEGEN_DEFAULT_EFFORT}</code>) or drop to <code>minimal</code> for the cheapest possible renders.</p>
            </div>
            <div>
              <label htmlFor={codexParallelId} className="block text-xs font-medium text-gray-400 mb-1">Parallel render limit</label>
              <input
                id={codexParallelId}
                type="number"
                min={parallelBounds.min}
                max={parallelBounds.max}
                step={1}
                value={parallelLimitDraft}
                onChange={(e) => setParallelLimitDraft(e.target.value)}
                onBlur={() => {
                  const clamped = clampParallel(parallelLimitDraft, parallelBounds);
                  setCodexParallelLimit(clamped);
                  setParallelLimitDraft(String(clamped));
                }}
                className="w-24 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
              />
              <p className="text-xs text-gray-500 mt-1">
                How many Codex renders the queue runs in parallel. Default <code>{parallelBounds.default}</code>. Hard capped at <code>{parallelBounds.max}</code>.
                Higher values let large batches finish faster but burn OpenAI credits non-linearly — a runaway {parallelBounds.max}-wide
                batch can rack up real money in minutes.
                {codexParallelLimit > Math.ceil(parallelBounds.max / 2) && (
                  <span className="block mt-1 text-port-warning">
                    ⚠️ {codexParallelLimit} concurrent renders can burn credits quickly during a long batch. Watch usage.
                  </span>
                )}
              </p>
            </div>
            <CleanersToggles
              cleanC2PA={cleanC2PAByMode.codex}
              denoise={denoiseByMode.codex}
              onCleanC2PAChange={setCleanC2PAFor(IMAGE_GEN_MODE.CODEX)}
              onDenoiseChange={setDenoiseFor(IMAGE_GEN_MODE.CODEX)}
            />
          </div>
        )}
      </div>
      )}

      {/* Grok Build CLI config — mirrors the Codex section's enable-gate
          pattern. Grok appears as a backend tile only after the user flips
          this on. Simpler than the Codex form: grok's image tools expose no
          model/effort knobs, so it's just the binary path + a default aspect
          ratio + the cleaner toggles. */}
      {mediaTab === 'grok' && (
      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <Sparkles size={18} />
          <h2 className="text-lg font-semibold">Grok CLI Imagegen</h2>
        </div>
        <p className="text-xs text-gray-500">
          Route image generation through the Grok Build CLI's built-in
          <code className="text-gray-400"> image_gen </code> tool (and
          <code className="text-gray-400"> image_edit </code> for image-to-image) — invoked headlessly.
          Uses your logged-in Grok session, no XAI_API_KEY required. Not every Grok plan includes
          image generation; if yours doesn't, leave this off.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={grokEnabled}
            onChange={(e) => {
              const v = e.target.checked;
              setGrokEnabled(v);
              // Disabling Grok while it's the active backend would leave the
              // saved mode pointing at a disabled provider — same fallback
              // order as the Codex toggle: local if configured, else external.
              if (!v && mode === IMAGE_GEN_MODE.GROK) {
                const hasLocal = !!pythonPath?.trim();
                setMode(hasLocal ? IMAGE_GEN_MODE.LOCAL : IMAGE_GEN_MODE.EXTERNAL);
              }
            }}
            className="rounded"
          />
          <span className="text-sm text-gray-300">Enable Grok Imagegen</span>
        </label>
        {grokEnabled && (
          <div className="space-y-3 pl-6 border-l-2 border-port-border">
            <div>
              <label htmlFor={grokPathId} className="block text-xs font-medium text-gray-400 mb-1">Grok binary path (optional)</label>
              <input
                id={grokPathId}
                type="text"
                value={grokPath}
                onChange={(e) => setGrokPath(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                placeholder="grok (uses $PATH)"
              />
              <p className="text-xs text-gray-500 mt-1">Leave empty to invoke <code>grok</code> from $PATH.</p>
            </div>
            <div>
              <label htmlFor={grokRatioId} className="block text-xs font-medium text-gray-400 mb-1">Default aspect ratio (optional)</label>
              <select
                id={grokRatioId}
                value={grokAspectRatio}
                onChange={(e) => setGrokAspectRatio(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
              >
                <option value="">Auto (from requested size)</option>
                {GROK_ASPECT_RATIOS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Applied when a render doesn't specify dimensions. A render's width/height maps to the nearest supported ratio automatically.
              </p>
            </div>
            <CleanersToggles
              cleanC2PA={cleanC2PAByMode.grok}
              denoise={denoiseByMode.grok}
              onCleanC2PAChange={setCleanC2PAFor(IMAGE_GEN_MODE.GROK)}
              onDenoiseChange={setDenoiseFor(IMAGE_GEN_MODE.GROK)}
            />
          </div>
        )}
      </div>
      )}

      {/* HuggingFace token — used by local Flux models (FLUX.1-dev, FLUX.2-klein).
          Independent of the mode picker because the token persists in settings
          and applies whenever local image gen runs. */}
      {mediaTab === 'tokens' && (
      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <Key size={18} />
          <h2 className="text-lg font-semibold">HuggingFace Token</h2>
        </div>
        <p className="text-xs text-gray-500">
          Required for gated local models — currently <code className="text-gray-400">FLUX.1-dev</code> and the{' '}
          <code className="text-gray-400">FLUX.2-klein</code> family. Accept each model's license on HuggingFace, then create a read token at{' '}
          <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer" className="text-port-accent hover:underline">
            huggingface.co/settings/tokens
          </a>{' '}and paste it below. PortOS reads stored tokens first, then falls back to the{' '}
          <code className="text-gray-400">HF_TOKEN</code> env var or <code className="text-gray-400">~/.cache/huggingface/token</code>.
        </p>

        {hfTokenInfo.hfTokenPresent === null ? (
          <div className="text-xs text-gray-500"><BrailleSpinner text="Checking token status" /></div>
        ) : hfTokenInfo.hfTokenPresent ? (
          <div className="flex items-center gap-2 text-xs text-port-success">
            <Check size={14} />
            <span>
              Token configured
              {hfTokenInfo.source === 'env' && ' (from HF_TOKEN environment variable)'}
              {hfTokenInfo.source === 'cli' && ' (from ~/.cache/huggingface/token — set via `hf auth login`)'}
              {hfTokenInfo.source === 'stored' && ' (stored in settings.json)'}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-port-warning">
            <AlertTriangle size={14} />
            <span>No HuggingFace token configured — gated models will fail to download.</span>
          </div>
        )}

        <div>
          <label htmlFor="hf-token-input" className="block text-xs font-medium text-gray-400 mb-1">
            {hfTokenInfo.source === 'stored' ? 'Replace stored token' : 'Paste a token'}
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="hf-token-input"
              type="password"
              value={hfTokenInput}
              onChange={(e) => setHfTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveHfToken(); }}
              disabled={hfTokenBusy !== null}
              placeholder="hf_…"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleSaveHfToken}
              disabled={hfTokenBusy !== null || !hfTokenInput.trim()}
              className="whitespace-nowrap inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-port-accent text-white text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 min-h-[40px]"
            >
              {hfTokenBusy === 'saving' ? <BrailleSpinner /> : <Save size={14} />}
              Save token
            </button>
          </div>
        </div>

        {hfTokenInfo.source === 'stored' && (
          <button
            type="button"
            onClick={handleClearHfToken}
            disabled={hfTokenBusy !== null}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-border text-gray-300 text-xs font-medium hover:bg-port-error/20 hover:text-port-error disabled:opacity-50"
          >
            {hfTokenBusy === 'clearing' ? <BrailleSpinner /> : <Trash2 size={12} />}
            Clear stored token
          </button>
        )}
      </div>
      )}

      {mediaTab === 'expose' && (
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
      )}

      {mediaTab === 'test' && (
      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <Sparkles size={18} />
          <h2 className="text-lg font-semibold">Test Render</h2>
        </div>
        <p className="text-xs text-gray-500">
          Send a prompt through the active backend to verify end-to-end. For richer controls, visit the
          <a href="/media/image" className="text-port-accent hover:underline ml-1">Image Gen</a> page.
        </p>
        <label htmlFor="test-render-prompt" className="sr-only">Test prompt</label>
        <textarea
          id="test-render-prompt"
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
      )}
      </div>

      {/* Persistent global save + status bar — applies across every tab since
          Save persists the whole imageGen config and Test Connection probes the
          active backend. Kept outside the tab panel so it's reachable no matter
          which section is open. */}
      <div className="flex items-center gap-3 pt-3 border-t border-port-border">
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

// Per-provider post-render cleaner toggles. Both must run before the SSE
// complete event fires so subscribers see the cleaned bytes on first fetch —
// enforced by the provider success paths, not here. A future "Clean SynthID"
// diffusion option will join this group when ready.
function CleanersToggles({ cleanC2PA, denoise, onCleanC2PAChange, onDenoiseChange }) {
  return (
    <div className="space-y-2 pt-1">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={cleanC2PA}
          onChange={(e) => onCleanC2PAChange(e.target.checked)}
          className="rounded mt-0.5"
        />
        <span className="text-sm text-gray-300">
          Clean C2PA
          <span className="block text-xs text-gray-500 mt-0.5">
            Strip the gpt-image <code>caBX</code> provenance chunk. Lossless — pixels untouched, only metadata removed. Safe to leave on; recommended for renders you'll share publicly.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={denoise}
          onChange={(e) => onDenoiseChange(e.target.checked)}
          className="rounded mt-0.5"
        />
        <span className="text-sm text-gray-300">
          Denoise (median + sharpen)
          <span className="block text-xs text-gray-500 mt-0.5">
            Smooths AI-generation artifacts with a median filter + sharpen pass. <span className="text-port-warning">Warning: lossy — blurs annotation text, small labels, and fine detail.</span> Implicitly also strips C2PA. Skip this for renders with text (concept sheets, infographics, comic panels).
          </span>
        </span>
      </label>
      <p className="text-[11px] text-gray-500 italic mt-1">
        Neither option defeats SynthID — gpt-image / Imagen renders stay detectable by their vendor watermark checkers. A "Clean SynthID" diffusion option is planned separately.
      </p>
    </div>
  );
}

export default ImageGenTab;
