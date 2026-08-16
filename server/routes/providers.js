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
  getOpenCodeInstallStatus,
  OPENCODE_NPM_PACKAGE,
  spawnOpenCodeInstaller,
  stopOpenCodeInstaller,
} from '../services/opencodeInstaller.js';

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

// One npm global install may write the same package prefix at a time. This is
// a lightweight re-entrancy guard for a double-click or a second browser tab;
// its child stays in the route so a client disconnect can terminate it.
let opencodeInstallInFlight = null;

/**
 * Sanitize a provider object for client responses.
 * Strips apiKey (replaces with hasApiKey boolean) and redacts secretEnvVars values.
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
        sanitized.envVars[key] = '***';
      }
    }
  }
  return sanitized;
};

/**
 * The shape a provider takes on its way OUT to the client: secrets stripped,
 * plus the derived `canRefreshModels` flag the AI Providers page reads to
 * decide whether to offer a "Refresh Models" button (#3620).
 *
 * Order matters. `canRefreshModels` is computed on the RAW provider, before
 * sanitization: the ollama row of the fetcher table keys partly on
 * `envVars.ANTHROPIC_BASE_URL`, which `sanitizeProvider` redacts to `'***'`
 * when the user marked it secret — deriving after would silently drop the
 * Refresh button for a Claude-Ollama provider.
 *
 * These PortOS routes SHADOW the toolkit's own (which decorate the same way);
 * the toolkit keeps its copy so it stays correct standalone. Both decorate on
 * the way out only — the field is never persisted.
 */
const presentProvider = (provider) => sanitizeProvider(withRefreshCapability(provider));

/**
 * Create PortOS-specific provider routes
 * Extends AI Toolkit routes with vision testing endpoints
 */
