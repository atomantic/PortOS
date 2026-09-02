import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { testVision, runVisionTestSuite, checkVisionHealth } from '../services/visionTest.js';
import { providerSchema, providerActiveSchema, validate } from '../lib/aiToolkit/validation.js';
import { withRefreshCapability } from '../lib/aiToolkit/internal/modelFetchers.js';
import { ALLOWED_COMMANDS } from '../cos-runner/allowedCommands.js';
import { createLineReader } from '../lib/streamLines.js';
import { onClientDisconnect, openSseStream } from '../lib/sseDownload.js';
import { createInstallLogger } from '../lib/installLogger.js';
import {
  validateRequest,
  codexLoginCancelSchema,
  codexLoginStartSchema,
  providerVisionTestSchema,
  providerVisionSuiteSchema,
} from '../lib/validation.js';
import {
  describeRuntimeInstall,
  getProviderRuntime,
  getProviderRuntimeStatus,
  getProviderRuntimeStatuses,
  spawnRuntimeInstaller,
  stopRuntimeInstaller,
} from '../services/providerRuntimeInstaller.js';
import { getProviderReadinessMap, resetProviderReadinessCache, servedModelId } from '../services/providerReadiness.js';
import { getLlamaServerEndpoint, relaunchLlamaServerWithAlias } from '../services/llamaServerManager.js';
import { claimHeavyLocalJob } from '../lib/heavyJobClaim.js';
import { getProviderPrerequisiteMap } from '../services/providerPrerequisites.js';
import { isCodexSubscriptionProvider } from '../lib/codexAccount.js';
import {
  cancelCodexChatGptLogin,
  peekCodexAccountReadiness,
  codexLogout,
  listCodexModels,
  getCodexAccountReadiness,
  startCodexChatGptLogin,
} from '../services/codexAppServer.js';
import { runLocalRuntimeSetup, SETUP_ACTIONS } from '../services/localRuntimeSetup.js';
import { localEndpointPort, localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { supportsPublicReviewProvider } from '../lib/providerVendors.js';
import { buildTuiShellLaunch } from '../lib/tuiShellLaunch.js';
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

// One global CLI install at a time — npm's global prefix and the vendor
// install scripts all write the same bin directory. This is a lightweight
// re-entrancy guard for a double-click or a second browser tab; its child stays
// in the route so a client disconnect can terminate it.
let runtimeInstallInFlight = null;

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
  return sanitizeProvider({
    ...decorated,
    publicReviewSupported: supportsPublicReviewProvider(provider, { tui: provider?.type === 'tui' }),
  });
};

/**
 * Create PortOS-specific provider routes
 * Extends AI Toolkit routes with vision testing endpoints
 */
