import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Bot, Gauge, Network, Package } from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import socket from '../services/socket';
import { filterSelectableModels, isProviderHardwareCompatible, mergeModelLists, localBackendForProvider, providerTypeClass, isTuiProvider, isApiProvider, isProcessProvider, isCodexSubscriptionProvider, isLocalEndpoint, isLocalInstanceProvider, providerRuntimeKey, providerCardState, PROVIDER_CARD_STATE } from '../utils/providers';
import { copyToClipboard } from '../lib/clipboard';
import { isHttpsUrl } from '../utils/urlNormalize';
import useLocalModels from '../hooks/useLocalModels';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import EmptyState from '../components/EmptyState';
import Banner from '../components/ui/Banner';
import SettingsTabsHeader from '../components/settings/SettingsTabsHeader';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import OverflowMenu from '../components/ui/OverflowMenu';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';
import ProviderCard from '../components/providers/ProviderCard';
import ProviderForm from '../components/providers/ProviderForm';
import CollapsibleSection from '../components/ui/CollapsibleSection';
import FleetProviderSetup from '../components/providers/FleetProviderSetup';

// The two local apps an API provider can front. Their installer lives on the
// Models → LLMs page (it starts the service too), so the provider card
// links there instead of offering an install of its own.
const LOCAL_APP_LABELS = { ollama: 'Ollama', lmstudio: 'LM Studio' };

