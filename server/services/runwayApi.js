import { assertRunwayCatalogModel } from './runwayModelCatalog.js';
/**
 * Runway developer API — the shared task transport for image and video backends.
 *
 * Runway runs every generation as a task: POST the input to
 * `/v1/image_to_video` (or `/v1/text_to_video`), which answers `{ id }`; poll
 * `GET /v1/tasks/{id}` until SUCCEEDED / FAILED / CANCELLED, then download
 * `output[0]` (a signed URL that expires, so it is fetched at once).
 * `DELETE /v1/tasks/{id}` cancels a task that is still running.
 *
 * Same submit/poll/cancel rules as `falQueue.js`: a lost submit response marks
 * the run unsettled (it may still bill), a transient status failure is retried
 * on the poll cadence without resubmitting, and every abandonment path sends
 * the remote cancel once.
 */

import { maintenance } from '../lib/maintenanceAdmission.js';
import { ServerError } from '../lib/errorHandler.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';

export const RUNWAY_API_BASE = 'https://api.dev.runwayml.com';
// Every request names the API version it was written against.
export const RUNWAY_API_VERSION = '2024-11-06';

export const RUNWAY_SUBMIT_TIMEOUT_MS = 60_000;
export const RUNWAY_POLL_TIMEOUT_MS = 15_000;
// Runway asks for polling no faster than every 5 seconds.
export const RUNWAY_POLL_INTERVAL_MS = 5000;
export const RUNWAY_MAX_STATUS_RETRIES = 2;

/** The Runway API key: the settings-stored key, else the `RUNWAYML_API_SECRET` env var. */
export function resolveRunwayApiKey(settings) {
  const fromSettings = (settings?.videoGen?.runway?.apiKey || '').trim();
  if (fromSettings) return fromSettings;
  return (process.env.RUNWAYML_API_SECRET || '').trim() || null;
}

