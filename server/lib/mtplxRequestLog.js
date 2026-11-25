/**
 * Attribute one provider run to a single MTPLX request from the server's own request log (`<MTPLX_HOME or ~/.mtplx>/logs/request-log-<port>.jsonl`).
 *
 * Only identity and counters are projected out of each line (id, time, served model, token counters); prompt previews, message text and reasoning never leave this module. A run is attributed only when exactly one request was logged inside its window, so a concurrent client or a missing log stays unattributed and the caller keeps its generic timeout.
 */
import { open } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

// Request records carry the full sampler/transcript state and run to several KB each; the tail is plenty for one run's window.
const TAIL_BYTES = 4 * 1024 * 1024;
// A log line is stamped when the request ends, which can trail the caller's own deadline by a moment.
const LATE_GRACE_MS = 30_000;
const CLOCK_SLACK_MS = 1_000;

export const mtplxRequestLogPath = (port, home = process.env.MTPLX_HOME || join(homedir(), '.mtplx')) => join(home, 'logs', `request-log-${port}.jsonl`);

async function readTail(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A tail that starts mid-file begins inside a line; drop it.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

const counter = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

/** One log line reduced to the fields attribution may read, or null when it is not a request record. */
function project(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (!record || !Number.isFinite(record.logged_at_s)) return null;
  return {
    requestId: typeof record.request_id === 'string' ? record.request_id : null,
    loggedAtMs: record.logged_at_s * 1000,
    model: typeof record.request_model === 'string' ? record.request_model : null,
    // PortOS stopping the run is a client cancel; a request another client finished normally is not this run's.
    cancelled: record.request_cancelled === true || record.stream_cancelled_by_client === true,
    startedAtMs: Number.isFinite(record.request_elapsed_s) ? (record.logged_at_s - record.request_elapsed_s) * 1000 : null,
    completionTokens: Math.max(counter(record.completion_tokens), counter(record.generated_tokens), counter(record.streamed_completion_tokens)),
  };
}

/** `attributeMtplxRequest`, re-read for a short while: MTPLX writes the record when the cancelled request unwinds, which can trail the caller's deadline. */
export async function awaitMtplxRequest(args, { attempts = 4, delayMs = 500 } = {}) {
  let result = await attributeMtplxRequest(args);
  for (let attempt = 1; attempt < attempts && result.reason === 'no request in window'; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    result = await attributeMtplxRequest(args);
  }
  return result;
}

/**
 * The completion counter of the one MTPLX request that ended inside `[startedAtMs, endedAtMs]`.
 * `matched` carries `{ requestId, completionTokens }`; `unavailable` (no readable log) and `unattributed` (no request, several requests, a request this run did not cancel or begin, or a different model) carry a `reason`.
 */
export async function attributeMtplxRequest({ logPath, startedAtMs, endedAtMs, model = null }) {
  let text;
  try { text = await readTail(logPath); } catch { return { status: 'unavailable', reason: 'request log unreadable' }; }
  const from = startedAtMs - CLOCK_SLACK_MS;
  const to = endedAtMs + LATE_GRACE_MS;
  const inWindow = text.split('\n').map(project).filter((r) => r && r.loggedAtMs >= from && r.loggedAtMs <= to);
  const [request] = inWindow;
  if (inWindow.length !== 1) return { status: 'unattributed', reason: inWindow.length ? 'concurrent requests' : 'no request in window' };
  if (!request.cancelled) return { status: 'unattributed', reason: 'request was not cancelled by the run' };
  // A request that began before the run did is another client's, still ending inside the window.
  if (request.startedAtMs !== null && request.startedAtMs < from) return { status: 'unattributed', reason: 'request began before the run' };
  if (model && request.model && request.model !== model) return { status: 'unattributed', reason: 'request names a different model' };
  return { status: 'matched', requestId: request.requestId, completionTokens: request.completionTokens };
}
