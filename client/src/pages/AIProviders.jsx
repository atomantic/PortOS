import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { AlertTriangle, Gauge } from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import socket from '../services/socket';
import { filterSelectableModels, filterGenerationModels, isEmbeddingModel, mergeModelLists, configuredDefaultIn, localBackendForProvider, modelOptionLabel, providerTypeClass, isTuiProvider, isApiProvider, isProcessProvider, isGrokBuildCli, isLocalEndpoint, isLocalInstanceProvider, effectiveModelContextWindow, isRunnerAllowedCommand, effortLevelsForProvider, isOllamaBackedProvider, isOrcaRouterBackedProvider, isClaudeCommandProvider, generationControlsFor, providerRuntimeKey, providerCardState, PROVIDER_CARD_STATE } from '../utils/providers';
import useLocalModels from '../hooks/useLocalModels';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import BrailleSpinner from '../components/BrailleSpinner';
import EmptyState from '../components/EmptyState';
import Banner from '../components/ui/Banner';
import {
  formatDurationMs,
  formatContextLength,
  parseTimeoutMs,
  TIMEOUT_INPUT_MIN_MS,
  TIMEOUT_INPUT_MAX_MS,
  TIMEOUT_INPUT_STEP_MS,
} from '../utils/formatters';
import SettingsTabsHeader from '../components/settings/SettingsTabsHeader';
import EffortSelect from '../components/cos/EffortSelect';
import Drawer from '../components/Drawer';
import useDrawerTab from '../hooks/useDrawerTab';
import { FormField } from '../components/ui/FormField';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';
import ProviderCard from '../components/providers/ProviderCard';
import { GrokUploadWarning, OrcaRouterKeyHint } from '../components/providers/ProviderNotices';
import CollapsibleSection from '../components/ui/CollapsibleSection';

// The two local apps an API provider can front. Their installer lives on the
// Models → LLMs page (it starts the service too), so the provider card
// links there instead of offering an install of its own.
const LOCAL_APP_LABELS = { ollama: 'Ollama', lmstudio: 'LM Studio' };

// The three buckets the cards are grouped into, in the order they render.
// "Needs setup" sits between them deliberately: a provider missing its CLI or
// key can't be turned on at all, so it is neither enabled nor merely disabled.
export const PROVIDER_SECTIONS = [
  {
    key: 'enabled',
    title: 'Enabled',
    hint: 'Switched on and available to run',
    dot: 'bg-port-success',
    states: [PROVIDER_CARD_STATE.READY, PROVIDER_CARD_STATE.BENCHED],
  },
  {
    key: 'blocked',
    title: 'Needs setup',
    hint: 'Missing a CLI or an API key — these cannot run yet',
    dot: 'bg-port-warning',
    states: [PROVIDER_CARD_STATE.BLOCKED],
  },
  {
    key: 'disabled',
    title: 'Disabled',
    hint: 'Fully configured, but switched off',
    dot: 'bg-gray-500',
    states: [PROVIDER_CARD_STATE.DISABLED],
  },
];

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