// The buckets the cards are grouped into, in the order they render.
// "Needs setup" sits second because it is the page's only outstanding-task list,
// and it is short: it holds ONLY providers the user switched ON that still can't
// run. A switched-off one files under "Disabled" whatever it is missing — see
// the precedence note on `providerCardState`.
//
// The last bucket is the machine's own veto: a provider the server has marked
// hardware-`unavailable` can never run here no matter what the user toggles, so
// it is pulled out of the three readiness buckets and parked in a section that
// stays COLLAPSED. Deleting it outright is not an option — the record is shared
// across a user's federated machines, and one that is unavailable here may be
// the workhorse on another — so it stays editable/deletable one click away
// instead of adding noise to the three sections that describe real choices.
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
    hint: 'Switched on but missing a CLI or an API key — these cannot run yet',
    dot: 'bg-port-warning',
    states: [PROVIDER_CARD_STATE.BLOCKED, PROVIDER_CARD_STATE.UNKNOWN],
  },
  {
    key: 'disabled',
    title: 'Disabled',
    hint: 'Switched off — optional, nothing to do unless you want one',
    dot: 'bg-gray-500',
    states: [PROVIDER_CARD_STATE.DISABLED],
  },
  {
    key: 'incompatible',
    title: 'Unavailable on this machine',
    hint: 'This hardware cannot run them — kept for your other machines',
    dot: 'bg-port-error',
    // Matched by hardware, not by card state: `states` stays empty so the
    // readiness filter never claims one of these cards back.
    states: [],
    hardwareIncompatible: true,
    defaultOpen: false,
  },
];

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
  // `undefined` = this page has not asked the account endpoint yet; `null` =
  // the endpoint did not give a verdict. The distinction keeps a failed fetch
  // from posing as either signed out or ready.
  const [codexAccount, setCodexAccount] = useState(undefined);
  const [codexModels, setCodexModels] = useState(null);
  const [codexAccountLoading, setCodexAccountLoading] = useState(false);
  const [codexLoginLoading, setCodexLoginLoading] = useState(false);
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
  const [fleetPeers, setFleetPeers] = useState([]);
  // Samples this machine could actually run. One the server marked
  // hardware-`unavailable` has no path to becoming usable here, so it is not
  // listed at all rather than listed with a dead "Unavailable" button.
  const addableSamples = useMemo(
    () => sampleProviders.filter(isProviderHardwareCompatible),
    [sampleProviders],
  );
  const hasCodexSubscriptionProvider = providers.some(isCodexSubscriptionProvider);

  const mergeCodexCatalog = useCallback((catalog) => {
    if (!Array.isArray(catalog)) return;
    const ids = catalog.map((model) => (typeof model === 'string' ? model : model?.id))
      .filter((id) => typeof id === 'string' && id.trim() !== '');
    setProviders((current) => current.map((provider) => (
      isCodexSubscriptionProvider(provider)
        ? { ...provider, models: mergeModelLists(provider.models, ids) }
        : provider
    )));
  }, []);

  const loadCodexModels = useCallback(async (fresh = false) => {
    const result = await api.getCodexModels({ fresh, silent: true }).catch(() => null);
    if (!result || !Object.hasOwn(result, 'models')) return null;
    setCodexModels(result);
    // `null` is never fetched; an empty list is a real catalog. Only merge a
    // real array, preserving every current default/tier pin even if it is no
    // longer in the catalog so the form can show it as stale rather than clear
    // a saved choice behind the user's back.
    mergeCodexCatalog(result.models);
    return result;
  }, [mergeCodexCatalog]);

  const loadCodexAccount = useCallback(async (fresh = false) => {
    // Compatibility with a server that predates the account endpoint. The
    // normal client library always has this function; the guard makes a mixed
    // client/server upgrade leave the established provider controls intact.
    if (typeof api.getCodexAccount !== 'function') return undefined;
    setCodexAccountLoading(true);
    const result = await api.getCodexAccount({ fresh, silent: true }).catch(() => null);
    const readiness = result?.readiness && typeof result.readiness === 'object' ? result.readiness : null;
    setCodexAccount(readiness);
    setCodexAccountLoading(false);
    if (readiness?.status === 'ready') loadCodexModels(fresh);
    return readiness;
  }, [loadCodexModels]);

  useEffect(() => {
    if (hasCodexSubscriptionProvider) loadCodexAccount();
    else {
      setCodexAccount(undefined);
      setCodexModels(null);
    }
  }, [hasCodexSubscriptionProvider, loadCodexAccount]);
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
  const fleetSetupOpen = location.pathname.replace(/\/+$/, '').endsWith('/ai/fleet');
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
    if (!fleetSetupOpen) return;
    api.getInstances({ silent: true })
      .then((data) => setFleetPeers(Array.isArray(data?.peers) ? data.peers : []))
      .catch(() => setFleetPeers([]));
  }, [fleetSetupOpen]);

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
  const pollCards = useCallback(() => Promise.all([
    refreshStatuses(),
    loadReadiness(),
    hasCodexSubscriptionProvider ? loadCodexAccount() : Promise.resolve(),
  ]), [refreshStatuses, loadReadiness, hasCodexSubscriptionProvider, loadCodexAccount]);
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
    await api.updateProvider(provider.id, {
      enabled: !provider.enabled,
    });
    loadData();
  };

  const handleEnableCodexSubscription = async (provider) => {
    const updated = await api.updateProvider(provider.id, { textTransportEnabled: true }, { silent: true }).catch(() => null);
    if (!updated) {
      toast.error('Could not save the ChatGPT subscription transport');
      return;
    }
    setProviders((current) => current.map((entry) => (
      entry.id === provider.id ? { ...entry, textTransportEnabled: true } : entry
    )));
    toast.success('ChatGPT subscription transport enabled');
  };

  const handleCodexSignIn = async (deviceCode) => {
    setCodexLoginLoading(true);
    const result = await api.startCodexLogin(deviceCode, { silent: true }).catch(() => null);
    setCodexLoginLoading(false);
    if (!result?.login) {
      toast.error('Could not start ChatGPT sign-in');
      return;
    }
    const login = {
      ...result.login,
      authUrl: isHttpsUrl(result.login.authUrl) ? result.login.authUrl : null,
      verificationUrl: isHttpsUrl(result.login.verificationUrl) ? result.login.verificationUrl : null,
    };
    setCodexAccount((current) => ({
      ...(current && typeof current === 'object' ? current : {}),
      status: 'login-pending',
      login,
    }));
    if (login.authUrl) window.open(login.authUrl, '_blank', 'noopener,noreferrer');
  };

  const handleCancelCodexLogin = async (loginId) => {
    setCodexLoginLoading(true);
    const result = await api.cancelCodexLogin(loginId, { silent: true }).catch(() => null);
    setCodexLoginLoading(false);
    if (!result?.readiness) {
      toast.error('Could not cancel ChatGPT sign-in');
      return;
    }
    setCodexAccount(result.readiness);
  };

  const handleCodexLogout = async () => {
    setCodexAccountLoading(true);
    const result = await api.codexLogout({ silent: true }).catch(() => null);
    setCodexAccountLoading(false);
    if (!result?.readiness) {
      toast.error('Could not log out of ChatGPT');
      return;
    }
    setCodexAccount(result.readiness);
    toast.success('ChatGPT subscription signed out');
  };

  const handleCopyCodexDeviceCode = async (code) => {
    if (await copyToClipboard(code)) toast.success('Device code copied');
    else toast.error('Could not copy the device code');
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

  const handleCreateFleetProvider = async (provider) => {
    const created = await api.createProvider(provider);
    setProviders((current) => [...current, created]);
    toast.success(`${created.name} is connected to the fleet GPU host`);
    return created;
  };

  const handleAddAllSamples = async () => {
    if (addableSamples.length === 0) return;

    const succeededIds = [];
    const failedIds = [];

    for (const provider of addableSamples) {
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
      codexAccount: isCodexSubscriptionProvider(provider) ? codexAccount : undefined,
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
    // The hardware veto is decided first: what this machine cannot run never
    // reaches the readiness buckets, so a card lands in exactly one section.
    const runnable = providers.filter(isProviderHardwareCompatible);
    const unrunnable = providers.filter(p => !isProviderHardwareCompatible(p));
    return {
      providersById: byId,
      runtimeByProviderId: runtimeById,
      cardStateByProviderId: readinessById,
      providersBySection: Object.fromEntries(PROVIDER_SECTIONS.map(section => [
        section.key,
        defaultFirst(section.hardwareIncompatible
          ? unrunnable
          : runnable.filter(p => section.states.includes(readinessById[p.id].state))),
      ])),
    };
  }, [providers, statuses, activeProviderId, runtimeForProvider, codexAccount]);

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
        <PageHeader icon={Bot} title="AI Providers" />
        <SettingsTabsHeader activeTab="providers" />
        <div className="flex-1 overflow-auto p-4">
          <PageSkeleton header="none" label="Loading providers" layout="grid" cards={4} />
        </div>
      </div>
    );
  }

  // Only the two actions a user reaches for on nearly every visit stay as
  // visible buttons; the rare ones are demoted to the overflow menu so the bar
  // stays one row tall on a 360px viewport and the first provider card is
  // reachable without scrolling (issue #5653).
  const secondaryActions = [
    { id: 'compare-models', label: 'Compare local models', icon: Gauge, to: '/models/performance' },
    { id: 'fleet-setup', label: 'Fleet setup', icon: Network, to: '/ai/fleet' },
    {
      id: 'load-samples',
      label: loadingSamples ? 'Loading samples…' : 'Load Samples',
      icon: Package,
      disabled: loadingSamples,
      onSelect: handleLoadSamples,
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={Bot}
        title="AI Providers"
        actions={(
          <>
            <button
              onClick={() => setShowRunPanel(!showRunPanel)}
              className="inline-flex min-h-[40px] items-center rounded-lg bg-port-accent px-3 py-1.5 text-sm text-white transition-colors hover:bg-port-accent/80"
            >
              {showRunPanel ? 'Hide Runner' : 'Run Prompt'}
            </button>
            <button
              onClick={() => openForm(null)}
              className="inline-flex min-h-[40px] items-center rounded-lg bg-port-border px-3 py-1.5 text-sm text-white transition-colors hover:bg-port-border/80"
            >
              Add Provider
            </button>
            <OverflowMenu label="More provider actions" items={secondaryActions} />
          </>
        )}
      />

      <SettingsTabsHeader activeTab="providers" />

      <div className="flex-1 overflow-auto p-4 space-y-6">

      {/* Sample Providers Panel */}
      {showSamples && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Sample Providers</h2>
            <div className="flex gap-2">
              {addableSamples.length > 1 && (
                <button
                  onClick={handleAddAllSamples}
                  className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded transition-colors"
                >
                  Add All ({addableSamples.length})
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
          ) : addableSamples.length === 0 ? (
            <div className="text-center py-6 text-gray-500">
              {sampleProviders.length === 0
                ? 'All sample providers are already in your configuration.'
                : 'The remaining sample providers cannot run on this machine’s hardware.'}
            </div>
          ) : (
            <div className="grid gap-3">
              {addableSamples.map(provider => (
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
                    disabled={Boolean(addingSample[provider.id])}
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
              aria-label="Active provider"
              value={activeProviderId || ''}
              onChange={(e) => handleSetActive(e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white w-full sm:w-auto"
            >
              <option value="">Select Provider</option>
              {providers.filter(p => p.enabled && isProviderHardwareCompatible(p)).map(p => (
                <option key={p.id} value={p.id}>{p.name}{isTuiProvider(p) ? ' (CoS TUI)' : ''}</option>
              ))}
            </select>

            <select
              aria-label="Workspace"
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
            aria-label="Prompt"
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
                  defaultOpen={section.defaultOpen !== false}
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
                      codexAccount={isCodexSubscriptionProvider(provider) ? codexAccount : undefined}
                      codexModels={codexModels}
                      codexAccountLoading={codexAccountLoading}
                      codexLoginLoading={codexLoginLoading}
                      onCodexCheckAccount={() => loadCodexAccount(true)}
                      onCodexSignIn={handleCodexSignIn}
                      onCodexCancelLogin={handleCancelCodexLogin}
                      onCodexLogout={handleCodexLogout}
                      onCodexRefreshModels={() => loadCodexModels(true)}
                      onCodexCopyCode={handleCopyCodexDeviceCode}
                      onCodexEnable={() => handleEnableCodexSubscription(provider)}
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
      {fleetSetupOpen && (
        <FleetProviderSetup
          peers={fleetPeers}
          onClose={closeForm}
          onCreate={handleCreateFleetProvider}
        />
      )}
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
