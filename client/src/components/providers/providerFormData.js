import { routingFormDefaults, findRoutingFormError, applyRoutingToPayload } from './providerRoutingForm';
import {
  effortLevelsForProvider,
  isClaudeCommandProvider,
  isCodexProvider,
  isEmbeddingModel,
  isProcessProvider,
  localBackendForProvider,
} from '../../utils/providers';
import {
  formatCount,
  parseTimeoutMs,
  TIMEOUT_INPUT_MIN_MS,
  TIMEOUT_INPUT_MAX_MS,
} from '../../utils/formatters';
import { CONFIGURED_MODEL_KEYS, normalizeModelAccess, providerModelCatalog } from '../../utils/providerModelAccess';

// Numeric bounds for the editor's number inputs. Declared once so an input's own
// `min`/`max` and the submit-time check that stands in for it (the drawer
// unmounts inactive tabs, so the browser can't validate a field the user isn't
// looking at) can never drift apart. Mirrors the provider schema in
// `server/lib/aiToolkit/validation.js`; `timeout` is absent because it has a
// shared parser (`parseTimeoutMs`) that already owns its bounds.
export const PROVIDER_FIELD_RANGES = {
  tuiPromptDelayMs: { min: 250, max: 60000 },
  contextWindow: { min: 512, max: 2097152 },
  numCtx: { min: 512, max: 1048576 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
};

/** A space-separated argv input as the array the provider schema takes. */
export const argList = (text) => (text ? text.split(' ').filter(Boolean) : []);
export const modelListFromText = (text) => text.split(',').map(model => model.trim()).filter(Boolean);

// Per-model num_ctx overrides edited as one 'model = tokens' line each.
export const modelNumCtxToText = (map) => Object.entries(map || {}).map(([model, tokens]) => `${model} = ${tokens}`).join('\n');
/** Parse the per-model text into { map } or { error } naming the first bad line. */
export const parseModelNumCtxText = (text) => {
  const map = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.lastIndexOf('=');
    const model = at > 0 ? line.slice(0, at).trim() : '';
    const value = at > 0 ? line.slice(at + 1).trim() : '';
    const { min, max } = PROVIDER_FIELD_RANGES.numCtx;
    if (!model || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      return { error: `Per-model num_ctx line "${line}" must be "model = tokens" with ${formatCount(min)} to ${formatCount(max)} tokens` };
    }
    map[model] = Number(value);
  }
  return { map };
};

const rangeMessage = (label, { min, max }, unit = '') =>
  `${label} must be between ${formatCount(min)} and ${formatCount(max)}${unit ? ` ${unit}` : ''}`;

// Live installed Ollama/LM Studio models, folded into the model pickers so a
// local provider shows what's actually installed — not just the stale `models`
// list stored on the provider record (the "Command R+ / Gemma missing" bug).
// The page passes `localModels` down, since it already holds this status for the cards.
export const liveModelsFor = (localModels, p) => {
  const backend = localBackendForProvider(p);
  return backend ? localModels[backend] : [];
};

export const liveHardwareFor = (localModels, p) => {
  const backend = localBackendForProvider(p);
  return backend ? localModels.hardwareCompatibilityByBackend?.[backend] || {} : {};
};

