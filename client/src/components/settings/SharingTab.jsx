import { useEffect, useState } from 'react';
import { Save, Loader2, Users, ShieldCheck, Network } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { getAuthStatus, getMediaShareCandidates, getSettings, listMusicEngines, updateSettings } from '../../services/api';

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const modelKey = ({ engine, modelId }) => `${engine}\u0000${modelId}`;

// Image and video share one shape: a flat candidate list from the server, each
// entry already carrying the readiness projection the wire status reports. Audio
// is not in this table — its picker is driven by the music-engine catalog, which
// nests models under engines.
// A model the operator already shares must stay visible even after it leaves
// the local catalog (uninstalled, or newly reported broken), or there is no
// checkbox left to un-share it and the provider keeps advertising a stale
// `unknown-model` entry forever. Mirrors the peer panel's `not-advertised` rows.
function candidateRows(candidates, selected) {
  const rows = [...candidates];
  const known = new Set(candidates.map(modelKey));
  for (const model of selected) {
    if (!model?.engine || !model.modelId || known.has(modelKey(model))) continue;
    rows.push({
      kind: null,
      engine: model.engine,
      modelId: model.modelId,
      modelName: model.modelId,
      ready: false,
      unavailableReason: 'no longer installed',
    });
  }
  return rows;
}

const VISUAL_KINDS = Object.freeze([
  { kind: 'image', label: 'image', field: 'imageModels' },
  { kind: 'video', label: 'video', field: 'videoModels' },
]);
const normalizeSelectedModels = (models) => Array.isArray(models)
  ? models.filter((model) => model && typeof model.engine === 'string' && typeof model.modelId === 'string')
    .map((model) => ({ ...model, engine: model.engine, modelId: model.modelId }))
  : [];
const stableModels = (models) => normalizeSelectedModels(models).map(modelKey).sort().join('\n');

function modelReady(engine, model) {
  if (!engine.runtimeReady || !engine.platformSupported) return false;
  if (engine.cudaRequired && engine.cudaState !== 'available') return false;
  if (engine.fixedModelInstall && engine.modelReadyById?.[model.id] !== true) return false;
  return true;
}

