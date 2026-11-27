import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  runtimeQuerySchema,
  providerReadinessQuerySchema,
  providerReadinessSetupQuerySchema,
  providerServeModelQuerySchema,
} from '../../lib/queryValidation.js';
import { observeModelResource } from '../../services/modelObservation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { onClientDisconnect, openSseStream } from '../../lib/sseDownload.js';
import { createInstallLogger } from '../../lib/installLogger.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { getProviderRuntimeStatuses } from '../../services/provider/providerRuntimeInstaller.js';
import { streamHarnessAction } from '../../services/harnessActionStream.js';
import {
  getProviderReadinessMap,
  resetProviderReadinessCache,
  servedModelId,
} from '../../services/provider/providerReadiness.js';
import { getLlamaServerEndpoint, relaunchLlamaServerWithAlias } from '../../services/llamaServerManager.js';
import { claimHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { localEndpointPort, localRuntimeForProvider } from '../../lib/localProviderRuntime.js';

export function createReadinessSetupRoutes(providerService, runtimeSetup) {
  const router = Router();

  const readinessObservation = observeModelResource('provider-readiness', async () => {
    const data = await providerService.getAllProviders();
    return { readiness: await getProviderReadinessMap(data.providers) };
  });

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
   * (llama.cpp, Ollama, LM Studio, MTPLX) — see `services/provider/providerReadiness.js`.
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
    const compositeId = validateRequest(providerReadinessQuerySchema, req.query).providerId ?? null;
    if (compositeId) {
      const provider = await providerService.getProviderById(compositeId);
      res.json({ readiness: provider ? await getProviderReadinessMap([provider]) : {} });
      return;
    }
    res.json(await readinessObservation.read());
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
    const setupQuery = validateRequest(providerReadinessSetupQuerySchema, req.query);
    const providerId = String(setupQuery.provider || '');
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
    const requested = setupQuery.runtime ? String(setupQuery.runtime) : runtime.kind;
    if (requested !== runtime.kind) {
      throw new ServerError('This provider no longer uses that runtime — reload the page and try again.', { status: 409, code: 'RUNTIME_MISMATCH' });
    }
    // Which of the fixed steps the checklist's button named. Matched against the
    // closed set rather than passed through, so the only thing an unexpected
    // value can do is 400 — it never reaches a command. Absent stays `null`
    // rather than becoming a default here: a client built before this parameter
    // existed still renders THIS server's button label, so the service resolves
    // what the checklist is currently offering instead of assuming a start.
    const action = setupQuery.action ? String(setupQuery.action) : null;
    const { runLocalRuntimeSetup, SETUP_ACTIONS } = await import('../../services/localRuntimeSetup.js');
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

    if (runtimeSetup.holder) {
      send({ type: 'error', message: 'Another local-runtime setup is already running. Wait for it to finish.', code: 'SETUP_BUSY', context: { holder: runtimeSetup.holder } });
      return safeEnd();
    }
    if (clientGone) return safeEnd();
    runtimeSetup.holder = { runId: randomUUID(), kind: runtime.kind };
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
      io: req.app.get('io'),
    }).catch((err) => ({ success: false, error: err.message }));

    if (holdsLock) { runtimeSetup.holder = null; holdsLock = false; }
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
    const providerId = String(validateRequest(providerServeModelQuerySchema, req.query).provider || '');
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
    await streamRuntimeInstall(req, res, validateRequest(runtimeQuerySchema, req.query).runtime);
  }));

  return router;
}
