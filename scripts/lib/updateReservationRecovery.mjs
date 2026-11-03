/** Inspect the running install from a fresh updater, including older servers. */
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PORTS } from '../../server/lib/ports.js';
import { certPaths } from '../../lib/certPaths.js';
import { hasTailscaleCert } from '../../lib/tailscale-https.js';
import { parseEnvFile, resolveHttpMirrorPort } from './envFile.js';
import { resolveCredentials } from '../portos-api.js';
import { createMaintenanceJournal } from '../../server/lib/maintenanceJournal.js';
import { legacyProcessCwds, snapshotLegacyProcesses } from './legacyUpdateActivity.mjs';

const refuse = message => { throw Object.assign(new Error(message), { code: 'MAINTENANCE_STALE' }); };
const canonical = path => { try { return realpathSync(path); } catch { return resolve(path); } };

async function localServicePresent(rows, root, relative) {
  const path = canonical(join(root, relative)).replaceAll('\\', '/').toLowerCase();
  const escaped = relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const relativeCommand = new RegExp(`(?:^|[\\s"'])\\.?/?${escaped}(?=$|[\\s"'])`, 'i');
  const live = rows.filter(row => !String(row.state ?? '').startsWith('Z'));
  if (live.some(row => String(row.command ?? '').replaceAll('\\', '/').toLowerCase().includes(path))) return true;
  const candidates = live.filter(row => relativeCommand.test(String(row.command ?? '').replaceAll('\\', '/')));
  const cwds = await legacyProcessCwds(candidates.map(row => row.pid)).catch(() => new Map());
  return candidates.some(row => !cwds.has(row.pid) || canonical(cwds.get(row.pid)) === canonical(root));
}