export function SharingTab() {
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [savedDisplayName, setSavedDisplayName] = useState('');
  const [savedBio, setSavedBio] = useState('');
  const [saving, setSaving] = useState(false);
  const [strictPull, setStrictPull] = useState(false);
  const [strictPullSaving, setStrictPullSaving] = useState(false);
  // The settings PATCH shallow-merges top-level keys, so `federation` is
  // replaced wholesale — carry the rest of the slice forward on every write.
  const [federationSettings, setFederationSettings] = useState({});
  const [authEnabled, setAuthEnabled] = useState(false);
  const [musicEngines, setMusicEngines] = useState([]);
  const [providerSettings, setProviderSettings] = useState({});
  const [providerEnabled, setProviderEnabled] = useState(false);
  const [providerMaxQueuedJobs, setProviderMaxQueuedJobs] = useState(2);
  const [providerModels, setProviderModels] = useState([]);
  // `null` per kind = the candidate list could not be fetched, which is NOT the
  // same as a genuinely empty local catalog — reporting "no models installed"
  // for a transient API failure would send the user hunting for a model they
  // already have.
  const [visualCandidates, setVisualCandidates] = useState({ image: null, video: null });
  const [providerVisualModels, setProviderVisualModels] = useState({ image: [], video: [] });
  const [savedProviderVisualModels, setSavedProviderVisualModels] = useState({ image: [], video: [] });
  const [savedProviderEnabled, setSavedProviderEnabled] = useState(false);
  const [savedProviderMaxQueuedJobs, setSavedProviderMaxQueuedJobs] = useState(2);
  const [savedProviderModels, setSavedProviderModels] = useState([]);
  const [providerSaving, setProviderSaving] = useState(false);

  useEffect(() => {
    // Engine health probes may spawn local Python checks on a cold cache. Load
    // them independently so the existing sharing controls do not wait on that
    // optional provider catalog.
    listMusicEngines({ silent: true })
      .then((music) => setMusicEngines(Array.isArray(music?.engines) ? music.engines : []))
      .catch(() => setMusicEngines([]));
    // Same rationale as the engine probe above: readiness inspection can touch
    // the model cache, so keep it off the critical path for the other controls.
    getMediaShareCandidates({ silent: true })
      .then((candidates) => setVisualCandidates({
        image: Array.isArray(candidates?.image) ? candidates.image : null,
        video: Array.isArray(candidates?.video) ? candidates.video : null,
      }))
      .catch(() => setVisualCandidates({ image: null, video: null }));
    Promise.all([
      getSettings({ silent: true }),
      getAuthStatus({ silent: true }).catch(() => ({ enabled: false })),
    ])
      .then(([settings, auth]) => {
        const display = settings?.sharingDisplayName || '';
        const b = settings?.sharingBio || '';
        setDisplayName(display);
        setBio(b);
        setSavedDisplayName(display);
        setSavedBio(b);
        const federation = settings?.federation && typeof settings.federation === 'object' ? settings.federation : {};
        setFederationSettings(federation);
        setStrictPull(federation.strictPullAuthorization === true);
        setAuthEnabled(auth?.enabled === true);
        const provider = federation.mediaProvider && typeof federation.mediaProvider === 'object'
          ? federation.mediaProvider
          : {};
        const enabled = provider.enabled === true;
        const maxQueuedJobs = Number.isInteger(provider.maxQueuedJobs) ? provider.maxQueuedJobs : 2;
        const models = normalizeSelectedModels(provider.audioModels);
        const visual = Object.fromEntries(VISUAL_KINDS.map(({ kind, field }) =>
          [kind, normalizeSelectedModels(provider[field])]));
        setProviderSettings(provider);
        setProviderEnabled(enabled);
        setProviderMaxQueuedJobs(maxQueuedJobs);
        setProviderModels(models);
        setSavedProviderEnabled(enabled);
        setSavedProviderMaxQueuedJobs(maxQueuedJobs);
        setSavedProviderModels(models);
        setProviderVisualModels(visual);
        setSavedProviderVisualModels(visual);
      })
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const dirty = displayName !== savedDisplayName || bio !== savedBio;
  const providerDirty = providerEnabled !== savedProviderEnabled
    || providerMaxQueuedJobs !== savedProviderMaxQueuedJobs
    || stableModels(providerModels) !== stableModels(savedProviderModels)
    || VISUAL_KINDS.some(({ kind }) =>
      stableModels(providerVisualModels[kind]) !== stableModels(savedProviderVisualModels[kind]));

  const handleSave = async () => {
    setSaving(true);
    const patch = {
      sharingDisplayName: displayName.trim(),
      sharingBio: bio.trim(),
    };
    const merged = await updateSettings(patch).catch(() => null);
    setSaving(false);
    if (!merged) return;
    setDisplayName(patch.sharingDisplayName);
    setBio(patch.sharingBio);
    setSavedDisplayName(patch.sharingDisplayName);
    setSavedBio(patch.sharingBio);
    toast.success('Saved');
  };

  const handleStrictPullToggle = async (next) => {
    setStrictPullSaving(true);
    // Same whole-slice replacement hazard as the provider save below.
    const fresh = await getSettings({ silent: true }).catch(() => null);
    const base = isRecord(fresh?.federation) ? fresh.federation : federationSettings;
    const federation = { ...base, strictPullAuthorization: next };
    const merged = await updateSettings({ federation }).catch(() => null);
    setStrictPullSaving(false);
    if (!merged) return;
    setFederationSettings(federation);
    setStrictPull(next);
    toast.success(next ? 'Strict pull authorization on' : 'Strict pull authorization off');
  };

  const toggleProviderModel = (engine, modelId, checked) => {
    const selected = { engine, modelId };
    const key = modelKey(selected);
    setProviderModels((current) => checked
      ? (current.some((model) => modelKey(model) === key) ? current : [...current, selected])
      : current.filter((model) => modelKey(model) !== key));
  };

  const toggleVisualModel = (kind, candidate, checked) => {
    const key = modelKey(candidate);
    setProviderVisualModels((current) => ({
      ...current,
      [kind]: checked
        ? (current[kind].some((model) => modelKey(model) === key)
          ? current[kind]
          : [...current[kind], { engine: candidate.engine, modelId: candidate.modelId }])
        : current[kind].filter((model) => modelKey(model) !== key),
    }));
  };

  const handleProviderSave = async () => {
    if (providerEnabled && !authEnabled) {
      toast.error('Enable an instance password before sharing media capacity');
      return;
    }
    const visualSelections = Object.fromEntries(VISUAL_KINDS.map(({ kind }) =>
      [kind, normalizeSelectedModels(providerVisualModels[kind])]));
    const totalSelected = providerModels.length
      + VISUAL_KINDS.reduce((sum, { kind }) => sum + visualSelections[kind].length, 0);
    if (providerEnabled && totalSelected === 0) {
      toast.error('Select at least one model to share');
      return;
    }
    const maxQueuedJobs = Math.max(1, Math.min(20, Number(providerMaxQueuedJobs) || 1));
    const mediaProvider = {
      ...providerSettings,
      enabled: providerEnabled,
      maxQueuedJobs,
      audioModels: normalizeSelectedModels(providerModels),
      ...Object.fromEntries(VISUAL_KINDS.map(({ kind, field }) => [field, visualSelections[kind]])),
    };
    setProviderSaving(true);
    // /api/settings replaces the top-level `federation` slice wholesale, so this
    // write has to carry everything else in it. Re-read immediately before
    // saving rather than trusting the mount-time snapshot: the Instances page
    // owns `mediaRouting`, and a Settings tab left open across a routing change
    // would otherwise write back the slice as it looked before, silently
    // clearing the route and sending unattended renders back to local.
    const fresh = await getSettings({ silent: true }).catch(() => null);
    const base = isRecord(fresh?.federation) ? fresh.federation : federationSettings;
    const federation = { ...base, mediaProvider };
    const merged = await updateSettings({ federation }, { silent: true }).catch(() => null);
    setProviderSaving(false);
    if (!merged) {
      toast.error('Failed to save media provider settings');
      return;
    }
    setFederationSettings(federation);
    setProviderSettings(mediaProvider);
    setProviderMaxQueuedJobs(maxQueuedJobs);
    setSavedProviderEnabled(providerEnabled);
    setSavedProviderMaxQueuedJobs(maxQueuedJobs);
    setSavedProviderModels(normalizeSelectedModels(providerModels));
    setSavedProviderVisualModels(visualSelections);
    toast.success(providerEnabled ? 'Media provider enabled' : 'Media provider disabled');
  };

  if (loading) return <BrailleSpinner />;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Users size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Sharing identity</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          This display name is stamped as the <em>source</em> on every share you send through the Sharing page.
          Recipients see it as attribution. Each bucket can override this with its own display name + bio.
        </p>
        <div className="space-y-3">
          <div>
            <label htmlFor="sharing-display-name" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Display name</label>
            <input
              id="sharing-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name (e.g. atomantic)"
              maxLength={120}
              className="w-full sm:max-w-md px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
          </div>
          <div>
            <label htmlFor="sharing-bio" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Bio (optional)</label>
            <textarea
              id="sharing-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Optional bio / contact note (visible to recipients)"
              maxLength={2000}
              rows={3}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm resize-y"
            />
          </div>
          <div>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Federation pull authorization</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Peers that pull records from this instance are identified by the instance id they send.
          By default a pull that your per-peer sharing settings would deny is still served, and logs a
          warning once per peer per restart — so peers running an older PortOS keep syncing.
          Turn this on to reject those pulls with a 403 instead. This default flips in a future release.
        </p>
        <label htmlFor="federation-strict-pull" className="flex items-start gap-3 cursor-pointer">
          <input
            id="federation-strict-pull"
            type="checkbox"
            checked={strictPull}
            disabled={strictPullSaving || providerSaving}
            onChange={(e) => handleStrictPullToggle(e.target.checked)}
            className="mt-1 h-4 w-4 accent-port-accent disabled:opacity-40"
          />
          <span className="text-sm text-white">
            Enforce per-peer sharing settings on pull requests
            {strictPullSaving && <Loader2 size={12} className="inline ml-2 animate-spin" />}
          </span>
        </label>
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Network size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Federated media provider</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Let registered PortOS peers submit allowlisted audio renders to this machine&apos;s durable media queue.
          Prompts and job details stay out of capability status, and completed downloads include a SHA-256 integrity hash.
        </p>

        {!authEnabled && (
          <div className="mb-4 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            An instance password is required for peer jobs. Configure one in the Security tab before enabling this provider.
          </div>
        )}

        <div className="space-y-4">
          <label htmlFor="federated-media-enabled" className="flex items-start gap-3 cursor-pointer">
            <input
              id="federated-media-enabled"
              type="checkbox"
              checked={providerEnabled}
              disabled={providerSaving || strictPullSaving || (!authEnabled && !providerEnabled)}
              onChange={(event) => setProviderEnabled(event.target.checked)}
              className="mt-1 h-4 w-4 accent-port-accent disabled:opacity-40"
            />
            <span className="text-sm text-white">Accept audio generation jobs from authenticated registered peers</span>
          </label>

          <div>
            <label htmlFor="federated-media-max-queued" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Shared active-job limit
            </label>
            <input
              id="federated-media-max-queued"
              type="number"
              min="1"
              max="20"
              value={providerMaxQueuedJobs}
              disabled={providerSaving || strictPullSaving}
              onChange={(event) => setProviderMaxQueuedJobs(Number(event.target.value))}
              className="w-28 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-40"
            />
            <p className="mt-1 text-xs text-gray-500">
              Remote admission stops when this many local and remote media jobs are already active.
            </p>
          </div>

          <fieldset>
            <legend className="block text-xs uppercase tracking-wider text-gray-500 mb-2">Allowed audio models</legend>
            {musicEngines.length === 0 ? (
              <p className="text-sm text-gray-500">The local music engine catalog is not available to configure.</p>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {musicEngines.map((engine, engineIndex) => (
                  <div key={engine.id} className="rounded border border-port-border bg-port-bg/40 p-3">
                    <div className="text-sm font-medium text-white mb-2">{engine.name}</div>
                    <div className="space-y-2">
                      {(engine.models || []).map((model, modelIndex) => {
                        const selection = { engine: engine.id, modelId: model.id };
                        const checked = providerModels.some((candidate) => modelKey(candidate) === modelKey(selection));
                        const ready = modelReady(engine, model);
                        const inputId = `federated-media-model-${engineIndex}-${modelIndex}`;
                        return (
                          <label key={model.id} htmlFor={inputId} className="flex items-start gap-2 text-sm cursor-pointer">
                            <input
                              id={inputId}
                              type="checkbox"
                              checked={checked}
                              disabled={providerSaving || strictPullSaving || (!ready && !checked)}
                              onChange={(event) => toggleProviderModel(engine.id, model.id, event.target.checked)}
                              className="mt-0.5 h-4 w-4 accent-port-accent disabled:opacity-40"
                            />
                            <span className={ready ? 'text-gray-200' : 'text-gray-500'}>
                              {model.name}{!ready && ' (not ready)'}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </fieldset>

          {VISUAL_KINDS.map(({ kind, label, field }) => {
            const unavailable = visualCandidates[kind] === null;
            const rows = candidateRows(visualCandidates[kind] || [], providerVisualModels[kind]);
            return (
            <fieldset key={field}>
              <legend className="block text-xs uppercase tracking-wider text-gray-500 mb-2">Allowed {label} models</legend>
              {rows.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {unavailable
                    ? `Could not load the local ${label} model list. Reload to try again.`
                    : `No local ${label} models are installed to share.`}
                </p>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  {rows.map((candidate, index) => {
                    const checked = providerVisualModels[kind].some((model) => modelKey(model) === modelKey(candidate));
                    const inputId = `federated-media-${kind}-model-${index}`;
                    return (
                      <label key={modelKey(candidate)} htmlFor={inputId} className="flex items-start gap-2 text-sm cursor-pointer">
                        <input
                          id={inputId}
                          type="checkbox"
                          checked={checked}
                          // An already-shared model stays togglable even when it
                          // reports not-ready, or a model that broke after being
                          // shared could never be un-shared.
                          disabled={providerSaving || strictPullSaving || (!candidate.ready && !checked)}
                          onChange={(event) => toggleVisualModel(kind, candidate, event.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-port-accent disabled:opacity-40"
                        />
                        <span className={candidate.ready ? 'text-gray-200' : 'text-gray-500'}>
                          {candidate.modelName}
                          {!candidate.ready && ` (${candidate.unavailableReason || 'not ready'})`}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
            );
          })}

          <button
            type="button"
            onClick={handleProviderSave}
            disabled={!providerDirty || providerSaving || strictPullSaving
              || (providerEnabled && (!authEnabled || (providerModels.length === 0
                && VISUAL_KINDS.every(({ kind }) => providerVisualModels[kind].length === 0))))}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {providerSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {providerSaving ? 'Saving...' : 'Save provider'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SharingTab;
