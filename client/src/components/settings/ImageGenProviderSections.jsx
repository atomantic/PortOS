import { useRunwayCatalog } from '../../hooks/useRunwayCatalog.js';
import RunwayCatalogStatus from '../imageGen/RunwayCatalogStatus.jsx';
/**
 * Media settings — the per-provider sections (External SD API, Local
 * runtimes, Codex CLI, Grok CLI, Agy CLI, fal.ai). Every field is read from
 * and written to the shared `useSettingsForm` the Media drawer owns; the
 * probes and catalogs a section needs (local models, the Codex provider's
 * model list, `agy models`) live here so an unopened section never pays for
 * them. Always mounted: the Local section is lazily mounted on first visit
 * and then kept mounted (hidden) so a running install stream survives a tab
 * switch — see the comment on `localMounted`.
 */

import { useState, useEffect, useCallback, useId } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Check, Sparkles, Terminal } from 'lucide-react';
import FormField from '../ui/FormField';
import BrailleSpinner from '../BrailleSpinner';
import ListLoadError from '../ui/ListLoadError';
import useListResource from '../../hooks/useListResource';
import LocalSetupPanel from './LocalSetupPanel';
import LocalRuntimeStatus from '../imageGen/LocalRuntimeStatus';
import FalModelSelect from '../imageGen/FalModelSelect';
import HiggsfieldModelSelect from '../imageGen/HiggsfieldModelSelect';
import GoogleModelSelect from '../imageGen/GoogleModelSelect';
import useLocalImageModels from '../../hooks/useLocalImageModels';
import { useAgyModels } from '../../hooks/useAgyModels';
import { getNavPageForPath } from '../../../../server/lib/navManifest.js';
import { getVideoGenModelContext, getProviders } from '../../services/api';
import {
  isLocalImageConfigured, IMAGE_GEN_MODE, FAL_IMAGE_DEFAULT_MODEL, falImageFamily, HIGGSFIELD_IMAGE_DEFAULT_MODEL, higgsfieldImageFamily,
  GOOGLE_IMAGE_DEFAULT_MODEL, googleImageFamily,
  AGY_IMAGEGEN_DEFAULT_MODEL, AGY_IMAGEGEN_IMAGE_MODEL, CODEX_IMAGEGEN_DEFAULT_EFFORT, CODEX_IMAGEGEN_DEFAULT_MODEL,
  GROK_ASPECT_RATIOS, localModelSelectOptions, getRunwayImageModel, RUNWAY_IMAGE_DISCLOSURE,
} from '../../lib/imageGenBackends';
import { withUnlistedOption } from '../../lib/withUnlistedOption';
import { effortLevelsForProvider, isCodexSubscriptionProvider, providerModelList } from '../../utils/providers';
import { formatCount } from '../../utils/formatters';

// Fallback bounds used until /api/settings has been fetched once. The server
// is the source of truth (returns `imageGen.codex.parallelLimitBounds` with
// the real min/max/default), so these only matter for the first paint.
export const PARALLEL_FALLBACK = { min: 1, max: Number.MAX_SAFE_INTEGER, default: 1 };
export const clampParallel = (n, bounds = PARALLEL_FALLBACK) =>
  Math.max(bounds.min, Math.min(bounds.max, Math.floor(Number(n) || bounds.default)));

// The configured Codex provider's model ids (the signed-in account's catalog
// when fetched, else the shipped presets).
const fetchCodexProviderModels = () => getProviders({ silent: true }).then((data) => {
  const providers = Array.isArray(data?.providers) ? data.providers : [];
  const provider = providers.find((p) => p?.id === 'codex' && isCodexSubscriptionProvider(p))
    || providers.find(isCodexSubscriptionProvider);
  return provider ? providerModelList(provider)
    .map((m) => (typeof m === 'string' ? m : m?.id))
    .filter((id) => typeof id === 'string' && id !== '') : [];
});

const INPUT_CLASS = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent';
const SECTION_CLASS = 'bg-port-card border border-port-border rounded-xl p-6 space-y-4';
const FIELD_LABEL_CLASS = 'block text-xs font-medium text-gray-400 mb-1';

