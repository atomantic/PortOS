/**
 * Who is spending this machine's GPU, and how much of it.
 *
 * The dedicated inference host (`services/fleetLlmGateway.js`) publishes one
 * OpenAI-compatible endpoint on the tailnet and admits one generation at a
 * time. Until this module existed the only thing it could say about that was
 * `{ active, queued }` — a depth, with no answer to "is another machine using
 * my GPU right now, and which one?". An operator watching their 3090 sit at
 * 100% had no way to attribute it, and no record at all once the request ended.
 *
 * This is the pure half: a bounded ledger keyed by the CLIENT ADDRESS the
 * gateway's socket reports, plus the parser that lifts token counts out of an
 * OpenAI-compatible response. `services/fleetLlmUsage.js` owns the singleton,
 * its persistence, and the peer-name resolution that turns an address into a
 * name a human recognizes — all three of which need a daemon, a peer list or a
 * disk, and none of which this module touches.
 *
 * Three deliberate shapes:
 *
 *   - **Addresses are identity, names are decoration.** The gateway
 *     authenticates every client with ONE shared host key (that is the whole
 *     point of a host key), so the wire carries no per-peer identity. The
 *     socket's remote address is the only thing that distinguishes two callers,
 *     so it is the ledger's key; a peer NAME is resolved at report time and may
 *     change or disappear without rewriting history.
 *   - **Tokens are observed, never estimated.** A count is recorded only when
 *     the upstream actually reported one. A client whose requests all streamed
 *     without `stream_options.include_usage` shows `requests` with null token
 *     totals — which is honest — rather than a number invented from body size.
 *     `tokenReports` counts how many of its requests carried a reading, so the
 *     report can say "12 of 40 requests reported tokens" instead of implying
 *     the other 28 were free.
 *   - **Bounded on every axis.** Clients, per-client day buckets and the recent
 *     event list all have caps, because this ledger is written by remote
 *     callers: an unbounded map keyed by remote address is a memory leak with a
 *     network interface in front of it.
 *
 * Nothing here records a prompt, a completion, or any part of a request body.
 * The ledger holds counts, timestamps, a model id and an HTTP status.
 */

import { normalizeUsage } from './openAiChatStream.js';

/** Distinct client addresses retained. Oldest-seen is evicted past this. */
export const MAX_CLIENTS = 64;

/** Per-client daily buckets retained, and the age past which a client is dropped. */
export const RETENTION_DAYS = 30;

/** Completed requests kept for the "what just happened" list. */
export const MAX_RECENT = 50;

/**
 * How much of a response body is held while looking for its token counts.
 *
 * `usage` sits at the END of both shapes this has to read — the last SSE frame
 * of a stream, or the tail of a single JSON object — so a rolling tail is
 * enough and a full-body buffer would mean holding every concurrent generation
 * in memory to learn two integers.
 */
export const USAGE_TAIL_BYTES = 64 * 1024;

/**
 * Strip the IPv4-mapped IPv6 prefix Node reports on a dual-stack listener.
 *
 * `server.listen(port, '0.0.0.0')` still yields `::ffff:100.x.x.x` for an IPv4
 * client on some hosts, which would file the same machine under two keys
 * depending on which stack the connection arrived over.
 */
export function normalizeClientAddress(address) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim().toLowerCase();
  if (trimmed === '') return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}

/** Local calendar day, which is the day an operator reading the report means. */
export function usageDayKey(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Walk a balanced JSON object starting at `start` (which must be `{`).
 *
 * Written by hand rather than by regex because the value being located sits in
 * a text buffer that may be TRUNCATED at its head — there is no whole document
 * to hand to `JSON.parse`, only "the object that begins here".
 *
 * @returns {string|null} the object's source text, or null if it does not close
 *   within the buffer.
 */
function readBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The LAST reported token counts in an OpenAI-compatible response body.
 *
 * Searched from the end because both shapes put the real reading last, and
 * because a stream with `stream_options.include_usage` emits `"usage": null` on
 * every intermediate frame before the single populated one — a forward scan
 * would find a null and stop. A candidate that is null, unparseable, or carries
 * no numeric token field is skipped and the walk continues backwards.
 *
 * @returns {{promptTokens: number|null, completionTokens: number|null}|null}
 */
export function findReportedUsage(text) {
  if (typeof text !== 'string') return null;
  let cursor = text.length;
  while (cursor > 0) {
    const at = text.lastIndexOf('"usage"', cursor - 1);
    if (at < 0) return null;
    cursor = at;
    const colon = text.indexOf(':', at + 7);
    if (colon < 0) continue;
    const brace = text.indexOf('{', colon);
    // A `"usage": null` frame has no object before the next key, so require the
    // brace to be the very next non-whitespace character.
    if (brace < 0 || text.slice(colon + 1, brace).trim() !== '') continue;
    const source = readBalancedObject(text, brace);
    if (!source) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(source);
    } catch {
      continue;
    }
    const usage = normalizeUsage(parsed);
    if (usage.promptTokens !== null || usage.completionTokens !== null) return usage;
  }
  return null;
}

