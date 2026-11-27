/**
 * CoS Agent Runner - Standalone PM2 Process
 *
 * This service runs as a separate PM2 app (portos-cos) that doesn't restart
 * when portos-server restarts. It manages Claude CLI agent spawning and
 * prevents orphaned processes when the main server cycles.
 *
 * Communication with portos-server happens via HTTP on port 5558.
 */

import {
  prepareWindowsAgentLaunch as defaultPrepareWindowsAgentLaunch,
  watchWindowsAgentProcess as defaultWatchWindowsAgentProcess,
} from '../lib/windowsAgentProcess.js';
import { persistRunnerCompletion as defaultPersistRunnerCompletion } from './completion.js';
import { createSecurityScanManager } from './securityScan.js';
import { maintenance as defaultMaintenance } from '../lib/maintenanceAdmission.js';
import express from 'express';
import { runnerRequestGuard, runnerRequestRefusal } from './requestGuard.js';
import { assertDatabaseAdmission as defaultAssertDatabaseAdmission } from '../lib/databaseMaintenanceJournal.js';
import { existsSync as defaultExistsSync } from 'fs';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import { ensureDir as defaultEnsureDir, PATHS } from '../lib/fileUtils.js';
import { prepareCliSpawn as defaultPrepareCliSpawn, killProcessTree as defaultKillProcessTree } from '../lib/bufferedSpawn.js';
import { buildCliChildEnv as defaultBuildCliChildEnv } from '../lib/cliChildEnv.js';
import { adoptNpmGlobalBinDir as defaultAdoptNpmGlobalBinDir } from '../lib/npmGlobalBin.js';
import { withState as defaultWithState, drainState as defaultDrainState } from './runnerState.js';
import { ALLOWED_COMMANDS, isAllowedCommand as defaultIsAllowedCommand } from './allowedCommands.js';
import { armForceKill as armForceKillShared } from './forceKill.js';
import { bodyErrorMessage } from './requestSchemas.js';
import { createRunnerShutdown, registerRunnerShutdownSignals } from './shutdown.js';
import { createHttpDrain } from '../lib/httpDrain.js';
import { PORTS } from '../lib/ports.js';
import { setupProcessErrorHandlers } from '../lib/errorHandler.js';
import { isDirectlyInvoked } from '../../scripts/lib/directInvocation.js';
import { registerSecurityScanRoutes } from './securityScanRoutes.js';
import { registerAgentControlRoutes } from './agentControlRoutes.js';
import { registerSpawnTuiRoute } from './spawnTuiRoute.js';
import { registerSpawnCliRoute } from './spawnCliRoute.js';
import { registerRunnerSockets } from './runnerSockets.js';
import { createOrphanCleanup } from './orphanCleanup.js';

// Timing constants for process termination/cleanup (ms). Named so the grace
// windows are obvious at each call site instead of bare literals.
const SIGKILL_GRACE_MS = 5000;        // wait after SIGTERM before forcing SIGKILL
const ORPHAN_CLEANUP_DELAY_MS = 3000; // delay on boot before reaping orphaned agents

/**
 * PM2 fork mode runs `node ProcessContainerFork.js`, which then imports this
 * file. `argv[1]` is that container; the script PM2 was asked to run is
 * `pm_exec_path`. Vitest's argv is not this file and does not set that
 * variable, so importing the module under test does not bind a port.
 */
export function shouldStartUnderPm2(moduleUrl, env = process.env) {
  const pmExec = env?.pm_exec_path;
  return typeof pmExec === 'string' && pmExec.length > 0 && isDirectlyInvoked(moduleUrl, pmExec);
}

// Terminal JSON error handler: without it Express answers a thrown route error
// with an HTML page and drops err.code, which cosRunnerClient cannot classify.
export function runnerErrorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  const isValidation = err?.name === 'ZodError' || Array.isArray(err?.issues);
  const status = isValidation ? 400 : Number.isInteger(err?.status) ? err.status : 500;
  const message = Array.isArray(err?.issues) ? bodyErrorMessage(err) : err?.message || 'Internal runner error';
  res.status(status).json({
    error: message,
    code: isValidation ? 'VALIDATION_ERROR' : err?.code || 'RUNNER_ERROR',
  });
}

/**
 * Construct a CoS runner instance (Express app, HTTP server, Socket.IO server,
 * lifecycle, security scan manager, and orphan reaper) without binding a port
 * or attaching process-global signal/error handlers.
 */
