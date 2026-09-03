import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import { filterHardwareCompatibleProviderModels, filterGenerationModels, isEmbeddingModel, isProviderHardwareCompatible, isProviderModelHardwareCompatible, mergeModelLists, configuredDefaultIn, localBackendForProvider, modelOptionLabel, isProcessProvider, isLocalEndpoint, effectiveModelContextWindow, isRunnerAllowedCommand, effortLevelsForProvider, isOllamaBackedProvider, gatewayForProvider, isClaudeCommandProvider, generationControlsFor } from '../../utils/providers';
import Banner from '../ui/Banner';
import {
  formatDurationMs,
  formatContextLength,
  parseTimeoutMs,
  TIMEOUT_INPUT_MIN_MS,
  TIMEOUT_INPUT_MAX_MS,
  TIMEOUT_INPUT_STEP_MS,
} from '../../utils/formatters';
import EffortSelect from '../cos/EffortSelect';
import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';
import { FormField } from '../ui/FormField';
import { GatewayKeyHint } from './ProviderNotices';

// The provider editor's Drawer tabs. `connection` is the default, so a bare
// /ai/edit/:providerId deep link opens on the identity/transport fields; the
// others are reachable as /ai/edit/:providerId?providerTab=<id>.
const PROVIDER_FORM_TABS = [
  { id: 'connection', label: 'Connection' },
  { id: 'models', label: 'Models' },
  { id: 'generation', label: 'Generation' },
  { id: 'environment', label: 'Environment' },
];
const PROVIDER_FORM_TAB_IDS = PROVIDER_FORM_TABS.map(t => t.id);

