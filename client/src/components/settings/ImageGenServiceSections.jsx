/**
 * Media settings — the sections beside the backend config: the HuggingFace
 * token (its own validated endpoints, independent of the Media save), the
 * tailnet A1111 exposure toggle, and the Test Render panel. The toggle is a
 * field of the shared `useSettingsForm`; the token and test render own their
 * own state. Always mounted so the test render's media-run owner outlives a
 * tab switch.
 */

import { useState, useId } from 'react';
import { Save, Globe, AlertTriangle, Sparkles, Key, Check, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import FormField from '../ui/FormField';
import BrailleSpinner from '../BrailleSpinner';
import { isLoopbackHost } from '../../lib/loopbackHost.js';
import { PORTS } from '../../lib/ports.js';
import { generateImage, saveHfToken, clearHfToken } from '../../services/api';
import { deriveAvailableBackends, isCloudCliMode, IMAGE_GEN_MODE, modeLabel } from '../../lib/imageGenBackends';
import { withUnlistedOption } from '../../lib/withUnlistedOption';
import { useMediaJobSse, isMediaRunEnded } from '../../hooks/useMediaJobSse';
import { useHfTokenStatus } from '../../hooks/useHfTokenStatus';

const SECTION_CLASS = 'bg-port-card border border-port-border rounded-xl p-6 space-y-4';
const DEFAULT_TEST_PROMPT = 'a small cyberpunk fox sitting on a neon-lit rooftop at night, cinematic, highly detailed';

// The advertised A1111 URL must be the canonical user-facing endpoint
// (`<tailscale-host>.<tailnet>.ts.net:PORTS.API` / `<tailscale-ip>:PORTS.API`),
// not the loopback HTTP mirror on PORTS.API_LOCAL or a localhost dev URL —
// those aren't reachable from other tailnet machines.
const advertisedA1111Url = () => {
  if (typeof window === 'undefined') return null;
  const h = window.location.hostname;
  // Local dev / loopback mirror — we can't infer the tailnet hostname
  // from the browser; tell the user to look it up.
  if (isLoopbackHost(h)) return null;
  // Real tailnet host — use the canonical user-facing API port and
  // match the currently-active scheme so the hint works in both HTTPS-on
  // (Tailscale cert provisioned) and HTTP-only PortOS deployments.
  const scheme = window.location.protocol === 'http:' ? 'http' : 'https';
  return `${scheme}://${h}:${PORTS.API}`;
};

export default function ImageGenServiceSections({ mediaTab, form }) {
  const { values, saved, isDirty, set } = form;
  const { exposeA1111 } = values;

  // HuggingFace token state — separate from the main settings save flow because
  // it has its own validated endpoints (POST /setup/hf-token + DELETE) and
  // applies to local Flux models regardless of which backend is active.
  // `source` is 'stored' | 'env' | 'cli' | 'none'; only 'stored' tokens can be
  // cleared from the UI (env/CLI come from outside settings.json).
  const { present: hfTokenPresent, source: hfTokenSource, refresh: refreshHfTokenStatus } = useHfTokenStatus();
  const [hfTokenInput, setHfTokenInput] = useState('');
  // One busy flag covers both save and clear since they're mutually exclusive
  // (both disable the form + buttons). `busy` is the in-flight verb so the
  // Clear button can still show a Trash icon while the spinner is on Save.
  const [hfTokenBusy, setHfTokenBusy] = useState(null); // null | 'saving' | 'clearing'

  const handleSaveHfToken = async () => {
    const trimmed = hfTokenInput.trim();
    if (!trimmed) return;
    setHfTokenBusy('saving');
    const result = await saveHfToken(trimmed).catch(() => null);
    setHfTokenBusy(null);
    if (!result?.ok) return;
    setHfTokenInput('');
    refreshHfTokenStatus();
    toast.success('HuggingFace token saved');
  };

  const handleClearHfToken = async () => {
    setHfTokenBusy('clearing');
    const result = await clearHfToken().catch(() => null);
    setHfTokenBusy(null);
    if (!result?.ok) return;
    refreshHfTokenStatus();
    toast.success(result.hfTokenPresent ? 'Stored token cleared (env / CLI token still active)' : 'HuggingFace token cleared');
  };

  const [testPrompt, setTestPrompt] = useState(DEFAULT_TEST_PROMPT);
  // Backend the Test Render panel should render through. '' is the sentinel for
  // "follow the saved default" — NOT a picked backend — so the panel tracks a
  // default the user changes on the Backend tab instead of pinning whatever was
  // saved the first time this tab painted (#4128).
  const [testMode, setTestMode] = useState('');
  const testModeId = useId();
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState(null);
  // Shared media-run owner — same hook ImageGen/VideoGen use to await an async
  // render's terminal frame after the kickoff POST returns a jobId. It also
  // detaches the stream and drops the pending kickoff when the tab unmounts.
  const { start: startRenderRun } = useMediaJobSse('image');

  // Backends the Test Render picker may offer — derived from the SAVED slice,
  // not the live form, because a test render runs against what the server has
  // persisted (the same reason handleRenderTest reads `saved.mode`). The
  // settings-shaped argument is what `deriveAvailableBackends` (the client
  // mirror of the server's usability gate) consumes, so enabling a backend is
  // still one edit in one place.
  const savedBackends = deriveAvailableBackends({
    imageGen: {
      local: { pythonPath: saved.pythonPath, modelId: saved.localModelId },
      codex: { enabled: saved.codexEnabled },
      grok: { enabled: saved.grokEnabled },
      agy: { enabled: saved.agyEnabled },
      fal: { enabled: saved.falEnabled },
      external: { sdapiUrl: saved.sdapiUrl },
    },
  });
  // The saved default always stays selectable even when it isn't "usable" by
  // the derivation above (e.g. external with a blank URL) — the server would
  // still route the render there, so hiding it would make the select disagree
  // with what the button actually does.
  const testModeOptions = withUnlistedOption(
    savedBackends,
    saved.mode,
    (id) => ({ id, label: modeLabel(id) }),
  );
  // A pick that a later save disabled falls back to the saved default rather
  // than queueing a render that can only 400.
  const effectiveTestMode = testModeOptions.some((b) => b.id === testMode) ? testMode : saved.mode;

  const handleRenderTest = async () => {
    if (!testPrompt.trim() || rendering) return;
    setRendering(true);
    setRenderResult(null);
    try {
      // `effectiveTestMode` is the panel's own picker, defaulting to saved.mode
      // (not the live form) so an unchanged picker still reflects what's
      // actually persisted server-side. The disabled={isDirty} guard already
      // prevents this branch from running with unsaved changes, but resolving
      // through `saved` makes the contract explicit. Codex is async like local
      // (returns a job descriptor immediately) so the SSE branch handles it.
      // Local + Codex modes return immediately after spawning the child —
      // the PNG isn't on disk yet. Subscribe to the per-job SSE and only
      // mark the render complete on the `complete` event (or fail on
      // `error`). External mode awaits internally and the file is on disk
      // by the time generateImage resolves, so it completes synchronously
      // (no job id to follow).
      const result = await startRenderRun(
        () => generateImage({ prompt: testPrompt.trim(), mode: effectiveTestMode }, { silent: true }),
        (ack) => ({
          onError: (msg) => new Error(msg.error || 'Generation failed'),
          onComplete: (msg) => ({ ...ack, ...msg.result }),
        }),
        {
          jobIdOf: (ack) => ((ack?.mode === IMAGE_GEN_MODE.LOCAL || isCloudCliMode(ack?.mode)) ? ack.generationId : null),
        },
      );
      setRenderResult(result);
      toast.success('Test render complete');
    } catch (err) {
      // A detached run (tab unmounted mid-render) has nothing left to report to.
      if (!isMediaRunEnded(err)) toast.error(err.message || 'Test render failed');
    } finally {
      setRendering(false);
    }
  };

  const a1111Url = mediaTab === 'expose' ? advertisedA1111Url() : null;

  return (
    <>
      {/* HuggingFace token — used by local Flux models (FLUX.1-dev, FLUX.2-klein).
          Independent of the mode picker because the token persists in settings
          and applies whenever local image gen runs. */}
      {mediaTab === 'tokens' && (
      <div className={SECTION_CLASS}>
        <div className="flex items-center gap-2 text-white">
          <Key size={18} />
          <h2 className="text-lg font-semibold">HuggingFace Token</h2>
        </div>
        <p className="text-xs text-gray-500">
          Used for gated local models and model downloads — including <code className="text-gray-400">FLUX.1-dev</code>, the{' '}
          <code className="text-gray-400">FLUX.2-klein</code> family, and gated video sources. Accept each model's license on HuggingFace, then create a read token at{' '}
          <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer" className="text-port-accent hover:underline">
            huggingface.co/settings/tokens
          </a>{' '}and paste it below. PortOS reads stored tokens first, then falls back to the{' '}
          <code className="text-gray-400">HF_TOKEN</code> env var or <code className="text-gray-400">~/.cache/huggingface/token</code>.
        </p>

        {hfTokenPresent === null ? (
          <div className="text-xs text-gray-500"><BrailleSpinner text="Checking token status" /></div>
        ) : hfTokenPresent ? (
          <div className="flex items-center gap-2 text-xs text-port-success">
            <Check size={14} />
            <span>
              Token configured
              {hfTokenSource === 'env' && ' (from HF_TOKEN environment variable)'}
              {hfTokenSource === 'cli' && ' (from ~/.cache/huggingface/token — set via `hf auth login`)'}
              {hfTokenSource === 'stored' && ' (stored in settings.json)'}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-port-warning">
            <AlertTriangle size={14} />
            <span>No HuggingFace token configured — gated models will fail to download.</span>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2 items-end">
          <FormField label={hfTokenSource === 'stored' ? 'Replace stored token' : 'Paste a token'} labelClassName="block text-xs font-medium text-gray-400 mb-1" className="flex-1 w-full">
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
              className="w-full flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
            />
          </FormField>
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

        {hfTokenSource === 'stored' && (
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
      <div className={SECTION_CLASS}>
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
            onChange={(e) => set('exposeA1111', e.target.checked)}
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
              {a1111Url ? (
                <>Other machines should set their SD API URL to <code className="text-gray-300">{a1111Url}</code></>
              ) : (
                <>Other machines should set their SD API URL to <code className="text-gray-300">https://&lt;your-tailscale-host&gt;:{PORTS.API}</code> (run <code className="text-gray-300">tailscale status</code> on this machine to see the hostname).</>
              )}
            </div>
          </div>
        )}
      </div>
      )}

      {mediaTab === 'test' && (
      <div className={SECTION_CLASS}>
        <div className="flex items-center gap-2 text-white">
          <Sparkles size={18} />
          <h2 className="text-lg font-semibold">Test Render</h2>
        </div>
        <p className="text-xs text-gray-500">
          Send a prompt through {modeLabel(effectiveTestMode)} to verify end-to-end. For richer controls, visit the
          <a href="/media/image" className="text-port-accent hover:underline ml-1">Image Gen</a> page.
        </p>
        <FormField label="Backend" labelClassName="block text-sm text-gray-300 mb-1">
          <select
            id={testModeId}
            value={effectiveTestMode}
            onChange={(e) => setTestMode(e.target.value)}
            disabled={rendering}
            className="w-full sm:w-64 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
          >
            {testModeOptions.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}{b.id === saved.mode ? ' (default)' : ''}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Only enabled backends are listed — smoke-test one without making it your default.
          </p>
        </FormField>
        <FormField label="Test prompt" labelClassName="sr-only">
          <textarea
            id="test-render-prompt"
            value={testPrompt}
            onChange={(e) => setTestPrompt(e.target.value)}
            rows={2}
            disabled={rendering}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
            placeholder="Describe the image you want..."
          />
        </FormField>
        <button
          type="button"
          onClick={handleRenderTest}
          disabled={rendering || isDirty || !testPrompt.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
          title={isDirty ? 'Save settings first' : `Generate a test image with ${modeLabel(effectiveTestMode)}`}
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
    </>
  );
}
