import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Orbit, RotateCcw, Settings } from 'lucide-react';
import { Link } from 'react-router';
import PageHeader from '../components/PageHeader';
import BrailleSpinner from '../components/BrailleSpinner';
import {
  getApp,
  getEidoverseWorldStatus,
  getInstanceFeatures,
  projectEidoverseWorld,
  startApp,
  startEidoverseHost,
  updateEidoverseWorldConfig,
} from '../services/api';

const silent = { silent: true };
const RUNNING_STATUSES = new Set(['online', 'launching', 'unknown']);

const failedStart = (result) => Object.values(result?.results || {})
  .find((entry) => entry?.success === false);

export const hostUrlFor = (host, setup, location = window.location, identity = null) => {
  let baseUrl;
  if (location.protocol === 'https:') {
    if (host.protocol !== 'https') {
      throw new Error('PortOS is using HTTPS, but the Eidoverse host could not load the shared certificate.');
    }
    baseUrl = `https://${location.hostname}:${host.port}/`;
  } else {
    baseUrl = `http://${location.hostname}:${setup.uiPort}/`;
  }
  if (!identity) return baseUrl;

  const url = new URL(baseUrl);
  if (identity.world) url.searchParams.set('world', identity.world);
  if (identity.name) url.searchParams.set('name', identity.name);
  if (identity.avatar) url.searchParams.set('avatar', identity.avatar);
  return url.toString();
};

const RECIPE_INCLUDE_KEYS = [
  'apps',
  'agents',
  'tasks',
  'features',
  'peers',
  'health',
  'productivity',
  'activity',
  'goals',
  'memory',
  'storage',
  'jira',
  'operations',
];

const RECIPE_KIND_BY_SOURCE = {
  apps: 'app',
  agents: 'agent',
  tasks: 'task',
  features: 'feature',
  peers: 'peer',
  health: 'health',
  productivity: 'productivity',
  activity: 'activity',
  goals: 'goal',
  memory: 'memory',
  storage: 'storage',
  jira: 'jira',
  operations: 'operations',
};

const RECIPE_LAYOUT_KEYS = ['spacing', 'laneGap', 'columns'];
const RECIPE_TERRAIN_KEYS = ['size', 'segments', 'amplitude', 'flatRadius'];
// Mirror the server's case-insensitive, slash-normalized path contract. HTML
// patterns have no flag syntax, so spell out the case-insensitive prefixes and
// accept either path separator explicitly.
const EIDOVERSE_ASSET_PATTERN = '(?:[Ee][Ii][Dd][Oo][Vv][Ee][Rr][Ss][Ee]|[Ss][Tt][Oo][Rr][Ee])[\\\\/](?!.*\\.\\.).*';

const worldIdentityFor = (world) => ({
  world: world?.world,
  name: world?.identity?.name || world?.human?.name,
  avatar: world?.identity?.avatar || world?.human?.avatar,
});