// Numeric bounds for the editor's number inputs. Declared once so an input's own
// `min`/`max` and the submit-time check that stands in for it (the drawer
// unmounts inactive tabs, so the browser can't validate a field the user isn't
// looking at) can never drift apart. Mirrors the provider schema in
// `server/lib/aiToolkit/validation.js`; `timeout` is absent because it has a
// shared parser (`parseTimeoutMs`) that already owns its bounds.
const PROVIDER_FIELD_RANGES = {
  tuiPromptDelayMs: { min: 250, max: 60000 },
  contextWindow: { min: 512, max: 2097152 },
  numCtx: { min: 512, max: 1048576 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
};

const rangeMessage = (label, { min, max }, unit = '') =>
  `${label} must be between ${min.toLocaleString()} and ${max.toLocaleString()}${unit ? ` ${unit}` : ''}`;

export default function ProviderForm({ provider, onClose, onSave, onEditProvider, allProviders = [], localModels = { ollama: [], lmstudio: [], ctxById: {}, hardwareCompatibilityByBackend: {} }, runnerAllowedCommands = null }) {
  const [formData, setFormData] = useState({
    name: provider?.name || '',
    type: provider?.type || 'cli',
    command: provider?.command || '',
    args: provider?.args?.join(' ') || '',
    endpoint: provider?.endpoint || '',
    apiKey: '',
    allowCustomEndpoint: provider?.allowCustomEndpoint === true,
    models: provider?.models || [],
    hardwareRequirements: provider?.hardwareRequirements,
    modelHardwareRequirements: provider?.modelHardwareRequirements,
    defaultModel: provider?.defaultModel || '',
    effort: provider?.effort || '',
    lightModel: provider?.lightModel || '',
    mediumModel: provider?.mediumModel || '',
    heavyModel: provider?.heavyModel || '',
    fallbackProvider: provider?.fallbackProvider || '',
    fallbackModel: provider?.fallbackModel || '',
    numCtx: provider?.numCtx ?? '',
    // All three seed from the record ONLY. Seeding a value the provider does not
    // have would let an unrelated Save pin it — the editor must be able to leave
    // "unset" alone, since unset is what lets each backend keep its own default.
    temperature: provider?.temperature ?? '',
    topP: provider?.topP ?? '',
    thinking: provider?.thinking === true ? 'true' : provider?.thinking === false ? 'false' : '',
    contextWindow: provider?.contextWindow ?? '',
    timeout: provider?.timeout || 300000,
    enabled: provider?.enabled !== false,
    textTransportEnabled: provider?.textTransportEnabled === true
      && provider?.textTransportReadRiskAcknowledged === true,
    textTransportReadRiskAcknowledged: provider?.textTransportReadRiskAcknowledged === true,
    envVars: provider?.envVars || {},
    secretEnvVars: provider?.secretEnvVars || [],
    headlessArgs: provider?.headlessArgs?.join(' ') || '',
    tuiPromptDelayMs: provider?.tuiPromptDelayMs || 2500
  });

  const [activeTab, setActiveTab] = useDrawerTab('providerTab', 'connection', PROVIDER_FORM_TAB_IDS);

  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [newEnvSecret, setNewEnvSecret] = useState(false);

  // Live installed Ollama/LM Studio models, folded into the model pickers so a
  // local provider shows what's actually installed — not just the stale `models`
  // list stored on the provider record (the "Command R+ / Gemma missing" bug).
  // Passed down from the page, which already holds this status for the cards.
  const liveModelsFor = (p) => {
    const backend = localBackendForProvider(p);
    return backend ? localModels[backend] : [];
  };

  const liveHardwareFor = (p) => {
    const backend = localBackendForProvider(p);
    return backend ? localModels.hardwareCompatibilityByBackend?.[backend] || {} : {};
  };

  // Generation pickers (default + light/medium/heavy tiers) — drop embedding-only
  // models (and internal sentinels) so an embedding can't be chosen as a model
  // that runs prompts, consistent with the fallback picker below.
  const mergedModels = mergeModelLists(formData.models, liveModelsFor(formData));
  // The server publishes compatibility for both the provider runtime and any
  // explicitly annotated model. Unknown probe results stay in the list; only a
  // definitive mismatch is hidden.
  const capabilityProvider = {
    ...provider,
    ...formData,
    id: provider?.id,
    models: mergedModels,
    modelHardwareCompatibility: {
      ...provider?.modelHardwareCompatibility,
      ...liveHardwareFor(formData),
    },
  };
  const availableModels = filterHardwareCompatibleProviderModels(
    filterGenerationModels(mergedModels),
    capabilityProvider,
  );
  const configuredModels = [
    formData.defaultModel,
    formData.lightModel,
    formData.mediumModel,
    formData.heavyModel,
  ].filter((model) => model
    && !isEmbeddingModel(model)
    && !availableModels.includes(model)
    && !isProviderModelHardwareCompatible(capabilityProvider, model));
  // A provider can pin its tiers to the "use the CLI's own default" sentinel
  // while still publishing a real model catalog (Antigravity: `agy models`
  // lists real ids, but PortOS leaves the tiers on agy's own default). The
  // sentinel is filtered out of `availableModels`, so without an explicit
  // option for it the four selects below would hold a value matching no option
  // and render blank — reading as "no model configured" when one is.
  const configuredDefault = configuredDefaultIn(mergedModels);
  // The markers that identify a backed provider (`ollamaBacked`, `llamaBacked`,
  // `gatewayBacked`) are NOT form fields, so a shape built from `formData`
  // alone loses them — which hid the effort ladder on the OpenCode-Ollama
  // providers, whose ladder is keyed on `ollamaBacked`. Merge the live edits
  // over the stored record instead, so edits to command/endpoint/envVars count
  // immediately while the markers survive.
  // Shared option list for the Default Model + Light/Medium/Heavy tier selects,
  // so the sentinel option can't be added to some and missed on others.
  const modelSelectOptions = (
    <>
      <option value="">None</option>
      {configuredDefault && (
        <option value={configuredDefault}>Use the CLI&apos;s configured default</option>
      )}
      {[...new Set([...configuredModels, ...availableModels])].map(model => (
        <option key={model} value={model} disabled={!availableModels.includes(model)}>
          {modelOptionLabel(model, localModels.ctxById, capabilityProvider)}
          {!availableModels.includes(model) ? ' (unavailable on this machine)' : ''}
        </option>
      ))}
    </>
  );

  // Filter out current provider from fallback options (treat undefined enabled as enabled)
  const fallbackOptions = allProviders.filter(p => p.id !== provider?.id
    && p.enabled !== false
    && (isProviderHardwareCompatible(p) || p.id === formData.fallbackProvider));

  // The fallback model is a model OF the selected fallback provider, so its
  // option list comes from that provider's `models` — merged with the live
  // installed list for local backends, and embedding-only models dropped (a
  // fallback runs prompts, so `nomic-embed-text` must never be selectable here).
  const selectedFallbackProvider = allProviders.find(p => p.id === formData.fallbackProvider);
  const fallbackCapabilityProvider = selectedFallbackProvider && {
    ...selectedFallbackProvider,
    modelHardwareCompatibility: {
      ...selectedFallbackProvider.modelHardwareCompatibility,
      ...liveHardwareFor(selectedFallbackProvider),
    },
  };
  const fallbackModelOptions = filterGenerationModels(
    mergeModelLists(selectedFallbackProvider?.models, liveModelsFor(selectedFallbackProvider)),
  );
  const compatibleFallbackModelOptions = filterHardwareCompatibleProviderModels(
    fallbackModelOptions,
    fallbackCapabilityProvider,
  );
  const fallbackModelIsUnavailable = Boolean(
    formData.fallbackModel
    && !isEmbeddingModel(formData.fallbackModel)
    && !compatibleFallbackModelOptions.includes(formData.fallbackModel)
    && !isProviderModelHardwareCompatible(fallbackCapabilityProvider, formData.fallbackModel)
  );
  // `capabilityProvider`, not `formData`: the per-model windows model refresh
  // recorded (`modelContextWindows`) live on the RECORD and are not form fields,
  // so reading formData alone reported the assumed 128K for a model whose real
  // window PortOS already knows.
  const plannedContextLabel = formatContextLength(
    effectiveModelContextWindow(capabilityProvider, formData.defaultModel)
  );
  // `num_ctx` is meaningful for any provider whose tokens come from Ollama, not
  // just `api` ones: an `api` provider sends it on every request, while an
  // Ollama-backed CLI/TUI (claude-ollama, opencode-ollama) talks to the daemon
  // itself, so PortOS applies it by reloading Ollama at that window before the
  // run (server/services/ollamaAgentContext.js). Gating the field to `api` left
  // those providers stuck on Ollama's VRAM-based 32K auto-pick, which an agent
  // harness overruns mid-task. Reads `capabilityProvider` because the
  // `ollamaBacked` marker that identifies opencode-ollama (whose envVars carry
  // no ANTHROPIC_BASE_URL) is not a form field.
  const showsNumCtx = formData.type === 'api' || isOllamaBackedProvider(capabilityProvider);
  // Default sampling/reasoning controls, offered only for the backends PortOS
  // actually forwards them to (see `generationControlsFor`). Reads
  // `capabilityProvider` for the same reason `showsNumCtx` does: `llamaBacked`
  // and friends are record markers, not form fields.
  const generationControls = generationControlsFor(capabilityProvider);
  const parseOptionalIntField = (value) => {
    const input = String(value ?? '').trim();
    if (!input) return null;
    return /^\d+$/.test(input) ? Number(input) : value;
  };
  const parseNumberField = (value) => {
    const input = String(value ?? '').trim();
    return input === '' ? undefined : Number(input);
  };

  // Every constraint the inputs themselves declare (`required`, `type="url"`,
  // `min`/`max`), restated as a check the SUBMIT path runs. The drawer mounts
  // only the active tab, so the browser's own constraint validation sees just
  // that panel: a Save pressed from Models would otherwise ship an unparseable
  // endpoint or an out-of-range num_ctx straight to the server and surface it as
  // a generic API error with no pointer to the offending field. Returns the tab
  // that owns the first problem plus its message, or null when the form is
  // valid. Order matches the tab order so the user is sent to the earliest
  // offending panel.
  const findValidationError = () => {
    const text = (value) => String(value ?? '').trim();
    const outOfRange = (value, { min, max }) => {
      const input = text(value);
      if (input === '') return false;
      const parsed = Number(input);
      return !Number.isFinite(parsed) || parsed < min || parsed > max;
    };

    if (!text(formData.name)) return { tab: 'connection', message: 'Name is required' };
    if (isProcessProvider(formData) && !text(formData.command)) {
      return { tab: 'connection', message: 'Command is required' };
    }
    if (formData.type === 'api') {
      if (!text(formData.endpoint)) return { tab: 'connection', message: 'Endpoint is required' };
      // Mirrors the field's `type="url"` and the server's `z.string().url()`:
      // an absolute URL with a scheme.
      if (!URL.canParse(text(formData.endpoint))) {
        return { tab: 'connection', message: 'Endpoint must be a full URL, e.g. http://localhost:1234/v1' };
      }
    }
    if (formData.type === 'tui' && outOfRange(formData.tuiPromptDelayMs, PROVIDER_FIELD_RANGES.tuiPromptDelayMs)) {
      return { tab: 'connection', message: rangeMessage('Prompt Paste Delay', PROVIDER_FIELD_RANGES.tuiPromptDelayMs, 'ms') };
    }
    if (text(formData.timeout) !== '' && parseTimeoutMs(formData.timeout) == null) {
      return {
        tab: 'generation',
        message: `Timeout must be a whole number of ms between ${TIMEOUT_INPUT_MIN_MS.toLocaleString()} and ${TIMEOUT_INPUT_MAX_MS.toLocaleString()}`,
      };
    }
    if (outOfRange(formData.contextWindow, PROVIDER_FIELD_RANGES.contextWindow)) {
      return { tab: 'generation', message: rangeMessage('Planning Window', PROVIDER_FIELD_RANGES.contextWindow, 'tokens') };
    }
    if (showsNumCtx && outOfRange(formData.numCtx, PROVIDER_FIELD_RANGES.numCtx)) {
      return { tab: 'generation', message: rangeMessage('Local num_ctx', PROVIDER_FIELD_RANGES.numCtx, 'tokens') };
    }
    if (generationControls?.temperature && outOfRange(formData.temperature, PROVIDER_FIELD_RANGES.temperature)) {
      return { tab: 'generation', message: rangeMessage('Temperature', PROVIDER_FIELD_RANGES.temperature) };
    }
    if (generationControls?.topP && outOfRange(formData.topP, PROVIDER_FIELD_RANGES.topP)) {
      return { tab: 'generation', message: rangeMessage('Top-P', PROVIDER_FIELD_RANGES.topP) };
    }
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const invalid = findValidationError();
    if (invalid) {
      setActiveTab(invalid.tab);
      toast.error(invalid.message);
      return;
    }

    const tuiPromptDelay = parseInt(formData.tuiPromptDelayMs, 10);
    // Blank input is omitted so the server keeps the current value. Non-empty
    // invalid input (e.g. '1e3', '500', 'abc') is sent as the raw string so
    // Number() cannot silently save an exponent form the client/runner reject;
    // the server's digit-only preprocess leaves it alone and z.number() produces
    // a clear validation error.
    const parsedTimeout = parseTimeoutMs(formData.timeout);
    const timeoutInput = String(formData.timeout ?? '').trim();
    const data = {
      ...formData,
      args: formData.args ? formData.args.split(' ').filter(Boolean) : [],
      headlessArgs: formData.headlessArgs ? formData.headlessArgs.split(' ').filter(Boolean) : [],
      contextWindow: parseOptionalIntField(formData.contextWindow),
      numCtx: showsNumCtx ? parseOptionalIntField(formData.numCtx) : null,
      // A blank generation field clears back to "let the backend pick" — `null`
      // rather than `undefined`, which the server's spread-merge would read as
      // "unchanged" and leave the old pin in place.
      ...(generationControls?.temperature ? { temperature: parseNumberField(formData.temperature) ?? null } : {}),
      ...(generationControls?.topP ? { topP: parseNumberField(formData.topP) ?? null } : {}),
      ...(generationControls?.thinking
        ? { thinking: formData.thinking === '' ? null : formData.thinking === 'true' }
        : {}),
    };
    // `data` opens as a spread of the WHOLE form, so a control this provider
    // doesn't offer rides along regardless of the branches above — and a blank
    // field is `''`, which is not a number (or a boolean) the server schema
    // accepts. Drop what can't be used; the server merges by spread, so
    // anything already stored is left alone.
    if (!generationControls?.temperature) delete data.temperature;
    if (!generationControls?.topP) delete data.topP;
    if (!generationControls?.thinking) delete data.thinking;
    // The generation/fallback pickers filter out embedding-only models, so a
    // stored embedding (from an older config) would be hidden in the UI yet
    // still spread into `data` and silently persisted on an unrelated edit.
    // Clear any embedding value that slipped through so the saved record matches
    // what the picker allows.
    for (const field of ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel', 'fallbackModel']) {
      if (isEmbeddingModel(data[field])) data[field] = '';
    }
    // Effort is meaningful only for providers/models that expose an effort
    // ladder. Clear a stale value when an edit switches to an effort-less
    // provider or Antigravity model; narrowed ladders are clamped by the
    // server and remain visible in the selector.
    if (!isProcessProvider(data) || !effortLevelsForProvider({ ...provider, ...data, id: provider?.id }, data.defaultModel)) {
      data.effort = '';
    }
    if (parsedTimeout != null) {
      data.timeout = parsedTimeout;
    } else if (timeoutInput === '') {
      delete data.timeout;
    } else {
      data.timeout = formData.timeout;
    }
    if (formData.type === 'tui') {
      if (Number.isFinite(tuiPromptDelay)) data.tuiPromptDelayMs = tuiPromptDelay;
      else delete data.tuiPromptDelayMs;
    } else {
      delete data.tuiPromptDelayMs;
    }
    // These controls belong only to the advertised Codex subscription
    // transport. Do not stamp false capability fields onto unrelated provider
    // records when their editor saves an ordinary connection change.
    if (provider?.textTransport !== 'codex-app-server') {
      delete data.textTransportEnabled;
      delete data.textTransportReadRiskAcknowledged;
    }

    // Only send apiKey if user entered a new value (avoid overwriting existing key with empty string)
    if (!data.apiKey && provider) {
      delete data.apiKey;
    }

    if (provider) {
      await api.updateProvider(provider.id, data);
    } else {
      await api.createProvider(data);
    }

    onSave();
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={provider ? 'Edit Provider' : 'Add Provider'}
      subtitle={provider ? provider.name : undefined}
      size="lg"
      tabs={PROVIDER_FORM_TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      // A long multi-tab config form: an accidental Esc or backdrop click
      // mid-edit would discard work across every tab.
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
        {/* The Drawer body remounts per active tab (key={currentTab}), so this
            whole form subtree is torn down and rebuilt on every tab switch. All
            mutable state (formData and the new-env-var row) therefore lives in
            this component, above the Drawer — never inside the panels below. */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {provider?.hardwareCompatibility?.state === 'unavailable' && (
            <Banner tone="warning" icon={AlertTriangle}>
              <p>
                This provider is unavailable on this machine: {provider.hardwareCompatibility.reasons?.join(' · ') || 'hardware requirements are not met'}.
                Its models are hidden from selection until the host matches those requirements.
              </p>
            </Banner>
          )}
          {activeTab === 'connection' && (
            <div className="space-y-4">
              <FormField label="Name *">
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  required
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
              </FormField>

              <FormField label="Type *">
                <select
                  value={formData.type}
                  onChange={(e) => setFormData(prev => ({ ...prev, type: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                >
                  <option value="cli">CLI</option>
                  <option value="tui">TUI</option>
                  <option value="api">API</option>
                </select>
              </FormField>

              {(formData.type === 'cli' || formData.type === 'tui') && (
                <>
                  <FormField label="Command *">
                    <input
                      type="text"
                      value={formData.command}
                      onChange={(e) => setFormData(prev => ({ ...prev, command: e.target.value }))}
                      placeholder={formData.type === 'tui' ? 'codex' : 'claude'}
                      required={formData.type === 'cli' || formData.type === 'tui'}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                    {/* Informational only — an off-allowlist command saves fine and runs
                        fine in direct-spawn mode; it just can't be launched by the CoS
                        Agent Runner. Rejecting the save would break that valid config. */}
                    {isRunnerAllowedCommand(formData.command, runnerAllowedCommands) === false && (
                      <Banner tone="warning" icon={AlertTriangle} className="mt-2">
                        <p>
                          <code className="font-mono break-all">{formData.command}</code> is not on the CoS Agent Runner’s
                          command allowlist, so <code className="font-mono">/spawn</code> and{' '}
                          <code className="font-mono">/spawn-tui</code> will refuse it. Saving is fine — the provider still
                          runs in direct-spawn mode and everywhere else.
                        </p>
                        <p className="mt-1 text-port-warning/80 break-words">
                          Allowlisted: {runnerAllowedCommands.join(', ')}
                        </p>
                      </Banner>
                    )}
                  </FormField>

                  <FormField label="Arguments (space-separated)">
                    <input
                      type="text"
                      value={formData.args}
                      onChange={(e) => setFormData(prev => ({ ...prev, args: e.target.value }))}
                      placeholder={formData.type === 'tui' ? '--dangerously-skip-permissions' : '--print -p'}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                  </FormField>

                  {/* The CLI/TUI backends that can authenticate: the vLLM compose
                      stack is started with VLLM_API_KEY, so without this field
                      there is nowhere to put it and the container 401s every
                      model refresh and every run. Reads `capabilityProvider`
                      because `vllmBacked` is a stored marker, not a form field.
                      SGLang has its own field below — its key is OPTIONAL (only
                      set when the operator ran `--api-key`), so the two cannot
                      share one placeholder without telling half the operators to
                      paste a secret that does not exist. */}
                  {capabilityProvider?.vllmBacked && (
                    <FormField label="API Key">
                      <input
                        type="password"
                        value={formData.apiKey}
                        onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                        placeholder={provider?.hasApiKey ? 'Key set — leave blank to keep' : 'Paste VLLM_API_KEY from the stack’s .env'}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        The <code>VLLM_API_KEY</code> your compose stack was started with. PortOS puts it on the
                        spawned OpenCode provider and on the model-refresh probe; the container rejects both without it.
                      </p>
                    </FormField>
                  )}

                  {capabilityProvider?.sglangBacked && (
                    <FormField label="API Key (optional)">
                      <input
                        type="password"
                        value={formData.apiKey}
                        onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                        placeholder={provider?.hasApiKey ? 'Key set — leave blank to keep' : 'Only if you started SGLang with --api-key'}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        SGLang serves unauthenticated unless you started it with <code>--api-key</code>. Leave this
                        blank in that case — PortOS attaches a key only when one is set.
                        {isClaudeCommandProvider(capabilityProvider)
                          ? <> This <strong>Claude</strong> harness reads it for the model-refresh probe only; the
                            credential its runs authenticate with is <code>ANTHROPIC_AUTH_TOKEN</code> under
                            Environment Variables, so set that to the same key too.</>
                          : <> It rides both the spawned OpenCode provider and the model-refresh probe.</>}
                      </p>
                    </FormField>
                  )}

                  {formData.type === 'cli' && (
                    <FormField label="Headless Args (for simple prompt tasks)">
                      <input
                        type="text"
                        value={formData.headlessArgs}
                        onChange={(e) => setFormData(prev => ({ ...prev, headlessArgs: e.target.value }))}
                        placeholder='--no-session-persistence --disable-slash-commands --tools ""'
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Extra CLI flags for lightweight prompt-in/text-out mode (brain classifier, etc.)
                      </p>
                    </FormField>
                  )}

                  {formData.type === 'tui' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField label="Prompt Paste Delay (ms)">
                        <input
                          type="number"
                          min={PROVIDER_FIELD_RANGES.tuiPromptDelayMs.min}
                          max={PROVIDER_FIELD_RANGES.tuiPromptDelayMs.max}
                          value={formData.tuiPromptDelayMs}
                          onChange={(e) => setFormData(prev => ({ ...prev, tuiPromptDelayMs: e.target.value }))}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                        />
                      </FormField>
                      <p className="sm:col-span-2 text-xs text-gray-500">
                        TUI providers stay attached while the provider is silent; they finish on the completion sentinel, process exit, or explicit failure.
                      </p>
                    </div>
                  )}
                </>
              )}

              {formData.type === 'api' && (
                <>
                  <FormField label="Endpoint *">
                    <input
                      type="url"
                      value={formData.endpoint}
                      onChange={(e) => setFormData(prev => ({ ...prev, endpoint: e.target.value }))}
                      placeholder="http://localhost:1234/v1"
                      required={formData.type === 'api'}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                  </FormField>

                  <FormField label="API Key">
                    <input
                      type="password"
                      value={formData.apiKey}
                      onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                      placeholder={provider?.hasApiKey
                        ? 'Key set — leave blank to keep'
                        : isLocalEndpoint(formData.endpoint)
                          ? 'Not needed for local endpoints'
                          : 'Paste the key from your provider dashboard'}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      This field is the only place API providers read a key from — it's stored on this
                      provider and sent as an <code>Authorization: Bearer</code> header on every request.
                      No environment variable is involved. Hosted APIs (Cerebras, Grok, NVIDIA, OrcaRouter, OpenRouter, …) require
                      one; local backends (Ollama, LM Studio) don't.
                    </p>
                  </FormField>

                  <FormField label="Custom endpoint">
                    <label htmlFor="allowCustomEndpoint" className="flex items-start gap-2 cursor-pointer">
                      <input
                        id="allowCustomEndpoint"
                        type="checkbox"
                        checked={formData.allowCustomEndpoint}
                        onChange={(e) => setFormData(prev => ({ ...prev, allowCustomEndpoint: e.target.checked }))}
                        className="mt-1"
                      />
                      <span className="text-sm text-gray-300">
                        Allow sending the API key to this custom (non-local, non-allowlisted) endpoint.
                        Loopback/LAN and known providers (OpenAI, Anthropic, OpenRouter, …) are always allowed;
                        cloud-metadata hosts are always blocked. Leave off unless you trust this host.
                      </span>
                    </label>
                  </FormField>
                </>
              )}

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.enabled}
                  onChange={(e) => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
                  className="w-4 h-4 rounded border-port-border bg-port-bg"
                />
                <span className="text-sm text-gray-400">Enabled</span>
              </label>

              {provider?.textTransport === 'codex-app-server' && (
                <div className="max-w-3xl rounded-lg border border-port-warning/40 bg-port-warning/10 p-3 space-y-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-port-warning">ChatGPT subscription text calls</p>
                    <p className="text-xs text-gray-300">
                      PortOS blocks writes, network access, MCP servers, and web search for these calls.
                      Codex can still read local files by absolute path, so untrusted prompt text could make
                      a saved response contain local file contents.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <input
                        id="codex-text-read-risk"
                        type="checkbox"
                        checked={formData.textTransportReadRiskAcknowledged}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          textTransportReadRiskAcknowledged: e.target.checked,
                          textTransportEnabled: e.target.checked ? prev.textTransportEnabled : false,
                        }))}
                        className="mt-0.5 w-4 h-4 rounded border-port-border bg-port-bg"
                      />
                      <label htmlFor="codex-text-read-risk" className="text-sm text-gray-300">
                        I understand that Codex may read local files during generic text calls.
                      </label>
                    </div>
                    <div className="flex items-start gap-2">
                      <input
                        id="codex-text-transport-enabled"
                        type="checkbox"
                        checked={formData.textTransportEnabled}
                        disabled={!formData.textTransportReadRiskAcknowledged}
                        onChange={(e) => setFormData(prev => ({ ...prev, textTransportEnabled: e.target.checked }))}
                        className="mt-0.5 w-4 h-4 rounded border-port-border bg-port-bg disabled:opacity-50"
                      />
                      <label
                        htmlFor="codex-text-transport-enabled"
                        className={`text-sm ${formData.textTransportReadRiskAcknowledged ? 'text-gray-300' : 'text-gray-500'}`}
                      >
                        Allow this provider to serve generic text calls.
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {gatewayForProvider(provider) && (
                <GatewayKeyHint
                  gateway={gatewayForProvider(provider)}
                  sibling={allProviders.find(p => p.id === gatewayForProvider(provider).id)}
                  onEdit={onEditProvider}
                />
              )}
            </div>
          )}

          {activeTab === 'models' && (
            <div className="space-y-4">
              <FormField label={<>
                  Available Models
                  {formData.type === 'api' && <span className="text-xs text-gray-500 ml-2">(Use Refresh button after saving)</span>}
                </>}>
                <textarea
                  value={(formData.models || []).join(', ')}
                  onChange={(e) => {
                    const models = e.target.value
                      .split(',')
                      .map(m => m.trim())
                      .filter(Boolean);
                    setFormData(prev => ({ ...prev, models }));
                  }}
                  placeholder="model-1, model-2, model-3"
                  rows={2}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:border-port-accent focus:outline-hidden"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Comma-separated list of available models. For API providers, use Refresh to auto-populate.
                </p>
              </FormField>

              <FormField label="Default Model">
                {availableModels.length > 0 ? (
                  <select
                    value={formData.defaultModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  >
                    {modelSelectOptions}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.defaultModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                    placeholder="claude-sonnet-4-20250514"
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  />
                )}
                <p className="text-xs text-gray-500 mt-1">
                  {availableModels.length > 0
                    ? 'Model to use when no tier is specified'
                    : 'Save and test provider to fetch available models'}
                </p>
              </FormField>

              <EffortSelect
                provider={isProcessProvider(capabilityProvider) ? capabilityProvider : null}
                model={formData.defaultModel}
                value={formData.effort}
                onChange={(effort) => setFormData(prev => ({ ...prev, effort }))}
                label="Default Effort"
                hint={generationControls
                  ? 'Reasoning effort used when a run does not specify one — passed to the local model as reasoningEffort.'
                  : 'Reasoning effort used when a run does not specify one.'}
              />

              {/* Model Tiers */}
              <div className="border-t border-port-border pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-300 mb-3">Model Tiers</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <FormField labelClassName="block text-xs text-gray-400 mb-1" label={<>
                      <span className="inline-block w-2 h-2 rounded-full bg-port-success mr-1"></span>
                      Light (fast)
                    </>}>
                    {availableModels.length > 0 ? (
                      <select
                        value={formData.lightModel}
                        onChange={(e) => setFormData(prev => ({ ...prev, lightModel: e.target.value }))}
                        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                      >
                        {modelSelectOptions}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={formData.lightModel}
                        onChange={(e) => setFormData(prev => ({ ...prev, lightModel: e.target.value }))}
                        placeholder="haiku"
                        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                      />
                    )}
                  </FormField>
                  <FormField labelClassName="block text-xs text-gray-400 mb-1" label={<>
                      <span className="inline-block w-2 h-2 rounded-full bg-port-warning mr-1"></span>
                      Medium (balanced)
                    </>}>
                    {availableModels.length > 0 ? (
                      <select
                        value={formData.mediumModel}
                        onChange={(e) => setFormData(prev => ({ ...prev, mediumModel: e.target.value }))}
                        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                      >
                        {modelSelectOptions}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={formData.mediumModel}
                        onChange={(e) => setFormData(prev => ({ ...prev, mediumModel: e.target.value }))}
                        placeholder="sonnet"
                        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                      />
                    )}
                  </FormField>
                  <FormField labelClassName="block text-xs text-gray-400 mb-1" label={<>
                      <span className="inline-block w-2 h-2 rounded-full bg-port-error mr-1"></span>
                      Heavy (powerful)
                    </>}>
                    {availableModels.length > 0 ? (
                      <select
                        value={formData.heavyModel}
                        onChange={(e) => setFormData(prev => ({ ...prev, heavyModel: e.target.value }))}
                        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                      >
                        {modelSelectOptions}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={formData.heavyModel}
                        onChange={(e) => setFormData(prev => ({ ...prev, heavyModel: e.target.value }))}
                        placeholder="opus"
                        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                      />
                    )}
                  </FormField>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  {availableModels.length > 0
                    ? 'Used for intelligent model selection based on task requirements'
                    : 'Save provider, then use Test or Refresh to fetch available models'}
                </p>
              </div>

              {/* Fallback Provider */}
              <div className="border-t border-port-border pt-4 mt-4">
                <FormField label="Fallback Provider">
                <select
                  value={formData.fallbackProvider}
                  onChange={(e) => setFormData(prev => ({
                    ...prev,
                    fallbackProvider: e.target.value,
                    // The model belongs to the fallback provider; clear it when the
                    // provider changes so a stale model from the previous pick
                    // doesn't carry over.
                    fallbackModel: ''
                  }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                >
                  <option value="">None (use system default)</option>
                  {fallbackOptions.map(p => (
                    <option key={p.id} value={p.id} disabled={!isProviderHardwareCompatible(p)}>
                      {p.name}{!isProviderHardwareCompatible(p) ? ' (unavailable on this machine)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  If this provider hits a usage limit or becomes unavailable, tasks will automatically use the fallback provider.
                </p>
                </FormField>

                {formData.fallbackProvider && (
                  <FormField label="Fallback Model" className="mt-3">
                    {compatibleFallbackModelOptions.length > 0 ? (
                      <select
                        value={formData.fallbackModel}
                        onChange={(e) => setFormData(prev => ({ ...prev, fallbackModel: e.target.value }))}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      >
                        <option value="">Use fallback provider's default</option>
                        {fallbackModelIsUnavailable && (
                          <option value={formData.fallbackModel} disabled>
                            {modelOptionLabel(formData.fallbackModel, localModels.ctxById, selectedFallbackProvider)} (unavailable on this machine)
                          </option>
                        )}
                        {compatibleFallbackModelOptions.map(model => (
                          <option key={model} value={model}>{modelOptionLabel(model, localModels.ctxById, selectedFallbackProvider)}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={formData.fallbackModel}
                        onChange={(e) => setFormData(prev => ({ ...prev, fallbackModel: e.target.value }))}
                        placeholder="Use fallback provider's default"
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      />
                    )}
                    <p className="text-xs text-gray-500 mt-1">
                      Model to run on the fallback provider. Leave blank to use that provider's default model.
                    </p>
                  </FormField>
                )}
              </div>
            </div>
          )}

          {activeTab === 'generation' && (
            <div className="space-y-4">
              <FormField label="Timeout (ms)">
                <input
                  type="number"
                  inputMode="numeric"
                  min={TIMEOUT_INPUT_MIN_MS}
                  max={TIMEOUT_INPUT_MAX_MS}
                  step={TIMEOUT_INPUT_STEP_MS}
                  value={formData.timeout}
                  onChange={(e) => setFormData(prev => ({ ...prev, timeout: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {(() => {
                    // Same parser the submit path uses, so the displayed
                    // duration always matches what would be saved. parseTimeoutMs
                    // returns null for out-of-range/invalid → fall back to the
                    // generic cap message.
                    const ms = parseTimeoutMs(formData.timeout);
                    return ms != null
                      ? `≈ ${formatDurationMs(ms)} per run`
                      : `Per-call cap. Server max: ${TIMEOUT_INPUT_MAX_MS.toLocaleString()} ms (${formatDurationMs(TIMEOUT_INPUT_MAX_MS)}).`;
                  })()}
                </p>
              </FormField>

              <div className="border-t border-port-border pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-300 mb-3">Context Window</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField label="Planning Window">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={PROVIDER_FIELD_RANGES.contextWindow.min}
                      max={PROVIDER_FIELD_RANGES.contextWindow.max}
                      value={formData.contextWindow}
                      onChange={(e) => setFormData(prev => ({ ...prev, contextWindow: e.target.value }))}
                      placeholder="Auto from model"
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {plannedContextLabel ? `Budgeter uses ${plannedContextLabel}` : 'Leave blank to use model/provider defaults'}
                    </p>
                  </FormField>

                  {showsNumCtx && (
                    <FormField label="Local num_ctx">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={PROVIDER_FIELD_RANGES.numCtx.min}
                        max={PROVIDER_FIELD_RANGES.numCtx.max}
                        value={formData.numCtx}
                        onChange={(e) => setFormData(prev => ({ ...prev, numCtx: e.target.value }))}
                        placeholder="Ollama request size"
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        {formData.type === 'api'
                          ? 'Sent to compatible local backends; used for planning when no model window is known.'
                          : 'PortOS reloads the Ollama daemon at this window before the run — the CLI/TUI talks to Ollama directly, so nothing else can raise it. Leave blank to keep Ollama\'s VRAM-based auto-pick; make sure the model still fits at the larger size.'}
                      </p>
                    </FormField>
                  )}
                </div>
              </div>

              {generationControls && (
                <div className="border-t border-port-border pt-4 mt-4">
                  <h4 className="text-sm font-medium text-gray-300 mb-3">Generation Defaults</h4>
                  <p className="text-xs text-gray-500 mb-3">
                    Applied to every run this provider starts — HTTP, CLI, and TUI alike. OpenCode wrappers
                    receive them as its <code className="text-gray-400">agent.build</code> options; a task can
                    still override temperature and thinking for one run. Every field left blank is simply not
                    sent, so the backend keeps its own default.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {generationControls.temperature && (
                      <FormField label="Temperature">
                        <input
                          type="number"
                          min={PROVIDER_FIELD_RANGES.temperature.min}
                          max={PROVIDER_FIELD_RANGES.temperature.max}
                          step="0.1"
                          value={formData.temperature}
                          onChange={(e) => setFormData(prev => ({ ...prev, temperature: e.target.value }))}
                          placeholder="Backend default"
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                        />
                        <p className="text-xs text-gray-500 mt-1">Local Ollama agent runs fall back to 0.6 when this is blank.</p>
                      </FormField>
                    )}
                    {generationControls.topP && (
                      <FormField label="Top-P">
                        <input
                          type="number"
                          min={PROVIDER_FIELD_RANGES.topP.min}
                          max={PROVIDER_FIELD_RANGES.topP.max}
                          step="0.05"
                          value={formData.topP}
                          onChange={(e) => setFormData(prev => ({ ...prev, topP: e.target.value }))}
                          placeholder="Backend default"
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                        />
                        <p className="text-xs text-gray-500 mt-1">Nucleus sampling. Leave blank to send no top_p at all.</p>
                      </FormField>
                    )}
                    {generationControls.thinking && (
                      /* Tri-state rather than a checkbox: a checkbox cannot say
                         "leave the model's own reasoning mode alone", so it
                         forced a pin onto every provider the moment anyone
                         pressed Save. */
                      <FormField label="Thinking mode">
                        <select
                          value={formData.thinking}
                          onChange={(e) => setFormData(prev => ({ ...prev, thinking: e.target.value }))}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                        >
                          <option value="">Model default</option>
                          <option value="true">Enabled</option>
                          <option value="false">Disabled</option>
                        </select>
                        <p className="text-xs text-gray-500 mt-1">
                          Ollama receives its native <code className="text-gray-400">think</code> flag; llama.cpp and
                          MTPLX get <code className="text-gray-400">enable_thinking</code> through the chat template;
                          a Claude harness on Ollama gets <code className="text-gray-400">MAX_THINKING_TOKENS</code>.
                          Models without a reasoning mode ignore it.
                        </p>
                      </FormField>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'environment' && (
            <div className="space-y-4">
              {/* Consumed only when spawning CLI/TUI child processes; API runs
                  never read them (auth is the API Key field on the Connection
                  tab). For API type the add-row is hidden so a key can't be
                  "set" here by mistake, but existing entries stay
                  editable/removable. */}
              <div>
                {formData.type === 'api' && Object.entries(formData.envVars).length > 0 && (
                  <p className="text-xs text-port-warning mb-2">
                    API providers ignore environment variables — these entries have no effect.
                    Put the key in the API Key field on the Connection tab.
                  </p>
                )}
                {Object.entries(formData.envVars).length > 0 && (
                  <div className="space-y-2 mb-3">
                    {Object.entries(formData.envVars).map(([key, value]) => {
                      const isSecret = formData.secretEnvVars.includes(key);
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <code className="text-xs text-gray-300 bg-port-bg px-2 py-1.5 rounded border border-port-border shrink-0">{key}</code>
                          <input
                            type={isSecret ? 'password' : 'text'}
                            aria-label={`${key} value`}
                            value={value}
                            onChange={(e) => setFormData(prev => ({
                              ...prev,
                              envVars: { ...prev.envVars, [key]: e.target.value }
                            }))}
                            className="flex-1 min-w-0 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-hidden"
                          />
                          <button
                            type="button"
                            onClick={() => setFormData(prev => ({
                              ...prev,
                              secretEnvVars: isSecret
                                ? prev.secretEnvVars.filter(k => k !== key)
                                : [...prev.secretEnvVars, key]
                            }))}
                            className={`px-2 py-1.5 text-xs rounded transition-colors shrink-0 ${
                              isSecret
                                ? 'text-port-warning bg-port-warning/20 hover:bg-port-warning/30'
                                : 'text-gray-400 hover:bg-port-border/50'
                            }`}
                            title={isSecret ? 'Secret (click to unmask)' : 'Not secret (click to mask)'}
                          >
                            {isSecret ? '🔒' : '🔓'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setFormData(prev => {
                              const { [key]: _, ...rest } = prev.envVars;
                              return {
                                ...prev,
                                envVars: rest,
                                secretEnvVars: prev.secretEnvVars.filter(k => k !== key)
                              };
                            })}
                            className="px-2 py-1.5 text-xs text-port-error hover:bg-port-error/20 rounded transition-colors shrink-0"
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {formData.type !== 'api' && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newEnvKey}
                    onChange={(e) => setNewEnvKey(e.target.value.toUpperCase())}
                    placeholder="KEY"
                    aria-label="New environment variable name"
                    className="w-1/3 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-hidden font-mono"
                  />
                  <input
                    type={newEnvSecret ? 'password' : 'text'}
                    value={newEnvValue}
                    onChange={(e) => setNewEnvValue(e.target.value)}
                    placeholder="value"
                    aria-label="New environment variable value"
                    className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-hidden"
                  />
                  <label className="flex items-center gap-1 text-xs text-gray-400 shrink-0 cursor-pointer" title="Mark as secret (value will be masked on provider list)">
                    <input
                      type="checkbox"
                      checked={newEnvSecret}
                      onChange={(e) => setNewEnvSecret(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-port-border bg-port-bg"
                    />
                    Secret
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (newEnvKey.trim()) {
                        setFormData(prev => ({
                          ...prev,
                          envVars: { ...prev.envVars, [newEnvKey.trim()]: newEnvValue },
                          secretEnvVars: newEnvSecret
                            ? [...prev.secretEnvVars, newEnvKey.trim()]
                            : prev.secretEnvVars
                        }));
                        setNewEnvKey('');
                        setNewEnvValue('');
                        setNewEnvSecret(false);
                      }
                    }}
                    disabled={!newEnvKey.trim()}
                    className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50 shrink-0"
                  >
                    Add
                  </button>
                </div>
                )}
                <p className="text-xs text-gray-500 mt-2">
                  {formData.type === 'api'
                    ? 'Not used by API providers — auth goes in the API Key field on the Connection tab. Env vars only apply to CLI/TUI process providers.'
                    : 'Environment variables passed to the CLI process (e.g., CLAUDE_CODE_USE_BEDROCK=1, AWS_PROFILE).'}
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
            >
              {provider ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
    </Drawer>
  );
}