export function createCosRunner(deps = {}) {
  const proc = deps.process ?? process;
  const agentsDir = deps.agentsDir ?? PATHS.cosAgents;
  const port = deps.port ?? (proc.env?.PORT || PORTS.COS);
  const host = deps.host ?? (proc.env?.HOST || '127.0.0.1');
  const sigkillGraceMs = deps.sigkillGraceMs ?? SIGKILL_GRACE_MS;
  const orphanCleanupDelayMs = deps.orphanCleanupDelayMs ?? ORPHAN_CLEANUP_DELAY_MS;
  const shutdownDeadlineMs = deps.shutdownDeadlineMs;

  const admission = deps.maintenance ?? defaultMaintenance;
  const persistRunnerCompletion = deps.persistRunnerCompletion ?? defaultPersistRunnerCompletion;
  const existsSync = deps.existsSync ?? defaultExistsSync;
  const ensureDir = deps.ensureDir ?? defaultEnsureDir;
  const adoptNpmGlobalBinDir = deps.adoptNpmGlobalBinDir ?? defaultAdoptNpmGlobalBinDir;
  const withState = deps.withState ?? defaultWithState;
  const drainState = deps.drainState ?? defaultDrainState;
  const armForceKillImpl = deps.armForceKill ?? armForceKillShared;
  const requestGuard = deps.requestGuard ?? runnerRequestGuard;
  const requestRefusal = deps.requestRefusal ?? runnerRequestRefusal;
  const exit = deps.exit ?? ((code) => proc.exit(code));

  // Active agent processes (in memory)
  const activeAgents = new Map();

  // Bind the shared escalation to this runner's map, grace window, and durable
  // state. See forceKill.js for the contract (notably: a fresh termination always
  // re-arms, and `dropState` is only for a kill relayed after the PortOS server
  // has already finalized the agent).
  const armForceKill = (agentId, agent, opts = {}) =>
    armForceKillImpl(activeAgents, agentId, agent, {
      graceMs: sigkillGraceMs,
      ...opts,
      onDropState: (id) => {
        withState((state) => { delete state.agents[id]; })
          .catch(err => console.error(`❌ Reap state write failed for ${id}: ${err.message}`));
      },
    });

  // Express app setup
  const app = express();
  app.use(requestGuard);
  app.use(express.json({ limit: '10mb' }));

  const server = http.createServer(app);
  const io = new SocketServer(server, {
    allowRequest: (req, callback) => callback(null, requestRefusal(req) === null),
  });

  // Check subsequent polling requests and upgrades too, even with an existing sid.
  io.engine.use(requestGuard);

  const httpDrain = createHttpDrain([server]);
  let orphanCleanupTimer = null;
  let transportClose;
  const lifecycle = createRunnerShutdown({
    admission,
    stopIntake: (deadlineMs) => httpDrain.begin(deadlineMs),
    closeTransports: () => {
      if (orphanCleanupTimer) {
        clearTimeout(orphanCleanupTimer);
        orphanCleanupTimer = null;
      }
      transportClose ??= new Promise(resolve => {
        io.close(resolve);
        server.closeAllConnections?.();
      });
      return transportClose;
    },
    drainState,
    exit,
    graceMs: sigkillGraceMs,
    ...(shutdownDeadlineMs !== undefined ? { deadlineMs: shutdownDeadlineMs } : {}),
  });

  // Keep established sockets for outgoing completion events, but stop incoming
  // commands and new namespace connections as soon as shutdown starts.
  io.use((socket, next) => next(lifecycle.isStopping() ? new Error('Runner is shutting down') : undefined));

  const persistCompletion = (agentId, output, metadata) => persistRunnerCompletion(agentsDir, agentId, output, metadata);

  /**
   * Emit event to connected portos-server instances
   */
  function emitToServer(event, data) {
    io.emit(event, data);
    console.log(`📡 Emitted ${event}`);
  }

  const securityScans = deps.securityScans ?? createSecurityScanManager({
    agentsDir,
    getAgent: id => activeAgents.get(id),
    trackWork: work => lifecycle.trackWork(work),
    emitEvidence: async (agentId, evidence) => {
      const agent = activeAgents.get(agentId);
      if (agent) agent.securityScan = evidence;
      emitToServer('agent:security-scan', { agentId, evidence });
    },
  });

  const context = {
    activeAgents, withState, lifecycle, securityScans, io, emitToServer,
    persistCompletion, armForceKill, proc, sigkillGraceMs, existsSync,
    rootDir: deps.rootDir ?? PATHS.root,
    assertDatabaseAdmission: deps.assertDatabaseAdmission ?? defaultAssertDatabaseAdmission,
    prepareCliSpawn: deps.prepareCliSpawn ?? defaultPrepareCliSpawn,
    killProcessTree: deps.killProcessTree ?? defaultKillProcessTree,
    buildCliChildEnv: deps.buildCliChildEnv ?? defaultBuildCliChildEnv,
    isAllowedCommand: deps.isAllowedCommand ?? defaultIsAllowedCommand,
    allowedCommands: deps.allowedCommands ?? ALLOWED_COMMANDS,
    prepareWindowsAgentLaunch: deps.prepareWindowsAgentLaunch ?? defaultPrepareWindowsAgentLaunch,
    watchWindowsAgentProcess: deps.watchWindowsAgentProcess ?? defaultWatchWindowsAgentProcess,
  };
  registerSecurityScanRoutes(app, context);
  registerAgentControlRoutes(app, context, deps);
  registerSpawnTuiRoute(app, context, deps);
  registerSpawnCliRoute(app, context, deps);
  registerRunnerSockets(context);
  const cleanupOrphanedAgents = createOrphanCleanup(context, deps);

  app.use(runnerErrorHandler);

  /**
   * Start listening on HTTP + Socket.IO and schedule boot-time initialization.
   */
  function start(listenPort = port, listenHost = host) {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(listenPort, listenHost, async () => {
        server.off('error', onError);
        const address = server.address();
        const boundPort = typeof address === 'object' && address ? address.port : listenPort;
        console.log(`🤖 CoS Agent Runner started on http://${listenHost}:${boundPort}`);

        // The runner is its own PM2 app with its own environment, and it spawns
        // provider CLIs by bare name — so it must adopt npm's global bin directory
        // itself. Without this a CLI the AI Providers page reports as installed
        // (the main server adopted it there) still 422s here as "not on the CoS
        // Runner PATH". Fire-and-forget: never blocks accepting work.
        adoptNpmGlobalBinDir().catch((err) => console.error(`❌ npm global bin adoption failed: ${err.message}`));

        // Ensure agents directory exists. try/catch is mandatory: this listener runs
        // outside the request lifecycle, so a rejected await here escapes as an
        // unhandled rejection and takes the runner down at boot (fatal on Node >= 15).
        try {
          if (!existsSync(agentsDir)) {
            await ensureDir(agentsDir);
          }
        } catch (err) {
          console.error(`❌ Agents dir setup failed: ${err.message}`);
        }

        // Delay orphan cleanup to allow socket connections to establish
        // This ensures completion events reach the main server for task retry
        if (orphanCleanupDelayMs >= 0) {
          orphanCleanupTimer = setTimeout(async () => {
            // Same rule, and this body is the one that reads and rewrites the agent
            // state file: a truncated/corrupt `agents.json` or an EACCES rejects out of
            // an async timer callback with no owner, killing the runner seconds after
            // boot and leaving PM2 to restart-loop it against the same bad file.
            // Log and continue — a corrupt state file must not stop the runner from
            // accepting new work, and the sweep re-runs on the next restart.
            try {
              if (lifecycle.isStopping()) return;
              const orphaned = await lifecycle.trackWork(cleanupOrphanedAgents);
              if (orphaned.length > 0) {
                console.log(`🧹 Cleaned ${orphaned.length} orphaned agent(s)`);
              }
            } catch (err) {
              console.error(`❌ Orphan cleanup failed: ${err.message}`);
            }
          }, orphanCleanupDelayMs);
        }

        resolve(address);
      });
    });
  }

  return {
    app,
    server,
    io,
    activeAgents,
    lifecycle,
    securityScans,
    cleanupOrphanedAgents,
    start,
  };
}

if (isDirectlyInvoked(import.meta.url) || shouldStartUnderPm2(import.meta.url)) {
  await import('../services/databaseBootFence.js');
  // Process-level safety net (defense-in-depth, see issue #1878). The main server
  // (server/index.js) already wires this same shared helper via
  // setupProcessErrorHandlers(io); the CoS runner — a separate long-lived PM2
  // process that spawns and supervises child agents — had no such net, so a stray
  // async handler that rejected/threw outside the request lifecycle would crash it
  // with Node's default unhandled output. Reusing the shared helper gives the runner
  // the identical, already-tested convention: log via the emoji-prefixed console.error
  // style, and on an uncaughtException exit cleanly after flushing so PM2 restarts a
  // process that would otherwise be left in an undefined state (boot then reaps any
  // orphaned agents). Called with no `io` — the runner's socket server fans agent
  // output to portos-server, not the error-alert UI, so the UI emit is skipped.
  setupProcessErrorHandlers();
  const runner = createCosRunner();
  registerRunnerShutdownSignals(process, runner.lifecycle);
  await runner.start();
}