export default function AIProviders() {
  const [providers, setProviders] = useState([]);
  // The CoS Agent Runner's exec allowlist, published by GET /api/providers.
  // `null` = not fetched yet (or the fetch failed) — never warn from that state.
  const [runnerAllowedCommands, setRunnerAllowedCommands] = useState(null);
  const [statuses, setStatuses] = useState({}); // runtime availability by providerId (separate from the `enabled` toggle)
  const [recovering, setRecovering] = useState({});
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [testResults, setTestResults] = useState({});
  const [refreshing, setRefreshing] = useState({});
  const [showRunPanel, setShowRunPanel] = useState(false);
  const [runPrompt, setRunPrompt] = useState('');
  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const [apps, setApps] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [runOutput, setRunOutput] = useState('');
  const [showSamples, setShowSamples] = useState(false);
  const [sampleProviders, setSampleProviders] = useState([]);
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [addingSample, setAddingSample] = useState({});
  // CLI availability per provider card, keyed by `providerRuntimeKey`. An empty
  // map means the endpoint was not reached (for example, an older server during
  // an upgrade) — distinct from a confirmed missing CLI — and simply renders no
  // install widgets.
  const [runtimes, setRuntimes] = useState({});
  // Local-daemon requirements per provider (llama.cpp / Ollama / LM Studio /
  // MTPLX), keyed by provider id. Providers with no local dependency are absent
  // from the map, and an empty map means the endpoint was not reached — both
  // render no checklist.
  const [readiness, setReadiness] = useState({});
  // The runtime whose install modal is open (`null` = closed).
  const [installingRuntime, setInstallingRuntime] = useState(null);
  // The local-daemon setup the user asked PortOS to run for them, from a
  // readiness checklist's action button: `{ runtime, label, actionLabel,
  // providerId }`. Separate from `installingRuntime` (a CLI binary) because it
  // streams from a different endpoint and is keyed by the PROVIDER whose
  // endpoint the daemon must come up on.
  const [settingUpRuntime, setSettingUpRuntime] = useState(null);
  // Provider ids whose local daemon is mid-relaunch onto the model id they send
  // (the "Serve as …" fix). A relaunch reloads the weights, so the button has to
  // stay disabled for the tens of seconds a large GGUF takes to come back.
  const [servingModel, setServingModel] = useState({});
  // Ollama / LM Studio install state (and the model lists the editor's pickers
  // fold in) — fetched once here rather than inside ProviderForm so opening the
  // editor doesn't re-request it.
  const localModels = useLocalModels();

  // The editor is a deep-linkable slide-in over this page, so which provider is
  // open lives in the URL (/ai/new · /ai/edit/:providerId) rather than local
  // state — the same "URL is the source of truth for what's open" rule the rest
  // of the app follows. The edit id sits under its own `edit` segment because
  // provider ids are slugified from the display name: a provider named "New"
  // gets the id `new`, and a bare /ai/:providerId route would let the static
  // create route shadow its editor.
  const navigate = useNavigate();
  const location = useLocation();
  const { providerId: editingProviderId } = useParams();
  const creatingProvider = location.pathname.replace(/\/+$/, '').endsWith('/ai/new');
  const closeForm = useCallback(() => navigate('/ai'), [navigate]);
  const openForm = useCallback((target) => navigate(target ? `/ai/edit/${target.id}` : '/ai/new'), [navigate]);

  useEffect(() => {
    loadData();
  }, []);

  // Probing the CLIs costs a `--version` child process each, so this stays OFF
  // the critical path: the page paints from the provider list and the install
  // badges appear when the probes land.
  const loadRuntimes = useCallback(async () => {
    const data = await api.getProviderRuntimes({ silent: true }).catch(() => null);
    setRuntimes(data?.runtimes && typeof data.runtimes === 'object' ? data.runtimes : {});
  }, []);

  useEffect(() => { loadRuntimes(); }, [loadRuntimes]);

  useEffect(() => {
    if (!activeRun) return;

    const handleData = (data) => {
      setRunOutput(prev => prev + data);
    };

    const handleComplete = (_metadata) => {
      setActiveRun(null);
    };

    socket.on(`run:${activeRun}:data`, handleData);
    socket.on(`run:${activeRun}:complete`, handleComplete);

    return () => {
      socket.off(`run:${activeRun}:data`, handleData);
      socket.off(`run:${activeRun}:complete`, handleComplete);
    };
  }, [activeRun]);

  const loadData = async () => {
    setLoading(true);
    setLoadError(false);
    let providersFailed = false;
    const [providersData, appsData, statusData] = await Promise.all([
      api.getProviders().catch(() => {
        providersFailed = true;
        return null;
      }),
      api.getApps().catch(() => []),
      api.getProviderStatuses().catch(() => ({ providers: {} })),
    ]);
    if (providersFailed || !providersData) {
      setLoadError(true);
      setProviders([]);
    } else {
      setLoadError(false);
      setProviders(providersData.providers || []);
      setActiveProviderId(providersData.activeProvider);
      // Keep `null` (not an empty array) when an older server omits the field,
      // so the "off the allowlist" warning stays silent rather than firing on
      // every command.
      setRunnerAllowedCommands(Array.isArray(providersData.runnerAllowedCommands)
        ? providersData.runnerAllowedCommands
        : null);
    }
    setApps(appsData);
    setStatuses(statusData.providers || {});
    setLoading(false);
  };

  // Refresh just the runtime availability map (cheap) so a bench badge appears
  // when a provider fails elsewhere and clears itself once its recovery window
  // passes (the server expires `estimatedRecovery` on read), without a full reload.
  const refreshStatuses = useCallback(async () => {
    const statusData = await api.getProviderStatuses().catch(() => null);
    if (statusData?.providers) setStatuses(statusData.providers);
  }, []);

  // Local-daemon readiness (is llama-server / Ollama actually up and serving the
  // model this provider names?). Off the critical path like the runtime probes,
  // and re-polled on the same cadence as the status map so starting a daemon
  // from the Models → LLMs page clears the card's checklist on its own.
  const loadReadiness = useCallback(async () => {
    const data = await api.getProviderReadiness({ silent: true }).catch(() => null);
    setReadiness(data?.readiness && typeof data.readiness === 'object' ? data.readiness : {});
  }, []);

  // `useAutoRefetch` rather than a raw interval so both polls pause while the
  // tab is hidden — a readiness tick costs one HTTP probe per distinct local
  // endpoint, which a backgrounded settings tab should not keep spending.
  const pollCards = useCallback(() => Promise.all([refreshStatuses(), loadReadiness()]), [refreshStatuses, loadReadiness]);
  useAutoRefetch(pollCards, 20000, { pollOnly: true });

  // Clear a provider's bench (runtime unavailability) so the next call retries it.
  // Note: if the underlying cause persists (e.g. an invalid model id), the very
  // next failure re-benches it — recovery is "try again now", not "fix the cause".
  const handleRecover = async (id) => {
    setRecovering(prev => ({ ...prev, [id]: true }));
    const result = await api.recoverProvider(id, { silent: true }).catch(() => null);
    if (result) {
      setStatuses(prev => ({ ...prev, [id]: { ...prev[id], available: true, reason: 'ok', message: 'Provider available', timeUntilRecovery: null } }));
      toast.success('Provider marked available — it will be retried on the next call');
    } else {
      toast.error('Could not clear the provider status');
    }
    setRecovering(prev => ({ ...prev, [id]: false }));
  };

  const handleSetActive = async (id) => {
    if (!id) return;
    const result = await api.setActiveProvider(id).catch(() => null);
    if (result) setActiveProviderId(id);
  };

  const handleTest = async (id) => {
    setTestResults(prev => ({ ...prev, [id]: { testing: true } }));
    const result = await api.testProvider(id).catch(err => ({ success: false, error: err.message }));
    setTestResults(prev => ({ ...prev, [id]: result }));
  };

  const handleDelete = async (id) => {
    await api.deleteProvider(id);
    loadData();
  };

  const handleToggleEnabled = async (provider) => {
    await api.updateProvider(provider.id, { enabled: !provider.enabled });
    loadData();
  };

  // llama.cpp (and similar local daemons) answer as a single model id — the
  // server's `--alias`, not the preset name on this card. Matching the
  // provider's default to what is actually served is the in-place fix for the
  // "model X available — serving Y" checklist, so the user never has to open
  // the editor or leave the page.
  const handleUseServedModel = async (provider, modelId) => {
    if (!provider?.id || typeof modelId !== 'string' || modelId.trim() === '') return;
    const defaultModel = modelId.trim();
    const models = Array.isArray(provider.models) ? [...provider.models] : [];
    const updates = { defaultModel };
    if (!models.includes(defaultModel)) updates.models = [defaultModel, ...models];
    const updated = await api.updateProvider(provider.id, updates).catch(() => null);
    if (!updated) return;
    setProviders((prev) => prev.map((entry) => (
      entry.id === provider.id ? { ...entry, ...updates } : entry
    )));
    toast.success(`Default model set to ${defaultModel}`);
    loadReadiness();
  };

  // The mirror of `handleUseServedModel`: instead of moving the provider onto
  // whatever the daemon answers as, relaunch the daemon under the id the
  // provider sends. llama.cpp serves one model per process under its `--alias`,
  // so this keeps the loaded weights and only changes the name — no download.
  const handleServeWantedModel = async (provider) => {
    if (!provider?.id || servingModel[provider.id]) return;
    setServingModel((prev) => ({ ...prev, [provider.id]: true }));
    // `silent` so the 409 refusal (an externally-started daemon) reads as one
    // toast naming the fix rather than the helper's generic error on top of it.
    const result = await api.serveProviderModel(provider.id, { silent: true })
      .catch((err) => ({ error: err?.message || 'The relaunch failed.' }));
    setServingModel((prev) => ({ ...prev, [provider.id]: false }));
    if (!result?.success) {
      toast.error(result?.error || 'Could not relaunch the local server under that model id.');
      loadReadiness();
      return;
    }
    toast.success(result.relaunched
      ? `Local server restarted — now serving ${result.model}`
      : `Local server already serves ${result.model}`);
    loadReadiness();
  };

  const handleRefreshModels = async (id) => {
    setRefreshing(prev => ({ ...prev, [id]: true }));
    try {
      const result = await api.refreshProviderModels(id, { silent: true });
      if (result) {
        toast.success(`Models refreshed for ${result.name}`);
        loadData();
      } else {
        toast.error('Failed to refresh models - provider may not support this feature');
      }
    } catch (error) {
      toast.error(`Error refreshing models: ${error.message}`);
    } finally {
      setRefreshing(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleExecuteRun = async () => {
    if (!runPrompt.trim() || !activeProviderId) return;

    setRunOutput('');
    const workspace = apps.find(a => a.id === selectedWorkspace);

    const result = await api.createRun({
      providerId: activeProviderId,
      prompt: runPrompt,
      workspacePath: workspace?.repoPath,
      workspaceName: workspace?.name
    }, { silent: true }).catch(err => ({ error: err.message }));

    if (result.error) {
      setRunOutput(`Error: ${result.error}`);
      return;
    }

    setActiveRun(result.runId);
  };

  const handleStopRun = async () => {
    if (activeRun) {
      await api.stopRun(activeRun);
      setActiveRun(null);
    }
  };

  const handleLoadSamples = async () => {
    setLoadingSamples(true);
    setShowSamples(true);
    const result = await api.getSampleProviders().catch(() => ({ providers: [] }));
    setSampleProviders(result.providers || []);
    setLoadingSamples(false);
  };

  const handleAddSample = async (provider) => {
    setAddingSample(prev => ({ ...prev, [provider.id]: true }));
    try {
      await api.createProvider(provider);
      setSampleProviders(prev => prev.filter(p => p.id !== provider.id));
      await loadData();
      toast.success(`Added ${provider.name}`);
    } catch (err) {
      const message = (typeof err?.message === 'string' && err.message) ||
                      (typeof err?.error === 'string' && err.error) ||
                      (typeof err === 'string' ? err : 'An unknown error occurred');
      toast.error(`Failed to add provider: ${message}`);
    } finally {
      setAddingSample(prev => ({ ...prev, [provider.id]: false }));
    }
  };

  const handleAddAllSamples = async () => {
    if (sampleProviders.length === 0) return;

    const succeededIds = [];
    const failedIds = [];

    for (const provider of sampleProviders) {
      try {
        await api.createProvider(provider);
        succeededIds.push(provider.id);
      } catch (err) {
        console.error(`Failed to add sample provider ${provider.name || provider.id}:`, err);
        failedIds.push(provider.id);
      }
    }

    setSampleProviders(prev => prev.filter(p => !succeededIds.includes(p.id)));
    await loadData();

    if (failedIds.length === 0) {
      toast.success(`Added ${succeededIds.length} provider${succeededIds.length === 1 ? '' : 's'}`);
    } else if (succeededIds.length === 0) {
      toast.error(`Failed to add ${failedIds.length} provider${failedIds.length === 1 ? '' : 's'}`);
    } else {
      toast.warning(`Added ${succeededIds.length} provider${succeededIds.length === 1 ? '' : 's'}, ${failedIds.length} failed`);
    }
  };

  const handleRuntimeInstallComplete = () => {
    toast.success(`${installingRuntime?.label || 'Runtime'} installed and ready to test`);
    // Only the CLI's availability changed — the provider records did not.
    loadRuntimes();
  };

  // A daemon was just installed/started. Only the readiness checklist changed —
  // re-poll it so the card's banner collapses to the "ready" pill on its own.
  const handleRuntimeSetupComplete = () => {
    toast.success(`${settingUpRuntime?.label || 'Local runtime'} is set up`);
    loadReadiness();
  };

  // The install widget's data for one card: a CLI provider's binary comes from
  // the server's runtime table; an API provider fronted by a local app takes the
  // local-LLM status, which counts an installed app with no CLI shim on PATH.
  //
  // Only when the endpoint is on THIS machine: `localBackendForProvider` matches
  // by name and port, so an API provider pointed at another box's LM Studio also
  // resolves to `lmstudio` — and reporting this host's install state for it says
  // nothing true about that server, which is somebody else's to run.
  const runtimeForProvider = useCallback((provider) => {
    const backend = isApiProvider(provider) && isLocalInstanceProvider(provider)
      ? localBackendForProvider(provider)
      : null;
    if (!backend) return runtimes[providerRuntimeKey(provider)] || null;
    // The readiness checklist covers this same backend in more detail, and knows
    // the difference between "not installed" and "installed but not started".
    // Rendering both put a green "LM Studio installed" pill directly above
    // "Install LM Studio" — so wherever the checklist has an answer, it wins.
    if (readiness[provider.id]?.kind === backend) return null;
    const installed = localModels.installed?.[backend];
    // `null` = status not fetched — never offer an install from an unknown state.
    if (typeof installed !== 'boolean') return null;
    return { id: backend, label: LOCAL_APP_LABELS[backend], installed, installable: false, manageUrl: '/models/llms' };
  }, [runtimes, localModels.installed, readiness]);

  // Everything the cards are derived from, in one pass: each provider's runtime,
  // its readiness (runtime install state + credentials + the runtime bench,
  // folded into the state that drives the card's color, its badge and its
  // section), and the id lookup the cards use for fallback/sibling references.
  // Memoized because this page re-renders on the 20s status poll and on every
  // keystroke in the ad-hoc runner's prompt box.
  const { providersById, runtimeByProviderId, cardStateByProviderId, providersBySection } = useMemo(() => {
    const byId = Object.fromEntries(providers.map(p => [p.id, p]));
    const runtimeById = Object.fromEntries(providers.map(p => [p.id, runtimeForProvider(p)]));
    const readinessById = Object.fromEntries(providers.map((provider) => [provider.id, providerCardState(provider, {
      runtime: runtimeById[provider.id],
      status: statuses[provider.id],
      keySetFor: (id) => {
        const referenced = byId[id];
        // The list is authoritative once this memo runs. A missing sibling was
        // deleted, so the wrapper has no inherited key; an unknown lookup is
        // reserved for callers that genuinely cannot determine the state.
        if (!referenced) return false;
        return typeof referenced.hasApiKey === 'boolean' ? referenced.hasApiKey : null;
      },
    })]));
    // The default provider floats to the top of whichever section it sits in, so
    // "which one runs by default" stays a one-glance answer after grouping.
    const defaultFirst = (list) => {
      const idx = list.findIndex(p => p.id === activeProviderId);
      return idx <= 0 ? list : [list[idx], ...list.slice(0, idx), ...list.slice(idx + 1)];
    };
    return {
      providersById: byId,
      runtimeByProviderId: runtimeById,
      cardStateByProviderId: readinessById,
      providersBySection: Object.fromEntries(PROVIDER_SECTIONS.map(section => [
        section.key,
        defaultFirst(providers.filter(p => section.states.includes(readinessById[p.id].state))),
      ])),
    };
  }, [providers, statuses, activeProviderId, runtimeForProvider]);

  // Resolved only once the list has loaded, so an /ai/edit/:providerId reload can't
  // flash the editor in "Add Provider" mode before the record arrives. An id
  // that never resolves (deleted provider, hand-edited link) bounces back to the
  // list rather than leaving a blank editor open. `hasOwn` rather than a plain
  // lookup because the id comes straight off the URL: `/ai/edit/__proto__`
  // would otherwise resolve to `Object.prototype` and open the editor on it.
  const editingProvider = editingProviderId && Object.hasOwn(providersById, editingProviderId)
    ? providersById[editingProviderId]
    : null;
  const editorOpen = creatingProvider || Boolean(editingProvider);

  useEffect(() => {
    if (loading || loadError || !editingProviderId || editingProvider) return;
    toast.error(`No provider with id "${editingProviderId}"`);
    navigate('/ai', { replace: true });
  }, [loading, loadError, editingProviderId, editingProvider, navigate]);

  const selectedRunProvider = providers.find(p => p.id === activeProviderId);
  const runProviderIsTui = isTuiProvider(selectedRunProvider);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 p-4 border-b border-port-border">
          <h1 className="text-2xl font-bold text-white">Settings</h1>
        </div>
        <SettingsTabsHeader activeTab="providers" />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-gray-400">Loading providers...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-port-border">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
      </div>

      <SettingsTabsHeader activeTab="providers" />

      <div className="flex-1 overflow-auto p-4 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">AI Providers</h1>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/models/performance"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors text-sm sm:text-base"
          >
            <Gauge size={15} /> Compare local models
          </Link>
          <button
            onClick={() => setShowRunPanel(!showRunPanel)}
            className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors text-sm sm:text-base"
          >
            {showRunPanel ? 'Hide Runner' : 'Run Prompt'}
          </button>
          <button
            onClick={handleLoadSamples}
            className="px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors text-sm sm:text-base"
          >
            {loadingSamples ? <BrailleSpinner text="Loading" /> : 'Load Samples'}
          </button>
          <button
            onClick={() => openForm(null)}
            className="px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors text-sm sm:text-base"
          >
            Add Provider
          </button>
        </div>
      </div>

      {/* Sample Providers Panel */}
      {showSamples && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Sample Providers</h2>
            <div className="flex gap-2">
              {sampleProviders.length > 1 && (
                <button
                  onClick={handleAddAllSamples}
                  className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded transition-colors"
                >
                  Add All ({sampleProviders.length})
                </button>
              )}
              <button
                onClick={() => setShowSamples(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>

          {loadingSamples ? (
            <div className="text-center py-6 text-gray-400">Loading sample providers...</div>
          ) : sampleProviders.length === 0 ? (
            <div className="text-center py-6 text-gray-500">
              All sample providers are already in your configuration.
            </div>
          ) : (
            <div className="grid gap-3">
              {sampleProviders.map(provider => (
                <div
                  key={provider.id}
                  className="bg-port-bg border border-port-border rounded-lg p-3 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-white">{provider.name}</h3>
                      <span className={`text-xs px-2 py-0.5 rounded ${providerTypeClass(provider.type)}`}>
                        {provider.type.toUpperCase()}
                      </span>
                      {provider.llamaBacked && (
                        <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                          LLAMA.CPP / DFLASH
                        </span>
                      )}
                      {provider.vllmBacked && (
                        <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                          vLLM / DFLASH2
                        </span>
                      )}
                      {provider.sglangBacked && (
                        <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          SGLANG
                        </span>
                      )}
                      {provider.mtplxBacked && (
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                          MTPLX
                        </span>
                      )}
                      {!provider.enabled && (
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">
                          DISABLED
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-400 space-y-0.5">
                      {isProcessProvider(provider) && (
                        <p>Command: <code className="text-gray-300">{provider.command} {provider.args?.join(' ')}</code></p>
                      )}
                      {isApiProvider(provider) && (
                        <p>Endpoint: <code className="text-gray-300">{provider.endpoint}</code></p>
                      )}
                      {isApiProvider(provider) && !isLocalEndpoint(provider.endpoint) && (
                        <p className="text-port-warning">Needs an API key — after adding, use Edit to paste it</p>
                      )}
                      {filterSelectableModels(provider.models).length > 0 && (
                        <p>Models: {filterSelectableModels(provider.models).slice(0, 3).join(', ')}{filterSelectableModels(provider.models).length > 3 ? ` +${filterSelectableModels(provider.models).length - 3}` : ''}</p>
                      )}
                      {provider.envVars && Object.keys(provider.envVars).length > 0 && (
                        <div className="mt-0.5">
                          <span>Env:</span>
                          {Object.entries(provider.envVars).map(([k, v]) => (
                            <div key={k}>
                              <code className="ml-1 text-orange-400">
                                {k}={provider.secretEnvVars?.includes(k) ? (v === '' ? '(not set)' : '***') : v}
                              </code>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleAddSample(provider)}
                    disabled={addingSample[provider.id]}
                    className="px-4 py-1.5 text-sm bg-port-success/20 text-port-success hover:bg-port-success/30 rounded transition-colors disabled:opacity-50 shrink-0"
                  >
                    {addingSample[provider.id] ? 'Adding...' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Run Panel */}
      {showRunPanel && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-4">
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
            <select
              value={activeProviderId || ''}
              onChange={(e) => handleSetActive(e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white w-full sm:w-auto"
            >
              <option value="">Select Provider</option>
              {providers.filter(p => p.enabled).map(p => (
                <option key={p.id} value={p.id}>{p.name}{isTuiProvider(p) ? ' (CoS TUI)' : ''}</option>
              ))}
            </select>

            <select
              value={selectedWorkspace}
              onChange={(e) => setSelectedWorkspace(e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white w-full sm:w-auto"
            >
              <option value="">No workspace</option>
              {apps.map(app => (
                <option key={app.id} value={app.id}>{app.name}</option>
              ))}
            </select>
          </div>

          <textarea
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
            placeholder="Enter your prompt..."
            rows={3}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:border-port-accent focus:outline-hidden"
          />

          <div className="flex justify-between items-center">
            <button
              onClick={handleExecuteRun}
              disabled={!runPrompt.trim() || !activeProviderId || activeRun}
              className="px-6 py-2 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {activeRun ? 'Running...' : 'Execute'}
            </button>

            {activeRun && (
              <button
                onClick={handleStopRun}
                className="px-4 py-2 bg-port-error hover:bg-port-error/80 text-white rounded-lg transition-colors"
              >
                Stop
              </button>
            )}
          </div>

          {runProviderIsTui && (
            <div className="text-xs text-port-accent bg-port-accent/10 border border-port-accent/20 rounded-lg px-3 py-2">
              TUI providers spawn a PTY-backed run that streams output here and is stoppable from the run list.
            </div>
          )}

          {runOutput && (
            <div className="bg-port-bg border border-port-border rounded-lg p-3 max-h-64 overflow-auto">
              <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">{runOutput}</pre>
            </div>
          )}
        </div>
      )}

      {/* Provider List, grouped by readiness (see PROVIDER_SECTIONS) */}
      <div className="grid gap-6">
        {loadError ? (
          <Banner
            tone="error"
            size="md"
            title="Failed to load AI providers"
            actions={(
              <button
                type="button"
                onClick={loadData}
                className="px-3 py-1.5 rounded-lg text-xs bg-port-error/20 hover:bg-port-error/30 text-port-error font-medium transition-colors"
              >
                Retry
              </button>
            )}
          >
            Could not connect to the server to fetch provider configuration.
          </Banner>
        ) : (
          <>
            {PROVIDER_SECTIONS.map(section => {
              const sectionProviders = providersBySection[section.key];
              if (sectionProviders.length === 0) return null;
              return (
                <CollapsibleSection
                  key={section.key}
                  size="lg"
                  defaultOpen
                  buttonClassName="flex-wrap border-b border-port-border/60 pb-1.5"
                  bodyClassName="grid gap-4 pt-3"
                  label={(
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${section.dot}`} aria-hidden="true" />
                      <span className="text-sm font-semibold uppercase tracking-wide text-white">{section.title}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-port-bg text-gray-400">{sectionProviders.length}</span>
                      <span className="text-xs text-gray-500">{section.hint}</span>
                    </span>
                  )}
                >
                  {sectionProviders.map(provider => (
                    <ProviderCard
                      key={provider.id}
                      provider={provider}
                      cardState={cardStateByProviderId[provider.id]}
                      daemonReadiness={readiness[provider.id]}
                      runtime={runtimeByProviderId[provider.id]}
                      status={statuses[provider.id]}
                      isDefault={provider.id === activeProviderId}
                      providersById={providersById}
                      runnerAllowedCommands={runnerAllowedCommands}
                      testResult={testResults[provider.id]}
                      refreshing={Boolean(refreshing[provider.id])}
                      recovering={Boolean(recovering[provider.id])}
                      onTest={handleTest}
                      onRefreshModels={handleRefreshModels}
                      onToggleEnabled={handleToggleEnabled}
                      onSetActive={handleSetActive}
                      onEdit={openForm}
                      onDelete={handleDelete}
                      onRecover={handleRecover}
                      onInstallRuntime={setInstallingRuntime}
                      onAutoSetupRuntime={setSettingUpRuntime}
                      onUseServedModel={handleUseServedModel}
                      onServeWantedModel={handleServeWantedModel}
                      servingModel={Boolean(servingModel[provider.id])}
                    />
                  ))}
                </CollapsibleSection>
              );
            })}

            {providers.length === 0 && (
              <EmptyState
                title="No providers configured"
                message="Configure at least one API provider to enable autonomous CoS, voice, and AI-assisted features across PortOS."
                actionLabel="Add Provider"
                onAction={() => openForm(null)}
              />
            )}
          </>
        )}
      </div>

      {/* Full run history lives on the Chief of Staff → Runs tab; this page
          only configures providers. */}
      <div className="mt-8">
        <Link to="/cos/runs" className="text-sm text-port-accent hover:underline">
          View AI run history →
        </Link>
      </div>

      {/* Provider editor — a deep-linkable slide-in over this page. `key` resets
          the form state when the route swaps one provider for another. */}
      {editorOpen && (
        <ProviderForm
          key={editingProvider?.id || 'new'}
          provider={editingProvider}
          allProviders={providers}
          localModels={localModels}
          runnerAllowedCommands={runnerAllowedCommands}
          onEditProvider={openForm}
          onClose={closeForm}
          onSave={() => { closeForm(); loadData(); }}
        />
      )}
      <RuntimeInstallModal
        open={Boolean(installingRuntime)}
        runtime={installingRuntime?.id}
        label={installingRuntime?.label}
        onClose={() => setInstallingRuntime(null)}
        onComplete={handleRuntimeInstallComplete}
        installUrlBase="/api/providers/runtimes/install"
        streamMethod="POST"
        flushMs={250}
        description={`Installing ${installingRuntime?.label} from ${installingRuntime?.method === 'script' ? "the vendor's official install script" : 'its global npm package'}.`}
      />
      {/* The readiness checklist's one-click fix. Same streaming modal as the
          CLI installer, pointed at the local-daemon setup endpoint — which
          re-derives the runtime and its endpoint from the provider record, so
          `provider` is the only thing that travels. */}
      <RuntimeInstallModal
        open={Boolean(settingUpRuntime)}
        runtime={settingUpRuntime?.runtime}
        label={settingUpRuntime?.label}
        title={settingUpRuntime?.actionLabel}
        params={settingUpRuntime ? { provider: settingUpRuntime.providerId, action: settingUpRuntime.action } : undefined}
        onClose={() => setSettingUpRuntime(null)}
        onComplete={handleRuntimeSetupComplete}
        installUrlBase="/api/providers/readiness/setup"
        streamMethod="POST"
        flushMs={250}
        description={settingUpRuntime?.action === 'pull-start'
          ? `${settingUpRuntime.actionLabel} — model weights are a multi-gigabyte download, so this can run for a long time.`
          : `${settingUpRuntime?.actionLabel || 'Setting up'} — this can take several minutes on a first install.`}
      />
      </div>
    </div>
  );
}

function ProviderForm({ provider, onClose, onSave, onEditProvider, allProviders = [], localModels = { ollama: [], lmstudio: [], ctxById: {} }, runnerAllowedCommands = null }) {
  const [formData, setFormData] = useState({
    name: provider?.name || '',
    type: provider?.type || 'cli',
    command: provider?.command || '',
    args: provider?.args?.join(' ') || '',
    endpoint: provider?.endpoint || '',
    apiKey: '',
    allowCustomEndpoint: provider?.allowCustomEndpoint === true,
    models: provider?.models || [],
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

  // Generation pickers (default + light/medium/heavy tiers) — drop embedding-only
  // models (and internal sentinels) so an embedding can't be chosen as a model
  // that runs prompts, consistent with the fallback picker below.
  const mergedModels = mergeModelLists(formData.models, liveModelsFor(formData));
  const availableModels = filterGenerationModels(mergedModels);
  // A provider can pin its tiers to the "use the CLI's own default" sentinel
  // while still publishing a real model catalog (Antigravity: `agy models`
  // lists real ids, but PortOS leaves the tiers on agy's own default). The
  // sentinel is filtered out of `availableModels`, so without an explicit
  // option for it the four selects below would hold a value matching no option
  // and render blank — reading as "no model configured" when one is.
  const configuredDefault = configuredDefaultIn(mergedModels);
  // The markers that identify a backed provider (`ollamaBacked`, `llamaBacked`,
  // `orcarouterBacked`) are NOT form fields, so a shape built from `formData`
  // alone loses them — which hid the effort ladder on the OpenCode-Ollama
  // providers, whose ladder is keyed on `ollamaBacked`. Merge the live edits
  // over the stored record instead, so edits to command/endpoint/envVars count
  // immediately while the markers survive.
  const capabilityProvider = { ...provider, ...formData, id: provider?.id, models: mergedModels };
  // Shared option list for the Default Model + Light/Medium/Heavy tier selects,
  // so the sentinel option can't be added to some and missed on others.
  const modelSelectOptions = (
    <>
      <option value="">None</option>
      {configuredDefault && (
        <option value={configuredDefault}>Use the CLI&apos;s configured default</option>
      )}
      {availableModels.map(model => (
        <option key={model} value={model}>{modelOptionLabel(model, localModels.ctxById)}</option>
      ))}
    </>
  );

  // Filter out current provider from fallback options (treat undefined enabled as enabled)
  const fallbackOptions = allProviders.filter(p => p.id !== provider?.id && p.enabled !== false);

  // The fallback model is a model OF the selected fallback provider, so its
  // option list comes from that provider's `models` — merged with the live
  // installed list for local backends, and embedding-only models dropped (a
  // fallback runs prompts, so `nomic-embed-text` must never be selectable here).
  const selectedFallbackProvider = allProviders.find(p => p.id === formData.fallbackProvider);
  const fallbackModelOptions = filterGenerationModels(
    mergeModelLists(selectedFallbackProvider?.models, liveModelsFor(selectedFallbackProvider)),
  );
  const plannedContextLabel = formatContextLength(
    effectiveModelContextWindow(formData, formData.defaultModel)
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
                      No environment variable is involved. Hosted APIs (Cerebras, Grok, NVIDIA, OrcaRouter, …) require
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

              {isGrokBuildCli({ type: formData.type, command: formData.command }) && <GrokUploadWarning />}

              {isOrcaRouterBackedProvider(provider) && (
                <OrcaRouterKeyHint
                  sibling={allProviders.find(p => p.id === 'orcarouter')}
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
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  If this provider hits a usage limit or becomes unavailable, tasks will automatically use the fallback provider.
                </p>
                </FormField>

                {formData.fallbackProvider && (
                  <FormField label="Fallback Model" className="mt-3">
                    {fallbackModelOptions.length > 0 ? (
                      <select
                        value={formData.fallbackModel}
                        onChange={(e) => setFormData(prev => ({ ...prev, fallbackModel: e.target.value }))}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      >
                        <option value="">Use fallback provider's default</option>
                        {fallbackModelOptions.map(model => (
                          <option key={model} value={model}>{modelOptionLabel(model, localModels.ctxById)}</option>
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