export default function Eidoverse() {
  const requestGeneration = useRef(0);
  const configDraftRevision = useRef(0);
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [hostUrl, setHostUrl] = useState('');
  const [hostInfo, setHostInfo] = useState(null);
  const [setupState, setSetupState] = useState(null);
  const [appId, setAppId] = useState(null);
  const [worldState, setWorldState] = useState(null);
  const [worldName, setWorldName] = useState('');
  const [humanName, setHumanName] = useState('');
  const [recipeDraft, setRecipeDraft] = useState(null);
  const [projectionStatus, setProjectionStatus] = useState('idle');
  const [projectionError, setProjectionError] = useState('');
  const [configStatus, setConfigStatus] = useState('');

  const prepare = useCallback(() => {
    const generation = ++requestGeneration.current;
    const isCurrent = () => requestGeneration.current === generation;
    const updatePhase = (next) => { if (isCurrent()) setPhase(next); };

    setPhase('loading');
    setError('');
    setHostUrl('');
    setHostInfo(null);
    setSetupState(null);
    setWorldState(null);
    setRecipeDraft(null);
    setProjectionStatus('idle');
    setProjectionError('');
    setConfigStatus('');
    configDraftRevision.current = 0;

    const load = async () => {
      const featureState = await getInstanceFeatures(silent);
      const feature = featureState.features?.find((entry) => entry.id === 'eidoverse');
      const setup = feature?.setup;
      if (!setup?.installed) return { phase: 'setup', appId: setup?.appId || null };
      if (!setup.appId) throw new Error('Eidoverse is installed but its managed-app record is unavailable.');

      const app = await getApp(setup.appId, silent);
      if (!RUNNING_STATUSES.has(app.overallStatus)) {
        updatePhase('starting');
        const result = await startApp(setup.appId, silent);
        const failure = failedStart(result);
        if (failure) throw new Error(failure.error || 'PortOS could not start Eidoverse Worlds.');
      }

      updatePhase('connecting');
      const host = await startEidoverseHost(silent);
      if (!host?.running) throw new Error('The Eidoverse host did not start.');
      const world = await getEidoverseWorldStatus(silent);
      return {
        phase: 'ready',
        appId: setup.appId,
        setup,
        host,
        world,
        hostUrl: hostUrlFor(host, setup, window.location, worldIdentityFor(world)),
      };
    };

    load().then((result) => {
      if (!isCurrent()) return;
      setPhase(result.phase);
      setAppId(result.appId);
      setSetupState(result.setup || null);
      setHostInfo(result.host || null);
      setWorldState(result.world || null);
      setWorldName(result.world?.world || '');
      setHumanName(result.world?.identity?.name || result.world?.human?.name || '');
      setRecipeDraft(result.world?.recipe || null);
      setHostUrl(result.hostUrl || '');
    }, (reason) => {
      if (!isCurrent()) return;
      setPhase('error');
      setError(reason?.message || 'Eidoverse Worlds could not be loaded.');
    });
  }, []);

  const runProjection = useCallback(async () => {
    setProjectionStatus('running');
    setProjectionError('');
    try {
      const result = await projectEidoverseWorld(silent);
      setWorldState((current) => current
        ? {
          ...current,
          projection: result.projection || current.projection,
          presence: result.presence || current.presence,
        }
        : current);
      setProjectionStatus('complete');
      return result;
    } catch (reason) {
      setProjectionStatus('error');
      setProjectionError(reason?.message || 'PortOS could not project its current state into Eidoverse.');
      throw reason;
    }
  }, []);

  useEffect(() => {
    if (phase !== 'ready' || !hostUrl) return undefined;
    void runProjection().catch(() => {});
    return undefined;
  }, [phase, hostUrl, runProjection]);

  const saveWorldConfig = useCallback(async () => {
    if (!recipeDraft) return;
    const submittedRevision = configDraftRevision.current;
    setConfigStatus('saving');
    let updated;
    try {
      updated = await updateEidoverseWorldConfig({
        world: worldName.trim(),
        humanName: humanName.trim() || null,
        recipe: recipeDraft,
      }, silent);
      setWorldState((current) => current
        ? { ...current, ...updated, identity: updated.human }
        : current);
      if (configDraftRevision.current === submittedRevision) {
        setWorldName(updated.world || '');
        setHumanName(updated.human?.name || '');
        setRecipeDraft(updated.recipe || recipeDraft);
        setConfigStatus('saved');
      } else {
        setConfigStatus('');
      }
    } catch (reason) {
      setConfigStatus(reason?.message || 'Could not save the Eidoverse world configuration.');
      return;
    }

    const nextHostUrl = hostInfo && setupState
      ? hostUrlFor(hostInfo, setupState, window.location, worldIdentityFor(updated))
      : hostUrl;
    if (nextHostUrl !== hostUrl) setHostUrl(nextHostUrl);
    else void runProjection().catch(() => {});
  }, [humanName, hostInfo, hostUrl, recipeDraft, runProjection, setupState, worldName]);

  const markConfigDirty = () => {
    configDraftRevision.current += 1;
    setConfigStatus((current) => current === 'saving' ? current : '');
  };

  const toggleRecipeInclude = (key) => {
    markConfigDirty();
    setRecipeDraft((current) => current
      ? { ...current, includes: { ...current.includes, [key]: !current.includes[key] } }
      : current);
  };

  const updateRecipeLimit = (key, value) => {
    markConfigDirty();
    setRecipeDraft((current) => current
      ? { ...current, limits: { ...current.limits, [key]: value === '' ? 0 : Number(value) } }
      : current);
  };

  const updateRecipeNumber = (section, key, value) => {
    markConfigDirty();
    setRecipeDraft((current) => current
      ? {
        ...current,
        [section]: {
          ...current[section],
          [key]: value === '' ? '' : Number(value),
        },
      }
      : current);
  };

  const updateRecipeText = (section, key, value) => {
    markConfigDirty();
    setRecipeDraft((current) => current
      ? { ...current, [section]: { ...current[section], [key]: value } }
      : current);
  };

  const updateRecipeOrigin = (index, value) => {
    markConfigDirty();
    setRecipeDraft((current) => current
      ? {
        ...current,
        layout: {
          ...current.layout,
          origin: current.layout?.origin?.map((part, partIndex) => partIndex === index
            ? (value === '' ? '' : Number(value))
            : part) || [0, 0, 0],
        },
      }
      : current);
  };

  const updateRecipeAsset = (sourceKey, value) => {
    const kind = RECIPE_KIND_BY_SOURCE[sourceKey];
    markConfigDirty();
    setRecipeDraft((current) => kind && current
      ? { ...current, assets: { ...current.assets, [kind]: value } }
      : current);
  };

  useEffect(() => {
    prepare();
    return () => { requestGeneration.current += 1; };
  }, [prepare]);

  const actions = (
    <>
      {hostUrl && (
        <a
          href={hostUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white"
        >
          <ExternalLink size={15} aria-hidden="true" />
          Open full screen
        </a>
      )}
      {appId && (
        <Link
          to={`/apps/${appId}/overview`}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white"
        >
          <Settings size={15} aria-hidden="true" />
          Manage app
        </Link>
      )}
    </>
  );

  const worldControls = phase === 'ready' && worldState && recipeDraft ? (
    <div className="max-h-[55vh] shrink-0 overflow-y-auto overscroll-contain border-b border-port-border bg-port-bg px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-300">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="rounded-full border border-port-accent/40 px-2 py-0.5 text-port-accent">Private PortOS world</span>
          <span>World: <span className="text-white">{worldState.world}</span></span>
          <span>User: <span className="text-white">{worldState.identity?.name || 'not configured'}</span></span>
          <span>CoS: <span className="text-white">{worldState.presence?.connected ? 'connected' : 'ready to reconnect'}</span>{worldState.presence?.role ? ` · ${worldState.presence.role}` : ''}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void runProjection().catch(() => {}); }}
            disabled={projectionStatus === 'running'}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-port-border px-2.5 py-1.5 text-gray-200 transition-colors hover:border-port-accent hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            <RotateCcw size={14} aria-hidden="true" />
            {projectionStatus === 'running' ? 'Projecting…' : 'Project PortOS now'}
          </button>
          <Link
            to="/cos/jobs"
            className="inline-flex min-h-[36px] items-center rounded-lg border border-port-border px-2.5 py-1.5 text-gray-200 transition-colors hover:border-port-accent hover:text-white"
          >
            CoS tasks
          </Link>
        </div>
      </div>
      {projectionError && (
        <p className="mt-1 text-xs text-port-error" role="status">{projectionError}</p>
      )}
      <details className="mt-2 text-xs text-gray-300">
        <summary className="cursor-pointer text-gray-400 hover:text-white">World identity and projection recipe</summary>
        <form
          className="mt-3 grid gap-3 rounded-lg border border-port-border bg-port-card p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end"
          onSubmit={(event) => { event.preventDefault(); void saveWorldConfig(); }}
        >
          <label className="flex flex-col gap-1" htmlFor="eidoverse-world-name">
            <span className="text-gray-400">World name</span>
            <input
              id="eidoverse-world-name"
              value={worldName}
              onChange={(event) => {
                markConfigDirty();
                setWorldName(event.target.value);
              }}
              className="min-h-[36px] rounded border border-port-border bg-port-bg px-2 text-sm text-white"
              maxLength={64}
              pattern="[A-Za-z0-9_-]+"
              required
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor="eidoverse-human-name">
            <span className="text-gray-400">My Eidoverse name</span>
            <input
              id="eidoverse-human-name"
              value={humanName}
              onChange={(event) => {
                markConfigDirty();
                setHumanName(event.target.value);
              }}
              className="min-h-[36px] rounded border border-port-border bg-port-bg px-2 text-sm text-white"
              maxLength={64}
              placeholder="Clear to use the persistent PortOS instance identity"
            />
          </label>
          <button
            type="submit"
            disabled={configStatus === 'saving'}
            className="inline-flex min-h-[36px] items-center justify-center rounded-lg bg-port-accent px-3 py-1.5 font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {configStatus === 'saving' ? 'Saving…' : 'Save and project'}
          </button>
          <fieldset className="sm:col-span-3">
            <legend className="mb-1 text-gray-400">Draw PortOS resources</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {RECIPE_INCLUDE_KEYS.map((key) => (
                <label key={key} className="inline-flex items-center gap-1.5 capitalize">
                  <input
                    type="checkbox"
                    checked={recipeDraft.includes?.[key] === true}
                    onChange={() => toggleRecipeInclude(key)}
                  />
                  {key}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="sm:col-span-3">
            <legend className="mb-1 text-gray-400">Per-resource caps</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {RECIPE_INCLUDE_KEYS.map((key) => (
                <label key={key} className="flex flex-col gap-1 capitalize" htmlFor={`eidoverse-limit-${key}`}>
                  <span className="text-gray-500">{key}</span>
                  <input
                    id={`eidoverse-limit-${key}`}
                    type="number"
                    min="0"
                    max="100"
                    required
                    value={recipeDraft.limits?.[key] ?? ''}
                    onChange={(event) => updateRecipeLimit(key, event.target.value)}
                    className="min-h-[34px] rounded border border-port-border bg-port-bg px-2 text-sm text-white"
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="sm:col-span-3">
            <legend className="mb-1 text-gray-400">World layout</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {RECIPE_LAYOUT_KEYS.map((key) => (
                <label key={key} className="flex flex-col gap-1 capitalize" htmlFor={`eidoverse-layout-${key}`}>
                  <span className="text-gray-500">{key}</span>
                  <input
                    id={`eidoverse-layout-${key}`}
                    type="number"
                    min={key === 'columns' ? 1 : 2}
                    max={key === 'columns' ? 32 : 100}
                    step={key === 'columns' ? 1 : 'any'}
                    required
                    value={recipeDraft.layout?.[key] ?? ''}
                    onChange={(event) => updateRecipeNumber('layout', key, event.target.value)}
                    className="min-h-[34px] rounded border border-port-border bg-port-bg px-2 text-sm text-white"
                  />
                </label>
              ))}
              {['x', 'y', 'z'].map((axis, index) => (
                <label key={axis} className="flex flex-col gap-1" htmlFor={`eidoverse-origin-${axis}`}>
                  <span className="text-gray-500">Origin {axis}</span>
                  <input
                    id={`eidoverse-origin-${axis}`}
                    type="number"
                    step="any"
                    required
                    value={recipeDraft.layout?.origin?.[index] ?? ''}
                    onChange={(event) => updateRecipeOrigin(index, event.target.value)}
                    className="min-h-[34px] rounded border border-port-border bg-port-bg px-2 text-sm text-white"
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="sm:col-span-3">
            <legend className="mb-1 text-gray-400">Models and scales</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {RECIPE_INCLUDE_KEYS.map((sourceKey) => {
                const kind = RECIPE_KIND_BY_SOURCE[sourceKey];
                return (
                  <div key={sourceKey} className="rounded border border-port-border/70 p-2">
                    <span className="capitalize text-gray-400">{sourceKey}</span>
                    <label className="mt-1 flex flex-col gap-1" htmlFor={`eidoverse-asset-${kind}`}>
                      <span className="text-gray-500">Asset path</span>
                      <input
                        id={`eidoverse-asset-${kind}`}
                        value={recipeDraft.assets?.[kind] ?? ''}
                        onChange={(event) => updateRecipeAsset(sourceKey, event.target.value)}
                        className="min-h-[34px] rounded border border-port-border bg-port-bg px-2 text-xs text-white"
                        maxLength={512}
                        pattern={EIDOVERSE_ASSET_PATTERN}
                        required
                      />
                    </label>
                    <label className="mt-1 flex items-center gap-2" htmlFor={`eidoverse-scale-${kind}`}>
                      <span className="text-gray-500">Scale</span>
                      <input
                        id={`eidoverse-scale-${kind}`}
                        type="number"
                        min="0"
                        max="20"
                        step="any"
                        required
                        value={recipeDraft.scale?.[kind] ?? ''}
                        onChange={(event) => {
                          event.currentTarget.setCustomValidity(
                            event.currentTarget.valueAsNumber > 0 ? '' : 'Scale must be greater than zero.',
                          );
                          updateRecipeNumber('scale', kind, event.target.value);
                        }}
                        className="min-h-[32px] w-24 rounded border border-port-border bg-port-bg px-2 text-xs text-white"
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="sm:col-span-3">
            <legend className="mb-1 text-gray-400">Procedural terrain</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <label className="flex flex-col gap-1" htmlFor="eidoverse-terrain-seed">
                <span className="text-gray-500">Seed</span>
                <input
                  id="eidoverse-terrain-seed"
                  value={recipeDraft.terrain?.seed ?? ''}
                  onChange={(event) => updateRecipeText('terrain', 'seed', event.target.value)}
                  className="min-h-[34px] rounded border border-port-border bg-port-bg px-2 text-sm text-white"
                  maxLength={64}
                  required
                />
              </label>
              {RECIPE_TERRAIN_KEYS.map((key) => (
                <label key={key} className="flex flex-col gap-1 capitalize" htmlFor={`eidoverse-terrain-${key}`}>
                  <span className="text-gray-500">{key}</span>
                  <input
                    id={`eidoverse-terrain-${key}`}
                    type="number"
                    min={key === 'segments' ? 2 : (key === 'size' ? 0.01 : 0)}
                    max={key === 'amplitude' ? 100 : (key === 'flatRadius' ? 256 : 512)}
                    step={key === 'segments' ? 1 : 'any'}
                    required
                    value={recipeDraft.terrain?.[key] ?? ''}
                    onChange={(event) => updateRecipeNumber('terrain', key, event.target.value)}
                    className="min-h-[34px] rounded border border-port-border bg-port-bg px-2 text-sm text-white"
                  />
                </label>
              ))}
            </div>
          </fieldset>
          {configStatus && configStatus !== 'saving' && (
            <p className="sm:col-span-3 text-xs text-gray-400" role="status">
              {configStatus === 'saved' ? 'Saved locally.' : configStatus}
            </p>
          )}
        </form>
      </details>
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      <PageHeader
        icon={Orbit}
        title="Eidoverse Worlds"
        subtitle="A shared 3D world for you and your agents"
        actions={actions}
        className="bg-port-bg"
      />

      {worldControls}

      {phase === 'ready' && (
        <iframe
          src={hostUrl}
          title="Eidoverse Worlds"
          className="min-h-0 w-full flex-1 border-0 bg-black"
          allow="camera; microphone; fullscreen; gamepad; xr-spatial-tracking"
          allowFullScreen
        />
      )}

      {['loading', 'starting', 'connecting'].includes(phase) && (
        <div className="flex flex-1 items-center justify-center p-6" role="status">
          <BrailleSpinner
            text={phase === 'starting'
              ? 'Starting Eidoverse Worlds'
              : (phase === 'connecting' ? 'Connecting to Eidoverse Worlds' : 'Loading Eidoverse Worlds')}
          />
        </div>
      )}

      {phase === 'setup' && (
        <div className="flex flex-1 items-center justify-center p-6">
          <section className="max-w-lg rounded-xl border border-port-border bg-port-card p-6 text-center">
            <Orbit className="mx-auto mb-3 h-10 w-10 text-port-accent" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-white">Install Eidoverse Worlds</h2>
            <p className="mt-2 text-sm text-gray-400">
              Install and enable the managed app from PortOS Features before opening this world.
            </p>
            <Link
              to="/settings/features"
              className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
            >
              <Settings size={16} aria-hidden="true" />
              Open Features
            </Link>
          </section>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex flex-1 items-center justify-center p-6">
          <section className="max-w-lg rounded-xl border border-port-error/50 bg-port-card p-6 text-center" role="alert">
            <h2 className="text-lg font-semibold text-white">Eidoverse Worlds did not load</h2>
            <p className="mt-2 text-sm text-port-error">{error}</p>
            <button
              type="button"
              onClick={prepare}
              className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
            >
              <RotateCcw size={16} aria-hidden="true" />
              Retry
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
