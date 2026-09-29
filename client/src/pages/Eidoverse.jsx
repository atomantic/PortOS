import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Maximize2,
  Orbit,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Tags,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router';
import PageHeader from '../components/PageHeader';
import BrailleSpinner from '../components/BrailleSpinner';
import { useSocketResource } from '../hooks/useSocketResource';
import useConfigDraftRevision from '../hooks/useConfigDraftRevision';
import useEidoverseFrame from '../hooks/useEidoverseFrame';
import EidoverseWorldDrawer from '../components/eidoverse/EidoverseWorldDrawer';
import EidoverseTravel from '../components/eidoverse/EidoverseTravel';
import EidoverseUpdateBanner from '../components/eidoverse/EidoverseUpdateBanner';
import {
  draftsFromWorld,
  mergeDraft,
  reconcileAfterReset,
  shouldReplaceDraft,
} from '../lib/eidoverseDraftReconcile';
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
const PROJECTION_EVENTS = ['eidoverse:projection'];
const readProjection = () => getEidoverseWorldProjectionStatus(silent);
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

// Prefer the same-origin `/eidoverse-host/` path on the PortOS UI host+port.
// A single-port tailcat forward (e.g. 127.0.0.1:15555 → remote :5555) only
// tunnels :5555, so a dedicated :5563 iframe URL is unreachable from the
// laptop; absolute `/ws` and `/version` fetches from the iframe also need to
// hit that same origin (the main server reverse-proxies them while the host
// is active). The path mount answers `/embed-config` with this page's full
// origin (including a non-5555 forward port), which arms the frame handshake.
//
// Escape hatch: an HTTP page in front of an HTTPS-only host certificate still
// cannot load `https://…/eidoverse-host/` when the cert does not cover the
// hostname in use (loopback mirror / some Vite setups). There we keep the
// direct `:uiPort` load — scene renders, handshake stays dormant.
export const hostUrlFor = (host, setup, location = window.location, identity = null) => {
  if (location.protocol === 'https:' && host.protocol !== 'https') {
    throw new Error('PortOS is using HTTPS, but the Eidoverse host could not load the shared certificate.');
  }
  const baseUrl = location.protocol === 'http:' && host.protocol === 'https'
    ? `http://${location.hostname}:${setup.uiPort}/`
    : `${location.protocol}//${location.host}/eidoverse-host/`;
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

export default function Eidoverse() {
  const location = useLocation();
  const navigate = useNavigate();
  const { pathname } = location;
  const solo = pathname.replace(/\/+$/, '') === '/eidoverse/solo';
  const requestGeneration = useRef(0);
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [hostUrl, setHostUrl] = useState('');
  const [hostInfo, setHostInfo] = useState(null);
  const [setupState, setSetupState] = useState(null);
  const [appId, setAppId] = useState(null);
  const [worldState, setWorldState] = useState(null);
  const [worldName, setWorldName] = useState('');
  const [humanName, setHumanName] = useState('');
  const [cosId, setCosId] = useState('portos-cos');
  // One state object so a server response merges all three drafts atomically
  // against whatever the user has typed by the time it lands.
  const [drafts, setDrafts] = useState(() => draftsFromWorld(null));
  const { recipe: recipeDraft, assets: assetOverridesDraft, aliases: labelAliasesDraft } = drafts;
  const [projectionStatus, setProjectionStatus] = useState('idle');
  const [projectionError, setProjectionError] = useState('');
  const [configStatus, setConfigStatus] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);
  const {
    draftDirty, markDirty, markSaved, supersede, reset: resetDraftRevision, snapshot: snapshotDraft,
  } = useConfigDraftRevision();

  const { data: projectionProgress, updateData: updateProjectionProgress } = useSocketResource(readProjection, {
    events: PROJECTION_EVENTS, enabled: phase === 'ready', immediate: false,
  });
  useEffect(() => {
    if (!projectionProgress) return;
    setWorldState(current => current ? {
      ...current,
      projection: projectionProgress.projection || current.projection,
      design: projectionProgress.design ? { ...current.design, ...projectionProgress.design } : current.design,
    } : current);
  }, [projectionProgress]);

  const markConfigDirty = useCallback(() => {
    markDirty();
    setConfigStatus((current) => current === 'saving' ? current : '');
  }, [markDirty]);

  const stageIdentityRename = useCallback((name) => {
    markConfigDirty();
    setHumanName(name);
    setSettingsOpen(true);
    const search = new URLSearchParams(location.search);
    search.set('eidoverseTab', 'experience');
    navigate({ pathname: location.pathname, search: search.toString() }, { replace: true });
  }, [location.pathname, location.search, markConfigDirty, navigate]);

  const travelRef = useRef(null);
  const frame = useEidoverseFrame(
    hostUrl,
    worldState?.projection?.lastSummary?.objects,
    (peerId) => travelRef.current?.(peerId),
    stageIdentityRename,
  );

  const applyWorldResponse = useCallback((updated, { replaceDraft = true } = {}) => {
    updateProjectionProgress(null);
    setWorldState((current) => current
      ? { ...current, ...updated, identity: updated.identity || updated.human || current.identity }
      : updated);
    if (replaceDraft) {
      setDrafts((current) => ({ ...draftsFromWorld(updated), recipe: updated?.recipe || current.recipe }));
      if (updated?.world) setWorldName(updated.world);
      if (updated?.identity?.name || updated?.human?.name) setHumanName(updated.identity?.name || updated.human.name);
      if (updated?.cos?.id) setCosId(updated.cos.id);
      markSaved();
    }
  }, [markSaved, updateProjectionProgress]);

  const prepare = useCallback(() => {
    const generation = ++requestGeneration.current;
    const isCurrent = () => requestGeneration.current === generation;
    const updatePhase = (next) => { if (isCurrent()) setPhase(next); };

    // `appId` deliberately survives this reset: an update dispatched from
    // <EidoverseUpdateBanner> re-prepares the page on completion, and clearing
    // the id here would unmount that banner mid-report and drop its re-check.
    setPhase('loading');
    setError('');
    setHostUrl('');
    setHostInfo(null);
    setIframeReady(false);
    setSetupState(null);
    setWorldState(null);
    setDrafts(draftsFromWorld(null));
    setProjectionStatus('idle');
    setProjectionError('');
    setConfigStatus('');
    resetDraftRevision();

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
      setCosId(result.world?.cos?.id || 'portos-cos');
      setHumanName(result.world?.identity?.name || result.world?.human?.name || '');
      setDrafts(draftsFromWorld(result.world));
      setHostUrl(result.hostUrl || '');
    }, (reason) => {
      if (!isCurrent()) return;
      setPhase('error');
      setError(reason?.message || 'Eidoverse Worlds could not be loaded.');
    });
  }, [resetDraftRevision]);

  const runProjection = useCallback(async () => {
    setProjectionStatus('running');
    setProjectionError('');
    const submittedDraft = snapshotDraft();
    return projectEidoverseWorld(silent).then((result) => {
      // A progress read begun before the mutation response must not regress it.
      updateProjectionProgress(null);
      const replaceDraft = shouldReplaceDraft(submittedDraft);
      setWorldState((current) => current ? {
        ...current,
        projection: result.projection || current.projection,
        presence: result.presence || current.presence,
        design: result.design || current.design,
        recipe: result.recipe || current.recipe,
      } : current);
      if (replaceDraft && result.recipe) setDrafts(draftsFromWorld(result));
      setProjectionStatus('complete');
      return result;
    }, async (reason) => {
      setProjectionStatus('error');
      setProjectionError(reason?.message || 'PortOS could not project its current state into Eidoverse.');
      const failedStatus = await getEidoverseWorldStatus(silent).catch(() => null);
      if (failedStatus) {
        applyWorldResponse(failedStatus, { replaceDraft: false });
      }
      throw reason;
    });
  }, [applyWorldResponse, snapshotDraft, updateProjectionProgress]);

  useEffect(() => {
    if (phase !== 'ready' || !hostUrl) return undefined;
    void runProjection().catch(() => {});
    return undefined;
  }, [phase, hostUrl, runProjection]);

  useEffect(() => {
    prepare();
    return () => {
      requestGeneration.current += 1;
    };
  }, [prepare]);

  const mutateRecipe = useCallback((mutator) => {
    markConfigDirty();
    setDrafts((current) => current.recipe ? { ...current, recipe: mutator(current.recipe) } : current);
  }, [markConfigDirty]);

  const mutateAssetOverride = useCallback((slot, path) => {
    markConfigDirty();
    setDrafts((current) => {
      const assets = { ...current.assets };
      if (path.trim()) assets[slot] = path;
      else delete assets[slot];
      return { ...current, assets };
    });
  }, [markConfigDirty]);

  const mutateLabelAlias = useCallback((key, value) => {
    markConfigDirty();
    setDrafts((current) => {
      const aliases = { ...current.aliases };
      if (value.trim()) aliases[key] = value;
      else delete aliases[key];
      return { ...current, aliases };
    });
  }, [markConfigDirty]);

  const saveWorldConfig = useCallback(async () => {
    const submittedDraft = snapshotDraft();
    setConfigStatus('saving');
    const updated = await updateEidoverseWorldConfig({
      world: worldName.trim(),
      humanName: humanName.trim() || null,
      ...(recipeDraft ? {
        recipe: recipeDraft,
        assetOverrides: assetOverridesDraft,
        labelAliases: labelAliasesDraft,
      } : {}),
    }, silent).catch((reason) => {
      setConfigStatus(reason?.message || 'Could not save the Eidoverse world configuration.');
      return null;
    });
    if (!updated) return;

    const replaceDraft = shouldReplaceDraft({ ...submittedDraft, forceReplace: true });
    applyWorldResponse(updated, { replaceDraft });
    setConfigStatus(replaceDraft ? 'saved' : '');
    const nextHostUrl = hostInfo && setupState
      ? hostUrlFor(hostInfo, setupState, window.location, worldIdentityFor(updated))
      : hostUrl;
    if (nextHostUrl !== hostUrl) setHostUrl(nextHostUrl);
    else void runProjection().catch(() => {});
  }, [applyWorldResponse, assetOverridesDraft, labelAliasesDraft, hostInfo, hostUrl, humanName, recipeDraft, runProjection, setupState, snapshotDraft, worldName]);

  const runConfigAction = useCallback(async (payload) => {
    const submittedDraft = snapshotDraft();
    const submitted = drafts;
    const serverBefore = {
      recipe: worldState?.recipe,
      assets: worldState?.design?.userOverrides?.assets || {},
    };
    setConfigStatus('saving');
    const updated = await updateEidoverseWorldConfig(payload, silent).catch((reason) => {
      setConfigStatus(reason?.message || 'Could not update the Eidoverse world configuration.');
      return null;
    });
    if (!updated) return;
    const replaceDraft = shouldReplaceDraft({
      ...submittedDraft,
      forceReplace: payload.reset?.scope === 'all',
    });
    if (replaceDraft) supersede();
    applyWorldResponse(updated, { replaceDraft });
    const serverAfter = draftsFromWorld(updated);
    if (!replaceDraft && payload.reset) {
      setDrafts((current) => reconcileAfterReset({
        reset: payload.reset, drafts: current, submitted, serverAfter,
      }));
    } else if (!replaceDraft && payload.refreshAssets) {
      setDrafts((current) => ({
        ...current,
        recipe: updated.recipe ? mergeDraft({
          current: current.recipe,
          submitted: submitted.recipe,
          serverBefore: serverBefore.recipe,
          serverAfter: serverAfter.recipe,
        }) : current.recipe,
        assets: mergeDraft({
          current: current.assets,
          submitted: submitted.assets,
          serverBefore: serverBefore.assets,
          serverAfter: serverAfter.assets,
        }),
      }));
    }
    setConfigStatus(replaceDraft ? 'saved' : '');
    void runProjection().catch(() => {});
  }, [applyWorldResponse, drafts, runProjection, snapshotDraft, supersede, worldState]);

  const actions = (
    <>
      {phase === 'ready' && (
        <>
          <button
            type="button"
            aria-label="Show object labels"
            aria-pressed={frame.labelVisibility !== 'off'}
            onClick={() => frame.changeLabelVisibility(frame.labelVisibility === 'off' ? 'nearby' : 'off')}
            title="Toggle object labels for this visit"
            className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-lg border border-port-border px-2 sm:px-3 text-sm text-gray-200 hover:border-port-accent hover:text-white aria-pressed:border-port-accent aria-pressed:text-port-accent"
          >
            <Tags size={16} aria-hidden="true" />
            <span className="hidden sm:inline">Labels</span>
          </button>
          <button
            type="button"
            aria-label="Refresh world"
            onClick={() => { void runProjection().catch(() => {}); }}
            disabled={projectionStatus === 'running' || draftDirty}
            title={draftDirty ? 'Save changes in World controls before refreshing' : 'Refresh the PortOS projection'}
            className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-port-border px-2 text-gray-200 transition-colors hover:border-port-accent hover:text-white disabled:cursor-wait disabled:opacity-60"
          >
            <RotateCcw size={16} className={projectionStatus === 'running' ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="World controls"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-port-accent px-2 sm:px-3 py-1.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span aria-hidden="true" className="sm:hidden">Controls</span>
            <span aria-hidden="true" className="hidden sm:inline">World controls</span>
          </button>
        </>
      )}
      {hostUrl && !solo && (
        <Link
          to="/eidoverse/solo"
          aria-label="Open Eidoverse without PortOS controls"
          title="Open Eidoverse fullscreen inside PortOS (same iframe path as this page)"
          className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-lg border border-port-border px-2 sm:px-3 py-1.5 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white"
        >
          <Maximize2 size={15} aria-hidden="true" />
          <span className="hidden md:inline">Open Eidoverse alone</span>
          <span className="hidden sm:inline md:hidden">World only</span>
        </Link>
      )}
      {appId && (
        <Link
          to={`/apps/${appId}/overview`}
          aria-label="Manage Eidoverse app"
          title="Manage Eidoverse app"
          className="hidden min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-port-border px-2 text-gray-200 transition-colors hover:border-port-accent hover:text-white sm:inline-flex"
        >
          <Settings size={15} aria-hidden="true" />
        </Link>
      )}
    </>
  );

  const design = worldState?.design || {};
  const reconciliation = design.reconciliation || {};
  const freshWorldLighting = projectionStatus === 'running'
    && design.lastAppliedVersion == null
    && !FRESH_WORLD_VISIBLE_CHECKPOINTS.has(reconciliation.checkpoint);
  const showLoadingCurtain = !iframeReady || freshWorldLighting;

  const frameStage = (
    <>
      {phase === 'ready' && (
        <section className="relative min-h-0 flex-1 overflow-hidden bg-port-bg">
          <iframe
            ref={frame.frameRef}
            src={hostUrl}
            title="Eidoverse Worlds"
            className="absolute inset-0 h-full w-full border-0 bg-port-bg"
            allow="camera; microphone; fullscreen; gamepad; xr-spatial-tracking"
            allowFullScreen
            onLoad={() => { setIframeReady(true); frame.onFrameLoad(); }}
          />

          {showLoadingCurtain && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-port-bg" role="status">
              <BrailleSpinner text="Preparing the PortOS systems garden" />
            </div>
          )}

          {projectionError && (
            <div className={`port-media-overlay-strong pointer-events-auto absolute inset-x-3 z-10 mx-auto flex max-w-2xl items-start gap-3 rounded-xl border border-port-error/50 p-3 text-sm text-port-error shadow-xl ${solo ? 'bottom-3' : 'top-3'}`} role="status">
              <AlertTriangle className="mt-0.5 shrink-0" size={17} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p>{projectionError}</p>
                {appId && <Link className="mt-1 inline-block text-xs text-white underline" to={`/apps/${appId}/overview`}>Check the Eidoverse runtime</Link>}
              </div>
            </div>
          )}
        </section>
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
    </>
  );

  const worldDrawer = (
    <EidoverseWorldDrawer
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      worldState={worldState}
      worldName={worldName}
      setWorldName={setWorldName}
      humanName={humanName}
      setHumanName={setHumanName}
      cosId={cosId}
      recipeDraft={recipeDraft}
      assetOverridesDraft={assetOverridesDraft}
      labelAliasesDraft={labelAliasesDraft}
      mutateLabelAlias={mutateLabelAlias}
      frameConnection={frame.connection}
      labelVisibility={frame.labelVisibility}
      onLabelVisibilityChange={frame.changeLabelVisibility}
      appId={appId}
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
  );

  // Chromeless world-only surface: same hostUrl iframe as the embedded page,
  // without a top-level navigation to /eidoverse-host/ (Safari stuck-splash).
  if (solo) {
    return (
      <div className="flex h-dvh flex-col bg-port-bg text-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-port-border px-4 py-3">
          <div>
            <h1 className="font-semibold">Eidoverse · world only</h1>
            <p className="text-sm text-gray-400">Fullscreen inside PortOS · same renderer path as the Eidoverse page</p>
          </div>
          <Link
            to="/eidoverse"
            aria-label="Back to Eidoverse controls"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white"
          >
            <ArrowLeft size={15} aria-hidden="true" />
            Controls
          </Link>
        </header>
        {frameStage}
        {worldDrawer}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-port-bg">
      <EidoverseTravel travelRef={travelRef} beforeDeparture={frame.leaveWorld} enabled={Boolean(hostUrl)} objects={worldState?.projection?.lastSummary?.objects || []}
        onDestinationsChange={() => {
          if (projectionStatus === 'running' || draftDirty) return false;
          if (worldState?.recipe?.includes?.peers !== false) void runProjection().catch(() => {});
          return true;
        }} />
      <PageHeader
        icon={Orbit}
        title="Eidoverse Worlds"
        subtitle="PortOS rendered as a living systems garden"
        actions={actions}
        className="bg-port-bg"
      />

      {appId && phase !== 'setup' && (
        <EidoverseUpdateBanner appId={appId} onUpdated={prepare} />
      )}

      {frameStage}

      {worldDrawer}
    </div>
  );
}
