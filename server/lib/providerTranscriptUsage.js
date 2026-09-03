/**
 * Parsers for the per-message token counts the coding CLIs already write to
 * disk. PortOS's own accounting (`services/usage.js`) can only *estimate*
 * tokens — output from captured stdout (a repainted screen for TUI providers)
 * and input from the initial prompt length, which misses the per-turn context
 * replay and prompt-cache traffic that dominate real API cost. These files are
 * ground truth, cost 0 tokens to read, and are written by the CLI itself:
 *
 *   Claude Code — ~/.claude/projects/<cwd-slug>/<session>.jsonl
 *     One JSON object per line. Assistant lines carry
 *     `message.usage = { input_tokens, cache_creation_input_tokens,
 *     cache_read_input_tokens, output_tokens }` plus `message.model`; most
 *     lines also carry `cwd`, `sessionId`, and `timestamp`.
 *
 *   Codex — ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *     Line 1 is a `session_meta` payload with `id`/`cwd`/`cli_version`. Later
 *     `event_msg`/`token_count` lines carry a CUMULATIVE `total_token_usage`
 *     plus the per-turn `last_token_usage`.
 *
 * Both formats have a de-duplication hazard that makes naive summing wrong by
 * a large factor, documented at each parser. Both parsers are pure (text in,
 * totals out), tolerant of truncated trailing lines (a session still being
 * written), and ignore unknown fields so a CLI update can't break them.
 */

/**
 * Slugify a working directory the way Claude Code names its project folder:
 * every `/` and `.` becomes `-`. An absolute POSIX path therefore keeps its
 * leading `-` (`/Users/x/repo` → `-Users-x-repo`), which is what the CLI does.
 * @param {string} cwd
 * @returns {string}
 */
export function claudeProjectSlug(cwd) {
  return String(cwd || '').replace(/[/.]/g, '-');
}

/**
 * Parse newline-delimited JSON, skipping blank lines and any line that doesn't
 * parse. A partially-flushed final line is the common case for a session still
 * being appended to, so an unparseable line is normal input, not an error.
 * @param {string} text
 * @returns {object[]}
 */
function parseJsonLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A truncated mid-write line is expected — skip it rather than throw.
    // (JSON.parse has no non-throwing form, so this try/catch is the parse.)
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * `byModel` key for a billable message whose line names no model. Callers price
 * from `byModel`, so these tokens need a bucket of their own or they vanish from
 * the recorded total; a caller that sees this key prices it at the provider's
 * default rate (`resolveModelRates(providerId, null)`).
 */
export const UNKNOWN_MODEL = '(unknown model)';

/**
 * Stable identity for an assistant line that carries NO `message.id` and no
 * `uuid`. Derived from the fields that describe the billable event — its
 * timestamp, request id, model, and token counts — so the key survives any
 * reordering of the file. A POSITIONAL key does not: prepending or inserting a
 * line shifts every index after it, the shifted key reads as unclaimed, and the
 * cross-run double-bill reopens (measured: 100 billed for 70 after a prepend).
 */
function contentKey(entry, usage) {
  return [
    entry.timestamp || '',
    entry.requestId || '',
    entry.message?.model || '',
    num(usage.input_tokens),
    num(usage.output_tokens),
    num(usage.cache_read_input_tokens),
    num(usage.cache_creation_input_tokens)
  ].join('|');
}

const emptyTotals = () => ({
  messages: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
});