export default function ImageGenProviderSections({ mediaTab, setMediaTab, form, parallelBounds, falCredential, higgsfieldCredential, googleCredential, runwayCredential, localRuntime, onStatusRecheck }) {
  const runwayCatalog = useRunwayCatalog(mediaTab === 'runway');
  const { values, set } = form;
  const {
    mode, sdapiUrl, pythonPath, localModelId, localVideoModelId,
    codexEnabled, codexPath, codexModel, codexEffort, codexParallelLimit,
    grokEnabled, grokPath, grokAspectRatio, grokImageParallelLimit, grokVideoParallelLimit,
    agyEnabled, agyPath, agyModel, agyImageParallelLimit,
    runwayImageParallelLimit, runwayVideoParallelLimit,
    falEnabled, falModel, falImageParallelLimit, falVideoParallelLimit,
    higgsfieldEnabled, higgsfieldModel, higgsfieldImageParallelLimit, higgsfieldVideoParallelLimit,
    googleEnabled, googleModel, googleProjectId, googleLocation, googleImageParallelLimit, googleVideoParallelLimit,
  } = values;
  const localConfigured = isLocalImageConfigured({ pythonPath, modelId: localModelId });
  // Disabling a provider while it is the active backend would leave the saved
  // mode pointing at a disabled provider. Pick the best fallback: local if it
  // is configured, else external (so the user lands on a non-broken default
  // rather than sticking with the provider or hopping to an unconfigured one).
  const toggleProvider = (enabledKey, providerMode) => (e) => {
    const enabled = e.target.checked;
    set(enabledKey, enabled);
    if (!enabled && mode === providerMode) set('mode', localConfigured ? IMAGE_GEN_MODE.LOCAL : IMAGE_GEN_MODE.EXTERNAL);
  };

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
  // Catalog for the picker, probed once the Local tab is mounted — the same
  // "don't probe a tab nobody looked at" rule as the Agy list below.
  // Hardware-incompatible entries are filtered out by the hook's fetch: a
  // default this machine's runner refuses is a render error waiting to happen,
  // and `checkLocalConnection` already reports it as unavailable.
  const { models: localModels } = useLocalImageModels(localMounted);
  const [videoModelContext, setVideoModelContext] = useState(null);
  const [videoModelContextFailed, setVideoModelContextFailed] = useState(false);
  useEffect(() => {
    if (!localMounted) return undefined;
    let active = true;
    setVideoModelContextFailed(false);
    getVideoGenModelContext({ silent: true })
      .then((context) => { if (active) setVideoModelContext(context); })
      .catch(() => { if (active) setVideoModelContextFailed(true); });
    return () => { active = false; };
  }, [localMounted]);
  // Shared with the per-record local-model picker (RecordRenderPinRow), which
  // needs the same orphaned-pin handling: a pin the live catalog no longer
  // lists still has to render as the selected option, or the select paints
  // blank, reads as "install default", and a save silently drops a pin the
  // server is still honouring.
  const { options: localModelOptions, fallbackLabel: localDefaultLabel } = localModelSelectOptions(localModels, localModelId);
  const localVideoModels = videoModelContext?.models ?? null;
  const localVideoModelOptions = localVideoModels === null ? [] : (
    localVideoModelId && !localVideoModels.some((model) => model.id === localVideoModelId)
      ? [{ id: localVideoModelId, name: `${localVideoModelId} (unavailable on this machine)` }, ...localVideoModels]
      : localVideoModels
  );
  const localVideoDefaultId = videoModelContext?.defaultModel || '';
  const localVideoDefaultLabel = localVideoModels?.length === 0
    ? 'no compatible local model'
    : localVideoModels?.find((model) => model.id === localVideoDefaultId)?.name || localVideoDefaultId || 'no compatible local model';
  // A pip install into the mflux interpreter flips the verdict for an mflux
  // model, and neither probe can observe that on its own.
  const onLocalPackagesChanged = useCallback(() => {
    localRuntime.refresh();
    onStatusRecheck();
  }, [localRuntime, onStatusRecheck]);

  // Codex's effort ladder is MODEL-gated, so the options track the model field
  // rather than a fixed constant: the gpt-6 family has no `minimal` rung and
  // rejects it with an HTTP 400, failing the render.
  const codexEffortLevels = effortLevelsForProvider(
    { id: 'codex', command: 'codex' },
    codexModel.trim() || CODEX_IMAGEGEN_DEFAULT_MODEL,
  );
  // Model picker options, read only once the Codex section is enabled. The
  // shipped default is always offered so the picker is never empty, even when
  // the provider read failed (the error row below says so).
  const { items: codexProviderModels, state: codexModelsState, error: codexModelsError, retry: retryCodexModels } = useListResource(fetchCodexProviderModels, { enabled: codexEnabled });
  const codexModelOptions = withUnlistedOption(
    [...new Set([CODEX_IMAGEGEN_DEFAULT_MODEL, ...codexProviderModels])].map((id) => ({ id })),
    codexModel.trim(),
    (id) => ({ id }),
  );
  // Raw string held while the user is typing in the parallel-limit input.
  // Clamping is deferred to onBlur so multi-digit entry isn't blocked; the
  // draft follows the form value whenever a load or a save clamp moves it.
  const [parallelLimitDraft, setParallelLimitDraft] = useState(String(codexParallelLimit));
  useEffect(() => { setParallelLimitDraft(String(codexParallelLimit)); }, [codexParallelLimit]);

  // Probe only while the Agy tab is actually open — the list spawns `agy models`
  // server-side, so an unopened tab must not pay for a child process.
  const {
    models: agyModels,
    error: agyModelsError,
    loading: agyModelsLoading,
    refresh: refreshAgyModels,
  } = useAgyModels(mediaTab === 'agy' && agyEnabled);

  // Stable ids for label/input associations
  const codexPathId = useId();
  const codexModelId = useId();
  const codexEffortId = useId();
  const codexParallelId = useId();
  const grokPathId = useId();
  const grokRatioId = useId();
  const grokImageParallelId = useId();
  const grokVideoParallelId = useId();
  const agyPathId = useId();
  const agyModelId = useId();
  const agyModelsListId = useId();
  const agyImageParallelId = useId();
  const runwayImageParallelId = useId();
  const runwayVideoParallelId = useId();
  const falModelId = useId();
  const falImageParallelId = useId();
  const falVideoParallelId = useId();
  const higgsfieldModelId = useId();
  const higgsfieldImageParallelId = useId();
  const higgsfieldVideoParallelId = useId();
  const googleModelId = useId();
  const googleProjectFieldId = useId();
  const googleLocationFieldId = useId();
  const googleImageParallelId = useId();
  const googleVideoParallelId = useId();

  return (
    <>
      {mediaTab === 'external' && (
        <div className={SECTION_CLASS}>
          <FormField label="External AUTOMATIC1111 / Forge URL" labelClassName="text-sm font-medium text-gray-300">
            <input
              id="sdapi-url"
              type="text"
              value={sdapiUrl}
              onChange={(e) => set('sdapiUrl', e.target.value)}
              className={INPUT_CLASS}
              placeholder="http://localhost:7860"
            />
            <p className="text-xs text-gray-500">Base URL for the SD WebUI server PortOS should send generation requests to.</p>
          </FormField>
          <CleanersToggles mode={IMAGE_GEN_MODE.EXTERNAL} form={form} />
        </div>
      )}

      {localMounted && (
        <div className={`${SECTION_CLASS} ${mediaTab === 'local' ? '' : 'hidden'}`}>
          <h3 className="text-sm font-medium text-gray-300">Local runtimes (image + video)</h3>
          <p className="text-xs text-gray-500">
            Pick a Python 3.10+ interpreter — PortOS auto-detects the configured local runtimes and can install
            missing packages directly. HF model weights stream into the standard <code>~/.cache/huggingface</code>
            and are surfaced in <a href="/models/media" className="text-port-accent hover:underline">{getNavPageForPath('/models/media')?.breadcrumb || 'its management page'}</a>.
          </p>
          <div className="bg-port-bg border border-port-border rounded-lg p-3 text-xs text-gray-400">
            <span className="font-medium text-gray-300">Parallel limit:</span> Local model lanes stay at their memory-governed limit (1 render at a time) to protect system memory and GPU stability.
          </div>
          {/* The verdict first, then the interpreter detail below it. The
              packages panel only ever probes the mflux interpreter, so on its
              own it reported "All required packages installed" for a machine
              whose pinned model renders through the SHARED torch venv and could
              not run at all. This is the same diagnosis the Image Gen status
              pill and the renderer's pre-flight refusal use — settingsLink is
              off because this IS the settings form. */}
          <LocalRuntimeStatus
            runtime={localRuntime.runtime}
            loading={localRuntime.loading}
            onRefresh={localRuntime.refresh}
            settingsLink={false}
          />
          <LocalSetupPanel pythonPath={pythonPath} onPythonPathChange={(v) => set('pythonPath', v)} onPackagesChanged={onLocalPackagesChanged} />
          <p className="text-xs text-gray-500">
            MOSS Image SFT uses a separate Swift/MLX runtime. Select it below to install on native Apple Silicon,
            macOS 26+, with Swift 6.3 and the Metal compiler. Allow 10 GB for building and 27.2 GB for weights;
            48 GB unified memory is the eligibility floor. Validated on M5 Max with 128 GB. Text-to-image,
            bf16 only, 256–1024 pixels per side. Weight download is explicit.
          </p>
          <FormField label="Default model" labelClassName={FIELD_LABEL_CLASS}>
            <select
              value={localModelId}
              onChange={(e) => set('localModelId', e.target.value)}
              disabled={localModels === null}
              className={`${INPUT_CLASS} disabled:opacity-50`}
            >
              <option value="">
                {localModels === null ? 'Loading models…' : `Install default (${localDefaultLabel})`}
              </option>
              {localModelOptions.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
            </select>
          </FormField>
          {/* Deliberately does NOT point at the Defaults tab: its per-surface
              model pin is gated on supportsCloudModelOverride and hidden for
              Local, and renderDefaults[target].imageModel only ever reaches
              resolveCloudProviderConfig — so for local renders it is inert.
              What actually outranks this pin is a per-record/per-render model
              choice, which is what the sentence names. */}
          <p className="text-xs text-gray-500">
            Used by every local render that doesn&apos;t choose its own model — the Image Gen
            form, deck cards, sprite references, pipeline visuals, character sheets and
            FableLoom. A model picked on one of those surfaces still wins for that render.
            Most models download weights on first use; MOSS requires its separate download action. Check what&apos;s already cached in{' '}
            <a href="/models/media" className="text-port-accent hover:underline">{getNavPageForPath('/models/media')?.breadcrumb || 'its management page'}</a>.
          </p>
          {localModels?.length === 0 && (
            <p role="status" className="text-xs text-port-warning">
              No local image models are compatible with this machine.
            </p>
          )}
          <div className="border-t border-port-border pt-4 space-y-3">
            <h3 className="text-sm font-medium text-gray-300">Local video model</h3>
            <FormField label="Default local video model" labelClassName={FIELD_LABEL_CLASS}>
              <select
                value={localVideoModelId}
                onChange={(e) => set('localVideoModelId', e.target.value)}
                disabled={localVideoModels === null || videoModelContextFailed}
                className={`${INPUT_CLASS} disabled:opacity-50`}
              >
                <option value="">
                  {localVideoModels === null
                    ? videoModelContextFailed ? 'Video models unavailable' : 'Loading models…'
                    : `Install default (${localVideoDefaultLabel})`}
                </option>
                {localVideoModelOptions.map((model) => (
                  <option key={model.id} value={model.id}>{model.name || model.id}</option>
                ))}
              </select>
            </FormField>
            <p className="text-xs text-gray-500">
              Used by local video renders that do not choose a model. A model selected for a
              render still wins. Weights download on first use; check the{' '}
              <a href="/models/media" className="text-port-accent hover:underline">
                {getNavPageForPath('/models/media')?.breadcrumb || 'media models page'}
              </a>{' '}for cached models.
            </p>
            {videoModelContextFailed && (
              <p role="status" className="text-xs text-port-warning">Could not load local video models.</p>
            )}
            {localVideoModels?.length === 0 && !videoModelContextFailed && (
              <p role="status" className="text-xs text-port-warning">
                No local video models are compatible with this machine.
              </p>
            )}
          </div>
          <CleanersToggles mode={IMAGE_GEN_MODE.LOCAL} form={form} />
        </div>
      )}

      {/* Codex CLI config — the toggle that enables the option lives here.
          Codex appears as a backend tile only after the user flips this on. */}
      {mediaTab === 'codex' && (
      <div className={SECTION_CLASS}>
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
          <input type="checkbox" checked={codexEnabled} onChange={toggleProvider('codexEnabled', IMAGE_GEN_MODE.CODEX)} className="rounded" />
          <span className="text-sm text-gray-300">Enable Codex Imagegen</span>
        </label>
        {codexEnabled && (
          <div className="space-y-3 pl-6 border-l-2 border-port-border">
            <FormField label="Codex binary path (optional)" labelClassName={FIELD_LABEL_CLASS}>
              <input
                id={codexPathId}
                type="text"
                value={codexPath}
                onChange={(e) => set('codexPath', e.target.value)}
                className={INPUT_CLASS}
                placeholder="codex (uses $PATH)"
              />
              <p className="text-xs text-gray-500 mt-1">Leave empty to invoke <code>codex</code> from $PATH.</p>
            </FormField>
            <FormField label="Model override (optional)" labelClassName={FIELD_LABEL_CLASS}>
              <select
                id={codexModelId}
                value={codexModel.trim()}
                onChange={(e) => set('codexModel', e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Default ({CODEX_IMAGEGEN_DEFAULT_MODEL})</option>
                {codexModelOptions.map(({ id }) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              {codexModelsState === 'error' && (
                <ListLoadError what="your Codex provider's models" error={codexModelsError} onRetry={retryCodexModels} className="mt-1" />
              )}
              <p className="text-xs text-gray-500 mt-1">Passed as <code>codex exec -m &lt;model&gt;</code>. Leave on Default for the cheap shipped model (<code>{CODEX_IMAGEGEN_DEFAULT_MODEL}</code>). Models come from your Codex provider.</p>
            </FormField>
            <FormField label="Reasoning effort (optional)" labelClassName={FIELD_LABEL_CLASS}>
              <select
                id={codexEffortId}
                value={codexEffort}
                onChange={(e) => set('codexEffort', e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Default ({CODEX_IMAGEGEN_DEFAULT_EFFORT})</option>
                {codexEffortLevels.map((lvl) => (
                  <option key={lvl} value={lvl}>{lvl}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">Passed as <code>codex exec -c model_reasoning_effort=&lt;level&gt;</code>. Lower effort is cheaper; leave on the shipped default (<code>{CODEX_IMAGEGEN_DEFAULT_EFFORT}</code>){codexEffortLevels[0] !== CODEX_IMAGEGEN_DEFAULT_EFFORT ? <> or drop to <code>{codexEffortLevels[0]}</code> for the cheapest possible renders</> : null}. The levels offered depend on the model above.</p>
            </FormField>
            <FormField label="Parallel render limit" labelClassName={FIELD_LABEL_CLASS}>
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
                  set('codexParallelLimit', clamped);
                  setParallelLimitDraft(String(clamped));
                }}
                className="w-24 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
              />
              <p className="text-xs text-gray-500 mt-1">
                How many renders each cloud provider (Codex, Grok, Agy, …) runs in parallel; providers never wait on each other. Default <code>{formatCount(parallelBounds.default)}</code>.
                Higher values let large batches finish faster, subject to your provider&apos;s rate limits, and increase simultaneous usage.
                {codexParallelLimit > 5 && (
                  <span className="block mt-1 text-port-warning">
                    ⚠️ {formatCount(codexParallelLimit)} concurrent renders can burn credits quickly during a long batch. Watch usage.
                  </span>
                )}
              </p>
            </FormField>
            <CleanersToggles mode={IMAGE_GEN_MODE.CODEX} form={form} />
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
      <div className={SECTION_CLASS}>
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
          <input type="checkbox" checked={grokEnabled} onChange={toggleProvider('grokEnabled', IMAGE_GEN_MODE.GROK)} className="rounded" />
          <span className="text-sm text-gray-300">Enable Grok Imagegen</span>
        </label>
        {grokEnabled && (
          <div className="space-y-3 pl-6 border-l-2 border-port-border">
            <FormField label="Grok binary path (optional)" labelClassName={FIELD_LABEL_CLASS}>
              <input
                id={grokPathId}
                type="text"
                value={grokPath}
                onChange={(e) => set('grokPath', e.target.value)}
                className={INPUT_CLASS}
                placeholder="grok (uses $PATH)"
              />
              <p className="text-xs text-gray-500 mt-1">Leave empty to invoke <code>grok</code> from $PATH.</p>
            </FormField>
            <FormField label="Default aspect ratio (optional)" labelClassName={FIELD_LABEL_CLASS}>
              <select
                id={grokRatioId}
                value={grokAspectRatio}
                onChange={(e) => set('grokAspectRatio', e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Auto (from requested size)</option>
                {GROK_ASPECT_RATIOS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Applied when a render doesn't specify dimensions. A render's width/height maps to the nearest supported ratio automatically.
              </p>
            </FormField>
            <ParallelLimitField
              id={grokImageParallelId}
              label="Parallel image render limit"
              value={grokImageParallelLimit}
              onChange={(v) => set('grokImageParallelLimit', v)}
              bounds={parallelBounds}
              helpText="How many image renders Grok runs at once. Default 1."
              warningText={`${formatCount(grokImageParallelLimit)} concurrent renders can burn credits quickly during a long batch.`}
            />
            <ParallelLimitField
              id={grokVideoParallelId}
              label="Parallel video render limit"
              value={grokVideoParallelLimit}
              onChange={(v) => set('grokVideoParallelLimit', v)}
              bounds={parallelBounds}
              helpText="How many video renders Grok runs at once. Default 1."
              warningText={`${formatCount(grokVideoParallelLimit)} concurrent video renders can burn credits or hit rate limits quickly.`}
            />
            <CleanersToggles mode={IMAGE_GEN_MODE.GROK} form={form} />
          </div>
        )}
      </div>
      )}

      {mediaTab === 'agy' && (
      <div className={SECTION_CLASS}>
        <div className="flex items-center gap-2 text-white">
          <Terminal size={18} />
          <h2 className="text-lg font-semibold">Agy CLI Imagegen</h2>
        </div>
        <p className="text-xs text-gray-500">
          Route text-to-image generation through Antigravity's built-in
          <code className="text-gray-400"> generate_image </code> tool. Agy runs in an isolated scratch
          directory and PortOS imports only the directed image output. Image editing is not supported.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={agyEnabled} onChange={toggleProvider('agyEnabled', IMAGE_GEN_MODE.AGY)} className="rounded" />
          <span className="text-sm text-gray-300">Enable Agy Imagegen</span>
        </label>
        {agyEnabled && (
          <div className="space-y-3 pl-6 border-l-2 border-port-border">
            <FormField label="Agy binary path (optional)" labelClassName={FIELD_LABEL_CLASS}>
              <input
                id={agyPathId}
                type="text"
                value={agyPath}
                onChange={(e) => set('agyPath', e.target.value)}
                className={INPUT_CLASS}
                placeholder="agy (uses $PATH)"
              />
            </FormField>
            <div className="flex items-end justify-between gap-3 mb-1">
              <FormField label="Agent model (drives the session — not the image model)" labelClassName="block text-xs font-medium text-gray-400" className="flex-1">
                <input
                  id={agyModelId}
                  list={agyModelsListId}
                  type="text"
                  value={agyModel}
                  onChange={(e) => set('agyModel', e.target.value)}
                  className={INPUT_CLASS}
                  placeholder={`${AGY_IMAGEGEN_DEFAULT_MODEL} (default)`}
                />
              </FormField>
              <button
                type="button"
                onClick={refreshAgyModels}
                disabled={agyModelsLoading}
                className="text-xs text-port-accent hover:underline disabled:opacity-50"
              >
                {agyModelsLoading ? <BrailleSpinner text="Loading…" /> : 'Refresh models'}
              </button>
            </div>
            <div>
              <datalist id={agyModelsListId}>
                {agyModels.map((modelId) => <option key={modelId} value={modelId} />)}
              </datalist>
              {agyModelsError && <p role="status" className="text-xs text-port-warning mt-1">{agyModelsError}. You can still enter a custom model id.</p>}
              {/* This is the model `agy --model` runs the SESSION on — the agent that
                  calls the built-in generate_image tool. Agy exposes no knob for the
                  underlying image model (generate_image takes Prompt / ImageName /
                  AspectRatio / ImagePaths and nothing else — schema re-dumped from a
                  live session 2026-07-30, agy 1.1.8), so there is no imagen-* option to
                  pick here — the image model is fixed server-side (see the read-only
                  row below and AGY_IMAGEGEN_IMAGE_MODEL). An id outside `agy models`
                  makes agy exit non-zero before generating, which is why the list is a
                  live probe. */}
              {!agyModelsError && (
                <p className="text-xs text-gray-500 mt-1">
                  The agent model Agy runs the session on — it drives the built-in{' '}
                  <code className="text-gray-400">generate_image</code> tool. Leave empty to
                  use the cheap default (<code className="text-gray-400">{AGY_IMAGEGEN_DEFAULT_MODEL}</code>).
                  Renders can pin a different agent model per queue item on the Image Gen page.
                </p>
              )}
            </div>
            <div>
              <span className="block text-xs font-medium text-gray-400 mb-1">Image model</span>
              <p className="text-sm text-gray-300">
                <code className="text-gray-300">{AGY_IMAGEGEN_IMAGE_MODEL}</code>{' '}
                <span className="text-xs text-gray-500">
                  — chosen by Antigravity server-side; not selectable through the CLI
                  (no tool parameter, no <code>--model</code> id, prompt requests are ignored —
                  agy will claim it honored one, but the pixels come out identical).
                </span>
              </p>
            </div>
            <ParallelLimitField
              id={agyImageParallelId}
              label="Parallel image render limit"
              value={agyImageParallelLimit}
              onChange={(v) => set('agyImageParallelLimit', v)}
              bounds={parallelBounds}
              helpText="How many image renders Agy runs at once. Default 1."
              warningText={`${formatCount(agyImageParallelLimit)} concurrent renders can hit CLI session limits.`}
            />
            <CleanersToggles mode={IMAGE_GEN_MODE.AGY} form={form} />
          </div>
        )}
      </div>
      )}

      {mediaTab === 'runway' && (
        <div className={SECTION_CLASS}>
          <h2 className="text-lg font-semibold text-white">Runway Imagegen</h2>
          <p className="text-xs text-gray-400">Uses the Runway credential from <Link to="/settings/credentials" className="text-port-accent hover:underline">Settings → Credentials</Link>, shared with video generation.</p>
          <p className="text-xs text-gray-400">{runwayCredential == null ? 'Checking credential…' : runwayCredential.configured ? 'Runway credential configured.' : 'Add a Runway credential to render.'}</p>
          <p className="text-xs text-gray-400">{RUNWAY_IMAGE_DISCLOSURE.summary} <a href={RUNWAY_IMAGE_DISCLOSURE.termsUrl} target="_blank" rel="noreferrer" className="text-port-accent hover:underline">Runway’s terms</a> and moderation apply. {RUNWAY_IMAGE_DISCLOSURE.billing}</p>
          <label className="flex items-center gap-3 cursor-pointer"><input type="checkbox" checked={values.runwayEnabled} onChange={toggleProvider('runwayEnabled', IMAGE_GEN_MODE.RUNWAY)} /><span>Enable Runway Imagegen</span></label>
          <FormField label="Default model" labelClassName={FIELD_LABEL_CLASS}>
            <select value={values.runwayModel} onChange={(e) => { set('runwayModel', e.target.value); set('runwayResolution', getRunwayImageModel(e.target.value).defaultResolution); }} className={INPUT_CLASS}>
              {!runwayCatalog.imageModels.some((m) => m.id === values.runwayModel) && <option value={values.runwayModel}>{values.runwayModel} (unavailable)</option>}
              {runwayCatalog.imageModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.minReferences ? ' (requires a reference)' : ''}</option>)}
            </select>
          </FormField>
          <FormField label="Resolution" labelClassName={FIELD_LABEL_CLASS}>
            <select value={values.runwayResolution} onChange={(e) => set('runwayResolution', e.target.value)} className={INPUT_CLASS}>
              {Object.keys(getRunwayImageModel(values.runwayModel)?.ratios || {}).map((resolution) => (
                <option key={resolution} value={resolution}>
                  {resolution === 'auto' ? 'Match requested aspect ratio' : resolution.replace(':', ' × ')}{getRunwayImageModel(values.runwayModel)?.credits[resolution] != null ? ` · ${formatCount(getRunwayImageModel(values.runwayModel).credits[resolution])} credits` : ''}
                </option>
              ))}
            </select>
          </FormField>
          <ParallelLimitField
            id={runwayImageParallelId}
            label="Parallel image render limit"
            value={runwayImageParallelLimit}
            onChange={(v) => set('runwayImageParallelLimit', v)}
            bounds={parallelBounds}
            helpText="How many image renders Runway runs at once. Default 1."
            warningText={`${formatCount(runwayImageParallelLimit)} concurrent renders can burn Runway credits quickly.`}
          />
          <ParallelLimitField
            id={runwayVideoParallelId}
            label="Parallel video render limit"
            value={runwayVideoParallelLimit}
            onChange={(v) => set('runwayVideoParallelLimit', v)}
            bounds={parallelBounds}
            helpText="How many video renders Runway runs at once. Default 1."
            warningText={`${formatCount(runwayVideoParallelLimit)} concurrent video renders can burn Runway credits quickly.`}
          />
          <RunwayCatalogStatus catalog={runwayCatalog} />
          <CleanersToggles mode={IMAGE_GEN_MODE.RUNWAY} form={form} />
          <DeleteAfterDownloadToggle label="Delete from Runway after download" detail="Once a render is saved here, remove the rendered asset from Runway (image and video renders). Irreversible: the output can't be re-fetched from Runway afterward. Runway keeps its request history log, including the input prompt and input image. A failed delete is logged and never fails the render." checked={values.runwayDeleteAfterDownload} onChange={(v) => set('runwayDeleteAfterDownload', v)} />
        </div>
      )}
      {mediaTab === 'fal' && (
      <div className={SECTION_CLASS}>
        <div className="flex items-center gap-2 text-white">
          <Sparkles size={18} />
          <h2 className="text-lg font-semibold">fal.ai Imagegen</h2>
        </div>
        <p className="text-xs text-gray-500">
          Render through fal.ai&rsquo;s hosted image models. Renders with reference or source images
          go to the chosen model&rsquo;s edit endpoint, so mood-board references condition the result.
          Every render is billed to your fal.ai account; the gallery records each image&rsquo;s estimated cost.
        </p>
        {/* Key presence comes from the shared credential inventory — the key
            itself is write-only and lives on the Defaults tab with the fal.ai
            video key it is shared with. */}
        {falCredential == null ? (
          <div className="text-xs text-gray-500"><BrailleSpinner text="Checking fal.ai key" /></div>
        ) : falCredential.configured ? (
          <div className="flex items-center gap-2 text-xs text-port-success">
            <Check size={14} />
            <span>fal.ai API key configured (shared with the fal.ai video backend)</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-port-warning">
            <AlertTriangle size={14} />
            <span>No fal.ai API key — set it under the Defaults tab (fal.ai API key, shared with Video Gen) first.</span>
            <button type="button" onClick={() => setMediaTab('defaults')} className="text-port-accent hover:underline">
              Open Defaults
            </button>
          </div>
        )}
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={falEnabled} onChange={toggleProvider('falEnabled', IMAGE_GEN_MODE.FAL)} className="rounded" />
          <span className="text-sm text-gray-300">Enable fal.ai Imagegen</span>
        </label>
        {falEnabled && (
          <div className="space-y-3 pl-6 border-l-2 border-port-border">
            <FormField label="Default model" labelClassName={FIELD_LABEL_CLASS}>
              <FalModelSelect
                id={falModelId}
                value={falModel}
                onChange={(v) => set('falModel', v || '')}
                defaultLabel={`${falImageFamily(FAL_IMAGE_DEFAULT_MODEL)?.label} (default)`}
                className={INPUT_CLASS}
              />
            </FormField>
            <p className="text-xs text-gray-500">
              Prices are fal.ai&rsquo;s published per-image rates (Nano Banana charges more at 4K; FLUX.2 bills
              output plus reference megapixels). Renders can pick a different model per queue item on the
              Image Gen page, and each surface can pin one under Defaults.
            </p>
            <ParallelLimitField
              id={falImageParallelId}
              label="Parallel image render limit"
              value={falImageParallelLimit}
              onChange={(v) => set('falImageParallelLimit', v)}
              bounds={parallelBounds}
              helpText="How many image renders fal.ai runs at once. Default 1."
              warningText={`${formatCount(falImageParallelLimit)} concurrent renders can burn fal credits quickly.`}
            />
            <ParallelLimitField
              id={falVideoParallelId}
              label="Parallel video render limit"
              value={falVideoParallelLimit}
              onChange={(v) => set('falVideoParallelLimit', v)}
              bounds={parallelBounds}
              helpText="How many video renders fal.ai runs at once. Default 1."
              warningText={`${formatCount(falVideoParallelLimit)} concurrent video renders can burn fal credits quickly.`}
            />
            <CleanersToggles mode={IMAGE_GEN_MODE.FAL} form={form} />
          </div>
        )}
        <DeleteAfterDownloadToggle label="Delete from fal.ai after download" detail="Once a render is saved here, remove its stored payloads and output files from fal.ai (image and video renders). Irreversible: the output can't be re-fetched from fal.ai afterward. A failed delete is logged and never fails the render." checked={values.falDeleteAfterDownload} onChange={(v) => set('falDeleteAfterDownload', v)} />
      </div>
      )}

      {mediaTab === 'higgsfield' && (
      <div className={SECTION_CLASS}>
        <div className="flex items-center gap-2 text-white">
          <Sparkles size={18} />
          <h2 className="text-lg font-semibold">Higgsfield Imagegen</h2>
        </div>
        <p className="text-xs text-gray-500">
          Render through Higgsfield&rsquo;s hosted image models. Renders with reference images go to the
          model&rsquo;s edit endpoint where it has one. Prompt-rewrite options are always sent off.
          Higgsfield publishes no per-image prices, so the gallery leaves cost unknown; your Higgsfield
          console shows the real charge.
        </p>
        {higgsfieldCredential == null ? (
          <div className="text-xs text-gray-500"><BrailleSpinner text="Checking Higgsfield key" /></div>
        ) : higgsfieldCredential.configured ? (
          <div className="flex items-center gap-2 text-xs text-port-success">
            <Check size={14} />
            <span>Higgsfield API key configured (shared with the Higgsfield video backend)</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-port-warning">
            <AlertTriangle size={14} />
            <span>No Higgsfield API key — set it under the Defaults tab (Higgsfield API key, shared with Video Gen) first.</span>
            <button type="button" onClick={() => setMediaTab('defaults')} className="text-port-accent hover:underline">
              Open Defaults
            </button>
          </div>
        )}
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={higgsfieldEnabled} onChange={toggleProvider('higgsfieldEnabled', IMAGE_GEN_MODE.HIGGSFIELD)} className="rounded" />
          <span className="text-sm text-gray-300">Enable Higgsfield Imagegen</span>
        </label>
        {higgsfieldEnabled && (
          <div className="space-y-3 pl-6 border-l-2 border-port-border">
            <FormField label="Default model" labelClassName={FIELD_LABEL_CLASS}>
              <HiggsfieldModelSelect
                id={higgsfieldModelId}
                value={higgsfieldModel}
                onChange={(v) => set('higgsfieldModel', v || '')}
                defaultLabel={`${higgsfieldImageFamily(HIGGSFIELD_IMAGE_DEFAULT_MODEL)?.label} (default)`}
                className={INPUT_CLASS}
              />
            </FormField>
            <ParallelLimitField
              id={higgsfieldImageParallelId}
              label="Parallel image render limit"
              value={higgsfieldImageParallelLimit}
              onChange={(v) => set('higgsfieldImageParallelLimit', v)}
              bounds={parallelBounds}
              helpText="How many image renders Higgsfield runs at once. Default 1."
              warningText={`${formatCount(higgsfieldImageParallelLimit)} concurrent renders can spend Higgsfield credit quickly.`}
            />
            <ParallelLimitField
              id={higgsfieldVideoParallelId}
              label="Parallel video render limit"
              value={higgsfieldVideoParallelLimit}
              onChange={(v) => set('higgsfieldVideoParallelLimit', v)}
              bounds={parallelBounds}
              helpText="How many video renders Higgsfield runs at once. Default 1."
              warningText={`${formatCount(higgsfieldVideoParallelLimit)} concurrent video renders can spend Higgsfield credit quickly.`}
            />
            <CleanersToggles mode={IMAGE_GEN_MODE.HIGGSFIELD} form={form} />
          </div>
        )}
        <DeleteAfterDownloadToggle label="Delete from Higgsfield after download" detail="Once a render is saved here, delete its request data and outputs from Higgsfield (image and video renders). Irreversible: the output can't be re-fetched from Higgsfield afterward. A failed delete is logged and never fails the render." checked={values.higgsfieldDeleteAfterDownload} onChange={(v) => set('higgsfieldDeleteAfterDownload', v)} />
      </div>
      )}

      {mediaTab === 'google' && (
      <div className={SECTION_CLASS}>
        <div className="flex items-center gap-2 text-white">
          <Sparkles size={18} />
          <h2 className="text-lg font-semibold">Google Imagegen</h2>
        </div>
        <p className="text-xs text-gray-500">
          Render through Google Cloud Agent Platform: the Gemini image models (Nano Banana) take reference images,
          Imagen 4 is text-to-image. Imagen&rsquo;s prompt rewrite is sent off. Prices shown are Google list
          prices; your Google Cloud billing console shows the real charge.
        </p>
        {googleCredential == null ? (
          <div className="text-xs text-gray-500"><BrailleSpinner text="Checking Google credential" /></div>
        ) : googleCredential.configured ? (
          <div className="flex items-center gap-2 text-xs text-port-success">
            <Check size={14} />
            <span>Google credential configured (shared with the Google video backend)</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-port-warning">
            <AlertTriangle size={14} />
            <span>No Google credential — paste an API key or service account JSON under the Defaults tab first.</span>
            <button type="button" onClick={() => setMediaTab('defaults')} className="text-port-accent hover:underline">
              Open Defaults
            </button>
          </div>
        )}
        <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),20rem))]">
          <FormField label="Google Cloud project" labelClassName={FIELD_LABEL_CLASS}>
            <input
              id={googleProjectFieldId}
              type="text"
              value={googleProjectId}
              onChange={(e) => set('googleProjectId', e.target.value)}
              placeholder="From the service account key"
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </FormField>
          <FormField label="Region" labelClassName={FIELD_LABEL_CLASS}>
            <input
              id={googleLocationFieldId}
              type="text"
              value={googleLocation}
              onChange={(e) => set('googleLocation', e.target.value)}
              placeholder="us-central1"
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </FormField>
        </div>
        <p className="text-xs text-gray-500">
          With a service account key, a blank project uses the key&rsquo;s own project. With an API key, a blank project
          means Agent Platform express mode, which serves the Nano Banana models only; Imagen and Veo need the project.
          The region applies to Imagen and Veo; the Gemini image models always run on the global endpoint.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={googleEnabled} onChange={toggleProvider('googleEnabled', IMAGE_GEN_MODE.GOOGLE)} className="rounded" />
          <span className="text-sm text-gray-300">Enable Google Imagegen</span>
        </label>
        {googleEnabled && (
          <div className="space-y-3 pl-6 border-l-2 border-port-border">
            <FormField label="Default model" labelClassName={FIELD_LABEL_CLASS}>
              <GoogleModelSelect
                id={googleModelId}
                value={googleModel}
                onChange={(v) => set('googleModel', v || '')}
                defaultLabel={`${googleImageFamily(GOOGLE_IMAGE_DEFAULT_MODEL)?.label} (default)`}
                className={INPUT_CLASS}
              />
            </FormField>
            <ParallelLimitField
              id={googleImageParallelId}
              label="Parallel image render limit"
              value={googleImageParallelLimit}
              onChange={(v) => set('googleImageParallelLimit', v)}
              bounds={parallelBounds}
              helpText="How many image renders Google runs at once. Default 1."
              warningText={`${formatCount(googleImageParallelLimit)} concurrent renders can spend Google Cloud credit quickly.`}
            />
            <CleanersToggles mode={IMAGE_GEN_MODE.GOOGLE} form={form} />
          </div>
        )}
        <ParallelLimitField
          id={googleVideoParallelId}
          label="Parallel video render limit"
          value={googleVideoParallelLimit}
          onChange={(v) => set('googleVideoParallelLimit', v)}
          bounds={parallelBounds}
          helpText="How many Veo renders run at once. Default 1."
          warningText={`${formatCount(googleVideoParallelLimit)} concurrent Veo renders can spend Google Cloud credit quickly.`}
        />
      </div>
      )}
    </>
  );
}

function ParallelLimitField({
  id,
  label = 'Parallel render limit',
  value,
  onChange,
  bounds = PARALLEL_FALLBACK,
  helpText,
  warningThreshold = 5,
  warningText,
}) {
  const [draft, setDraft] = useState(String(value ?? bounds.default));
  useEffect(() => {
    setDraft(String(value ?? bounds.default));
  }, [value, bounds.default]);

  const numValue = Number(value ?? bounds.default);

  return (
    <FormField label={label} labelClassName={FIELD_LABEL_CLASS}>
      <input
        id={id}
        type="number"
        min={bounds.min}
        max={bounds.max}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const clamped = clampParallel(draft, bounds);
          onChange(clamped);
          setDraft(String(clamped));
        }}
        className="w-24 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
      />
      {helpText && <p className="text-xs text-gray-500 mt-1">{helpText}</p>}
      {numValue > warningThreshold && warningText && (
        <span className="block mt-1 text-xs text-port-warning">
          ⚠️ {warningText}
        </span>
      )}
    </FormField>
  );
}

// Applies to both image and video renders from the provider. The saved file and its record are kept; what the
// provider-side delete removes differs per provider, so the caller supplies the wording.
function DeleteAfterDownloadToggle({ label, detail, checked, onChange }) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-3 cursor-pointer">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="rounded" />
        <span className="text-sm text-gray-300">{label}</span>
      </label>
      <p className="text-xs text-gray-500 pl-7">{detail}</p>
    </div>
  );
}

// Per-provider post-render cleaner toggles. Both must run before the SSE
// complete event fires so subscribers see the cleaned bytes on first fetch —
// enforced by the provider success paths, not here. A future "Clean SynthID"
// diffusion option will join this group when ready.
//   - cleanC2PA (default ON): byte-level strip of the gpt-image `caBX`
//     provenance chunk. Lossless — pixels untouched.
//   - denoise   (default OFF): median(3) + sharpen pass for AI-artifact
//     reduction. LOSSY: blurs annotation text and small details.
function CleanersToggles({ mode, form }) {
  const { values, set } = form;
  return (
    <div className="space-y-2 pt-1">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={values.cleanC2PAByMode[mode]}
          onChange={(e) => set(`cleanC2PAByMode.${mode}`, e.target.checked)}
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
          checked={values.denoiseByMode[mode]}
          onChange={(e) => set(`denoiseByMode.${mode}`, e.target.checked)}
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