/**
 * A bounded tail buffer fed the response bytes as they stream to the client.
 *
 * Deliberately decode-free per chunk: the bytes are concatenated and decoded
 * once at the end, so a multi-byte character split across a chunk boundary
 * cannot corrupt the JSON the parser then reads. The buffer is trimmed to
 * `maxBytes` as it grows, so a long generation costs a fixed 64 KB rather than
 * its whole transcript.
 */
export function createUsageSniffer({ maxBytes = USAGE_TAIL_BYTES } = {}) {
  let tail = Buffer.alloc(0);
  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      tail = tail.length === 0 ? buf : Buffer.concat([tail, buf]);
      if (tail.length > maxBytes) tail = tail.subarray(tail.length - maxBytes);
    },
    result() {
      return tail.length === 0 ? null : findReportedUsage(tail.toString('utf8'));
    },
  };
}

const emptyClient = (key, at) => ({
  key,
  firstSeen: at,
  lastSeen: at,
  requests: 0,
  errors: 0,
  activeRequests: 0,
  tokenReports: 0,
  promptTokens: 0,
  completionTokens: 0,
  models: [],
  days: {},
});

const emptyDay = () => ({ requests: 0, promptTokens: 0, completionTokens: 0 });

const finiteOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);

/**
 * The ledger itself.
 *
 * `now` is injected so the retention and day-bucket contracts can be tested
 * without sleeping, per the test strategy in AGENTS.md.
 */