export async function createUpdateReservationRecovery({ directory, root, signal, env = process.env,
  fetcher = fetch, snapshot, scoped, credentials, mintSession, now = Date.now, apiOrigin } = {}) {
  const data = dirname(directory);
  const install = dirname(data);
  const journal = createMaintenanceJournal(data);
  let gate, disposition, inventory, processes;
  const loadRecovery = async () => {
    if (gate) return;
    // Offline updates with no reservations need no installed packages. Load
    // service dependencies only after finding a running API to inspect.
    const [admission, actions, foundInventory, foundProcesses] = await Promise.all([
      import('../../server/lib/maintenanceAdmission.js'), import('../../server/services/maintenanceReservationDisposition.js'),
      import('../../server/services/maintenanceProcessInventory.js'), import('../../server/services/maintenanceScopedProcesses.js'),
    ]);
    gate = admission.createMaintenanceAdmission(data);
    disposition = actions;
    inventory = foundInventory;
    processes = foundProcesses;
  };
  const dotenv = parseEnvFile(join(install, '.env'));
  const tls = hasTailscaleCert(certPaths(data).dir);
  const api = apiOrigin ?? `http://127.0.0.1:${tls ? resolveHttpMirrorPort({ env, dotenv }) : PORTS.API}`;
  const runner = (env.COS_RUNNER_URL || dotenv.COS_RUNNER_URL || `http://localhost:${PORTS.COS}`).replace(/\/+$/, '');
  const connection = credentials ?? await resolveCredentials({ ...env, PORTOS_URL: api });
  let token = connection.token, session, nextCheck = 0, lastError;
  const alive = () => !signal?.aborted;
  const checkSignal = () => signal?.throwIfAborted();
  const readProcesses = async () => {
    const rows = await (snapshot ?? snapshotLegacyProcesses)();
    if (!Array.isArray(rows) || !rows.some(row => row.pid === process.pid)) refuse('The local process inventory could not be verified.');
    return rows;
  };
  const read = async (path, optional = false, runnerRead = false) => {
    checkSignal();
    const request = () => fetcher(`${runnerRead ? runner : api}${path}`, {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      headers: !runnerRead && token ? { Authorization: `Bearer ${token}` } : {},
    });
    let response = await request();
    if (!runnerRead && response.status === 401 && !session) {
      // Local update scripts are host operators. Use the existing supported
      // out-of-process session flow, rather than requiring the opt-in agent
      // key or exposing/asking for the instance password.
      session = await (mintSession ? mintSession() : import('../../server/services/auth.js')
        .then(auth => auth.createSession({ label: 'update-recovery' })));
      token = session.token;
      checkSignal();
      response = await request();
    }
    if (optional && response.status === 404) return null;
    if (!response.ok) refuse(runnerRead ? 'The configured runner could not be inspected.' : 'The local activity service could not be authenticated or inspected.');
    return response.json();
  };
  const sameOwner = (status, update) => {
    if (status?.hold || status?.state !== 'normal') return false;
    if (status.deferredUpdate && status.deferredUpdate.id !== update.id) return false;
    const owners = status.blockers?.filter(op => op.kind === 'deferred-update');
    if (owners?.length !== 1 || owners[0].pid !== update.ownerPid || owners[0].startedAt !== update.requestedAt) return false;
    try {
      const owner = JSON.parse(owners[0].resource);
      return owner.phase === 'waiting' && owner.childPid === null && owner.holdId === null;
    } catch { return false; }
  };
  const selfUpdate = async (activity, update) => {
    if (activity.appOperations?.length !== 1) return false;
    const operation = activity.appOperations[0];
    if (operation.type !== 'update' || typeof operation.appId !== 'string') return false;
    const app = await read(`/api/apps/${encodeURIComponent(operation.appId)}`, true);
    if (typeof app?.repoPath !== 'string' || canonical(app.repoPath) !== canonical(root)) return false;
    if (activity.update?.handoffTracking === true) return operation.deferredUpdateOwnerPid === update.ownerPid;
    // Older servers have no explicit handoff field. Their first real STEP
    // closes "starting" only after this supervisor has registered ownership.
    // An unfinished preflight/pull cannot satisfy this completed handoff.
    const requestedAt = Date.parse(update.requestedAt);
    const steps = operation.steps;
    return Number.isFinite(operation.startedAt) && operation.startedAt <= requestedAt && Array.isArray(steps)
      && steps.some(step => step.step === 'app-update' && step.status === 'running')
      && steps.some(step => step.step === 'starting' && step.status === 'done'
        && Number.isFinite(step.timestamp) && step.timestamp >= requestedAt - 2000 && step.timestamp <= requestedAt + 10000)
      && !steps.some(step => step.status === 'running' && !['app-update', 'waiting'].includes(step.step));
  };
  const checkActivity = async (update, operations) => {
    if (!sameOwner(await read('/api/system/maintenance'), update)) refuse('The activity service belongs to a different update.');
    const [activity, rows] = await Promise.all([
      read('/api/system/activity'), readProcesses(),
    ]);
    const agents = await read('/agents', false, true).catch(async error => {
      if (env.COS_RUNNER_URL || dotenv.COS_RUNNER_URL || await localServicePresent(rows, root, 'server/cos-runner/index.js')) throw error;
      return [];
    });
    const ownOperation = await selfUpdate(activity, update);
    if (activity.llm?.directCallsTracked !== true) refuse('The older runtime cannot report all provider calls. Use an acknowledged manual update (--interrupt) to restart it.');
    disposition.assertInactiveActivity(ownOperation ? { ...activity, appOperations: [] } : activity, agents, { waitingUpdate: true });
    const loadAgent = id => read(`/api/cos/agents/${encodeURIComponent(id)}`, true);
    const loadTask = async id => (await read(`/api/cos/tasks/${encodeURIComponent(id)}`, true))?.task ?? null;
    const owners = await Promise.all(operations.map(async op => {
      if (!['agent', 'runner'].includes(op.kind)) return null;
      const owner = op.resource.startsWith('agent-') ? await loadAgent(op.resource) : await loadTask(op.resource);
      const task = owner?.taskId ? await loadTask(owner.taskId) : null;
      return disposition.isOrdinaryAgentRecord(op, owner, task) ? owner : null;
    }));
    await inventory.assertNoObservedReservationProcesses(operations, install, async () => rows);
    const limitations = await (scoped ?? processes.assertNoScopedLegacyProcesses)(operations, rows, {
      data, codeRoot: root, updatePid: update.ownerPid, idleProviderServices: activity.llm.directCallsTracked === true,
      loadAgent: id => id.startsWith('agent-') ? loadAgent(id) : loadTask(id),
      loadApp: id => read(`/api/apps/${encodeURIComponent(id)}`, true),
      loadProvider: id => read(`/api/providers/${encodeURIComponent(id)}`, true),
    });
    if (!sameOwner(await read('/api/system/maintenance'), update)) refuse('The waiting update changed during inspection.');
    checkSignal();
    return { processes: rows, limitations, ordinaryOwnerIds: operations.filter((_, index) => owners[index]).map(op => op.id),
      pids: owners.filter(owner => Number.isSafeInteger(owner?.pid) && owner.pid > 0)
        .map(owner => ({ pid: owner.pid, completedAt: owner.completedAt ?? owner.pausedAt ?? null })) };
  };
  return {
    run: async () => {
      checkSignal();
      if (now() < nextCheck) {
        if (lastError) throw lastError;
        return null;
      }
      nextCheck = now() + 5000;
      try {
        try { await read('/api/system/health'); }
        catch (error) {
          const rows = await readProcesses();
          if (await localServicePresent(rows, root, 'server/start.js') || await localServicePresent(rows, root, 'server/index.js')
            || journal.readForStatus().operations.some(op => op.kind !== 'deferred-update')) throw error;
          lastError = null;
          return null;
        }
        await loadRecovery();
        const receipt = await disposition.reconcileWaitingUpdate({ gate, checkActivity, isEnabled: alive });
        lastError = null;
        return receipt;
      } catch (error) { lastError = error; throw error; }
    },
    close: async () => {
      if (!session) return;
      // The API owns the current session inventory. An out-of-process auth
      // module still holds its pre-wait Map and must never write it back here.
      const response = await fetcher(`${api}/api/auth/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (!response.ok && response.status !== 401 && response.status !== 404)
        refuse('The temporary update session could not be revoked.');
      session = null;
    },
  };
}