export function createPortOSProviderRoutes(aiToolkit) {
  const router = Router();
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
    const capabilities = await detectSystemCapabilities();
    // Cache-only: this list must stay a synchronous read that spawns nothing.
    // `null` here means NOT PROBED, and the dedicated `/codex/account` fetch is
    // what fills it — a card renders "unknown", never "signed out", until then.
    const codexAccount = peekCodexAccountReadiness();
    res.json({
      activeProvider: data.activeProvider,
      providers: data.providers.map((provider) => ({
        ...presentProvider(provider, capabilities),
        prerequisitesMet: prerequisites[provider.id]?.met ?? true,
        missingPrerequisites: prerequisites[provider.id]?.missing ?? [],
        ...(isCodexSubscriptionProvider(provider) ? { codexAccount } : {}),
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
  router.get('/readiness', asyncHandler(async (_req, res) => {
    const data = await providerService.getAllProviders();
    res.json({ readiness: await getProviderReadinessMap(data.providers) });
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

  /**
   * Install one provider runtime, streaming the installer's output as SSE.
   *
   * Installing a global CLI mutates host state, so this stays a POST even
   * though the response is SSE-encoded. The client reads it with fetch rather
   * than EventSource: EventSource would auto-reconnect after a dropped stream
   * and could launch another non-idempotent install.
   *
   * The request names a runtime *id* only. The command, package, and URL all
   * come from the installer's fixed table, so no request input ever reaches a
   * shell word.
   */
  const streamRuntimeInstall = async (req, res, runtimeId) => {
    // Table lookup only (no I/O), so an unknown id is a plain 400 instead of a
    // stream that only says "no" once the modal is up. The real probe waits
    // until the disconnect handler is registered below.
    const row = getProviderRuntime(runtimeId);
    if (!row) {
      throw new ServerError('Unknown provider runtime', { status: 400, code: 'UNKNOWN_RUNTIME', context: { runtime: String(runtimeId || '') } });
    }

    const { send, safeEnd } = openSseStream(res);
    const installLog = createInstallLogger({ installer: row.label, target: `${row.command} on PortOS's PATH` });
    const emit = (event) => { installLog.onEvent(event); send(event); };
    let child = null;
    let finished = false;
    let clientGone = false;
    let reservation = null;

    // Register before the availability probe. If the modal closes while the
    // probe is resolving, do not start an installer nobody can observe.
    onClientDisconnect(req, res, () => {
      clientGone = true;
      installLog.cancel();
      if (finished) return;
      if (child) stopRuntimeInstaller(child);
      if (reservation && runtimeInstallInFlight === reservation) runtimeInstallInFlight = null;
      safeEnd();
    });

    // Un-cached: the user may have just installed this CLI in a terminal, and a
    // stale "not installed" would run a redundant install.
    const runtime = await getProviderRuntimeStatus(row.id, { fresh: true });
    if (clientGone) return safeEnd();
    if (runtime.installed) {
      send({ type: 'log', message: `${runtime.label} is already available to PortOS.` });
      send({ type: 'complete', message: 'Already installed — nothing to do.' });
      return safeEnd();
    }
    if (!runtime.installable) {
      send({ type: 'error', message: runtime.blockedReason || `PortOS cannot install ${runtime.label} on this host.` });
      return safeEnd();
    }
    if (runtimeInstallInFlight) {
      send({ type: 'error', message: 'Another runtime install is already running. Wait for it to finish or restart PortOS.' });
      return safeEnd();
    }

    // Reserve synchronously before spawning so two requests that finish their
    // status probe together cannot launch competing installs into the same bin
    // directory.
    reservation = {};
    runtimeInstallInFlight = reservation;
    if (clientGone) {
      runtimeInstallInFlight = null;
      return safeEnd();
    }

    send({ type: 'stage', stage: 'install', message: `Installing ${runtime.label}.` });
    emit({ type: 'log', message: `Running ${describeRuntimeInstall(runtime.id)}.` });
    installLog.start();
    // `spawn` can throw synchronously (a rejected argv shape, an OS-level spawn
    // refusal). Two things must happen here that letting it bubble would not do:
    // release the reservation — or every later install answers "another install
    // is already running" until PortOS restarts — and report the failure as a
    // terminal SSE frame, since the headers are already flushed and the error
    // middleware can no longer send JSON to this response.
    try {
      child = spawnRuntimeInstaller(runtime.id);
    } catch (err) {
      finished = true;
      if (runtimeInstallInFlight === reservation) runtimeInstallInFlight = null;
      emit({ type: 'error', message: `${runtime.label} installer failed to start: ${err.message}` });
      return safeEnd();
    }
    runtimeInstallInFlight = child;

    const onLine = (line) => {
      const text = line.trimEnd();
      if (text) emit({ type: 'log', message: text });
    };
    // npm runs with `--no-progress`, which suppresses its usual redraws. Keep
    // the default newline-only reader as a defensive second layer: a lifecycle
    // child (or a vendor install script's own progress bar) that still writes
    // bare carriage returns cannot turn every redraw into a browser log frame
    // and a full modal re-render.
    const stdoutReader = createLineReader(onLine);
    const stderrReader = createLineReader(onLine);
    child.stdout.on('data', stdoutReader.push);
    child.stderr.on('data', stderrReader.push);
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      if (runtimeInstallInFlight === child) runtimeInstallInFlight = null;
      emit({ type: 'error', message: `${runtime.label} installer failed to start: ${err.message}` });
      safeEnd();
    });
    // The post-install PATH check is deliberately stronger than the installer's
    // exit code. A successful write whose bin directory is absent from PM2's
    // PATH would otherwise recreate the same opaque agent-start failure.
    child.on('close', async (code) => {
      if (finished) return;
      try {
        stdoutReader.flush();
        stderrReader.flush();
        finished = true;
        if (runtimeInstallInFlight === child) runtimeInstallInFlight = null;
        // `fresh` is load-bearing: the pre-install probe cached "not installed"
        // seconds ago, and re-reading it would fail a CLI that now works.
        const installed = code === 0 && (await getProviderRuntimeStatus(runtime.id, { fresh: true })).installed;
        if (installed) {
          emit({ type: 'complete', message: `${runtime.label} is installed and available to PortOS.` });
        } else if (code === 0) {
          emit({ type: 'error', message: `The installer finished, but PortOS still cannot run \`${runtime.command}\`. Its bin directory may be missing from PortOS's PATH — restart PortOS, then try again.` });
        } else {
          emit({ type: 'error', message: `${runtime.label} installer exited with code ${code}.` });
        }
        safeEnd();
      } catch (err) {
        // Child-process completion runs outside Express's request lifecycle.
        console.error(`❌ ${runtime.label} install completion check failed: ${err.message}`);
        emit({ type: 'error', message: `${runtime.label} install completion check failed: ${err.message}` });
        safeEnd();
      }
    });
  };

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

    // Preserve existing apiKey if client didn't send a new one
    if (!('apiKey' in updates)) {
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

    const provider = await providerService.updateProvider(req.params.id, updates);
    res.json(presentProvider(provider, await detectSystemCapabilities()));
  }));

  // POST /:id/refresh-models — intercept the toolkit response so the refreshed
  // provider record receives the same secret redaction as every other provider
  // response. The toolkit returns its raw persisted record here.
  router.post('/:id/refresh-models', asyncHandler(async (req, res) => {
    const provider = await providerService.refreshProviderModels(req.params.id);
    if (!provider) throw new ServerError('Provider not found', { status: 404 });
    res.json(presentProvider(provider, await detectSystemCapabilities()));
  }));

  // POST / — intercept to (a) validate the body against providerSchema so
  // invalid fields like `timeout: "abc"` or non-object `envVars` don't
  // persist and later break runner behavior, and (b) sanitize the created
  // provider before responding so apiKey/secret envVar values don't echo
  // back to the client (the toolkit's POST returns the raw provider).
  router.post('/', asyncHandler(async (req, res) => {
    const validation = validate(providerSchema, req.body);
    if (!validation.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: validation.errors } });
    }
    const provider = await providerService.createProvider(validation.data);
    res.status(201).json(presentProvider(provider, await detectSystemCapabilities()));
  }));

  // Mount base toolkit routes last (GET/PUT /:id, POST /, and
  // POST /:id/refresh-models are now shadowed by sanitized versions above).
  // DELETE /:id has no provider body; POST /:id/test returns only its test
  // result, so neither endpoint needs a sanitizing shadow.
  router.use('/', aiToolkit.routes.providers);

  return router;
}
