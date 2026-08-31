import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Orbit,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { Link } from 'react-router';
import PageHeader from '../components/PageHeader';
import BrailleSpinner from '../components/BrailleSpinner';
import EidoverseWorldDrawer from '../components/eidoverse/EidoverseWorldDrawer';
import {
  EIDOVERSE_SOURCE_KIND as SOURCE_KIND,
  eidoverseResetAssetSlotsForDistrict,
} from '../lib/eidoverseWorldReset';
import {
  getApp,
  getEidoverseWorldProjectionStatus,
  getEidoverseWorldStatus,
  getInstanceFeatures,
  projectEidoverseWorld,
  startApp,
  startEidoverseHost,
  updateEidoverseWorldConfig,
} from '../services/api';

const silent = { silent: true };
const RUNNING_STATUSES = new Set(['online', 'launching', 'unknown']);
const FRESH_WORLD_VISIBLE_CHECKPOINTS = new Set([
  'environment-complete',
  'applying-infrastructure',
  'infrastructure-complete',
  'applying-live',
  'live-complete',
  'applying-ambient',
  'ambient-complete',
  'applying-reconciliation',
  'reconciliation-complete',
  'projection-committed',
]);

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

const worldIdentityFor = (world) => ({
  world: world?.world,
  name: world?.identity?.name || world?.human?.name,
  avatar: world?.identity?.avatar || world?.human?.avatar,
});

const statusTone = (status) => {
  if (status === 'complete') return 'border-port-success/45 bg-port-success/10 text-port-success';
  if (status === 'failed') return 'border-port-error/45 bg-port-error/10 text-port-error';
  return 'border-port-accent/45 bg-port-accent/10 text-port-accent';
};

const DELETE_DRAFT_VALUE = Symbol('delete-draft-value');
const isDraftRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const draftValuesEqual = (left, right) => Object.is(left, right)
  || JSON.stringify(left) === JSON.stringify(right);
function mergeServerDraftChanges(current, submitted, before, after) {
  if (draftValuesEqual(before, after)) return current;
  if (isDraftRecord(current) && isDraftRecord(submitted)
    && isDraftRecord(before) && isDraftRecord(after)) {
    const merged = { ...current };
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (draftValuesEqual(before[key], after[key])) continue;
      const value = mergeServerDraftChanges(current[key], submitted[key], before[key], after[key]);
      if (value === DELETE_DRAFT_VALUE) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }
  if (!draftValuesEqual(current, submitted)) return current;
  return after === undefined ? DELETE_DRAFT_VALUE : structuredClone(after);
}

const reconcileActionDraft = (current, submitted, before, after) => {
  const merged = mergeServerDraftChanges(current, submitted, before, after);
  return merged === DELETE_DRAFT_VALUE ? {} : merged;
};

function mergeSubmittedKeys(current = {}, submitted = {}, after = {}, keys = []) {
  const merged = { ...current };
  for (const key of keys) {
    if (!draftValuesEqual(current?.[key], submitted?.[key])) continue;
    if (Object.hasOwn(after || {}, key)) merged[key] = structuredClone(after[key]);
    else delete merged[key];
  }
  return merged;
}

function reconcileResetRecipe(current, submitted, after, reset) {
  if (reset.scope === 'all') {
    return reconcileActionDraft(current, submitted, submitted, after);
  }
  if (reset.scope === 'assets') {
    const keys = new Set([
      ...Object.keys(current?.assets || {}),
      ...Object.keys(submitted?.assets || {}),
      ...Object.keys(after?.assets || {}),
    ]);
    return {
      ...current,
      assets: mergeSubmittedKeys(current?.assets, submitted?.assets, after?.assets, keys),
    };
  }
  const district = after?.districts?.find(({ id }) => id === reset.districtId);
  const sources = district?.sources || [];
  const kinds = sources.map((source) => SOURCE_KIND[source]).filter(Boolean);
  const slots = eidoverseResetAssetSlotsForDistrict(reset.districtId, sources);
  return {
    ...current,
    includes: mergeSubmittedKeys(current?.includes, submitted?.includes, after?.includes, sources),
    limits: mergeSubmittedKeys(current?.limits, submitted?.limits, after?.limits, sources),
    scale: mergeSubmittedKeys(current?.scale, submitted?.scale, after?.scale, kinds),
    assets: mergeSubmittedKeys(current?.assets, submitted?.assets, after?.assets, slots),
  };
}

