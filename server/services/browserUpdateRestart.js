import { randomUUID } from 'node:crypto';
import { ServerError } from '../lib/errorHandler.js';
import { browserEvents, restartBrowser } from './browserService.js';
import { compareChromeVersions, readBrowserUpdateStatus, readManagedBrowserProcess } from './browserUpdateStatus.js';
import { runtimeUpdateEvents } from './runtimeUpdateEvents.js';

const TICKET_TTL_MS = 2 * 60 * 1000;
const MAX_TICKETS = 32;
const FOLLOWUP_MS = 12_000;
const FOLLOWUP_ATTEMPTS = 5;
const VERIFIED_STATES = new Set(['current', 'restart-required', 'downgrade-risk']);
const conflict = () => new ServerError('The browser or installed Chrome changed. Review the restart again.', {
  status: 409, code: 'BROWSER_RESTART_REVIEW_REQUIRED',
});

function createBrowserRestartController({ readStatus = readBrowserUpdateStatus, restart = restartBrowser,
  readSupervisor = readManagedBrowserProcess, now = Date.now, newToken = randomUUID, schedule = setTimeout,
  notify = () => runtimeUpdateEvents.emit('changed', { browserChanged: true }) } = {}) {
  const tickets = new Map();
  let confirming = false;
  let verification = null;
  let generation = 0;
  const invalidate = () => { generation += 1; verification = null; };
  const annotate = status => {
    const { proof, supervisorPid, ...publicStatus } = status || {};
    if (!verification || !VERIFIED_STATES.has(status?.state) || !proof) return publicStatus;
    if (supervisorPid !== verification.supervisorPid) { invalidate(); return publicStatus; }
    if (!verification.ready && verification.allowNext) { verification.ready = true; verification.proof = proof; }
    if (!verification.ready) return publicStatus;
    if (proof !== verification.proof) { invalidate(); return publicStatus; }
    const comparison = compareChromeVersions(publicStatus.runningVersion, verification.expectedVersion);
    if (comparison === null) return publicStatus;
    const state = publicStatus.channel !== verification.expectedChannel ? 'channel-changed'
      : comparison < 0 ? 'older' : comparison > 0 ? 'newer' : 'verified';
    return { ...publicStatus, restartVerification: { state, expectedVersion: verification.expectedVersion, expectedChannel: verification.expectedChannel } };
  };
  const followup = (expectedGeneration, attempt = 0) => {
    const timer = schedule(async () => {
      const target = verification;
      if (generation !== expectedGeneration || !target) return;
      const status = await Promise.resolve().then(() => readStatus({ includePublished: false, includeProof: true })).catch(() => null);
      if (generation !== expectedGeneration || verification !== target) return;
      if (VERIFIED_STATES.has(status?.state) && status.proof && status.supervisorPid !== target.supervisorPid) {
        invalidate();
        notify();
      } else if (VERIFIED_STATES.has(status?.state) && status.proof && status.channel && compareChromeVersions(status.runningVersion, target.expectedVersion) !== null) {
        target.ready = true;
        target.proof = status.proof;
        notify();
      } else if (attempt + 1 < FOLLOWUP_ATTEMPTS) followup(expectedGeneration, attempt + 1);
      else {
        // Allow a later verified periodic observation when startup is unusually slow.
        target.allowNext = true;
        notify();
      }
    }, FOLLOWUP_MS);
    timer?.unref?.();
  };
  const prepare = async () => {
    const { proof, supervisorPid: _supervisorPid, ...status } = await Promise.resolve()
      .then(() => readStatus({ includePublished: false, includeProof: true })).catch(() => ({ state: 'unverified' }));
    notify();
    if (!proof) return { ...status, ticket: null };
    const time = now();
    for (const [key, value] of tickets) if (value.expiresAt <= time) tickets.delete(key);
    if (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
    const ticket = newToken();
    tickets.set(ticket, { proof, expiresAt: time + TICKET_TTL_MS, expectedVersion: status.installedVersion, expectedChannel: status.channel });
    return { ...status, ticket };
  };
  const confirm = async ticket => {
    const saved = tickets.get(ticket);
    tickets.delete(ticket);
    if (!saved || saved.expiresAt <= now() || confirming) throw conflict();
    confirming = true;
    generation += 1;
    let restarted = false;
    try {
      return await restart({ beforeRestart: async () => {
        const current = await Promise.resolve().then(() => readStatus({ includePublished: false, includeProof: true })).catch(() => null);
        if (saved.expiresAt <= now() || !current?.proof || current.proof !== saved.proof) {
          notify();
          throw conflict();
        }
      }, afterRestart: async result => {
        const supervisor = await Promise.resolve().then(readSupervisor).catch(() => null);
        restarted = true;
        if (supervisor?.status !== 'online' || !Number.isInteger(supervisor.pid)) {
          return { ...result, updateVerification: { state: 'unverified' } };
        }
        verification = { expectedVersion: saved.expectedVersion, expectedChannel: saved.expectedChannel, supervisorPid: supervisor.pid, ready: false };
        followup(generation);
        return { ...result, updateVerification: { state: 'pending' } };
      } });
    } finally {
      confirming = false;
      if (!restarted && verification && !verification.ready) followup(generation);
    }
  };
  return { prepare, confirm, annotate, invalidate };
}

const controller = createBrowserRestartController();
browserEvents.on('mutation:started', controller.invalidate);
export const prepareBrowserUpdateRestart = () => controller.prepare();
export const confirmBrowserUpdateRestart = ticket => controller.confirm(ticket);
export const annotateBrowserRestartStatus = status => controller.annotate(status);
export const __testing = { createBrowserRestartController };