export const initialProviderFormData = (provider) => ({
  name: provider?.name || '',
  type: provider?.type || 'cli',
  command: provider?.command || '',
  args: provider?.args?.join(' ') || '',
  endpoint: provider?.endpoint || '',
  apiKey: '',
  allowCustomEndpoint: provider?.allowCustomEndpoint === true,
  ignoreUserConfig: provider?.ignoreUserConfig === true,
  codexAuthMode: provider?.codexAuthMode || '',
  executionOptions: provider?.executionOptions,
  lowPriorityOnUsageLimit: provider?.lowPriorityOnUsageLimit === true,
  // The FULL advertised catalog, never the model-access-scoped `models` the
  // payload carries. This textarea is saved verbatim, so seeding it from the
  // scoped list would let an ordinary Save persist the narrowed catalog over
  // the real one — recoverable only by a refresh, and silently wrong until then.
  models: providerModelCatalog(provider),
  // Absent on a record with no policy, which is the shape the server reads as
  // "unconstrained". `null` (not `undefined`) when cleared, so the PATCH
  // spread-merge sees a clear rather than "unchanged".
  modelAccess: provider?.modelAccess || null,
  hardwareRequirements: provider?.hardwareRequirements,
  modelHardwareRequirements: provider?.modelHardwareRequirements,
  defaultModel: provider?.defaultModel || '',
  effort: provider?.effort || '',
  lightModel: provider?.lightModel || '',
  mediumModel: provider?.mediumModel || '',
  heavyModel: provider?.heavyModel || '',
  ultraModel: provider?.ultraModel || '',
  fallbackProvider: provider?.fallbackProvider || '',
  fallbackModel: provider?.fallbackModel || '',
  numCtx: provider?.numCtx ?? '',
  modelNumCtxText: modelNumCtxToText(provider?.modelNumCtx),
  ...routingFormDefaults(provider),
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
  tuiPromptDelayMs: provider?.tuiPromptDelayMs || 2500,
  credentialBootstrapSetupCommand: provider?.credentialBootstrap?.setupCommand || '',
  credentialBootstrapCommand: provider?.credentialBootstrap?.command || '',
  credentialBootstrapEnvCommand: provider?.credentialBootstrap?.envCommand?.join('\n') || '',
  credentialBootstrapArgs: provider?.credentialBootstrap?.args?.join(' ') || '',
  credentialBootstrapHarnessId: provider?.credentialBootstrap?.harnessId || '',
  credentialBootstrapArgsSeparator: provider?.credentialBootstrap?.argsSeparator || '',
});

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
export const findProviderFormError = ({ formData, createsModePair, showsNumCtx, generationControls }) => {
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
  if ((formData.type === 'tui' || createsModePair) && outOfRange(formData.tuiPromptDelayMs, PROVIDER_FIELD_RANGES.tuiPromptDelayMs)) {
    return { tab: 'connection', message: rangeMessage('Prompt Paste Delay', PROVIDER_FIELD_RANGES.tuiPromptDelayMs, 'ms') };
  }
  if (text(formData.timeout) !== '' && parseTimeoutMs(formData.timeout) == null) {
    return {
      tab: 'generation',
      message: `Timeout must be a whole number of ms between ${formatCount(TIMEOUT_INPUT_MIN_MS)} and ${formatCount(TIMEOUT_INPUT_MAX_MS)}`,
    };
  }
  if (outOfRange(formData.contextWindow, PROVIDER_FIELD_RANGES.contextWindow)) {
    return { tab: 'generation', message: rangeMessage('Planning Window', PROVIDER_FIELD_RANGES.contextWindow, 'tokens') };
  }
  if (showsNumCtx && outOfRange(formData.numCtx, PROVIDER_FIELD_RANGES.numCtx)) {
    return { tab: 'generation', message: rangeMessage('Local num_ctx', PROVIDER_FIELD_RANGES.numCtx, 'tokens') };
  }
  if (showsNumCtx) {
    const perModel = parseModelNumCtxText(formData.modelNumCtxText);
    if (perModel.error) return { tab: 'generation', message: perModel.error };
  }
  const routingError = findRoutingFormError(formData);
  if (routingError) return { tab: 'generation', message: routingError };
  if (generationControls?.temperature && outOfRange(formData.temperature, PROVIDER_FIELD_RANGES.temperature)) {
    return { tab: 'generation', message: rangeMessage('Temperature', PROVIDER_FIELD_RANGES.temperature) };
  }
  if (generationControls?.topP && outOfRange(formData.topP, PROVIDER_FIELD_RANGES.topP)) {
    return { tab: 'generation', message: rangeMessage('Top-P', PROVIDER_FIELD_RANGES.topP) };
  }
  return null;
};

