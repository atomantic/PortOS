/** Temporarily switch the managed MTPLX checkpoint and restore its previous launch after the caller finishes. */

import { ServerError } from '../lib/errorHandler.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';

export function createMtplxCheckpointRunner({
  onDemand, getMtplxServerStatus, endpointFor, defaultPort, probeTimeoutMs,
  stopMtplxServer, waitForPortRelease, launchMtplxServer, restorePrevious,
}) {
  /**
   * Run `fn` while MTPLX serves the cached checkpoint `model`, then put back what was serving before.
   *
   * `mtplx serve` holds one checkpoint, so a caller that compares several cached packs (the HTML
   * Pages bench) has to relaunch between them. When `model` is already serving, `fn` runs with no
   * relaunch. Otherwise the daemon is stopped and started on `model`, and once `fn` settles the
   * previous launch line goes back up, or MTPLX is stopped again when it was not running before.
   * Refuses to stop a server unless PortOS owns it and can name its checkpoint.
   *
   * `fn` receives the served model id as `/v1/models` reports it and the endpoint serving it.
   *
   * @param {string} model a cached MTPLX repo id
   * @param {(servedModelId: string|null, endpoint: string) => Promise<*>} fn
   * @param {{ signal?: AbortSignal, requireCached?: boolean }} [options] abort loading or require a complete cache entry
   */
  async function runOnMtplxCheckpoint(model, fn, { signal, requireCached = false } = {}) {
    if (signal?.aborted) throw checkpointAborted();
    const switched = await onDemand.runStart(() => switchToCheckpoint(model, { signal, requireCached }));
    try {
      if (signal?.aborted) throw checkpointAborted();
      return await fn(switched.servedModelId, switched.endpoint);
    } finally {
      if (switched?.previous !== undefined) {
        await onDemand.runStart(() => restoreAfterCheckpoint(switched)).catch((err) => {
          console.error(`❌ MTPLX: could not put the previous checkpoint back after ${model}: ${err.message}`);
        });
      }
    }
  }

  const checkpointAborted = () => {
    const err = new Error('The MTPLX checkpoint switch was aborted');
    err.name = 'AbortError';
    return err;
  };

  const servedModelIdAt = async (endpoint) => (await probeOpenAiModels(endpoint, { timeoutMs: probeTimeoutMs })).models?.[0] ?? null;

  async function switchToCheckpoint(model, { signal, requireCached }) {
    if (signal?.aborted) throw checkpointAborted();
    const status = await getMtplxServerStatus();
    if (requireCached) {
      if (status.cacheError) {
        throw new ServerError(`MTPLX model cache could not be read: ${status.cacheError}`, { status: 503, code: 'MTPLX_CACHE_UNAVAILABLE' });
      }
      if (!status.cachedModelRows.some((row) => row.repo === model && row.valid)) {
        throw new ServerError('Choose a complete cached checkpoint on the MTPLX runtime card', { status: 400, code: 'MTPLX_NO_CACHED_MODEL' });
      }
    }
    if (status.running && status.config?.model === model) {
      const endpoint = endpointFor(status.config);
      return { endpoint, servedModelId: await servedModelIdAt(endpoint), previous: undefined };
    }
    if (status.running && status.managed !== true) {
      const why = status.managed === null
        ? 'PortOS could not read PM2, so it cannot tell whether it owns the MTPLX server'
        : 'MTPLX was started outside PortOS, so PortOS will not stop it to switch checkpoints';
      throw new ServerError(why, { status: 409, code: 'MTPLX_SWITCH_REFUSED' });
    }
    if (status.running && !status.config?.model) {
      throw new ServerError('MTPLX is serving its own default checkpoint, which PortOS cannot name — restart it on a chosen checkpoint from the LLMs page before switching checkpoints', {
        status: 409,
        code: 'MTPLX_SWITCH_REFUSED',
      });
    }
    // If MTPLX was stopped, restore that state without changing its saved launch.
    const previous = status.running ? status.config : null;
    const port = previous?.port ?? status.launch.port ?? defaultPort;
    console.log(`🚄 MTPLX: switching to ${model}${previous?.model ? ` (from ${previous.model})` : ''}`);
    if (previous) {
      await stopMtplxServer();
      await waitForPortRelease(port);
    }
    const started = await launchMtplxServer({ port, model, temporary: true }).catch((failure) => ({ failure }));
    if (signal?.aborted && !started.failure) {
      await stopMtplxServer().catch(() => {});
      await restoreAfterCheckpoint({ previous, stopped: true }).catch((restoreErr) => {
        console.error(`❌ MTPLX: could not put the previous checkpoint back after an aborted switch to ${model}: ${restoreErr?.message ?? restoreErr}`);
      });
      throw checkpointAborted();
    }
    const ready = started.failure ? { ready: false, reason: started.failure.message }
      : started.online ? { ready: true } : await onDemand.waitForReady(started.endpoint, { signal });
    if (!ready.ready) {
      if (!started.failure) await stopMtplxServer().catch(() => {});
      await restoreAfterCheckpoint({ previous, stopped: true }).catch((restoreErr) => {
        console.error(`❌ MTPLX: could not put the previous checkpoint back after failed switch to ${model}: ${restoreErr?.message ?? restoreErr}`);
      });
      if (ready.aborted || signal?.aborted) throw checkpointAborted();
      throw new ServerError(`MTPLX could not serve ${model}: ${ready.reason}`, { status: 503, code: 'MTPLX_SWITCH_FAILED' });
    }
    return { endpoint: started.endpoint, servedModelId: await servedModelIdAt(started.endpoint), previous };
  }

  async function restoreAfterCheckpoint({ previous, stopped = false }) {
    if (!stopped) await stopMtplxServer();
    if (previous) await restorePrevious(previous, null, { temporary: true });
  }

  return runOnMtplxCheckpoint;
}