export function createPortOSProviderRoutes(aiToolkit) {
  const router = Router();
  const providerService = aiToolkit.services.providers;
  const providerStatusService = aiToolkit.services.providerStatus;

  // Sanitized GET routes — intercept toolkit GET endpoints to strip secrets
  router.get('/', asyncHandler(async (req, res) => {
    const data = await providerService.getAllProviders();
    res.json({
      activeProvider: data.activeProvider,
      providers: data.providers.map(presentProvider),
      runnerAllowedCommands: RUNNER_ALLOWED_COMMANDS
    });
  }));

  router.get('/active', asyncHandler(async (req, res) => {
    const provider = await providerService.getActiveProvider();
    res.json(presentProvider(provider));
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
    res.json(presentProvider(provider));
  }));

  router.get('/samples', asyncHandler(async (req, res) => {
    const providers = await providerService.getSampleProviders();
    res.json({ providers: providers.map(presentProvider) });
  }));

  // OpenCode is a local coding CLI, not an LLM service PortOS can silently
  // bootstrap. These endpoints only expose availability and service an
  // explicit click from the Providers page. They intentionally return no
  // resolved filesystem paths, which could disclose the host account name.
  router.get('/opencode/installation', asyncHandler(async (_req, res) => {
    res.json(await getOpenCodeInstallStatus());
  }));

  // Installing a global CLI mutates host state, so this stays a POST even
  // though the response is SSE-encoded. The client reads it with fetch rather
  // than EventSource: EventSource would auto-reconnect after a dropped stream
  // and could launch another non-idempotent npm install.
  //
  // The fixed command is npm install --global opencode-ai@latest; no request
  // input reaches a shell or package argument.
  router.post('/opencode/install', asyncHandler(async (req, res) => {
    const { send, safeEnd } = openSseStream(res);
    const installLog = createInstallLogger({ installer: 'OpenCode CLI', target: 'npm global prefix' });
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
      if (child) stopOpenCodeInstaller(child);
      if (reservation && opencodeInstallInFlight === reservation) opencodeInstallInFlight = null;
      safeEnd();
    });

    const status = await getOpenCodeInstallStatus();
    if (clientGone) return safeEnd();
    if (status.installed) {
      send({ type: 'log', message: 'OpenCode is already available to PortOS.' });
      send({ type: 'complete', message: 'Already installed — nothing to do.' });
      return safeEnd();
    }
    if (!status.npmAvailable) {
      send({ type: 'error', message: 'npm is not available on PortOS\'s PATH, so OpenCode cannot be installed from this page.' });
      return safeEnd();
    }
    if (opencodeInstallInFlight) {
      send({ type: 'error', message: 'Another OpenCode install is already running. Wait for it to finish or restart PortOS.' });
      return safeEnd();
    }

    // Reserve synchronously before spawning so two requests that finish their
    // status probe together cannot launch competing global npm installs.
    reservation = {};
    opencodeInstallInFlight = reservation;
    if (clientGone) {
      opencodeInstallInFlight = null;
      return safeEnd();
    }

    send({ type: 'stage', stage: 'install', message: 'Installing OpenCode CLI with npm.' });
    emit({ type: 'log', message: `Running npm install --global ${OPENCODE_NPM_PACKAGE}.` });
    installLog.start();
    child = spawnOpenCodeInstaller();
    opencodeInstallInFlight = child;

    const onLine = (line) => {
      const text = line.trimEnd();
      if (text) emit({ type: 'log', message: text });
    };
    // `--no-progress` suppresses npm's usual redraws. Keep the default
    // newline-only reader as a defensive second layer: a lifecycle child that
    // still writes bare carriage returns cannot turn every redraw into a
    // browser log frame and a full modal re-render.
    const stdoutReader = createLineReader(onLine);
    const stderrReader = createLineReader(onLine);
    child.stdout.on('data', stdoutReader.push);
    child.stderr.on('data', stderrReader.push);
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      if (opencodeInstallInFlight === child) opencodeInstallInFlight = null;
      emit({ type: 'error', message: `OpenCode installer failed to start: ${err.message}` });
      safeEnd();
    });
    // The post-install PATH check is deliberately stronger than npm's exit
    // code. A successful global write whose bin directory is absent from PM2's
    // PATH would otherwise recreate the same opaque agent-start failure.
    child.on('close', async (code) => {
      if (finished) return;
      try {
        stdoutReader.flush();
        stderrReader.flush();
        finished = true;
        if (opencodeInstallInFlight === child) opencodeInstallInFlight = null;
        const installed = code === 0 && (await getOpenCodeInstallStatus()).installed;
        if (installed) {
          emit({ type: 'complete', message: 'OpenCode is installed and available to PortOS.' });
        } else if (code === 0) {
          emit({ type: 'error', message: 'npm completed, but OpenCode is not runnable by PortOS. Restart PortOS or reinstall OpenCode so its postinstall script can complete, then try again.' });
        } else {
          emit({ type: 'error', message: `OpenCode installer exited with code ${code}.` });
        }
        safeEnd();
      } catch (err) {
        // Child-process completion runs outside Express's request lifecycle.
        console.error(`❌ OpenCode install completion check failed: ${err.message}`);
        emit({ type: 'error', message: `OpenCode install completion check failed: ${err.message}` });
        safeEnd();
      }
    });
  }));

  // Provider status routes MUST be defined before toolkit routes,
  // because the toolkit has a GET /:id route that would catch /status
  router.get('/status', asyncHandler(async (req, res) => {
    const statuses = providerStatusService.getAllStatuses();
    // Enrich with time until recovery
    const enriched = { ...statuses };
    for (const [providerId, status] of Object.entries(enriched.providers)) {
      enriched.providers[providerId] = {
        ...status,
        timeUntilRecovery: providerStatusService.getTimeUntilRecovery(providerId)
      };
    }
    res.json(enriched);
  }));

  router.get('/:id/status', asyncHandler(async (req, res) => {
    const status = providerStatusService.getStatus(req.params.id);
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
    const { imagePath, prompt, expectedContent, model } = req.body;

    if (!imagePath) {
      throw new ServerError('imagePath is required', { status: 400, code: 'VALIDATION_ERROR' });
    }

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
    const { model } = req.body;
    const result = await runVisionTestSuite(req.params.id, model);
    res.json(result);
  }));

  // Sanitized GET /:id — must be after specific /:id/* routes above
  router.get('/:id', asyncHandler(async (req, res) => {
    const provider = await providerService.getProviderById(req.params.id);
    if (!provider) throw new ServerError('Provider not found', { status: 404 });
    res.json(presentProvider(provider));
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
    res.json(presentProvider(provider));
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
    res.status(201).json(presentProvider(provider));
  }));

  // Mount base toolkit routes last (GET/PUT /:id and POST / are now shadowed
  // by sanitized versions above)
  router.use('/', aiToolkit.routes.providers);

  return router;
}
