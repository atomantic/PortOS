import { Router } from 'express';
import { providerModeGroups } from '../../lib/aiToolkit/internal/providerModes.js';
import { tuiModeAddition } from '../../lib/provider/providerModePairing.js';
import { findConnectionByRef, providerGraphEnabled } from '../../services/provider/providerGraph.js';
import { readGraph } from '../../services/provider/providerGraphStore.js';
import { refreshServiceCatalog } from '../../services/provider/providerServices.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import {
  providerCreateSchema,
  providerSchema,
  providerActiveSchema,
  validate,
} from '../../lib/aiToolkit/validation.js';
import { canRefreshModels } from '../../lib/aiToolkit/internal/modelFetchers.js';
import { ALLOWED_COMMANDS } from '../../cos-runner/allowedCommands.js';
import { harnessCatalogRuntime, refreshHarnessModels } from '../../services/harnesses.js';
import { getProviderPrerequisiteMap } from '../../services/provider/providerPrerequisites.js';
import { isCodexSubscriptionProvider } from '../../lib/codexAccount.js';
import { peekCodexAccountReadiness, peekCodexModelCatalog } from '../../services/codexAppServer.js';
import { isLocalInstanceEndpoint, LOCAL_RUNTIMES } from '../../lib/localProviderRuntime.js';
import { expandPageToken } from '../../lib/navManifest.js';
import { isMaskedEnvVar } from '../../lib/credentialEnvVars.js';
import { isDerivedPreset } from '../../lib/provider/providerGraphRecords.js';
import { detectSystemCapabilities } from '../../lib/systemCapabilities.js';
import { serviceDefinitionById } from '../../lib/serviceDefinitions.js';
import { presentProvider } from './presenter.js';
import { isUntrustedContentProvider } from '../../lib/untrustedContentSelection.js';
import { untrustedContentWindowsFor } from '../../lib/untrustedContentWindow.js';

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

/**
 * Bring a managed MTPLX up before its catalog is probed (#17439).
 *
 * A derived preset's catalog is its service's catalog, and a service pointed at
 * a stopped local MTPLX answers `ECONNREFUSED` — the same failure the card
 * then renders as a bare connection error. A routed inference request goes
 * through `ensureMtplxRunning` first, and the refresh path does the same.
 * Only the install's OWN daemon is woken: a managed MTPLX row pointed at a
 * remote port, or a service with another definition, is left exactly as it is.
 * A stop with no saved launch line is a typed refusal, not a connection
 * failure — the card renders the refusal with a link to Models → Runtimes.
 *
 * The managed daemon is lazy-imported so no suite that never refreshes a
 * managed MTPLX pays for the process-manager graph (server/AGENTS.md
 * "Import scoping").
 */
async function wakeManagedMtpxForRefresh(serviceSlug) {
  const graph = await readGraph();
  const connection = findConnectionByRef(graph, serviceSlug);
  if (!connection) return;
  const definition = connection.definitionId ? serviceDefinitionById(connection.definitionId) : null;
  if (definition?.localRuntime !== 'mtplx') return;
  const endpoint = connection.transports?.openai?.baseUrl;
  if (!endpoint || !isLocalInstanceEndpoint(endpoint)) return;
  const { getMtplxSavedLaunch, ensureMtplxRunning } = await import('../../services/mtplxServerManager.js');
  const saved = await getMtplxSavedLaunch();
  if (!saved || Object.keys(saved.raw ?? {}).length === 0) {
    console.log('🚄 MTPLX catalog refresh refused — the server is stopped and has no saved launch line');
    throw new ServerError(
      expandPageToken('MTPLX is stopped and has no saved launch line — open the MTPLX card in {page} to start it and save its launch line, then refresh again.', LOCAL_RUNTIMES.mtplx),
      {
        status: 409,
        code: 'MTPLX_STOPPED',
        context: { refreshNotice: { runtime: 'mtplx', manageUrl: LOCAL_RUNTIMES.mtplx.manageUrl } },
      },
    );
  }
  const { ready, reason } = await ensureMtplxRunning();
  if (!ready) {
    throw new ServerError(
      `MTPLX is stopped and PortOS could not start it: ${reason || 'unknown error'}`,
      { status: 502, code: 'MTPLX_START_FAILED' },
    );
  }
}

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

// Deferred: the preset service reaches the graph store and composite resolver.
const presetService = () => import('../../services/provider/providerPresets.js');

export function createProviderManagementRoutes(providerService, readProviders) {
  const router = Router();

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
    const data = await readProviders();
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
        // The policy editor previews unsaved provider/model choices against the host budget.
        ...(isUntrustedContentProvider(provider) ? { untrustedContentWindows: untrustedContentWindowsFor(provider) } : {}),
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

  router.get('/samples', asyncHandler(async (req, res) => {
    const providers = await providerService.getSampleProviders();
    const capabilities = await detectSystemCapabilities();
    res.json({ providers: providers.map((provider) => presentProvider(provider, capabilities)) });
  }));

  // Mounted after the other PortOS provider routers so literal paths win.
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

    // Preserve existing secret/credential-named env var values when client sends redacted '***' placeholders
    if (updates.envVars) {
      for (const [key, value] of Object.entries(updates.envVars)) {
        if (value === '***' && existing.envVars?.[key] && isMaskedEnvVar(key, existing.secretEnvVars)) {
          updates.envVars[key] = existing.envVars[key];
        }
      }
    }

    // A DERIVED preset (#7565) stores what its service derives — see
    // `storableProviderRecord` for what is refused and what is read as a narrowing.
    const { storableProviderRecord } = await presetService();
    const stored = await storableProviderRecord({ ...existing, ...updates, id: req.params.id }, updates, existing);

    const provider = Array.isArray(updates.models) && !isDerivedPreset(existing)
      ? await providerService.updateProvider(req.params.id, stored, { trackModelRemovals: true })
      : await providerService.updateProvider(req.params.id, stored);
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
      // re-derives every preset on it. A stopped managed MTPLX is woken first,
      // exactly as a routed request would wake it.
      await wakeManagedMtpxForRefresh(stored.serviceId);
      const { service } = await refreshServiceCatalog(stored.serviceId, { resetPresetId: stored.id });
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

  return router;
}
