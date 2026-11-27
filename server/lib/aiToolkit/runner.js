/** Compose run creation, execution, history and host-run lifecycle operations. */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { ERROR_CATEGORIES } from './errorDetection.js';
import { createApiStreamExecutor } from './internal/apiStreamExecutor.js';
import { createCliExecutor, killProcessTree } from './internal/cliExecutor.js';
import { createRunFactory } from './internal/createRun.js';
import { createRunStore, safeJsonParse } from './internal/runStore.js';

export function createRunnerService(config = {}) {
  const {
    dataDir = './data',
    runsDir = 'runs',
    screenshotsDir = './data/screenshots',
    providerService,
    providerStatusService = null,
    hooks = {},
    // Host-owned file-plus-record boundary; standalone toolkit has no coordinator.
    withAssetPublication = work => work(),
    redactStoredPrompt = prompt => prompt,
    maxConcurrentRuns: _maxConcurrentRuns = 5
  } = config;

  const runsPath = join(dataDir, runsDir);
  const activeRuns = new Map();

  // ── Declared extension points ────────────────────────────────────────────
  // PortOS supplies a CLI runner that knows per-CLI argv conventions (Codex
  // `exec -`, Antigravity `agy --print`, Claude Code `-p -`) and a TUI runner
  // the toolkit has no built-in for. Rather than reaching into private props
  // from server/index.js, the host registers them via setCliRunner/setTuiRunner.
  // Externally-spawned runs (the host owns their child process / pty) are tracked
  // in `externalRuns` so the toolkit's stopRun/isRunActive/deleteRun see them.
  // See server/lib/aiToolkit/AGENTS.md (override contract).
  let cliRunnerOverride = null;
  const externalRuns = new Map();
  // A host runner sees only the child/PTY exit event. Remember when that exit
  // was initiated through stopRun so it can distinguish a user cancellation
  // from an unexpected provider crash and avoid fallback/bench telemetry.
  const externalStopRequests = new Set();
  // The same one-shot marker for the toolkit's OWN in-flight runs (`activeRuns`
  // — an API fetch's AbortController). `controller.abort()` with no reason
  // surfaces to the reader as Node's bare `AbortError: This operation was
  // aborted`, which no error pattern matches and which is indistinguishable
  // from a provider transport fault. Without this marker every Stop of an API
  // run finalized as an UNKNOWN provider failure, fired `onRunFailed`, and was
  // escalated to a tier-4 investigation task — a post-mortem over a human
  // pressing Stop. CLI/TUI runs already avoid that via `externalStopRequests`.
  const activeStopRequests = new Set();
  const consumeActiveStop = (runId) => {
    const requested = activeStopRequests.has(runId);
    activeStopRequests.delete(runId);
    return requested;
  };

  async function handleProviderError(providerId, errorAnalysis, output) {
    hooks.onProviderError?.(providerId, errorAnalysis, output);

    if (providerStatusService) {
      if (errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT &&
          errorAnalysis.requiresFallback &&
          typeof providerStatusService.markUsageLimit === 'function') {
        await providerStatusService.markUsageLimit(providerId, {
          message: errorAnalysis.message,
          waitTime: errorAnalysis.waitTime,
          rateLimitWindow: errorAnalysis.rateLimitWindow,
        }).catch(err => {
          console.error(`❌ Failed to mark provider usage limit: ${err.message}`);
        });
      } else if (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT &&
                 typeof providerStatusService.markRateLimited === 'function') {
        await providerStatusService.markRateLimited(providerId, {
          rateLimitWindow: errorAnalysis.rateLimitWindow,
        }).catch(err => {
          console.error(`❌ Failed to mark provider rate limited: ${err.message}`);
        });
      }
    }
  }

  const store = createRunStore({ runsPath, withAssetPublication });
  const execution = { runsPath, patchRunMetadata: store.patchRunMetadata, activeRuns, hooks, handleProviderError, withAssetPublication };
  const executeCli = createCliExecutor(execution);
  const service = {
    // ── Extension-point setters / external-run registry ──────────────────
    // Register a host CLI runner. Pass `null` to revert to the toolkit's
    // built-in executeCliRun. The override receives the same args the built-in
    // would and must return the runId.
    setCliRunner(fn) {
      if (fn != null && typeof fn !== 'function') {
        throw new Error('setCliRunner expects a function or null');
      }
      cliRunnerOverride = fn;
    },
    // Register a host TUI runner. The toolkit has no built-in TUI executor, so
    // the runs router gates on `typeof runnerService.executeTuiRun === 'function'`.
    // Attaching/detaching the method keeps that gate honest.
    setTuiRunner(fn) {
      if (fn != null && typeof fn !== 'function') {
        throw new Error('setTuiRunner expects a function or null');
      }
      if (fn) service.executeTuiRun = fn;
      else delete service.executeTuiRun;
    },
    // Track a host-spawned run's killable handle (ChildProcess or node-pty IPty —
    // both expose `.kill(signal?)`; AbortController exposes `.abort()`) so
    // stopRun/isRunActive/deleteRun account for it alongside the toolkit's own.
    registerExternalRun(runId, killable) {
      externalStopRequests.delete(runId);
      externalRuns.set(runId, killable);
    },
    unregisterExternalRun(runId) {
      externalRuns.delete(runId);
      externalStopRequests.delete(runId);
    },
    hasExternalRun(runId) { return externalRuns.has(runId); },
    consumeExternalRunStop(runId) {
      const requested = externalStopRequests.has(runId);
      externalStopRequests.delete(runId);
      return requested;
    },

    createRun: createRunFactory({
      runsPath, ensureRunsDir: store.ensureRunsDir, providerService, providerStatusService,
      redactStoredPrompt, withAssetPublication, hooks,
      registerExternalRun: (...args) => service.registerExternalRun(...args),
      unregisterExternalRun: runId => service.unregisterExternalRun(runId),
    }),
    async executeCliRun(opts) {
      return cliRunnerOverride ? cliRunnerOverride(opts) : executeCli(opts);
    },
    executeApiRun: createApiStreamExecutor({
      ...execution, screenshotsDir, activeStopRequests, providerStatusService, consumeActiveStop,
    }),
    async stopRun(runId) {
      // Host-spawned runs (CLI/TUI) take precedence — kill the registered handle
      // and drop it so a later isRunActive reports false.
      const external = externalRuns.get(runId);
      if (external) {
        externalStopRequests.add(runId);
        if (external.kill && !external.killed) killProcessTree(external);
        else if (external.abort) external.abort();
        externalRuns.delete(runId);
        return true;
      }

      const active = activeRuns.get(runId);
      if (!active) return false;

      if (active.kill) {
        killProcessTree(active);
      } else if (active.abort) {
        // Mark BEFORE aborting: the abort rejects the in-flight reader
        // synchronously enough that the finalizer can already be running by
        // the time this returns, and it must see an intentional stop. Only the
        // AbortController (API) branch marks — the built-in CLI executor's
        // exit-code classification is unchanged by this, so a marker there
        // would never be consumed.
        activeStopRequests.add(runId);
        active.abort();
      }

      activeRuns.delete(runId);
      return true;
    },

    getRun: store.getRun,
    getRunOutput: store.getRunOutput,
    getRunPrompt: store.getRunPrompt,
    listRuns: store.listRuns,
    deleteFailedRuns: store.deleteFailedRuns,
    async deleteRun(runId) {
      // Kill an in-flight host-spawned run before removing its dir so deleting a
      // live run doesn't leave a zombie child process behind.
      if (externalRuns.has(runId)) {
        await service.stopRun(runId);
      }
      return store.removeRun(runId);
    },

    async isRunActive(runId) {
      return externalRuns.has(runId) || activeRuns.has(runId);
    },

    // Activity projection only: never return the persisted prompt, output,
    // workspace, or error fields. Bound I/O to the live registry, not history.
    async getActiveRunSummaries(limit = 50) {
      const ids = [...new Set([...activeRuns.keys(), ...externalRuns.keys()])].slice(0, limit);
      const runs = await Promise.all(ids.map(async (runId) => {
        const metadata = safeJsonParse(await readFile(join(runsPath, runId, 'metadata.json'), 'utf8').catch(() => '{}'));
        const text = (value) => typeof value === 'string' ? value.slice(0, 200) : null;
        return {
          runId,
          providerId: text(metadata.providerId),
          model: text(metadata.model),
          source: text(metadata.source),
          startedAt: text(metadata.startTime),
        };
      }));
      return runs.filter(({ runId }) => activeRuns.has(runId) || externalRuns.has(runId));
    },

    /**
     * How many runs this instance is tracking right now — API-based
     * (`activeRuns`) and host-spawned CLI/TUI (`externalRuns`) alike. A count
     * only: no run's prompt or output crosses this surface, so a host can
     * safely fold it into an activity/idle gate (PortOS's `systemIdle.js`
     * does exactly that) without leaking record content.
     */
    async getActiveRunCount() {
      return activeRuns.size + externalRuns.size;
    }
  };

  return service;
}