export function createFleetHostUsageLedger({
  now = Date.now,
  maxClients = MAX_CLIENTS,
  maxRecent = MAX_RECENT,
  retentionDays = RETENTION_DAYS,
} = {}) {
  /** @type {Map<string, ReturnType<typeof emptyClient>>} */
  const clients = new Map();
  let recent = [];
  let sequence = 0;
  let startedAt = now();

  const clientFor = (key, at) => {
    const existing = clients.get(key);
    if (existing) return existing;
    // Evict the least recently active client rather than the oldest INSERTED
    // one: a machine that connected first and still connects hourly matters
    // more than one that appeared once yesterday.
    if (clients.size >= maxClients) {
      let victimKey = null;
      let victimSeen = Infinity;
      for (const [candidateKey, candidate] of clients) {
        // Never evict a client with a request in flight — its `endRequest`
        // would then resurrect it as a fresh row with a negative-looking count.
        if (candidate.activeRequests > 0) continue;
        if (candidate.lastSeen < victimSeen) { victimSeen = candidate.lastSeen; victimKey = candidateKey; }
      }
      if (victimKey !== null) clients.delete(victimKey);
    }
    const created = emptyClient(key, at);
    clients.set(key, created);
    return created;
  };

  const prune = (at) => {
    const cutoffDay = usageDayKey(at - retentionDays * 24 * 60 * 60 * 1000);
    for (const [key, client] of clients) {
      for (const day of Object.keys(client.days)) {
        if (cutoffDay && day < cutoffDay) delete client.days[day];
      }
      if (client.activeRequests === 0 && cutoffDay && usageDayKey(client.lastSeen) < cutoffDay) clients.delete(key);
    }
  };

  return {
    /**
     * A request has arrived and been admitted. Returns the handle `endRequest`
     * needs; the caller must pass it back exactly once.
     */
    beginRequest({ address, path = null, model = null } = {}) {
      const at = now();
      const key = normalizeClientAddress(address) || 'unknown';
      const client = clientFor(key, at);
      client.lastSeen = at;
      client.activeRequests += 1;
      sequence += 1;
      return { id: `req-${sequence}`, key, path, model, startedAt: at };
    },

    /**
     * The request is done — successfully, with an error status, or because the
     * client hung up. `usage` is whatever the response actually reported, or
     * null; it is never inferred.
     */
    endRequest(handle, { status = null, usage = null, model = null } = {}) {
      if (!handle?.key) return;
      const at = now();
      const client = clients.get(handle.key) || clientFor(handle.key, at);
      client.activeRequests = Math.max(0, client.activeRequests - 1);
      client.requests += 1;
      client.lastSeen = at;
      if (typeof status === 'number' && status >= 400) client.errors += 1;

      const servedModel = model || handle.model;
      if (typeof servedModel === 'string' && servedModel !== '' && !client.models.includes(servedModel)) {
        // Bounded for the same reason the client map is: this value arrives in
        // a request body from another machine.
        client.models = [...client.models, servedModel].slice(-5);
      }

      const day = usageDayKey(at);
      const bucket = client.days[day] || (client.days[day] = emptyDay());
      bucket.requests += 1;

      const prompt = finiteOr(usage?.promptTokens, null);
      const completion = finiteOr(usage?.completionTokens, null);
      if (prompt !== null || completion !== null) {
        client.tokenReports += 1;
        client.promptTokens += prompt ?? 0;
        client.completionTokens += completion ?? 0;
        bucket.promptTokens += prompt ?? 0;
        bucket.completionTokens += completion ?? 0;
      }

      recent = [{
        id: handle.id,
        clientKey: handle.key,
        path: handle.path,
        model: servedModel,
        startedAt: handle.startedAt,
        finishedAt: at,
        durationMs: Math.max(0, at - handle.startedAt),
        status,
        promptTokens: prompt,
        completionTokens: completion,
      }, ...recent].slice(0, maxRecent);

      prune(at);
    },

    /**
     * Everything the report route needs, as plain data. Sorted by most recent
     * activity, which is the order an operator asking "who is on my GPU" reads.
     */
    snapshot() {
      const rows = [...clients.values()]
        .map((client) => ({ ...client, days: { ...client.days } }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
      return {
        since: startedAt,
        activeRequests: rows.reduce((sum, row) => sum + row.activeRequests, 0),
        clients: rows,
        recent: [...recent],
        totals: {
          requests: rows.reduce((sum, row) => sum + row.requests, 0),
          errors: rows.reduce((sum, row) => sum + row.errors, 0),
          tokenReports: rows.reduce((sum, row) => sum + row.tokenReports, 0),
          promptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0),
          completionTokens: rows.reduce((sum, row) => sum + row.completionTokens, 0),
        },
      };
    },

    /** The persisted shape — the snapshot minus anything that is live state. */
    toJSON() {
      const snapshot = this.snapshot();
      return {
        version: 1,
        since: snapshot.since,
        clients: snapshot.clients.map(({ activeRequests, ...client }) => client),
        recent: snapshot.recent,
      };
    },

    /**
     * Restore a persisted ledger.
     *
     * `activeRequests` is deliberately NOT restored: a connection cannot
     * survive the process that was serving it, so replaying a non-zero count
     * would show a permanent phantom generation on the report.
     */
    hydrate(data) {
      if (!data || typeof data !== 'object' || data.version !== 1) return false;
      clients.clear();
      for (const stored of Array.isArray(data.clients) ? data.clients : []) {
        const key = normalizeClientAddress(stored?.key);
        if (!key) continue;
        const at = finiteOr(stored.lastSeen, 0);
        clients.set(key, {
          ...emptyClient(key, at),
          firstSeen: finiteOr(stored.firstSeen, at),
          lastSeen: at,
          requests: finiteOr(stored.requests, 0),
          errors: finiteOr(stored.errors, 0),
          tokenReports: finiteOr(stored.tokenReports, 0),
          promptTokens: finiteOr(stored.promptTokens, 0),
          completionTokens: finiteOr(stored.completionTokens, 0),
          models: Array.isArray(stored.models) ? stored.models.filter((m) => typeof m === 'string').slice(-5) : [],
          days: stored.days && typeof stored.days === 'object'
            ? Object.fromEntries(Object.entries(stored.days)
              .filter(([, bucket]) => bucket && typeof bucket === 'object')
              .map(([day, bucket]) => [day, {
                requests: finiteOr(bucket.requests, 0),
                promptTokens: finiteOr(bucket.promptTokens, 0),
                completionTokens: finiteOr(bucket.completionTokens, 0),
              }]))
            : {},
        });
      }
      recent = (Array.isArray(data.recent) ? data.recent : []).slice(0, maxRecent);
      startedAt = finiteOr(data.since, startedAt);
      prune(now());
      return true;
    },
  };
}
