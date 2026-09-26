import { providerModeGroups } from '../lib/aiToolkit/internal/providerModes.js';
import { tuiModeAddition } from '../lib/providerModePairing.js';
import { buildProviderGraphPreview, toManagementPreviewDto } from '../lib/providerGraphPreview.js';
import {
  createBinding,
  createConnection,
  getManagementGraph,
  linkBinding,
  presetSkipReason,
  previewBindingLink,
  providerGraphEnabled,
  refreshConnectionCatalog,
  removeConnection,
  unlinkBinding,
  updateBindingSettings,
  updateConnectionSettings,
  updateRouteModelAliases,
  updateRouteSettings,
} from '../services/providerGraph.js';
import {
  createService,
  getService,
  listServices,
  refreshServiceCatalog,
  updateService,
} from '../services/providerServices.js';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { testVision, runVisionTestSuite, checkVisionHealth } from '../services/visionTest.js';
import { auditModelPins, clearModelPin } from '../services/modelPinAudit.js';
import { providerCreateSchema, providerSchema, providerActiveSchema, validate } from '../lib/aiToolkit/validation.js';
import { canRefreshModels, withRefreshCapability } from '../lib/aiToolkit/internal/modelFetchers.js';
import { applyModelAccess, applyModelAccessList } from '../lib/aiToolkit/internal/modelAccess.js';
import { ALLOWED_COMMANDS } from '../cos-runner/allowedCommands.js';
import { onClientDisconnect, openSseStream } from '../lib/sseDownload.js';
import { createInstallLogger } from '../lib/installLogger.js';
import {
  validateRequest,
  codexLoginCancelSchema,
  codexLoginStartSchema,
  modelPinClearSchema,
  providerVisionTestSchema,
  providerVisionSuiteSchema,
  providerBindingCreateSchema,
  providerBindingLinkSchema,
  providerBindingUnlinkSchema,
  providerBindingUpdateSchema,
  providerConnectionCreateSchema,
  providerConnectionUpdateSchema,
  providerServiceCreateSchema,
  providerServiceUpdateSchema,
  providerRouteModelAliasSchema,
  providerRouteSettingsUpdateSchema,
  providerPresetCreateSchema,
  credentialBootstrapsSettingsSchema,
  harnessEnablementUpdateSchema,
  harnessIdParamSchema,
} from '../lib/validation.js';
import {
  getProviderRuntimeStatus,
  getProviderRuntimeStatuses,
} from '../services/providerRuntimeInstaller.js';
import { harnessCatalogRuntime, refreshHarnessModels } from '../services/harnesses.js';
import { streamHarnessAction } from '../services/harnessActionStream.js';
import { getProviderReadinessMap, resetProviderReadinessCache, servedModelId } from '../services/providerReadiness.js';
import { getLlamaServerEndpoint, relaunchLlamaServerWithAlias } from '../services/llamaServerManager.js';
import { claimHeavyLocalJob } from '../lib/heavyJobClaim.js';
import { getProviderPrerequisiteMap } from '../services/providerPrerequisites.js';
import { isCodexSubscriptionProvider } from '../lib/codexAccount.js';
import {
  cancelCodexChatGptLogin,
  peekCodexAccountReadiness,
  peekCodexModelCatalog,
  codexLogout,
  listCodexModels,
  getCodexAccountReadiness,
  startCodexChatGptLogin,
} from '../services/codexAppServer.js';
import { runLocalRuntimeSetup, SETUP_ACTIONS } from '../services/localRuntimeSetup.js';
import { localEndpointPort, localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import {
  enforcedPublicReviewPosturesForProvider,
  publicReviewPosturesForProvider,
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
} from '../lib/providerVendors.js';
import { buildTuiShellLaunch } from '../lib/tuiShellLaunch.js';
import { presetDerivable, presetKind } from '../lib/providerPresets.js';
import { isDerivedPreset } from '../lib/providerGraphRecords.js';
import {
  captureSystemCapabilities,
  detectSystemCapabilities,
  withProviderHardwareCompatibility,
} from '../lib/systemCapabilities.js';

/**
 * The CoS Agent Runner's exec allowlist, published read-only so the AI
 * Providers editor can warn that a custom `command` will never spawn via
 * `/spawn` / `/spawn-tui` (#4143). Direct (non-runner) spawn does NOT consult
 * this list, so an off-list command is a legitimate config — informational
 * only, never a save-time rejection.
 *
 * Published as a list rather than a per-provider `runnerAllowed` flag on
 * purpose: the editor has to warn about the command the user is TYPING, which
 * has no persisted provider to decorate. Sorted so the payload is stable.
 *
 * This is a one-way read: the allowlist stays hand-curated in
 * `cos-runner/allowedCommands.js` and is never derived from the user-writable
 * `data/providers.json`, or a config write could choose the exec target.
 */
const RUNNER_ALLOWED_COMMANDS = [...ALLOWED_COMMANDS].sort();

// Same re-entrancy guard for the local-daemon setup lane. Separate from the CLI
// one because they install different things, but each is single-flight: two
// concurrent `brew install`s (or two copies of one daemon racing for a port) is
// never what a double-click meant.
let runtimeSetupInFlight = false;

/**
 * Sanitize a provider object for client responses.
 * Strips apiKey (replaces with hasApiKey boolean) and redacts secretEnvVars
 * values. An explicitly empty secret value stays empty so the client can
 * distinguish "configured but blank" from an unknown redacted value when it
 * paints provider readiness.
 */
const sanitizeProvider = (provider) => {
  if (!provider) return provider;
  const { apiKey, envVars, secretEnvVars, ...rest } = provider;
  const sanitized = {
    ...rest,
    hasApiKey: Boolean(apiKey),
    envVars: envVars ? { ...envVars } : {},
    secretEnvVars: secretEnvVars || []
  };
  // Redact values of secret env vars
  if (Array.isArray(secretEnvVars)) {
    for (const key of secretEnvVars) {
      if (key in sanitized.envVars) {
        sanitized.envVars[key] = sanitized.envVars[key] === '' ? '' : '***';
      }
    }
  }
  return sanitized;
};

/**
 * Decorate a TUI provider with the command line the Shell page will run for it,
 * so the card can render a "Launch in Shell" button and show what it will type.
 *
 * DISPLAY ONLY — the launch itself goes through `shell:start { providerId }`,
 * which re-resolves this server-side and pairs it with the provider's env (see
 * `lib/tuiShellLaunch.js`). Publishing the line does not publish the env: those
 * values are secret and stay on the server.
 *
 * Non-TUI providers get no field at all: the button is TUI-only, and an absent
 * key (rather than an empty string) keeps "not a TUI" distinct from "a TUI
 * whose command line came back blank".
 */
const withTuiLaunchCommand = (provider) => {
  const launch = buildTuiShellLaunch(provider);
  return launch ? { ...provider, tuiCommandLine: launch.commandLine } : provider;
};

/**
 * The shape a provider takes on its way OUT to the client: secrets stripped,
 * plus the derived `canRefreshModels` flag the AI Providers page reads to
 * decide whether to offer a "Refresh Models" button (#3620).
 *
 * Order matters, and BOTH derivations run on the RAW provider, before
 * sanitization. `canRefreshModels`: the ollama row of the fetcher table keys
 * partly on `envVars.ANTHROPIC_BASE_URL`, which `sanitizeProvider` redacts to
 * `'***'` when the user marked it secret — deriving after would silently drop
 * the Refresh button for a Claude-Ollama provider. `tuiCommandLine`: the same
 * trap one layer down, since `buildTuiInvocation` consults `envVars` for the
 * Bedrock model mapping (`CLAUDE_CODE_USE_BEDROCK`) — a redacted `'***'` reads
 * truthy, so a card whose provider has that var marked secret and switched OFF
 * would advertise a Bedrock-mapped model the real launch never uses.
 *
 * These PortOS routes SHADOW the toolkit's own (which decorate the same way);
 * the toolkit keeps its copy so it stays correct standalone. Both decorate on
 * the way out only — the field is never persisted.
 */
const presentProvider = (provider, capabilities = captureSystemCapabilities()) => {
  const decorated = withProviderHardwareCompatibility(
    withTuiLaunchCommand(withRefreshCapability(provider)),
    capabilities,
  );
  // Derived on read from the raw provider. This is an explicit capability of
  // the maintained public-review recipe, not a client-side guess based on a
  // provider name or a user-writable `args` list.
  // `publicReviewPostures` is the value the schedule UI filters on, so a stage
  // offers exactly the providers this install can actually run it on;
  // `publicReviewEnforcedPostures` is the subset backed by a vendor sandbox
  // recipe. The two booleans are derived from it and kept for existing consumers.
  const publicReviewPostures = publicReviewPosturesForProvider(provider);
  // Narrow `models` to the install's declared entitlement, LAST, so every
  // derivation above still reads the provider's full advertised catalog. The
  // untouched list rides along as `modelCatalog` — the editor seeds its
  // "Available Models" box from it, so an ordinary Save on a scoped provider
  // cannot persist the narrowed list over the real one.
  return sanitizeProvider({
    ...applyModelAccess(decorated),
    // The RAW record's key: an inherited or materialized one rides
    // NON-enumerably (`withGatewayApiKey`, the composite resolver), so the
    // decorating spreads above dropped it — re-carried here so `hasApiKey`
    // reports the key the run would actually use (#7564).
    apiKey: provider?.apiKey,
    // The UNION of the two refresh paths, because the button asks only
    // whether SOME path can serve this record. Which one actually serves it is
    // decided in `POST /:id/refresh-models`, and the two must stay in step or
    // a card offers a button the route refuses.
    canRefreshModels: decorated.canRefreshModels || Boolean(harnessCatalogRuntime(provider)),
    publicReviewPostures,
    publicReviewEnforcedPostures: enforcedPublicReviewPosturesForProvider(provider),
    publicReviewSupported: publicReviewPostures.includes(PUBLIC_REVIEW_NO_TOOL_POSTURE),
    publicReviewActionsSupported: publicReviewPostures.includes(PUBLIC_REVIEW_ACTIONS_POSTURE),
    // Preset structure (#7565): `derived` when the record names the service it
    // is materialized from, else `legacy`; and whether a legacy record is a
    // candidate for "Convert to derived preset": pure over the record, AND not
    // refused by the last reconcile pass — the conversion re-runs that pass, so
    // a record it just left legacy would only fail again (#7565).
    presetKind: presetKind(provider),
    presetDerivable: presetDerivable(provider) && !presetSkipReason(provider?.id),
  });
};

// Deferred: the preset service reaches the graph store and the composite
// resolver, which every suite that mounts these routes would otherwise pay for.
const presetService = () => import('../services/providerPresets.js');

/**
 * Carry a gateway-backed wrapper's RESOLVED model-access policy from the read
 * that preceded a write onto the record the write handed back.
 *
 * A write returns the PERSISTED record, and a wrapper stores no policy of its
 * own — the gateway sibling owns it, and `withGatewayModelAccess` resolves it on
 * read. Presenting the raw write result would answer that one request with the
 * unscoped catalog and the next GET with the scoped one, which reads as a bug.
 * The route already holds a resolved read (it needs it for the 404 and for
 * secret preservation), so this is a field copy rather than a second load.
 *
 * Deliberately not a re-read: several suites drive these routes with a provider
 * service double whose `getProviderById` answers a different fixture than the
 * write does, and a write path is the wrong place to depend on a second lookup.
 *
 * Safe against a write that CHANGED the policy: `applyModelAccess` reads the
 * record's own `modelAccess` first and only falls back to the resolved field,
 * so a freshly written own policy outranks the inherited one copied here.
 */
const withResolvedModelAccess = (provider, resolved) => (
  provider && resolved?.modelAccessEffective
    ? { ...provider, modelAccessEffective: resolved.modelAccessEffective, modelAccessSource: resolved.modelAccessSource }
    : provider
);

/**
 * Create PortOS-specific provider routes
 * Extends AI Toolkit routes with vision testing endpoints
 */
export function createPortOSProviderRoutes(aiToolkit) {
  const router = Router();
  router.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      res.once('finish', () => {
        if (res.statusCode < 400) req.app.get('io')?.emit('providers:changed');
      });
    }
    next();
  });

  router.get('/fleet-host', asyncHandler(async (req, res) => {
    const { readFleetHostStatus } = await import('../services/fleetHostNotify.js');
    res.set('Cache-Control', 'no-store').json(await readFleetHostStatus());
  }));
  // Who has been using this machine's GPU. Never cached: the point of the
  // report is what is happening right now.
  router.get('/fleet-host/usage', asyncHandler(async (req, res) => {
    const { getFleetLlmHostUsage } = await import('../services/fleetLlmHost.js');
    res.set('Cache-Control', 'no-store').json(await getFleetLlmHostUsage());
  }));
  // The counterpart to `/fleet-host/setup`: close the queue, clear the
  // enable marker, drop the login task and remove the container.
  router.post('/fleet-host/stop', asyncHandler(async (req, res) => {
    const { disableFleetLlmHost, getFleetLlmHostStatus } = await import('../services/fleetLlmHost.js');
    if (runtimeSetupInFlight) throw new ServerError('Model host setup is running — wait for it to finish before stopping the host.', { status: 409, code: 'SETUP_BUSY' });
    const log = [];
    const result = await disableFleetLlmHost({ emit: (message) => log.push(message) });
    resetProviderReadinessCache();
    res.set('Cache-Control', 'no-store').json({ ...result, log, status: await getFleetLlmHostStatus().catch(() => null) });
  }));
  router.get('/fleet-peer-hosts', asyncHandler(async (req, res) => {
    const { getFleetPeerHosts } = await import('../services/fleetLlmHost.js');
    res.set('Cache-Control', 'no-store').json(await getFleetPeerHosts());
  }));
  router.post('/fleet-peer-hosts/:peerId/key', asyncHandler(async (req, res) => {
    const { revealFleetPeerHostKey } = await import('../services/fleetLlmHost.js');
    res.set('Cache-Control', 'no-store').json(await revealFleetPeerHostKey(req.params.peerId));
  }));
  // Explicit reveal; secrets are never included in status, URLs or install logs.
  router.post('/fleet-host/key', asyncHandler(async (req, res) => {
    const { revealFleetLlmKey } = await import('../services/fleetLlmHost.js');
    res.set('Cache-Control', 'no-store').json({ apiKey: await revealFleetLlmKey() });
  }));
  router.post('/fleet-host/setup', asyncHandler(async (req, res) => {
    const { configureFleetLlmHost, getFleetLlmHostStatus } = await import('../services/fleetLlmHost.js');
    if (runtimeSetupInFlight) throw new ServerError('Another model setup is running.', { status: 409, code: 'SETUP_BUSY' });
    runtimeSetupInFlight = true;
    const { send, safeEnd } = openSseStream(res);
    let clientGone = false;
    onClientDisconnect(req, res, () => { clientGone = true; });
    const result = await configureFleetLlmHost({
      emit: (message) => send({ type: 'log', message }),
      isCancelled: () => clientGone,
    }).catch((err) => ({ success: false, error: err.message }))
      .finally(() => { runtimeSetupInFlight = false; resetProviderReadinessCache(); });
    const status = await getFleetLlmHostStatus().catch(() => null);
    send(result.success ? { type: 'complete', message: 'Host configured. Check model readiness below.', status } : { type: 'error', message: result.error });
    safeEnd();
  }));

  const providerService = aiToolkit.services.providers;
  const providerStatusService = aiToolkit.services.providerStatus;

  // Sanitized GET routes — intercept toolkit GET endpoints to strip secrets
  /**
   * The provider list, each record decorated with the SERVER's verdict on its
   * prerequisites (#4611): `prerequisitesMet` plus the `missingPrerequisites`
   * findings behind it. The AI Providers page paints its `NEEDS SETUP` cards
   * from this instead of re-deriving the same rules in the browser, and the
   * fallback router gates on the same computation — so a card that says a
   * provider can't run and a router that hands it a run can no longer disagree.
   *
   * Computed on the RAW providers, before sanitization: the API-key check reads
   * `apiKey`, which `sanitizeProvider` replaces with a boolean.
   *
   * The capability probe is cached and performed once per response, so every
   * provider shares one host snapshot instead of triggering its own hardware
   * checks. An unreadable probe remains `unknown`, which keeps the provider
   * visible until the runtime can make a confirmed decision.
   */
  router.get('/', asyncHandler(async (req, res) => {
    const data = await providerService.getAllProviders();
    const prerequisites = getProviderPrerequisiteMap(data.providers);
    const modeGroups = new Map(providerModeGroups(data.providers).flatMap(group =>
      group.map(provider => [provider.id, group.map(({ id, type }) => ({ id, type }))])));
    const capabilities = await detectSystemCapabilities();
    // Cache-only: this list must stay a synchronous read that spawns nothing.
    // `null` here means NOT PROBED, and the dedicated `/codex/account` fetch is
    // what fills it — a card renders "unknown", never "signed out", until then.
    const codexAccount = peekCodexAccountReadiness();
    // Same cache-only contract, for the CoS/model pickers (#6306): the signed-in
    // account's real catalog when one has been fetched, otherwise the three-state
    // shape that tells the client to keep showing its shipped list. Rendering a
    // picker must never be what starts `codex app-server`.
    const codexModelCatalog = peekCodexModelCatalog();
    res.json({
      activeProvider: data.activeProvider,
      providers: data.providers.map((provider) => ({
        ...presentProvider(provider, capabilities),
        executionModes: modeGroups.get(provider.id),
        // Whether this record can be COMPLETED into a CLI/TUI pair. Derived
        // here rather than on the record alone because the verdict reads the
        // whole list — this record's mode GROUP (a `<stem>-cli` record is
        // already paired while its `<id>-tui` sits unclaimed) and the sibling
        // id — and decided server-side for the same reason `prerequisitesMet`
        // is: the card offering the action and the endpoint performing it must
        // not re-derive the rule apart.
        canAddTuiMode: tuiModeAddition(provider, data.providers, modeGroups.get(provider.id)).ok,
        prerequisitesMet: prerequisites[provider.id]?.met ?? true,
        missingPrerequisites: prerequisites[provider.id]?.missing ?? [],
        // NON-blocking notices — today only 'this install's own ~/.codex/config.toml
        // re-points Codex model routing'. Kept OUT of `missingPrerequisites` so a
        // legitimate user choice never buckets a card as NEEDS SETUP; the card
        // renders it as a badge and caveats the subscription quota with it.
        prerequisiteAdvisories: prerequisites[provider.id]?.advisories ?? [],
        ...(isCodexSubscriptionProvider(provider) ? { codexAccount, codexModelCatalog } : {}),
      })),
      runnerAllowedCommands: RUNNER_ALLOWED_COMMANDS
    });
  }));

  router.get('/active', asyncHandler(async (req, res) => {
    const provider = await providerService.getActiveProvider();
    res.json(presentProvider(provider, await detectSystemCapabilities()));
  }));

  // PUT /active must be defined before PUT /:id to avoid the wildcard
  // catching "active" as a provider ID (which causes 404 "Provider not found")
  router.put('/active', asyncHandler(async (req, res) => {
    const validation = validate(providerActiveSchema, req.body);
    if (!validation.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: validation.errors } });
    }
    const { id } = validation.data;
    const provider = await providerService.setActiveProvider(id);
    if (!provider) {
      throw new ServerError('Provider not found', { status: 404 });
    }
    res.json(presentProvider(provider, await detectSystemCapabilities()));
  }));

  /**
   * READ-ONLY preview of the provider connection graph (#6366) — what an
   * import WOULD create from the records this install already runs, and which
   * records it would leave isolated, with reasons.
   *
   * Nothing is persisted, no provider is written, and no AI provider is
   * contacted: this is a pure projection of `providers.json` and must stay one,
   * because it is meant to be safe to open from a configuration screen. The
   * flat `GET /api/providers` shape is untouched and remains the execution
   * contract; `activeProvider` here is the same executable provider id string.
   *
   * A client talking to a server without this endpoint gets a 404 and falls
   * back to the flat list — an explicit unsupported answer, not a guess.
   */
  router.get('/management/preview', asyncHandler(async (_req, res) => {
    const data = await providerService.getAllProviders();
    // Scoped like every other picker payload: the preview's connection catalogs
    // and binding model menus are what the Backend Connections page offers, so
    // an unscoped read here would contradict the model-access policy four
    // handlers below (docs/MODEL_ACCESS.md).
    const scoped = { ...data, providers: applyModelAccessList(data.providers) };
    res.set('Cache-Control', 'no-store').json(toManagementPreviewDto(buildProviderGraphPreview(scoped)));
  }));

  /**
   * The DURABLE provider connection graph (#6367) — the same shape as the
   * preview above, but read from ai_connections / ai_harness_bindings /
   * ai_route_bindings rather than derived on every request.
   *
   * Sanitized identically: credential PRESENCE only, no projection snapshots,
   * no raw provider records. An install whose database is unavailable gets an
   * explicit 503 `PROVIDER_GRAPH_UNAVAILABLE` rather than a silent empty graph,
   * so a client can fall back to the flat list on a known answer instead of
   * guessing from a failed request.
   */
  router.get('/management', asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await getManagementGraph());
  }));

  /**
   * Add a NEW backend to the graph (#6369) — mock flow 3 in the decision
   * record: a distinct remote endpoint with its own credentials, created as its
   * own identity even when its model names match a backend already configured.
   *
   * Creation only. Nothing is probed, no model list is fetched, no route is
   * minted and `activeProvider` does not move: a connection with no binding is
   * a legitimate row the user then attaches a harness to.
   */
  router.post('/connections', asyncHandler(async (req, res) => {
    const input = validateRequest(providerConnectionCreateSchema, req.body ?? {});
    res.status(201).json(await createConnection(input));
  }));

  /**
   * Add a harness to an existing backend (#6369) — mock flow 2: the same
   * daemon, driven by a second program, as an INDEPENDENT binding with its own
   * executable route ids.
   *
   * The route records are minted from the harness's command recipe
   * (`PROVIDER_HARNESSES[].recipe`), which is what this endpoint waited on: the
   * registry could classify an existing record but not describe how to spawn a
   * fresh one.
   *
   * Every minted route arrives DISABLED with no model pins. Creating a route is
   * a management act; executing one is a separate grant on `PATCH
   * /api/providers/:id`, and nothing here launches, probes or generates.
   */
  router.post('/bindings', asyncHandler(async (req, res) => {
    const input = validateRequest(providerBindingCreateSchema, req.body ?? {});
    res.status(201).json(await createBinding(input));
  }));

  /**
   * What linking this binding into another connection WOULD change: which
   * executable route ids move, how the two backends differ, and which variant
   * key the binding would occupy. Read-only — POST because the body carries the
   * revisions being reviewed, not because anything is written.
   */
  router.post('/bindings/:id/link/preview', asyncHandler(async (req, res) => {
    const input = validateRequest(providerBindingLinkSchema, req.body ?? {});
    res.json(await previewBindingLink({ bindingId: req.params.id, ...input }));
  }));

  // Apply a reviewed link. Every named revision is re-checked inside the graph
  // transaction; a stale one is a 409 that requires a fresh preview.
  router.post('/bindings/:id/link', asyncHandler(async (req, res) => {
    const input = validateRequest(providerBindingLinkSchema, req.body ?? {});
    res.json(await linkBinding({ bindingId: req.params.id, ...input }));
  }));

  // Give this binding its own copy of the connection it shares. Route ids,
  // activeProvider, task pins and fallback references are all retained.
  router.post('/bindings/:id/unlink', asyncHandler(async (req, res) => {
    const input = validateRequest(providerBindingUnlinkSchema, req.body ?? {});
    res.json(await unlinkBinding({ bindingId: req.params.id, ...input }));
  }));

  // Remove a connection no binding uses. Refused with a 409 while one still
  // does — the graph never silently orphans a binding to tidy a row away.
  router.delete('/connections/:id', asyncHandler(async (req, res) => {
    res.json(await removeConnection(req.params.id));
  }));

  /**
   * Edit one SHARED backend (#6369) — its label, transports and credentials —
   * and materialize the result into every executable route on it.
   *
   * This is the edit the graph exists for: an endpoint or key changed once
   * rather than retyped per harness. `expectedRevision` is required and
   * re-checked inside the serialized pass, so an edit made against a row that
   * has since moved is a 409 instead of a silent overwrite.
   */
  router.patch('/connections/:id', asyncHandler(async (req, res) => {
    const input = validateRequest(providerConnectionUpdateSchema, req.body ?? {});
    res.json(await updateConnectionSettings({ connectionId: req.params.id, ...input }));
  }));

  /**
   * Refresh a connection's SHARED model catalog once for every harness on it.
   *
   * An explicit discovery request and nothing more: it lists models, it never
   * generates, and a failed probe keeps the catalog the connection already had
   * rather than reporting an empty backend.
   */
  router.post('/connections/:id/refresh-models', asyncHandler(async (req, res) => {
    res.json(await refreshConnectionCatalog(req.params.id));
  }));

  /**
   * Service INSTANCES (#7563) — the same `ai_connections` rows read as one
   * instance each of a `SERVICE_DEFINITIONS` entry: slug, definition, plan,
   * enabled, how it authenticates, and the catalog it last listed. Sanitized
   * like the graph: credential PRESENCE and SOURCE only, never a value.
   *
   * `:slug` also accepts the row's UUID, and every `/connections/:id` route
   * above accepts a slug, so the two surfaces address one row either way.
   */
  router.get('/services', asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await listServices());
  }));

  /**
   * Every `SERVICE_DEFINITIONS` row an "Add service" flow may instantiate
   * (#7567): family, plans, transports with default base URLs, and where a key
   * is obtained. Code-only data — no instance, no credential — so it is
   * cacheable for the process lifetime. Declared above `/services/:slug` by
   * name rather than position: its own segment can never be read as a slug.
   * Deferred imports like the catalog handler below: a suite that mocks
   * `providerServices.js` would otherwise instantiate the instance/definition
   * subtree through this route file alone (server/AGENTS.md "Import scoping").
   */
  router.get('/service-definitions', asyncHandler(async (_req, res) => {
    const [{ SERVICE_DEFINITIONS }, { presentServiceDefinition }] = await Promise.all([
      import('../lib/serviceDefinitions.js'),
      import('../lib/providerServiceInstances.js'),
    ]);
    res.json({ definitions: SERVICE_DEFINITIONS.map(presentServiceDefinition) });
  }));

  // Create an instance from a definition. Nothing is probed and no route is
  // minted; the catalog starts `unknown` until the explicit refresh below.
  router.post('/services', asyncHandler(async (req, res) => {
    const input = validateRequest(providerServiceCreateSchema, req.body ?? {});
    res.status(201).json(await createService(input));
  }));

  router.get('/services/:slug', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await getService(req.params.slug));
  }));

  // The shared-backend edit plus plan / enabled / credential mode. Same
  // required `expectedRevision`, same three-valued credential rule, same
  // projection into every route on the row.
  router.patch('/services/:slug', asyncHandler(async (req, res) => {
    const input = validateRequest(providerServiceUpdateSchema, req.body ?? {});
    res.json(await updateService(req.params.slug, input));
  }));

  // Refused with a 409 while a binding still names the row — the same rule as
  // the connection delete, because it IS the connection delete.
  router.delete('/services/:slug', asyncHandler(async (req, res) => {
    res.json(await removeConnection(req.params.slug));
  }));

  /**
   * List the instance's models through its DEFINITION's strategy — a probe of
   * its own endpoint with its own key, the local daemon, the program that signs
   * in, or the declared list — filtered to its plan. Needs no executable route.
   * An explicit discovery request: it lists, never generates, and a failure
   * keeps the catalog the instance already had.
   */
  router.post('/services/:slug/refresh-catalog', asyncHandler(async (req, res) => {
    res.json(await refreshServiceCatalog(req.params.slug));
  }));

  /**
   * Edit one harness binding's management state: its label and the subset of
   * the shared catalog it offers. Never its routes' enablement or consent —
   * those stay on `PATCH /api/providers/:id`, where granting them is explicit.
   */
  router.patch('/bindings/:id', asyncHandler(async (req, res) => {
    const input = validateRequest(providerBindingUpdateSchema, req.body ?? {});
    res.json(await updateBindingSettings({ bindingId: req.params.id, ...input }));
  }));

  /**
   * Edit ONE route's mode overrides (#6369) — args, timeout, effort, model pins.
   *
   * The per-mode counterpart to the shared-backend edit above, so a whole
   * backend is configurable from one screen instead of a connection plus three
   * route editors. Route-owned only: an endpoint, a credential and the `enabled`
   * flag are all unreachable here by construction, and `PATCH
   * /api/providers/:id` remains the place execution consent is granted.
   *
   * `expectedRevision` is the route's `settingsRevision` from
   * `GET /api/providers/management` — a fingerprint of the values on disk, so an
   * edit made in the route editor while this panel was open is a 409 too.
   */
  router.patch('/routes/:providerId', asyncHandler(async (req, res) => {
    const input = validateRequest(providerRouteSettingsUpdateSchema, req.body ?? {});
    res.json(await updateRouteSettings({ providerId: req.params.providerId, ...input }));
  }));

  /**
   * Correct ONE route's canonical→executable model aliases by hand (#6369).
   *
   * A refresh records only the aliases it can VERIFY — a stored model string
   * round-trips through the harness's own adapter or it stays an unresolved
   * alias rather than being rewritten — so a spelling the adapter cannot
   * reproduce reaches no shared catalog and no model menu. This is where a
   * human supplies it.
   *
   * `null` for a key removes that override and is the ONLY thing that does: a
   * refresh rewrites what it observed in a separate column, so a correction
   * survives it and an alias for a model the route no longer lists is kept and
   * reported stale rather than dropped.
   */
  router.patch('/routes/:providerId/model-aliases', asyncHandler(async (req, res) => {
    const input = validateRequest(providerRouteModelAliasSchema, req.body ?? {});
    res.json(await updateRouteModelAliases({ providerId: req.params.providerId, ...input }));
  }));

  router.get('/samples', asyncHandler(async (req, res) => {
    const providers = await providerService.getSampleProviders();
    const capabilities = await detectSystemCapabilities();
    res.json({ providers: providers.map((provider) => presentProvider(provider, capabilities)) });
  }));

  // A CLI/TUI provider is only usable if its runtime binary is on PortOS's
  // PATH. These are local coding tools, not LLM services PortOS may silently
  // bootstrap, so this endpoint only reports availability and the companion
  // install endpoint services an explicit click from the Providers page. Both
  // intentionally return no resolved filesystem paths, which could disclose the
  // host account name.
  router.get('/runtimes', asyncHandler(async (_req, res) => {
    res.json({ runtimes: await getProviderRuntimeStatuses() });
  }));

  /**
   * Requirements checklist for every provider backed by a LOCAL daemon
   * (llama.cpp, Ollama, LM Studio, MTPLX) — see `services/providerReadiness.js`.
   *
   * `/runtimes` above answers "can PortOS run this CLI?"; this answers "is the
   * daemon that CLI talks to installed, running, and serving the model this
   * provider asks for?" — the failure that otherwise only surfaces as
   * "Cannot connect to API" inside a dead agent transcript.
   *
   * Computed on the RAW providers on purpose: a sanitized copy redacts secret
   * env values, and a user's custom base URL can live in one
   * (`OPENCODE_CONFIG_CONTENT`, `ANTHROPIC_BASE_URL`), which would send the
   * probe at the wrong endpoint. The response carries booleans, labels, and the
   * provider's own already-displayed endpoint — never a resolved binary path.
   */
  router.get('/readiness', asyncHandler(async (req, res) => {
    // `?providerId=<composite>` answers for ONE composition (#7564): the
    // materialized record is what the readiness probe reads, so a composite
    // that resolves is judged exactly as a stored record on the same daemon.
    const compositeId = typeof req.query.providerId === 'string' ? req.query.providerId : null;
    if (compositeId) {
      const provider = await providerService.getProviderById(compositeId);
      res.json({ readiness: provider ? await getProviderReadinessMap([provider]) : {} });
      return;
    }
    const data = await providerService.getAllProviders();
    res.json({ readiness: await getProviderReadinessMap(data.providers) });
  }));

  /**
   * The composition catalog (#7564): every axis a `{ providerId, model, effort }`
   * picker composes over — harnesses with their enablement, service instances,
   * bootstrap apps, which harness reaches which service, the effort ladder per
   * harness (and per model where a model narrows it), and the stored presets.
   * Derived from cache and settings only: harness detection is the runtime
   * probe's cache, nothing is spawned, no provider is contacted.
   *
   * `GET /api/providers` stays presets-only — every existing `useProviderModels`
   * consumer keeps its shape; this is the additive surface for composing.
   */
  router.get('/catalog', asyncHandler(async (_req, res) => {
    const { buildProviderCatalog } = await import('../services/compositeProviders.js');
    const [catalog, data, capabilities] = await Promise.all([buildProviderCatalog(), providerService.getAllProviders(), detectSystemCapabilities()]);
    res.json({ ...catalog, presets: data.providers.map((provider) => presentProvider(provider, capabilities)) });
  }));

  /** Per-harness enablement (#7564): the user's word, else PATH detection, `direct` always on. */
  router.get('/harnesses', asyncHandler(async (_req, res) => {
    const { listHarnessEnablement } = await import('../services/harnessEnablement.js');
    res.json({ harnesses: await listHarnessEnablement() });
  }));

  router.put('/harnesses/:id', asyncHandler(async (req, res) => {
    const harnessId = validateRequest(harnessIdParamSchema, req.params.id);
    const { enabled } = validateRequest(harnessEnablementUpdateSchema, req.body || {});
    const { setHarnessEnabled } = await import('../services/harnessEnablement.js');
    res.json({ harness: { id: harnessId, ...(await setHarnessEnabled(harnessId, enabled)) } });
  }));

  /**
   * Credential-bootstrap apps (#7564): the wrapper CLIs a composite's
   * `+<slug>` suffix names. Saving never spawns anything — `setupCommand` is
   * advisory text, and the wrapper runs only when a composite is executed.
   */
  router.get('/bootstraps', asyncHandler(async (_req, res) => {
    const { listCredentialBootstraps } = await import('../services/credentialBootstrapApps.js');
    res.json({ bootstraps: await listCredentialBootstraps() });
  }));

  router.put('/bootstraps', asyncHandler(async (req, res) => {
    const bootstraps = validateRequest(credentialBootstrapsSettingsSchema, req.body?.bootstraps ?? req.body ?? {});
    const { saveCredentialBootstraps } = await import('../services/credentialBootstrapApps.js');
    res.json({ bootstraps: await saveCredentialBootstraps(bootstraps) });
  }));

  /**
   * One composite's verdict (#7564): eligible or not, with the reason a picker
   * shows beside a saved selection that names it, and — when eligible — the
   * materialized record sanitized exactly as a stored one (`presentProvider`:
   * `apiKey` → `hasApiKey`, secret env values redacted).
   */
  router.get('/composites/:id', asyncHandler(async (req, res) => {
    const { describeCompositeProvider } = await import('../services/compositeProviders.js');
    const { record, ...verdict } = await describeCompositeProvider(req.params.id);
    res.json({ ...verdict, provider: record ? presentProvider(record, await detectSystemCapabilities()) : null });
  }));

  /**
   * "Save as preset" (#7565): store the record a composite id resolves to, as
   * an enabled derived preset the picker can name like any other. The
   * resolver's verdict gates it — an ineligible composite is a 400 with its
   * code and reason, never a stored record that cannot run. `model` and
   * `effort` become the preset's defaults; a `+<bootstrap>` suffix becomes
   * its `credentialBootstrapId`.
   */
  router.post('/presets', asyncHandler(async (req, res) => {
    const input = validateRequest(providerPresetCreateSchema, req.body ?? {});
    const { createPresetFromComposite } = await presetService();
    const created = await createPresetFromComposite(input);
    res.status(201).json(presentProvider(created, await detectSystemCapabilities()));
  }));

  /**
   * Is a ChatGPT subscription signed in, and is it usable right now?
   *
   * The Codex CLI/TUI cards could already say whether the `codex` binary
   * exists; they could not say whether the account behind it is signed in, on
   * which plan, expired, or out of quota — the user learned that from a failed
   * agent transcript. The answer comes from the Codex app-server's own
   * `account/read`: PortOS never reads Codex's credential file and never holds
   * a token.
   *
   * LAZY BY CONTRACT. This is the call that may spawn `codex app-server`, and
   * it runs only from an explicit page fetch — nothing on the boot path calls
   * it, and `GET /api/providers` decorates its cards from the cache-only peek.
   * `?fresh=1` skips the TTL for the poll that follows a sign-in.
   *
   * The payload carries a status, a plan name, and quota percentages. No token,
   * no account id, no email, no credential path.
   */
  router.get('/codex/account', asyncHandler(async (req, res) => {
    res.json({ readiness: await getCodexAccountReadiness({ fresh: req.query.fresh === '1' }) });
  }));

  /**
   * Begin an explicit ChatGPT sign-in and return only the URL (browser flow) or
   * the verification URL plus short code (device-code flow) the user needs.
   *
   * A POST because it starts an OAuth flow — never a side effect of a read.
   * The response deliberately contains no token material, and `loginId` is the
   * bounded handle the cancel endpoint takes.
   */
  router.post('/codex/account/login', asyncHandler(async (req, res) => {
    const { deviceCode } = validateRequest(codexLoginStartSchema, req.body ?? {});
    res.json({ login: await startCodexChatGptLogin({ deviceCode }) });
  }));

  /**
   * Abandon the sign-in this PortOS started. The id must match the pending
   * login, so a stale tab cannot cancel a flow the user began afterwards.
   */
  router.post('/codex/account/login/cancel', asyncHandler(async (req, res) => {
    const { loginId } = validateRequest(codexLoginCancelSchema, req.body ?? {});
    res.json({ readiness: await cancelCodexChatGptLogin(loginId) });
  }));

  /**
   * Which models this ChatGPT subscription may run, from the app-server's own
   * catalog rather than a hard-coded list — so the picker reflects the account's
   * actual plan.
   *
   * LAZY, like `/codex/account`: only an explicit page fetch reaches it.
   * `?fresh=1` skips the TTL after a plan change or a sign-in.
   *
   * `models: null` means NEVER FETCHED, `[]` means fetched-and-empty, and a read
   * that fails returns the last-known-good list alongside `error` — the client
   * must not repaint an empty picker because one call timed out.
   */
  router.get('/codex/models', asyncHandler(async (req, res) => {
    res.json(await listCodexModels({ fresh: req.query.fresh === '1' }));
  }));

  /** Sign out. Codex drops its own credentials; PortOS has none to clear. */
  router.post('/codex/account/logout', asyncHandler(async (_req, res) => {
    res.json({ readiness: await codexLogout() });
  }));

  // Install-only: the update and remove lanes of the shared runner are reached
  // from `/api/harnesses`, which is where the Harnesses page drives them. See
  // `services/harnessActionStream.js` for the stream contract.
  const streamRuntimeInstall = (req, res, runtimeId) =>
    streamHarnessAction(req, res, { runtime: runtimeId, action: 'install' });

  /**
   * Install and/or start the LOCAL DAEMON one provider points at, streaming
   * progress as SSE. This is the "do it for me" half of `/readiness`: the
   * checklist says llama.cpp / Ollama / LM Studio / MTPLX is missing or down,
   * and this fixes it without sending the user to a vendor setup doc.
   *
   * The request names a PROVIDER id, never an endpoint, port, or command. The
   * runtime kind and the endpoint are both re-derived server-side from the
   * stored provider record, so nothing from the query reaches a spawn argument
   * — the `runtime` param is only cross-checked against what the record
   * resolves to, so a stale page cannot set up a different daemon than the card
   * it was clicked on.
   */
  router.post('/readiness/setup', asyncHandler(async (req, res) => {
    const providerId = String(req.query.provider || '');
    const data = await providerService.getAllProviders();
    // RAW record on purpose — a sanitized copy redacts the secret env values a
    // custom base URL can live in, which would resolve the wrong endpoint.
    const provider = (data.providers || []).find((row) => row.id === providerId);
    if (!provider) {
      throw new ServerError('Unknown provider', { status: 404, code: 'UNKNOWN_PROVIDER', context: { provider: providerId } });
    }
    const runtime = localRuntimeForProvider(provider);
    if (!runtime) {
      throw new ServerError('This provider does not depend on a local runtime PortOS can set up.', { status: 400, code: 'NO_LOCAL_RUNTIME' });
    }
    const requested = req.query.runtime ? String(req.query.runtime) : runtime.kind;
    if (requested !== runtime.kind) {
      throw new ServerError('This provider no longer uses that runtime — reload the page and try again.', { status: 409, code: 'RUNTIME_MISMATCH' });
    }
    // Which of the fixed steps the checklist's button named. Matched against the
    // closed set rather than passed through, so the only thing an unexpected
    // value can do is 400 — it never reaches a command. Absent stays `null`
    // rather than becoming a default here: a client built before this parameter
    // existed still renders THIS server's button label, so the service resolves
    // what the checklist is currently offering instead of assuming a start.
    const action = req.query.action ? String(req.query.action) : null;
    if (action !== null && !SETUP_ACTIONS.includes(action)) {
      throw new ServerError('Unknown setup action.', { status: 400, code: 'UNKNOWN_SETUP_ACTION', context: { action } });
    }

    const { send, safeEnd } = openSseStream(res);
    const installLog = createInstallLogger({ installer: runtime.label, target: runtime.endpoint });
    let clientGone = false;
    let holdsLock = false;
    // Closing the modal stops the WAIT, not the work: unlike the CLI installer
    // above there is no single child to SIGTERM (a step may be mid-`brew
    // install`), so the lock stays held until the setup actually settles —
    // releasing it here would let a second click start a competing install
    // into the same prefix. `isCancelled` makes that window short: the setup
    // bails before its next step rather than running to the end.
    onClientDisconnect(req, res, () => {
      clientGone = true;
      installLog.cancel();
      safeEnd();
    });

    if (runtimeSetupInFlight) {
      send({ type: 'error', message: 'Another local-runtime setup is already running. Wait for it to finish.' });
      return safeEnd();
    }
    if (clientGone) return safeEnd();
    runtimeSetupInFlight = true;
    holdsLock = true;

    send({ type: 'stage', stage: 'setup', message: `Setting up ${runtime.label} for ${runtime.endpoint}.` });
    installLog.start();
    const emit = (message) => {
      const event = { type: 'log', message };
      installLog.onEvent(event);
      send(event);
    };

    // `runLocalRuntimeSetup` resolves for every expected failure; the `.catch`
    // covers the unexpected throw. Either way the headers are already flushed,
    // so the outcome has to be a terminal SSE frame rather than a 500 body.
    const result = await runLocalRuntimeSetup(runtime.kind, {
      endpoint: runtime.endpoint,
      emit,
      isCancelled: () => clientGone,
      action,
    }).catch((err) => ({ success: false, error: err.message }));

    if (holdsLock) { runtimeSetupInFlight = false; holdsLock = false; }
    // A daemon just came up (or a binary just landed) — the readiness caches
    // remember it being down, and the page polls them within seconds.
    resetProviderReadinessCache();
    if (clientGone) return safeEnd();
    const terminal = result.success
      ? { type: 'complete', message: result.message || `${runtime.label} is ready.` }
      : { type: 'error', message: result.error || `${runtime.label} setup failed.` };
    installLog.onEvent(terminal);
    send(terminal);
    safeEnd();
  }));

  /**
   * Relaunch the local daemon so it answers under the model id THIS provider
   * sends — the other half of the readiness checklist's model mismatch.
   *
   * "Use `dflash` as default" already moved the provider onto whatever the
   * server happens to answer as. This moves the server instead, which is what a
   * user wants when they picked the model id deliberately: llama.cpp serves one
   * model per process under the `--alias` on its launch line, so the mismatch is
   * a label, not a missing download, and renaming it keeps the weights that are
   * already loaded.
   *
   * Only runtimes that HAVE such a label (`aliasFlag`) qualify; the model id is
   * re-derived server-side from the stored provider record, so nothing from the
   * query reaches a launch argument.
   */
  router.post('/readiness/serve-model', asyncHandler(async (req, res) => {
    const providerId = String(req.query.provider || '');
    const data = await providerService.getAllProviders();
    // RAW record — a sanitized copy redacts the secret env values a custom base
    // URL can live in, which would resolve the wrong runtime.
    const provider = (data.providers || []).find((row) => row.id === providerId);
    if (!provider) {
      throw new ServerError('Unknown provider', { status: 404, code: 'UNKNOWN_PROVIDER', context: { provider: providerId } });
    }
    const runtime = localRuntimeForProvider(provider);
    if (!runtime?.aliasFlag) {
      throw new ServerError(
        'This provider\'s runtime names its model after the weights it loaded, so PortOS cannot rename it — change the provider\'s default model instead.',
        { status: 400, code: 'NO_MODEL_ALIAS' },
      );
    }
    const wanted = servedModelId(provider, runtime.kind);
    if (!wanted) {
      throw new ServerError('This provider selects no specific model, so there is nothing to serve it as.', { status: 400, code: 'NO_DEFAULT_MODEL' });
    }

    // The provider's OWN endpoint, not the runtime's default: a second
    // llama-server on another loopback port is a different daemon, and PortOS
    // only manages one (`portos-llama-server`). Without this the button on a
    // provider pointed at that second server would restart the managed one under
    // the second one's model id — breaking the provider that WAS working and
    // leaving the clicked one mismatched exactly as before.
    const managedEndpoint = await getLlamaServerEndpoint();
    // Compared by PORT, not by string: the manager renders its host as
    // `127.0.0.1` while a provider may spell the same daemon `localhost`, and a
    // string compare would refuse a setup that works. `localRuntimeForProvider`
    // already guarantees `runtime.endpoint` is a local-instance host, so a
    // matching port is the same daemon.
    if (localEndpointPort(runtime.endpoint) !== localEndpointPort(managedEndpoint)) {
      throw new ServerError(
        `This provider points at ${runtime.endpoint}, but the llama-server PortOS manages serves ${managedEndpoint}. Add \`--alias ${wanted}\` to that server's own launch line instead.`,
        { status: 409, code: 'LLAMA_ENDPOINT_MISMATCH' },
      );
    }

    // A relaunch reloads multi-gigabyte weights onto the accelerator, and an
    // assessment sweep relaunches the same daemon on its own schedule — so this
    // takes the machine-wide claim those jobs take rather than a lock private to
    // this route. Zero timeout: an interactive click refuses immediately with
    // who holds it rather than queueing behind hours of sweep.
    const claim = await claimHeavyLocalJob({ kind: 'llama-server model id', id: wanted, timeoutMs: 0 });
    if (!claim.ok) {
      throw new ServerError(claim.message, { status: 409, code: 'LOCAL_ACCELERATOR_BUSY' });
    }
    // `relaunchLlamaServerWithAlias` resolves for every expected refusal, so
    // this covers the unexpected throw — the claim must not survive it, or every
    // later heavy local job is refused until the process exits.
    const result = await relaunchLlamaServerWithAlias(wanted).finally(() => claim.release());
    // The daemon's launch line just changed under the readiness caches, and the
    // page polls them within seconds.
    resetProviderReadinessCache();
    if (result.applied === false) {
      throw new ServerError(result.reason, {
        // A PM2 read that failed says nothing about the daemon — the fix is to
        // retry, not to go edit a launch line.
        status: result.retryable ? 503 : 409,
        code: result.retryable ? 'SERVE_MODEL_UNAVAILABLE' : 'SERVE_MODEL_FAILED',
        context: { model: wanted },
      });
    }
    res.json({
      success: true,
      model: wanted,
      // `null` = it already answered under that id, so nothing was restarted.
      relaunched: result.applied === true,
    });
  }));

  // `runtime` rides in the query string because the shared RuntimeInstallModal
  // already appends it there for every BYO-runtime installer.
  router.post('/runtimes/install', asyncHandler(async (req, res) => {
    await streamRuntimeInstall(req, res, req.query.runtime);
  }));

  // Back-compat for a client build that predates the generalized routes (a
  // deployed `client/dist` can lag the server across an upgrade). Both mirror
  // the old OpenCode-only response shape exactly.
  router.get('/opencode/installation', asyncHandler(async (_req, res) => {
    const status = await getProviderRuntimeStatus('opencode');
    res.json({ installed: status.installed, npmAvailable: status.installable });
  }));

  router.post('/opencode/install', asyncHandler(async (req, res) => {
    await streamRuntimeInstall(req, res, 'opencode');
  }));

  // Provider status routes MUST be defined before toolkit routes,
  // because the toolkit has a GET /:id route that would catch /status
  const presentProviderStatus = (status) => {
    // Keep a second allowlist at the HTTP boundary even though the toolkit
    // service already presents sanitized status. The route is the final guard
    // if a host injects a different provider-status implementation.
    const { rateLimitWindow, ...publicStatus } = status || {};
    if (!rateLimitWindow || typeof rateLimitWindow !== 'object') return publicStatus;
    const allowedWindow = Object.fromEntries(
      ['observedAt', 'retryAfterMs', 'resetAt', 'remaining', 'limit']
        .filter(key => rateLimitWindow[key] != null)
        .map(key => [key, rateLimitWindow[key]])
    );
    return Object.keys(allowedWindow).length
      ? { ...publicStatus, rateLimitWindow: allowedWindow }
      : publicStatus;
  };

  // GET /model-pins — stored model pins naming a model their provider no longer
  // lists (#7315). Registered BEFORE '/:id' so the literal path is not read as a
  // provider id. Derived on read, never persisted: see services/modelPinAudit.js.
  router.get('/model-pins', asyncHandler(async (_req, res) => {
    res.json(await auditModelPins());
  }));

  // POST /model-pins/clear — clear ONE pin back to "inherit". A pin is the
  // user's own choice, so PortOS surfaces a retirement and never rewrites it;
  // this is that one-click clear. Clearing a pin that is already gone is a
  // success with `cleared: false`, not a 404 — the outcome the caller wanted.
  router.post('/model-pins/clear', asyncHandler(async (req, res) => {
    const { pinId } = validateRequest(modelPinClearSchema, req.body ?? {});
    res.json(await clearModelPin(pinId));
  }));

  router.get('/status', asyncHandler(async (req, res) => {
    const statuses = providerStatusService.getAllStatuses();
    // Enrich with time until recovery
    const enriched = { ...statuses };
    for (const [providerId, status] of Object.entries(enriched.providers)) {
      enriched.providers[providerId] = {
        ...presentProviderStatus(status),
        timeUntilRecovery: providerStatusService.getTimeUntilRecovery(providerId)
      };
    }
    res.json(enriched);
  }));

  router.get('/:id/status', asyncHandler(async (req, res) => {
    const status = presentProviderStatus(providerStatusService.getStatus(req.params.id));
    res.json({
      ...status,
      timeUntilRecovery: providerStatusService.getTimeUntilRecovery(req.params.id)
    });
  }));

  router.post('/:id/status/recover', asyncHandler(async (req, res) => {
    const status = await providerStatusService.markAvailable(req.params.id);
    res.json({ success: true, status });
  }));

  // PortOS-specific extensions (parameterized routes before toolkit mount)
  router.get('/:id/vision-health', asyncHandler(async (req, res) => {
    const result = await checkVisionHealth(req.params.id);
    res.json(result);
  }));

  router.post('/:id/test-vision', asyncHandler(async (req, res) => {
    const { imagePath, prompt, expectedContent, model } = validateRequest(providerVisionTestSchema, req.body);

    const result = await testVision({
      imagePath,
      prompt: prompt || 'Describe what you see in this image.',
      expectedContent: expectedContent || [],
      providerId: req.params.id,
      model
    });

    res.json(result);
  }));

  router.post('/:id/vision-suite', asyncHandler(async (req, res) => {
    const { model } = validateRequest(providerVisionSuiteSchema, req.body);
    const result = await runVisionTestSuite(req.params.id, model);
    res.json(result);
  }));

  /**
   * "Convert to derived preset" (#7565): stamp one legacy record with the
   * harness, method and service instance it already runs on — only when
   * re-deriving it from that service reproduces every connection-owned value
   * it carries (the same fixpoint the boot backfill applies). Refused with the
   * reason otherwise; nothing about how the record runs is changed either way.
   */
  router.post('/:id/derive', asyncHandler(async (req, res) => {
    const { derivePreset } = await presetService();
    const provider = await derivePreset(req.params.id);
    res.json(presentProvider(provider, await detectSystemCapabilities()));
  }));

  // Sanitized GET /:id — must be after specific /:id/* routes above
  router.get('/:id', asyncHandler(async (req, res) => {
    const provider = await providerService.getProviderById(req.params.id);
    if (!provider) throw new ServerError('Provider not found', { status: 404 });
    res.json(presentProvider(provider, await detectSystemCapabilities()));
  }));

  // PUT /:id — intercept to (a) validate the body via a partial provider
  // schema (PUT can be a partial update; only the fields the client sent are
  // re-validated), and (b) preserve redacted secrets before passing to the
  // toolkit. Without partial validation, an `updateProvider` call could
  // still persist invalid types (timeout: "abc", non-object envVars) the
  // POST path now blocks.
  router.put('/:id', asyncHandler(async (req, res) => {
    const existing = await providerService.getProviderById(req.params.id);
    if (!existing) throw new ServerError('Provider not found', { status: 404 });

    const validation = validate(providerSchema.partial(), req.body);
    if (!validation.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: validation.errors } });
    }

    const updates = { ...validation.data };

    // Preserve an actually persisted apiKey if the client didn't send a new
    // one. Gateway-backed CLI/TUI wrappers receive their sibling API key as a
    // non-enumerable, execution-only property; carrying that value into a
    // derived-preset update turns an inherited credential into a direct edit
    // and makes an otherwise harmless save fail with PRESET_FIELD_DERIVED.
    if (!('apiKey' in updates) && Object.prototype.propertyIsEnumerable.call(existing, 'apiKey')) {
      updates.apiKey = existing.apiKey;
    }

    // Preserve existing secret env var values when client sends redacted '***' placeholders
    if (updates.envVars && Array.isArray(existing.secretEnvVars)) {
      for (const key of existing.secretEnvVars) {
        if (updates.envVars[key] === '***' && existing.envVars?.[key]) {
          updates.envVars[key] = existing.envVars[key];
        }
      }
    }

    // A DERIVED preset (#7565) stores what its service derives — see
    // `storableProviderRecord` for what is refused and what is read as a narrowing.
    const { storableProviderRecord } = await presetService();
    const stored = await storableProviderRecord({ ...existing, ...updates, id: req.params.id }, updates, existing);

    const provider = await providerService.updateProvider(req.params.id, stored);
    res.json(presentProvider(withResolvedModelAccess(provider, existing), await detectSystemCapabilities()));
  }));

  // POST /:id/refresh-models — intercept the toolkit response so the refreshed
  // provider record receives the same secret redaction as every other provider
  // response. The toolkit returns its raw persisted record here.
  router.post('/:id/refresh-models', asyncHandler(async (req, res) => {
    const stored = await providerService.getProviderById(req.params.id);
    if (!stored) throw new ServerError('Provider not found', { status: 404 });
    // A record can match BOTH paths — `cursor-cli` and `antigravity-cli` do
    // today — so the precedence is fixed here: the TOOLKIT FETCHER WINS, and
    // the harness catalog serves only records no fetcher claims. The fetcher
    // table keys on the launch command (and, failing that, the display name),
    // which is a per-record answer; routing a record the table already claims
    // to its harness instead would silently move where its catalog comes from.
    const harness = canRefreshModels(stored) ? null : harnessCatalogRuntime(stored);
    let provider;
    if (isDerivedPreset(stored) && providerGraphEnabled()) {
      // A DERIVED preset's models are its service's catalog (#7565). Writing a
      // probe onto the record alone leaves that catalog stale, so the next
      // derivation discards what was found — refresh the service instead, which
      // re-derives every preset on it.
      const { service } = await refreshServiceCatalog(stored.serviceId);
      if (service.catalog?.state === 'failed') {
        throw new ServerError(service.catalog.error || 'The service could not list its models; its catalog was preserved.', { status: 502 });
      }
      provider = await providerService.getProviderById(stored.id);
    } else if (harness) {
      // Scoped to THIS record: the harness is probed once per bootstrap
      // credential (services/harnesses.js), and a card's button must not spawn
      // another record's credential CLI to answer for its own.
      const result = await refreshHarnessModels(harness.id, { providerId: stored.id });
      if (!result.ok || !result.updated.includes(stored.id)) {
        throw new ServerError(result.reason || 'No models matched this provider’s namespace; its catalog was preserved.', { status: 502 });
      }
      provider = await providerService.getProviderById(stored.id);
    } else {
      provider = await providerService.refreshProviderModels(req.params.id);
    }
    if (!provider) throw new ServerError('Provider not found', { status: 404 });
    res.json(presentProvider(withResolvedModelAccess(provider, stored), await detectSystemCapabilities()));
  }));

  /**
   * POST /:id/modes/tui — give an existing CLI record the TUI half of its
   * harness, minted from the record already on disk.
   *
   * A NEW endpoint rather than a flag on `PUT /:id`, because `modes` is
   * deliberately create-only: a PATCH against one record cannot mean "make me
   * two". `:id` names the record the sibling is DERIVED from, and the sibling
   * is built from what is stored — the user does not retype the command,
   * endpoint, credentials and env that `providerModeGroups` then has to find
   * identical on both halves.
   *
   * There is no request body: every field either comes from the stored record
   * or from the harness recipe. The new record is editable like any other
   * afterwards.
   */
  router.post('/:id/modes/tui', asyncHandler(async (req, res) => {
    const { providers } = await providerService.getAllProviders();
    const stored = providers.find(provider => provider.id === req.params.id);
    if (!stored) throw new ServerError('Provider not found', { status: 404 });

    // The same verdict the list decorated this record with, so a card can only
    // ever offer an action this endpoint accepts.
    const verdict = tuiModeAddition(stored, providers);
    if (!verdict.ok) throw new ServerError(verdict.message, { status: verdict.status, code: verdict.code });

    const created = await providerService.createProviderTuiMode(stored.id, { args: verdict.args });
    res.status(201).json(presentProvider(created, await detectSystemCapabilities()));
  }));

  // POST / — intercept to (a) validate the body against providerCreateSchema so
  // invalid fields like `timeout: "abc"` or non-object `envVars` don't
  // persist and later break runner behavior, and (b) sanitize the created
  // provider before responding so apiKey/secret envVar values don't echo
  // back to the client (the toolkit's POST returns the raw provider).
  //
  // A body declaring `modes` creates BOTH execution modes of one harness and
  // responds with `{ providers: [cli, tui] }` — a distinct shape rather than a
  // polymorphic one, so a caller reading `.id` off a single-mode create keeps
  // working and a pair create cannot silently hide the id of the second record.
  router.post('/', asyncHandler(async (req, res) => {
    const validation = validate(providerCreateSchema, req.body);
    if (!validation.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: validation.errors } });
    }
    if (validation.data.modes) {
      const created = await providerService.createProviderModes(validation.data);
      // One snapshot for the pair — the probe is per-host, not per-record, and
      // it stays BEHIND the create so a refused one never pays for it.
      const capabilities = await detectSystemCapabilities();
      res.status(201).json({ providers: created.map(provider => presentProvider(provider, capabilities)) });
      return;
    }
    // A body naming a harness, method and service is a DERIVED preset (#7565).
    const { storableProviderRecord } = await presetService();
    const provider = await providerService.createProvider(await storableProviderRecord(validation.data, validation.data));
    res.status(201).json(presentProvider(provider, await detectSystemCapabilities()));
  }));

  // Mount base toolkit routes last (GET/PUT /:id, POST /, and
  // POST /:id/refresh-models are now shadowed by sanitized versions above).
  // DELETE /:id has no provider body; POST /:id/test returns only its test
  // result, so neither endpoint needs a sanitizing shadow.
  router.use('/', aiToolkit.routes.providers);

  return router;
}