const headers = (apiKey, json = false) => ({
  Authorization: `Bearer ${apiKey}`,
  'X-Runway-Version': RUNWAY_API_VERSION,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

/** A short, single-line reason from a Runway error body (`error`, `issues`), or ''. */
function runwayErrorDetail(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const issues = Array.isArray(payload.issues)
    ? payload.issues.map((issue) => [Array.isArray(issue?.path) ? issue.path.join('.') : null, issue?.message].filter(Boolean).join(': ')).filter(Boolean)
    : [];
  const reason = [typeof payload.error === 'string' ? payload.error : null, ...issues].filter(Boolean).join(' — ');
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Per-request bookkeeping shared by `cancelRunwayTask` and `awaitRunwayTask`. */
export const createRunwayTaskEntry = (apiKey) => ({
  apiKey, controller: new AbortController(), aborted: false, taskId: null, remoteTerminal: false, cancelPromise: null,
});

/**
 * Best-effort, idempotent cancellation of the remote task. Never rethrows: the
 * local job still finalizes as failed/canceled either way. Never fires once
 * Runway reported a terminal status (DELETE would then delete the finished task).
 */
export async function cancelRunwayTask(entry) {
  if (!entry) return;
  if (!entry.cancelPromise) {
    if (entry.remoteTerminal || !entry.taskId || !entry.apiKey) return;
    entry.cancelPromise = fetchWithTimeout(`${RUNWAY_API_BASE}/v1/tasks/${encodeURIComponent(entry.taskId)}`, {
      method: 'DELETE', headers: headers(entry.apiKey),
    }, RUNWAY_POLL_TIMEOUT_MS)
      .then(async (res) => {
        if (!res.ok && res.status !== 404) console.error(`❌ Runway cancellation request failed: HTTP ${res.status}`);
        await res.body?.cancel?.();
      })
      .catch((err) => console.error(`❌ Runway cancellation request failed: ${err?.message || err}`));
  }
  await entry.cancelPromise;
  // An accepted cancel does not prove the paid render stopped.
  if (!entry.remoteTerminal) maintenance.markCurrentUnsettled();
}

/** Submit one paid generation to a generation endpoint. Resolves to the task id. */
export async function submitRunwayTask({ apiKey, endpoint, body }) {
  assertRunwayCatalogModel(endpoint, body.model);
  const res = await fetchWithTimeout(`${RUNWAY_API_BASE}/v1/${endpoint}`, {
    method: 'POST', headers: headers(apiKey, true), body: JSON.stringify(body),
  }, RUNWAY_SUBMIT_TIMEOUT_MS).catch((err) => {
    // A lost POST response is not proof the paid task was rejected.
    maintenance.markCurrentUnsettled();
    throw err;
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || typeof payload?.id !== 'string') {
    if (res.ok || res.status >= 500) maintenance.markCurrentUnsettled();
    const detail = runwayErrorDetail(payload);
    throw new ServerError(`Runway rejected the request: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, { status: 502, code: 'RUNWAY_SUBMIT_FAILED' });
  }
  return payload.id;
}

async function getRunwayTask({ apiKey, taskId }) {
  const res = await fetchWithTimeout(`${RUNWAY_API_BASE}/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: headers(apiKey),
  }, RUNWAY_POLL_TIMEOUT_MS);
  if (!res.ok) throw new ServerError(`Runway status check failed: HTTP ${res.status}`, { status: 502, code: 'RUNWAY_STATUS_FAILED' });
  return res.json();
}

/**
 * Poll a submitted task until Runway reports it terminal, the caller cancels it
 * (`entry.aborted`), or `deadline` passes. Resolves to `{ outcome: 'completed',
 * outputUrl }` or `{ outcome: 'canceled' | 'failed', reason? }` and never
 * throws; every abandonment path has already sent the remote cancel.
 * `onStatus(status, progress)` reports each non-terminal status (PENDING,
 * THROTTLED, RUNNING) for the caller's progress wording.
 */
export async function awaitRunwayTask({
  entry, apiKey, deadline, timeoutMs, onPoll = () => {}, onStatus = () => {}, pollIntervalMs = RUNWAY_POLL_INTERVAL_MS, verbatimFailure = false,
}) {
  let statusFailures = 0;
  // A cancel (entry.controller.abort()) ends the wait at once rather than after the next interval.
  const wait = () => new Promise((resolve) => {
    const signal = entry.controller.signal;
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, pollIntervalMs);
    signal.addEventListener('abort', done, { once: true });
  });
  while (Date.now() < deadline) {
    if (entry.aborted) {
      await cancelRunwayTask(entry);
      return { outcome: 'canceled' };
    }
    onPoll();
    let task;
    try {
      task = await getRunwayTask({ apiKey, taskId: entry.taskId });
    } catch (err) {
      statusFailures += 1;
      if (statusFailures > RUNWAY_MAX_STATUS_RETRIES) {
        await cancelRunwayTask(entry);
        return { outcome: 'failed', reason: `Runway status checks failed ${statusFailures} times in a row: ${err?.message || err}` };
      }
      await wait();
      continue;
    }
    statusFailures = 0;
    if (task?.status === 'SUCCEEDED') {
      entry.remoteTerminal = true;
      if (entry.aborted) return { outcome: 'canceled' };
      const outputUrl = Array.isArray(task.output) ? task.output.find((url) => typeof url === 'string' && url.trim()) : null;
      return outputUrl ? { outcome: 'completed', outputUrl } : { outcome: 'failed', reason: 'Runway finished but returned no output URL' };
    }
    if (task?.status === 'FAILED' || task?.status === 'CANCELLED' || task?.status === 'CANCELED') {
      entry.remoteTerminal = true;
      if (entry.aborted) return { outcome: 'canceled' };
      const code = typeof task.failureCode === 'string' ? ` (${task.failureCode})` : '';
      return { outcome: 'failed', reason: verbatimFailure && task.failure ? task.failure : `Runway render failed: ${task.failure || task.status.toLowerCase()}${code}` };
    }
    onStatus(task?.status, Number.isFinite(task?.progress) ? task.progress : null);
    await wait();
  }
  await cancelRunwayTask(entry);
  if (entry.aborted) return { outcome: 'canceled' };
  return { outcome: 'failed', reason: `Runway did not finish within ${Math.round(timeoutMs / 1000)}s` };
}