/** ISO timestamp → epoch ms, or null when absent/unparseable. */
const toEpoch = (value) => {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * True when `ts` falls inside `[from, to]`. A null bound is open.
 *
 * A message with NO readable timestamp is EXCLUDED whenever a bound is supplied.
 * Counting it would be worse than dropping it: a bounded window means the caller
 * is attributing one run's share of a possibly long-lived session, and a
 * timestamp-less line can't be placed in any run — so accepting it hands the same
 * tokens to every run that ever reads this file, turning one unparseable line
 * into permanent double-billing on every completion. With no bounds at all
 * (a whole-file read) there is nothing to double-count against, so it's kept.
 */
const inWindow = (ts, from, to) => {
  if (ts == null) return from == null && to == null;
  if (from != null && ts < from) return false;
  if (to != null && ts > to) return false;
  return true;
};

/**
 * Parse a Claude Code session transcript.
 *
 * **De-duplication is load-bearing.** One API response is written to the
 * transcript as SEVERAL lines that share the same `message.id`, `requestId`,
 * and an identical `message.usage` — the CLI re-emits the assistant record as
 * it streams/annotates content blocks. On a measured session, 1,734 assistant
 * lines represented only 740 distinct responses, so summing per line inflates
 * every token count (and therefore the cost) by ~2.3×. We count each
 * `message.id` exactly once. Lines with no id fall back to their own `uuid`
 * so they still count once rather than being dropped.
 *
 * Sub-agent (`isSidechain`) messages ARE counted: their tokens are billed to
 * the same account, and PortOS records one run per parent invocation.
 *
 * @param {string} jsonlText raw file contents (may end mid-line)
 * @param {{ from?: number|null, to?: number|null, exclude?: Set<string>|null }} [opts]
 *   `from`/`to` are epoch-ms bounds; assistant messages outside the window are
 *   excluded (used to attribute a long-lived CLI session to one PortOS run).
 *   `exclude` is a set of message keys already billed to another run — those are
 *   skipped, and the keys this call DID count come back as `countedKeys` so the
 *   caller can claim them. Without this, two runs whose windows overlap both
 *   fold the same messages and the cost doubles.
 * @returns {{ sessionId: string|null, cwd: string|null, model: string|null,
 *   models: string[], byModel: object, messages: number, tokensIn: number,
 *   tokensOut: number, cacheReadTokens: number, cacheWriteTokens: number,
 *   countedKeys: string[], firstTs: string|null, lastTs: string|null }}
 */
export function parseClaudeTranscript(jsonlText, { from = null, to = null, exclude = null } = {}) {
  const totals = emptyTotals();
  const seen = new Set();
  const modelCounts = new Map();
  // Per-model token buckets, so a session that switched models mid-run
  // (`/model`, or a fallback) can be priced at each model's own rate instead of
  // billing the whole aggregate at whichever model happened to run most.
  const byModel = new Map();
  let sessionId = null;
  let cwd = null;
  let firstTs = null;
  let lastTs = null;

  // Occurrence counter per content key, so two genuinely distinct lines with
  // identical content still get distinct keys (see `dedupeKey` below).
  const contentSeen = new Map();

  for (const entry of parseJsonLines(jsonlText)) {
    if (!sessionId && typeof entry.sessionId === 'string') sessionId = entry.sessionId;
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;

    const usage = entry.type === 'assistant' ? entry.message?.usage : null;
    if (!usage || typeof usage !== 'object') continue;

    const ts = toEpoch(entry.timestamp);
    if (!inWindow(ts, from, to)) continue;

    // One response spans multiple lines with identical usage — count it once.
    //
    // EVERY counted line needs a key, including one carrying neither
    // `message.id` nor `uuid`: a keyless line is invisible to the cross-run claim
    // ledger, so two overlapping runs each bill it (measured: 100 billed for 50
    // reported). The fallback is derived from the line's CONTENT, not its
    // position: a positional key shifts if anything is ever prepended or
    // inserted, which re-opens the double-bill (measured: 100 billed for 70 after
    // a prepend). Content is stable under any reordering, and the `@` prefix
    // can't collide with a real id. The trailing `#<occurrence>` is only a
    // tiebreaker so two genuinely distinct lines with identical content don't
    // collapse into one — it is not part of the identity.
    let dedupeKey = entry.message?.id || entry.uuid;
    if (!dedupeKey) {
      const content = contentKey(entry, usage);
      // Nth occurrence of this exact content within this file — deterministic and
      // unaffected by lines added elsewhere.
      const occurrence = contentSeen.get(content) ?? 0;
      contentSeen.set(content, occurrence + 1);
      dedupeKey = `@${content}#${occurrence}`;
    }
    if (seen.has(dedupeKey)) continue;
    // Already billed to another run whose window also covers this message —
    // skip it so overlapping runs can't each claim the same tokens.
    if (exclude?.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    totals.messages += 1;
    totals.tokensIn += num(usage.input_tokens);
    totals.tokensOut += num(usage.output_tokens);
    totals.cacheReadTokens += num(usage.cache_read_input_tokens);
    totals.cacheWriteTokens += num(usage.cache_creation_input_tokens);

    const model = typeof entry.message?.model === 'string' ? entry.message.model : null;
    if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    // Bucket EVERY billable message, including one whose line carries no
    // `message.model` — callers price from `byModel`, so leaving an unnamed
    // message out of it would silently drop its tokens from the recorded total
    // (measured: 500 output tokens lost on a two-message fixture). The
    // UNKNOWN_MODEL key keeps them attributable at the provider's default rate.
    const bucketKey = model ?? UNKNOWN_MODEL;
    if (!byModel.has(bucketKey)) byModel.set(bucketKey, emptyTotals());
    const bucket = byModel.get(bucketKey);
    bucket.messages += 1;
    bucket.tokensIn += num(usage.input_tokens);
    bucket.tokensOut += num(usage.output_tokens);
    bucket.cacheReadTokens += num(usage.cache_read_input_tokens);
    bucket.cacheWriteTokens += num(usage.cache_creation_input_tokens);

    if (typeof entry.timestamp === 'string' && entry.timestamp) {
      if (!firstTs || entry.timestamp < firstTs) firstTs = entry.timestamp;
      if (!lastTs || entry.timestamp > lastTs) lastTs = entry.timestamp;
    }
  }

  // A session can switch models mid-run (/model, or a fallback). Report every
  // model seen, plus the most-used one as the single `model` attribution — and
  // `byModel`, so a caller can price each model's own tokens at its own rate
  // rather than billing the whole aggregate at the majority model.
  const models = [...modelCounts.keys()];
  const model = models.length
    ? [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;

  return {
    sessionId,
    cwd,
    model,
    models,
    byModel: Object.fromEntries(byModel),
    // The message keys this call counted — the caller claims them so a later,
    // overlapping run can pass them back as `exclude` instead of re-billing.
    countedKeys: [...seen],
    ...totals,
    firstTs,
    lastTs
  };
}

/**
 * Parse a Codex rollout transcript.
 *
 * **`total_token_usage` is cumulative, and its events repeat.** Every
 * `event_msg`/`token_count` line restates the running total for the whole
 * session, and consecutive lines commonly repeat an unchanged total. So
 * neither summing `total_token_usage` (which would multiply the session by its
 * event count) nor summing `last_token_usage` (which double-counts, because a
 * repeated event repeats its `last` block too) is correct. We take the LAST
 * total in range — the cumulative figure already is the session sum.
 *
 * `input_tokens` is the *total* input including the cached portion, so the
 * uncached input we bill at the standard rate is `input - cached`, with
 * `cached` priced at the provider's cached-input rate. Codex reports no
 * cache-write tier, so `cacheWriteTokens` is always 0. `reasoning_output_tokens`
 * is a subset of `output_tokens` (already billed as output), not an addition.
 *
 * When a window is supplied and no in-range event exists but earlier events do,
 * the delta from the last pre-window total is used, so a rollout spanning two
 * PortOS runs attributes each run only its own increment.
 *
 * @param {string} jsonlText raw file contents (may end mid-line)
 * @param {{ from?: number|null, to?: number|null }} [window] epoch-ms bounds
 * @returns {{ sessionId: string|null, cwd: string|null, model: string|null,
 *   models: string[], messages: number, tokensIn: number, tokensOut: number,
 *   cacheReadTokens: number, cacheWriteTokens: number,
 *   firstTs: string|null, lastTs: string|null }}
 */
export function parseCodexRollout(jsonlText, { from = null, to = null } = {}) {
  let sessionId = null;
  let cwd = null;
  let model = null;
  let messages = 0;
  let firstTs = null;
  let lastTs = null;
  // Cumulative snapshots: the last one before the window start is the
  // baseline; the last one inside the window is the end state.
  let baseline = null;
  let latest = null;

  for (const entry of parseJsonLines(jsonlText)) {
    const payload = entry.payload;
    if (entry.type === 'session_meta' && payload && typeof payload === 'object') {
      if (typeof payload.id === 'string') sessionId ??= payload.id;
      if (typeof payload.cwd === 'string') cwd ??= payload.cwd;
      if (typeof payload.model === 'string') model ??= payload.model;
      continue;
    }
    // The model can also arrive on a per-turn context record.
    if (entry.type === 'turn_context' && typeof payload?.model === 'string') {
      model ??= payload.model;
    }
    // Count assistant messages only inside the window, the same way the token
    // totals below are windowed. A rollout can span several PortOS runs, so
    // counting every `agent_message` in the file would hand each later run the
    // earlier runs' message counts while its tokens are correctly a delta.
    if (payload?.type === 'agent_message') {
      if (inWindow(toEpoch(entry.timestamp), from, to)) messages += 1;
      continue;
    }
    if (payload?.type !== 'token_count') continue;

    const total = payload.info?.total_token_usage;
    if (!total || typeof total !== 'object') continue;

    const ts = toEpoch(entry.timestamp);
    // A token_count line with no readable timestamp can't be placed relative
    // to the window — exclude it whenever a bound is supplied, the same way
    // `inWindow` excludes a timestamp-less message elsewhere in this file.
    // Falling through to `latest = total` here (this snapshot's old bug) would
    // fold a snapshot from outside the run's window into it regardless of
    // `from`/`to`, inflating (or double-billing, on an overlapping run) that
    // run's cumulative-usage delta.
    if (ts == null) {
      if (from != null || to != null) continue;
      latest = total;
      continue;
    }
    if (from != null && ts < from) {
      baseline = total; // pre-window state — subtract it below
      continue;
    }
    if (to != null && ts > to) continue;

    latest = total;
    if (typeof entry.timestamp === 'string' && entry.timestamp) {
      if (!firstTs || entry.timestamp < firstTs) firstTs = entry.timestamp;
      if (!lastTs || entry.timestamp > lastTs) lastTs = entry.timestamp;
    }
  }

  if (!latest) {
    return { sessionId, cwd, model, models: model ? [model] : [], byModel: {}, ...emptyTotals(), firstTs, lastTs };
  }

  // Cumulative delta against the pre-window baseline (0 when unwindowed).
  const delta = (key) => Math.max(0, num(latest[key]) - num(baseline?.[key]));
  const cachedIn = delta('cached_input_tokens');
  const totalIn = delta('input_tokens');

  const bounded = from != null || to != null;
  const totals = {
    // Codex reports no per-message split, so an UNBOUNDED read of a rollout that
    // produced tokens counts as one exchange. A BOUNDED read must keep a genuine
    // zero: a rollout whose only `agent_message` predates this run's window has
    // an in-window token delta but no in-window message, and synthesizing one
    // there would inflate the message count of every later overlapping run.
    messages: bounded ? messages : (messages || 1),
    // `input_tokens` INCLUDES the cached portion — split it so each tier is
    // priced at its own rate instead of billing cache reads as fresh input.
    tokensIn: Math.max(0, totalIn - cachedIn),
    tokensOut: delta('output_tokens'),
    cacheReadTokens: cachedIn,
    cacheWriteTokens: 0
  };

  return {
    sessionId,
    cwd,
    model,
    models: model ? [model] : [],
    // Codex reports one model per rollout (no mid-session switch in the format),
    // so the whole delta is that model's — mirrored into `byModel` for shape
    // parity with the Claude parser so callers need no per-family branch. A
    // model-less rollout (no session_meta.model, no turn_context.model) still
    // gets its own UNKNOWN_MODEL bucket rather than an empty byModel — an
    // empty map here made readMeasuredUsage's fold() drop this rollout's
    // tokens entirely whenever a run's window also picked up a NAMED-model
    // rollout: reconcileRunUsage's `perModel.length > 0` branch only bills
    // from byModel, so a model-less rollout invisible to it billed nothing.
    byModel: { [model || UNKNOWN_MODEL]: { ...totals } },
    ...totals,
    firstTs,
    lastTs
  };
}

/**
 * Sum of every billable token bucket — the "did we measure anything" test used
 * by the reconciler to decide between a measured record and the estimate.
 * @param {{ tokensIn?: number, tokensOut?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} totals
 * @returns {number}
 */
export function totalTranscriptTokens(totals) {
  return num(totals?.tokensIn) + num(totals?.tokensOut)
    + num(totals?.cacheReadTokens) + num(totals?.cacheWriteTokens);
}

/**
 * ---------------------------------------------------------------------------
 * Grok
 * ---------------------------------------------------------------------------
 *
 * `~/.grok/sessions/<encodeURIComponent(cwd)>/<session-id>/`
 *
 *   summary.json      — `info.id`, `info.cwd`, `created_at`, `updated_at`,
 *                       `last_active_at`, `current_model_id`, `num_messages`.
 *   updates.jsonl     — the ACP-style event stream. One JSON envelope per line
 *                       (`timestamp` in epoch SECONDS, `params._meta.agentTimestampMs`
 *                       in ms). A `params.update.sessionUpdate === 'turn_completed'`
 *                       line carries the real billed counts in `usage`.
 *   chat_history.jsonl — role-tagged messages with NO timestamps; the fallback
 *                       when a run was killed before any turn completed.
 *
 * **Two traps, both load-bearing:**
 *
 * 1. Streaming chunks carry `_meta.totalTokens`, which is CONTEXT-WINDOW
 *    OCCUPANCY (it jumps when a tool result is appended and falls after a
 *    compaction). It is not billed and is never read here.
 * 2. `turn_completed.usage` has been observed in BOTH shapes across grok
 *    versions: per-prompt on this install (measured: 44 of 46 multi-turn
 *    sessions are non-monotonic in `totalTokens`, so each block describes only
 *    its own prompt), and cumulative-for-the-session in the shape #5831 was
 *    filed against. Summing a cumulative stream inflates by its turn count, so
 *    `parseGrokTurns` detects the shape (see `looksCumulative`) and converts a
 *    cumulative stream to per-prompt deltas before summing. One code path,
 *    both formats, no double-count either way.
 *
 * `inputTokens` INCLUDES `cachedReadTokens` and `outputTokens` INCLUDES
 * `reasoningTokens` — verified over 373 real turns (0 counterexamples, and
 * `totalTokens === inputTokens + outputTokens` in every one). So the cached
 * portion is split out to be priced at the cache-read tier, and reasoning is
 * NOT added on top of output; doing either would over-bill.
 */

/** Grok's per-cwd session folder is `encodeURIComponent(cwd)`. */
export function decodeGrokSessionDir(dirName) {
  // A folder name that isn't valid percent-encoding isn't one of grok's —
  // decodeURIComponent has no non-throwing form, so this catch IS the test.
  try {
    return decodeURIComponent(String(dirName || ''));
  } catch {
    return null;
  }
}

/**
 * Epoch-ms for an updates.jsonl envelope. `params._meta.agentTimestampMs` is
 * already ms; the envelope's own `timestamp` is epoch SECONDS (a 10-digit
 * value), which would land in 1970 if read as ms.
 */
function grokEventMs(line) {
  const meta = line?.params?._meta;
  if (typeof meta?.agentTimestampMs === 'number' && Number.isFinite(meta.agentTimestampMs)) {
    return meta.agentTimestampMs;
  }
  const ts = line?.timestamp;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return ts < 1e11 ? Math.round(ts * 1000) : ts;
}

/** The four billable buckets of one grok `usage` block, cache tiers split out. */
const grokBuckets = (usage) => ({
  messages: 1,
  // `inputTokens` includes the cached read — split so each tier prices at its
  // own rate instead of billing cache reads as fresh input.
  tokensIn: Math.max(0, num(usage?.inputTokens) - num(usage?.cachedReadTokens)),
  // `reasoningTokens` is a SUBSET of `outputTokens`, not an addition.
  tokensOut: num(usage?.outputTokens),
  cacheReadTokens: num(usage?.cachedReadTokens),
  cacheWriteTokens: num(usage?.cacheCreationTokens)
});

/**
 * True when every consecutive pair of turns is non-decreasing in all three
 * independently-moving fields — the signature of a cumulative stream.
 *
 * Requires at least three turns: two per-prompt turns are non-decreasing by
 * coincidence often enough to matter, three are not (0 of 39 real sessions with
 * >=3 turns are monotonic in all three fields, while a cumulative stream is
 * monotonic in all of them by construction).
 */
function looksCumulative(usages) {
  if (usages.length < 3) return false;
  const fields = ['inputTokens', 'outputTokens', 'cachedReadTokens'];
  return fields.every((field) => usages.every((usage, i) => (
    i === 0 || num(usages[i - 1][field]) <= num(usage[field])
  )));
}

/**
 * Parse a grok session's `updates.jsonl` into billed totals.
 *
 * @param {string} jsonlText raw file contents (may end mid-line)
 * @param {{ from?: number|null, to?: number|null, exclude?: {has:(k:string)=>boolean}|null }} [opts]
 *   `from`/`to` are epoch-ms bounds; `exclude` holds prompt keys already billed
 *   to another run (the same claim mechanism the Claude parser uses).
 * @returns {{ sessionId: string|null, model: string|null, models: string[],
 *   byModel: object, messages: number, tokensIn: number, tokensOut: number,
 *   cacheReadTokens: number, cacheWriteTokens: number, countedKeys: string[],
 *   turns: number }} `turns` is the number of `turn_completed` events SEEN
 *   (before windowing) — the sentinel that separates "this session recorded no
 *   billed turn, fall back to chat_history" from "it did, and this window's
 *   share of it is legitimately zero".
 */
export function parseGrokTurns(jsonlText, { from = null, to = null, exclude = null } = {}) {
  const totals = emptyTotals();
  const byModel = new Map();
  const counted = [];
  let sessionId = null;

  // Every turn_completed in file order — the whole sequence is needed before
  // any of it can be billed, because the cumulative test is a property of the
  // sequence, not of one line.
  const turns = [];
  for (const line of parseJsonLines(jsonlText)) {
    const update = line?.params?.update;
    if (!update || typeof update !== 'object') continue;
    if (typeof line.params?.sessionId === 'string') sessionId ??= line.params.sessionId;
    if (update.sessionUpdate !== 'turn_completed') continue;
    const usage = update.usage;
    if (!usage || typeof usage !== 'object') continue;
    turns.push({
      // `prompt_id` is unique per turn on every observed session; the ordinal
      // fallback keeps a turn that lacks one claimable rather than unbillable.
      key: typeof update.prompt_id === 'string' && update.prompt_id ? update.prompt_id : `#${turns.length}`,
      ms: grokEventMs(line),
      usage
    });
  }

  const cumulative = looksCumulative(turns.map((turn) => turn.usage));

  for (const [index, turn] of turns.entries()) {
    // A cumulative snapshot describes the session so far, so this turn's own
    // share is its delta against the previous snapshot (turn 0's baseline is a
    // fresh session, i.e. zero). A per-prompt block already IS its own share.
    const previous = cumulative && index > 0 ? turns[index - 1].usage : null;
    const usage = previous
      ? Object.fromEntries(Object.keys(turn.usage)
        .filter((field) => typeof turn.usage[field] === 'number')
        .map((field) => [field, Math.max(0, turn.usage[field] - num(previous[field]))]))
      : turn.usage;

    // A turn with no readable timestamp can't be placed in a run's window —
    // excluded whenever a bound is supplied, for the same reason the Claude
    // parser drops a timestamp-less message: accepting it hands the same tokens
    // to every run that ever reads this file.
    if (!inWindow(turn.ms, from, to)) continue;
    if (exclude?.has(turn.key)) continue;

    const buckets = grokBuckets(usage);
    if (totalTranscriptTokens(buckets) === 0) continue;
    counted.push(turn.key);
    for (const field of Object.keys(totals)) totals[field] += buckets[field];

    // `modelUsage` names the model(s) the turn actually called. In cumulative
    // mode its per-model figures are cumulative too, so bucket the DELTA'd
    // aggregate under the named model rather than re-reading the raw block.
    // A turn that called several models is attributed to the first: grok bills
    // one turn as a unit, and splitting the delta across models would need
    // per-model deltas the cumulative shape doesn't reliably provide.
    const bucketKey = Object.keys(turn.usage.modelUsage || {})[0] ?? UNKNOWN_MODEL;
    if (!byModel.has(bucketKey)) byModel.set(bucketKey, emptyTotals());
    const bucket = byModel.get(bucketKey);
    for (const field of Object.keys(bucket)) bucket[field] += buckets[field];
  }

  const models = [...byModel.keys()].filter((model) => model !== UNKNOWN_MODEL);
  return {
    sessionId,
    model: models[0] ?? null,
    models,
    byModel: Object.fromEntries(byModel),
    ...totals,
    countedKeys: counted,
    turns: turns.length
  };
}

/** Flatten grok's `content`, which is either a string or `[{ type, text }]`. */
function grokText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/**
 * Chars-in / chars-out for a grok session with no completed turn — a run that
 * was killed or interrupted before `turn_completed` was written. There are no
 * timestamps in this file, so it is billed whole-session or not at all; the
 * caller windows it by `summary.json` and claims the session id so two
 * overlapping runs can't both take it.
 *
 * `user` and `tool_result` are what the model READ; `assistant` and the
 * `reasoning` summaries are what it WROTE. `encrypted_content` on a reasoning
 * entry is an opaque blob, not text, and is excluded — its length says nothing
 * about the token count it stands for.
 *
 * @returns {{ model: string|null, charsIn: number, charsOut: number, messages: number }}
 */
export function parseGrokChatHistory(jsonlText) {
  let charsIn = 0;
  let charsOut = 0;
  let messages = 0;
  let model = null;

  for (const entry of parseJsonLines(jsonlText)) {
    switch (entry.type) {
      case 'user':
      case 'tool_result':
        charsIn += grokText(entry.content).length;
        break;
      case 'assistant': {
        charsOut += grokText(entry.content).length;
        for (const call of entry.tool_calls || []) {
          charsOut += typeof call?.arguments === 'string' ? call.arguments.length : 0;
        }
        if (typeof entry.model_id === 'string' && entry.model_id) model = entry.model_id;
        messages += 1;
        break;
      }
      case 'reasoning':
        charsOut += grokText(entry.summary).length;
        break;
      default:
        break;
    }
  }

  return { model, charsIn, charsOut, messages };
}

/**
 * ---------------------------------------------------------------------------
 * Antigravity (`agy`)
 * ---------------------------------------------------------------------------
 *
 * `~/.gemini/antigravity-cli/`
 *
 *   history.jsonl — `{ timestamp (epoch ms), workspace, conversationId? }`.
 *                   Only the lines carrying a `conversationId` name a run.
 *   brain/<conversationId>/.system_generated/logs/transcript.jsonl — the steps.
 *
 * The transcript carries NO token fields at all, so these rows are honest
 * chars/4 ESTIMATES and must never be presented as measured. `PLANNER_RESPONSE`
 * is the model speaking (content + thinking + tool-call arguments → output);
 * every other step type is text handed TO the model — a user turn, a system
 * message, or a tool result such as `VIEW_FILE`/`GREP_SEARCH` (→ input). Note
 * those tool-result steps carry `source: 'MODEL'` even though the text is the
 * tool's, which is why the split keys off `type`, not `source`.
 *
 * @param {string} jsonlText raw file contents (may end mid-line)
 * @param {{ from?: number|null, to?: number|null, exclude?: {has:(k:string)=>boolean}|null }} [opts]
 * @returns {{ charsIn: number, charsOut: number, messages: number,
 *   countedKeys: string[], steps: number }} `steps` is the number of steps SEEN
 *   before windowing — the sentinel separating "unreadable/empty transcript"
 *   from "read, and this window's share is zero".
 */
export function parseAgyTranscript(jsonlText, { from = null, to = null, exclude = null } = {}) {
  let charsIn = 0;
  let charsOut = 0;
  let messages = 0;
  let steps = 0;
  const counted = [];

  for (const [index, entry] of parseJsonLines(jsonlText).entries()) {
    if (typeof entry.type !== 'string') continue;
    steps += 1;
    if (!inWindow(toEpoch(entry.created_at), from, to)) continue;
    // `step_index` is the CLI's own ordinal and is stable across appends; the
    // parse ordinal only fills in for a step that somehow lacks one.
    const key = Number.isFinite(entry.step_index) ? `step-${entry.step_index}` : `#${index}`;
    if (exclude?.has(key)) continue;

    let chars = typeof entry.content === 'string' ? entry.content.length : 0;
    if (entry.type === 'PLANNER_RESPONSE') {
      chars += typeof entry.thinking === 'string' ? entry.thinking.length : 0;
      for (const call of entry.tool_calls || []) {
        chars += typeof call?.args === 'object' ? JSON.stringify(call.args).length : 0;
      }
      charsOut += chars;
      messages += 1;
    } else {
      charsIn += chars;
    }
    counted.push(key);
  }

  return { charsIn, charsOut, messages, countedKeys: counted, steps };
}

/**
 * The conversations `agy` recorded, from `~/.gemini/antigravity-cli/history.jsonl`.
 * Only lines carrying a `conversationId` name a brain transcript; the rest are
 * slash-command echoes. `timestamp` is epoch ms.
 *
 * @param {string} jsonlText
 * @returns {Array<{ conversationId: string, workspace: string|null, timestamp: number|null }>}
 */
export function parseAgyHistory(jsonlText) {
  const seen = new Set();
  const out = [];
  for (const entry of parseJsonLines(jsonlText)) {
    const id = entry?.conversationId;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      conversationId: id,
      workspace: typeof entry.workspace === 'string' ? entry.workspace : null,
      timestamp: typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) ? entry.timestamp : null
    });
  }
  return out;
}