function reconcileResetAssetOverrides(current, submitted, after, reset, sources = []) {
  if (reset.scope === 'all' || reset.scope === 'assets') {
    return reconcileActionDraft(current, submitted, submitted, after);
  }
  return mergeSubmittedKeys(
    current,
    submitted,
    after,
    eidoverseResetAssetSlotsForDistrict(reset.districtId, sources),
  );
}

export default function Eidoverse() {
  const requestGeneration = useRef(0);
  const configDraftRevision = useRef(0);
  const savedDraftRevision = useRef(0);
  const projectionPollGeneration = useRef(0);
  const projectionPollTimer = useRef(null);
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
  const [assetOverridesDraft, setAssetOverridesDraft] = useState({});
  const [projectionStatus, setProjectionStatus] = useState('idle');
  const [projectionError, setProjectionError] = useState('');
  const [configStatus, setConfigStatus] = useState('');
  const [draftDirty, setDraftDirty] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);

  const applyWorldResponse = useCallback((updated, { replaceDraft = true } = {}) => {
    setWorldState((current) => current
      ? { ...current, ...updated, identity: updated.identity || updated.human || current.identity }
      : updated);
    if (replaceDraft) {
      if (updated?.recipe) setRecipeDraft(updated.recipe);
      setAssetOverridesDraft(updated?.design?.userOverrides?.assets || {});
      if (updated?.world) setWorldName(updated.world);
      if (updated?.identity?.name || updated?.human?.name) setHumanName(updated.identity?.name || updated.human.name);
      savedDraftRevision.current = configDraftRevision.current;
      setDraftDirty(false);
    }
  }, []);

  const prepare = useCallback(() => {
    const generation = ++requestGeneration.current;
    const isCurrent = () => requestGeneration.current === generation;
    const updatePhase = (next) => { if (isCurrent()) setPhase(next); };

    setPhase('loading');
    setError('');
    setHostUrl('');
    setHostInfo(null);
    setIframeReady(false);
    setSetupState(null);
    setWorldState(null);
    setRecipeDraft(null);
    setAssetOverridesDraft({});
    setProjectionStatus('idle');
    setProjectionError('');
    setConfigStatus('');
    setDraftDirty(false);
    configDraftRevision.current = 0;
    savedDraftRevision.current = 0;

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
      setAssetOverridesDraft(result.world?.design?.userOverrides?.assets || {});
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
    const submittedRevision = configDraftRevision.current;
    const submittedDraftWasClean = submittedRevision === savedDraftRevision.current;
    const pollGeneration = ++projectionPollGeneration.current;
    const poll = () => {
      if (projectionPollGeneration.current !== pollGeneration) return;
      getEidoverseWorldProjectionStatus(silent).then((status) => {
        if (projectionPollGeneration.current !== pollGeneration) return;
        setWorldState((current) => current ? {
          ...current,
          projection: status.projection || current.projection,
          design: status.design ? { ...current.design, ...status.design } : current.design,
        } : current);
      }).catch(() => {}).finally(() => {
        if (projectionPollGeneration.current === pollGeneration) {
          projectionPollTimer.current = setTimeout(poll, 750);
        }
      });
    };
    projectionPollTimer.current = setTimeout(poll, 750);
    return projectEidoverseWorld(silent).then((result) => {
      const replaceDraft = submittedDraftWasClean
        && configDraftRevision.current === submittedRevision;
      setWorldState((current) => current ? {
        ...current,
        projection: result.projection || current.projection,
        presence: result.presence || current.presence,
        design: result.design || current.design,
        recipe: result.recipe || current.recipe,
      } : current);
      if (replaceDraft && result.recipe) {
        setRecipeDraft(result.recipe);
        setAssetOverridesDraft(result.design?.userOverrides?.assets || {});
      }
      setProjectionStatus('complete');
      return result;
    }, async (reason) => {
      setProjectionStatus('error');
      setProjectionError(reason?.message || 'PortOS could not project its current state into Eidoverse.');
      const failedStatus = await getEidoverseWorldStatus(silent).catch(() => null);
      if (failedStatus) applyWorldResponse(failedStatus, { replaceDraft: false });
      throw reason;
    }).finally(() => {
      if (projectionPollGeneration.current === pollGeneration) {
        projectionPollGeneration.current += 1;
        clearTimeout(projectionPollTimer.current);
        projectionPollTimer.current = null;
      }
    });
  }, [applyWorldResponse]);

  useEffect(() => {
    if (phase !== 'ready' || !hostUrl) return undefined;
    void runProjection().catch(() => {});
    return undefined;
  }, [phase, hostUrl, runProjection]);

  useEffect(() => {
    prepare();
    return () => {
      requestGeneration.current += 1;
      projectionPollGeneration.current += 1;
      clearTimeout(projectionPollTimer.current);
    };
  }, [prepare]);

  const markConfigDirty = useCallback(() => {
    configDraftRevision.current += 1;
    setDraftDirty(true);
    setConfigStatus((current) => current === 'saving' ? current : '');
  }, []);

  const mutateRecipe = useCallback((mutator) => {
    markConfigDirty();
    setRecipeDraft((current) => current ? mutator(current) : current);
  }, [markConfigDirty]);

  const mutateAssetOverride = useCallback((slot, path) => {
    markConfigDirty();
    setAssetOverridesDraft((current) => {
      const next = { ...current };
      if (path.trim()) next[slot] = path;
      else delete next[slot];
      return next;
    });
  }, [markConfigDirty]);

  const saveWorldConfig = useCallback(async () => {
    if (!recipeDraft) return;
    const submittedRevision = configDraftRevision.current;
    setConfigStatus('saving');
    const updated = await updateEidoverseWorldConfig({
      world: worldName.trim(),
      humanName: humanName.trim() || null,
      recipe: recipeDraft,
      assetOverrides: assetOverridesDraft,
    }, silent).catch((reason) => {
      setConfigStatus(reason?.message || 'Could not save the Eidoverse world configuration.');
      return null;
    });
    if (!updated) return;

    const draftIsCurrent = configDraftRevision.current === submittedRevision;
    applyWorldResponse(updated, { replaceDraft: draftIsCurrent });
    setConfigStatus(draftIsCurrent ? 'saved' : '');
    const nextHostUrl = hostInfo && setupState
      ? hostUrlFor(hostInfo, setupState, window.location, worldIdentityFor(updated))
      : hostUrl;
    if (nextHostUrl !== hostUrl) setHostUrl(nextHostUrl);
    else void runProjection().catch(() => {});
  }, [applyWorldResponse, assetOverridesDraft, hostInfo, hostUrl, humanName, recipeDraft, runProjection, setupState, worldName]);

  const runConfigAction = useCallback(async (payload) => {
    const submittedRevision = configDraftRevision.current;
    const submittedDraftWasClean = submittedRevision === savedDraftRevision.current;
    const submittedRecipeDraft = recipeDraft;
    const submittedAssetOverrides = assetOverridesDraft;
    const serverRecipeBeforeAction = worldState?.recipe;
    const serverAssetOverridesBefore = worldState?.design?.userOverrides?.assets || {};
    setConfigStatus('saving');
    const updated = await updateEidoverseWorldConfig(payload, silent).catch((reason) => {
      setConfigStatus(reason?.message || 'Could not update the Eidoverse world configuration.');
      return null;
    });
    if (!updated) return;
    const draftIsCurrent = configDraftRevision.current === submittedRevision;
    const replaceDraft = draftIsCurrent
      && (submittedDraftWasClean || payload.reset?.scope === 'all');
    if (replaceDraft) configDraftRevision.current += 1;
    applyWorldResponse(updated, { replaceDraft });
    if (!replaceDraft && payload.reset) {
      if (updated.recipe) {
        setRecipeDraft((current) => reconcileResetRecipe(
          current,
          submittedRecipeDraft,
          updated.recipe,
          payload.reset,
        ));
      }
      setAssetOverridesDraft((current) => reconcileResetAssetOverrides(
        current,
        submittedAssetOverrides,
        updated.design?.userOverrides?.assets || {},
        payload.reset,
        updated.recipe?.districts?.find(({ id }) => id === payload.reset.districtId)?.sources,
      ));
    } else if (!replaceDraft && payload.refreshAssets) {
      if (updated.recipe) {
        setRecipeDraft((current) => reconcileActionDraft(
          current,
          submittedRecipeDraft,
          serverRecipeBeforeAction,
          updated.recipe,
        ));
      }
      setAssetOverridesDraft((current) => reconcileActionDraft(
        current,
        submittedAssetOverrides,
        serverAssetOverridesBefore,
        updated.design?.userOverrides?.assets || {},
      ));
    }
    setConfigStatus(replaceDraft ? 'saved' : '');
    void runProjection().catch(() => {});
  }, [applyWorldResponse, assetOverridesDraft, recipeDraft, runProjection, worldState]);

  const actions = (
    <>
      {hostUrl && (
        <a href={hostUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white">
          <ExternalLink size={15} aria-hidden="true" />
          Open full screen
        </a>
      )}
      {appId && (
        <Link to={`/apps/${appId}/overview`} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white">
          <Settings size={15} aria-hidden="true" />
          Manage app
        </Link>
      )}
    </>
  );

  const design = worldState?.design || {};
  const reconciliation = design.reconciliation || {};
  const summary = worldState?.projection?.lastSummary || {};
  const projectionProgress = reconciliation.operationCount > 0
    ? `${Math.min(reconciliation.appliedOperations || 0, reconciliation.operationCount)}/${reconciliation.operationCount}`
    : null;
  const freshWorldLighting = projectionStatus === 'running'
    && design.lastAppliedVersion == null
    && !FRESH_WORLD_VISIBLE_CHECKPOINTS.has(reconciliation.checkpoint);
  const showLoadingCurtain = !iframeReady || freshWorldLighting;

  return (
    <div className="flex h-full min-h-0 flex-col bg-port-bg">
      <PageHeader
        icon={Orbit}
        title="Eidoverse Worlds"
        subtitle="PortOS rendered as a living systems garden"
        actions={actions}
        className="bg-port-bg"
      />

      {phase === 'ready' && (
        <main className="relative min-h-0 flex-1 overflow-hidden bg-port-bg">
          <iframe
            src={hostUrl}
            title="Eidoverse Worlds"
            className="absolute inset-0 h-full w-full border-0 bg-port-bg"
            allow="camera; microphone; fullscreen; gamepad; xr-spatial-tracking"
            allowFullScreen
            onLoad={() => setIframeReady(true)}
          />

          {showLoadingCurtain && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-port-bg" role="status">
              <BrailleSpinner text="Preparing the PortOS systems garden" />
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-3 sm:p-4">
            <section className="port-media-overlay max-w-md rounded-2xl border border-port-border p-3 shadow-2xl sm:p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-port-accent/35 bg-port-accent/10 px-2 py-1 text-[11px] font-medium text-port-accent">
                  <Sparkles size={12} aria-hidden="true" />
                  {design.name || recipeDraft?.name || 'PortOS world'}
                </span>
                <span className={`rounded-full border px-2 py-1 text-[11px] ${statusTone(reconciliation.status)}`}>
                  {projectionStatus === 'running'
                    ? `Projecting${projectionProgress ? ` ${projectionProgress}` : ''}`
                    : (reconciliation.status || 'Pending')}
                </span>
              </div>
              <h2 className="mt-3 text-base font-semibold sm:text-lg">Your PortOS, made spatial</h2>
              <p className="mt-1 hidden text-xs leading-5 text-port-text-muted sm:block">
                The Nexus is system health. Eight districts turn bounded app signals into places, motion, and light—without copying raw records into the world.
              </p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-port-text-muted">
                <span>Design V{design.selectedVersion || recipeDraft?.version}</span>
                <span>{summary.liveEntityCount ?? 0}/{design.maxEntities || 48} live signals</span>
                <span>{worldState?.presence?.connected ? 'CoS connected' : 'CoS ready'}</span>
                {draftDirty && <span className="text-port-warning">Unsaved world changes</span>}
              </div>
            </section>

            <div className="pointer-events-auto flex gap-2">
              <button
                type="button"
                aria-label="Refresh world"
                onClick={() => { void runProjection().catch(() => {}); }}
                disabled={projectionStatus === 'running' || draftDirty}
                title={draftDirty ? 'Save changes in World controls before refreshing' : undefined}
                className="port-media-overlay-strong port-media-overlay-item inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-port-border px-3 text-sm shadow-xl transition-colors hover:border-port-accent disabled:cursor-wait disabled:opacity-60"
              >
                <RotateCcw size={15} className={projectionStatus === 'running' ? 'animate-spin' : ''} aria-hidden="true" />
                <span className="hidden sm:inline">{projectionStatus === 'running' ? 'Projecting…' : 'Refresh world'}</span>
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-port-accent px-3 text-sm font-semibold text-black shadow-xl transition-opacity hover:opacity-90"
              >
                <SlidersHorizontal size={15} aria-hidden="true" />
                World controls
              </button>
            </div>
          </div>

          {projectionError && (
            <div className="port-media-overlay-strong pointer-events-auto absolute inset-x-3 top-40 z-10 mx-auto flex max-w-2xl items-start gap-3 rounded-xl border border-port-error/50 p-3 text-sm text-port-error shadow-xl sm:top-44" role="status">
              <AlertTriangle className="mt-0.5 shrink-0" size={17} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p>{projectionError}</p>
                {appId && <Link className="mt-1 inline-block text-xs text-white underline" to={`/apps/${appId}/overview`}>Check the Eidoverse runtime</Link>}
              </div>
            </div>
          )}

          <section className="pointer-events-auto absolute inset-x-0 bottom-0 overflow-x-auto p-3 sm:p-4" aria-label="PortOS district legend">
            <div className="port-media-overlay mb-2 ml-auto w-fit rounded-full border border-port-border px-3 py-1 text-[10px] text-port-text-muted">
              Steady = current · slow bob = stale · raised pulse = attention · high fast pulse = error
            </div>
            <div className="port-media-overlay flex min-w-max gap-2 rounded-2xl border border-port-border p-2 shadow-2xl sm:grid sm:min-w-0 sm:grid-cols-4 lg:grid-cols-8">
              {(recipeDraft?.districts || []).map((district) => (
                <div key={district.id} className="port-media-overlay-item w-36 rounded-xl border border-port-border/70 px-3 py-2 sm:w-auto">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full shadow-[0_0_12px_currentColor]" style={{ backgroundColor: district.accent, color: district.accent }} aria-hidden="true" />
                    <span className="truncate text-[11px] font-medium">{district.label}</span>
                  </div>
                  <p className="mt-1 truncate text-[10px] text-gray-500">{district.direction} · {district.landmark}</p>
                </div>
              ))}
            </div>
          </section>
        </main>
      )}

      {['loading', 'starting', 'connecting'].includes(phase) && (
        <div className="flex flex-1 items-center justify-center p-6" role="status">
          <BrailleSpinner text={phase === 'starting'
            ? 'Starting Eidoverse Worlds'
            : (phase === 'connecting' ? 'Connecting to Eidoverse Worlds' : 'Loading Eidoverse Worlds')} />
        </div>
      )}

      {phase === 'setup' && (
        <div className="flex flex-1 items-center justify-center p-6">
          <section className="max-w-lg rounded-xl border border-port-border bg-port-card p-6 text-center">
            <Orbit className="mx-auto mb-3 h-10 w-10 text-port-accent" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-white">Install Eidoverse Worlds</h2>
            <p className="mt-2 text-sm text-gray-400">Install and enable the managed app from PortOS Features before opening this world.</p>
            <Link to="/settings/features" className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">
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
            <button type="button" onClick={prepare} className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">
              <RotateCcw size={16} aria-hidden="true" />
              Retry
            </button>
          </section>
        </div>
      )}

      <EidoverseWorldDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        worldState={worldState}
        worldName={worldName}
        setWorldName={setWorldName}
        humanName={humanName}
        setHumanName={setHumanName}
        recipeDraft={recipeDraft}
        assetOverridesDraft={assetOverridesDraft}
        mutateRecipe={mutateRecipe}
        mutateAssetOverride={mutateAssetOverride}
        markDirty={markConfigDirty}
        configStatus={configStatus}
        projectionStatus={projectionStatus}
        dirty={draftDirty}
        onSave={saveWorldConfig}
        onProject={() => { if (!draftDirty) void runProjection().catch(() => {}); }}
        onReset={(scope, districtId) => { void runConfigAction({ reset: { scope, ...(districtId ? { districtId } : {}) } }); }}
        onRefreshAssets={() => { if (!draftDirty) void runConfigAction({ refreshAssets: true }); }}
      />
    </div>
  );
}
