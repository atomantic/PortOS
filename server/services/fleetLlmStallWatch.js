// Stall detection for the dedicated host's private vLLM runtime.
//
// A wedged engine keeps answering `/v1/models` while never producing a token, so
// response bytes cannot tell "stuck" from "a long non-streaming generation that
// legitimately sends nothing until it finishes". The runtime's own Prometheus
// counters can: a live engine with a request running moves the prompt or
// generation token totals; a wedged one does not.

const RUNNING = 'vllm:num_requests_running';
const TOKEN_COUNTERS = new Set(['vllm:prompt_tokens_total', 'vllm:generation_tokens_total']);

/**
 * Read the two numbers the watchdog needs out of a Prometheus text exposition.
 * Label sets (per engine / per model) are summed. Returns null when the running
 * gauge is absent, which means the text is not a vLLM exposition at all.
 */
function parseVllmProgress(text) {
  let running = null;
  let tokens = 0;
  for (const line of String(text).split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1] === RUNNING) running = (running ?? 0) + value;
    else if (TOKEN_COUNTERS.has(match[1])) tokens += value;
  }
  return running === null ? null : { running, tokens };
}

/** Progress counters from the private runtime, or null when it cannot be read. */
export async function readVllmProgress({ upstream, apiKey, timeoutMs = 5000, fetchImpl = fetch }) {
  const response = await fetchImpl(`${upstream}/metrics`, {
    headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!response?.ok) return null;
  return parseVllmProgress(await response.text().catch(() => ''));
}

/**
 * The detect / clear state machine, with time injected so tests never sleep.
 *
 * `sample(progress, jobKey)` takes one reading (null = runtime unreachable) and
 * returns `'stalled'` / `'cleared'` on a transition, else null. Once stalled it
 * stays stalled until the runtime shows it is alive again: the token total moves,
 * or it goes unreachable and comes back (a restart completed). The stalled job
 * finishing does not clear it, because aborting that job is how a stall is acted
 * on, and clearing there would route new requests straight back into the dead slot.
 */
export function createStallDetector({ stalledAfterMs = 120000, now = Date.now } = {}) {
  let jobKey = null;
  let lastTokens = null;
  let movedAt = 0;
  let stalledSince = null;
  let stallTokens = null;
  let sawOutage = false;

  const clear = () => { stalledSince = null; stallTokens = null; sawOutage = false; jobKey = null; lastTokens = null; };
  return {
    stalledSince: () => stalledSince,
    /** Forget an in-progress observation (nothing is admitted); a stall episode is kept. */
    idle() { jobKey = null; lastTokens = null; },
    sample(progress, key) {
      if (stalledSince !== null) {
        if (!progress) { sawOutage = true; return null; }
        if (sawOutage || progress.tokens !== stallTokens) { clear(); return 'cleared'; }
        return null;
      }
      if (!progress) return null;
      if (key !== jobKey || progress.tokens !== lastTokens || progress.running <= 0) {
        jobKey = key; lastTokens = progress.tokens; movedAt = now();
        return null;
      }
      if (now() - movedAt < stalledAfterMs) return null;
      stalledSince = now();
      stallTokens = progress.tokens;
      return 'stalled';
    },
  };
}