// The create/update body for a validated form.
export const buildProviderPayload = ({ provider, formData, modelsText, showsNumCtx, generationControls, createsModePair, tuiArgs }) => {
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
    models: modelListFromText(modelsText),
    args: argList(formData.args),
    headlessArgs: argList(formData.headlessArgs),
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
  // Form-only text; the record stores the parsed map ({} clears every override).
  delete data.modelNumCtxText;
  applyRoutingToPayload(data, formData);
  if (showsNumCtx) data.modelNumCtx = parseModelNumCtxText(formData.modelNumCtxText).map || {};
  if (!generationControls?.temperature) delete data.temperature;
  if (!generationControls?.topP) delete data.topP;
  if (!generationControls?.thinking) delete data.thinking;
  // The generation/fallback pickers filter out embedding-only models, so a
  // stored embedding (from an older config) would be hidden in the UI yet
  // still spread into `data` and silently persisted on an unrelated edit.
  // Clear any embedding value that slipped through so the saved record matches
  // what the picker allows.
  for (const field of CONFIGURED_MODEL_KEYS) {
    if (isEmbeddingModel(data[field])) data[field] = '';
  }
  // An explicit `null` rather than `undefined` when the policy says nothing:
  // the server merges a PATCH by spread, which reads `undefined` as "unchanged"
  // and would leave a policy the user just cleared in place.
  data.modelAccess = normalizeModelAccess(formData.modelAccess);
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
  // Both modes from one submit. Only what actually differs per mode is
  // declared: everything else on the body is shared by both records, which is
  // what lets the server pair them as one harness rather than two unrelated
  // routes. `cli: {}` because the body's own `args` / `headlessArgs` already
  // describe the CLI record — the key is there so the pair is declared.
  if (createsModePair) {
    data.modes = {
      cli: {},
      tui: {
        args: argList(tuiArgs),
        ...(Number.isFinite(tuiPromptDelay) ? { tuiPromptDelayMs: tuiPromptDelay } : {}),
      },
    };
  }
  // These controls belong only to the advertised Codex subscription
  // transport. Do not stamp false capability fields onto unrelated provider
  // records when their editor saves an ordinary connection change.
  if (provider?.textTransport !== 'codex-app-server') {
    delete data.textTransportEnabled;
    delete data.textTransportReadRiskAcknowledged;
  }
  // `--ignore-user-config` is a Codex flag. Never stamp it onto a record
  // running another vendor's binary, where it would be a stored lie.
  if (!isCodexProvider({ ...provider, ...data, id: provider?.id })) {
    delete data.ignoreUserConfig;
    delete data.codexAuthMode;
  } else {
    data.codexAuthMode = data.codexAuthMode || null;
  }
  // `/low-priority` is a Claude TUI-only command. Do not persist a dormant
  // toggle on a CLI/headless or another vendor's provider record.
  if (formData.type !== 'tui' || !isClaudeCommandProvider({ ...provider, ...data, id: provider?.id })) {
    delete data.lowPriorityOnUsageLimit;
  }

  // Fold the five flat scratch fields into the nested shape the server
  // schema expects. Only a CLI/TUI provider carries the field at all (the
  // Connection tab's section is gated the same way): an api-type save must not
  // ship `credentialBootstrap: null` onto a record that never had one. A named
  // bootstrap command becomes the object; an emptied one becomes an explicit
  // `null` (absent means "unchanged" on a PATCH) — never
  // `{ command: '' }`, which would fail the server's `min(1)` check on every
  // unrelated save.
  const bootstrapCommand = formData.credentialBootstrapCommand.trim();
  if (formData.type === 'cli' || formData.type === 'tui') {
    data.credentialBootstrap = bootstrapCommand
      ? {
        ...(formData.credentialBootstrapSetupCommand.trim() ? { setupCommand: formData.credentialBootstrapSetupCommand.trim() } : {}),
        command: bootstrapCommand,
        args: argList(formData.credentialBootstrapArgs),
        ...(formData.credentialBootstrapEnvCommand.trim()
          ? { envCommand: formData.credentialBootstrapEnvCommand.split('\n').filter(line => line.trim()) } : {}),
        ...(formData.credentialBootstrapHarnessId.trim() ? { harnessId: formData.credentialBootstrapHarnessId.trim() } : {}),
        ...(formData.credentialBootstrapArgsSeparator.trim() ? { argsSeparator: formData.credentialBootstrapArgsSeparator.trim() } : {}),
      }
      : null;
  }
  delete data.credentialBootstrapSetupCommand;
  delete data.credentialBootstrapCommand;
  delete data.credentialBootstrapEnvCommand;
  delete data.credentialBootstrapArgs;
  delete data.credentialBootstrapHarnessId;
  delete data.credentialBootstrapArgsSeparator;

  // Only send apiKey if user entered a new value (avoid overwriting existing key with empty string)
  if (!data.apiKey && provider) {
    delete data.apiKey;
  }
  return data;
};
