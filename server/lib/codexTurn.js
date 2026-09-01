/**
 * The INFERENCE half of the Codex ChatGPT-subscription provider (#5590), pure.
 *
 * `codexAccount.js` answers "is this subscription usable"; this module answers
 * "what can it run, and what did a run produce". It owns the thread/turn/model
 * slice of the documented Codex app-server protocol: which methods and
 * notifications PortOS speaks, the fixed safety envelope a generic text call
 * runs under, and the normalizers that turn protocol frames into PortOS's own
 * `{ text, usage, error }` contract. The process half is
 * `services/codexAppServer.js`.
 *
 * Two boundaries this file exists to hold:
 *
 *   - **A text call is not a coding agent.** The `codex` provider stays a
 *     file-writing CLI/TUI harness for CoS tasks; that path is untouched. When
 *     the SAME record is selected as a text transport it runs under
 *     {@link CODEX_TEXT_THREAD_CONFIG}: an empty throwaway cwd, a read-only
 *     sandbox with no network, approvals that can only deny, no MCP servers,
 *     and no web search. Nothing about the PortOS checkout or `data/` is
 *     reachable from a Brain or JIRA summary call.
 *   - **Partial output is not an answer.** A turn that is interrupted, fails,
 *     or never reaches `turn/completed` yields an error, never the text
 *     accumulated so far — a half-streamed JSON object that parsed would be
 *     silently wrong data.
 *
 * Sentinel discipline (AGENTS.md) carries over from `codexAccount.js`:
 * `models: null` = NEVER FETCHED and `models: []` = fetched and genuinely
 * empty, so a catalog read that fails can never overwrite a last-known-good
 * list with "this account has no models".
 */

import { ERROR_CATEGORIES } from './aiToolkit/errorDetection.js';
import { CODEX_ERROR_CODES, isCodexSubscriptionProvider } from './codexAccount.js';

/**
 * The value a provider record carries to advertise that it can serve generic
 * text through the app-server. One string rather than a boolean so a future
 * second transport is a new value, not a second flag that can contradict the
 * first.
 */
export const CODEX_TEXT_TRANSPORT = 'codex-app-server';

/** Thread/turn/model JSON-RPC methods. Read + run; nothing that mutates state. */
export const CODEX_TURN_RPC = Object.freeze({
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  modelList: 'model/list',
});

/** Server notifications a running turn projects into text/usage. */
export const CODEX_TURN_NOTIFICATIONS = Object.freeze({
  agentMessageDelta: 'item/agentMessage/delta',
  itemCompleted: 'item/completed',
  turnCompleted: 'turn/completed',
  tokenUsage: 'thread/tokenUsage/updated',
  error: 'error',
});

/**
 * The safety envelope every generic text turn runs under.
 *
 * `approvalPolicy: 'never'` is FAIL-CLOSED here, not permissive: paired with a
 * read-only sandbox it means an escalation request is refused outright rather
 * than queued for a human who is not watching a Brain summary. `ephemeral`
 * keeps the thread out of the user's Codex history, and the empty `mcp_servers`
 * / disabled web search strip every tool the model could otherwise reach for.
 *
 * The `cwd` is supplied per call (a fresh empty directory outside the PortOS
 * checkout) because it is a runtime path, not a constant.
 */
export const CODEX_TEXT_THREAD_CONFIG = Object.freeze({
  approvalPolicy: 'never',
  sandbox: 'read-only',
  ephemeral: true,
  config: Object.freeze({
    mcp_servers: {},
    tools: { web_search: false },
    web_search: false,
  }),
});

/** The per-turn sandbox override, restated so a turn cannot inherit a wider one. */
export const CODEX_TEXT_TURN_SANDBOX = Object.freeze({ type: 'readOnly', networkAccess: false });

/** Typed failures the transport raises, alongside `CODEX_ERROR_CODES`. */
export const CODEX_TURN_ERROR_CODES = Object.freeze({
  turnFailed: 'CODEX_TURN_FAILED',
  turnInterrupted: 'CODEX_TURN_INTERRUPTED',
  turnEmpty: 'CODEX_TURN_EMPTY',
  quotaExhausted: 'CODEX_QUOTA_EXHAUSTED',
  transportBenched: 'CODEX_TRANSPORT_BENCHED',
});

/**
 * Does this record ADVERTISE the subscription text transport?
 *
 * Advertising is not permission — see {@link isCodexTextTransportEnabled}. The
 * shipped seed advertises it so the Providers page has something to offer,
 * while the capability stays off until the user turns it on.
 */
export const providerDeclaresCodexTextTransport = (provider) =>
  provider?.textTransport === CODEX_TEXT_TRANSPORT
  // "Which record IS the Codex subscription" is one question with one answer,
  // keyed on the COMMAND so a renamed clone still resolves. Reused rather than
  // restated so the account side and the inference side can never drift.
  && isCodexSubscriptionProvider(provider);

/**
 * May PortOS actually route a text call here?
 *
 * Requires the explicit opt-in, so a fresh install that has never signed in
 * cannot have a background feature quietly start billing a subscription — the
 * epic's "keep the capability off until the user enables it" rule, enforced at
 * the one place every caller passes through.
 */
export const isCodexTextTransportEnabled = (provider) =>
  providerDeclaresCodexTextTransport(provider)
  && provider.enabled !== false
  && provider.textTransportEnabled === true;

const trimmed = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

const finiteInt = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null);

/**
 * The non-secret shape of one `model/list` entry, or `null` when the entry has
 * no usable id.
 */
const normalizeModel = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = trimmed(raw.id) || trimmed(raw.model);
  if (!id) return null;
  const supportedEfforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
      .map((entry) => trimmed(typeof entry === 'string' ? entry : entry?.reasoningEffort))
      .filter(Boolean)
    : [];
  return {
    id,
    displayName: trimmed(raw.displayName) || id,
    description: trimmed(raw.description),
    isDefault: raw.isDefault === true,
    hidden: raw.hidden === true,
    defaultEffort: trimmed(raw.defaultReasoningEffort),
    supportedEfforts,
    contextWindow: finiteInt(raw.contextWindow),
  };
};

/**
 * The non-secret shape of `model/list`.
 *
 * THROWS for a response that is not a catalog, so a failed read stays `null`
 * at the call site and the last-known-good list survives. A catalog that is
 * genuinely empty returns `[]`, which is a real answer and must not be
 * re-labelled as a failed fetch.
 *
 * Hidden models are dropped: they are not in Codex's own picker, so offering
 * them in PortOS would surface ids the account cannot actually run.
 */
export const normalizeCodexModels = (result) => {
  if (!result || typeof result !== 'object') throw new Error('model/list returned a non-object result');
  const data = Array.isArray(result.data) ? result.data : (Array.isArray(result.models) ? result.models : null);
  if (!data) throw new Error('model/list returned no model array');
  return {
    models: data.map(normalizeModel).filter((model) => model !== null && !model.hidden),
    nextCursor: trimmed(result.nextCursor),
  };
};

/**
 * One token-usage breakdown, normalized to PortOS's field names, or `null`
 * when the payload carries no counts.
 *
 * `source: 'chatgpt-subscription'` is the attribution the criterion asks for:
 * the tokens are real, the dollar cost is NOT — a subscription turn has no
 * per-call price, and inventing one would corrupt the savings/quota views that
 * consume these records.
 */
export const normalizeCodexTokenUsage = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const breakdown = raw.last ?? raw.total ?? raw;
  if (!breakdown || typeof breakdown !== 'object') return null;
  const inputTokens = finiteInt(breakdown.inputTokens);
  const outputTokens = finiteInt(breakdown.outputTokens);
  const totalTokens = finiteInt(breakdown.totalTokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedInputTokens: finiteInt(breakdown.cachedInputTokens) ?? 0,
    reasoningOutputTokens: finiteInt(breakdown.reasoningOutputTokens) ?? 0,
    totalTokens: totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)),
    modelContextWindow: finiteInt(raw.modelContextWindow),
    source: 'chatgpt-subscription',
  };
};

/**
 * Which reasoning effort a turn should carry.
 *
 * The rule mirrors the existing Codex provider's visible clamp: an effort the
 * model does not advertise is reported as clamped to the model's own default
 * rather than silently sent and rejected mid-turn. A model whose catalog entry
 * PortOS has never fetched (`supportedEfforts: []`) is NOT evidence that the
 * effort is unsupported, so the request passes through untouched.
 */
export const resolveCodexEffort = (requested, model = null) => {
  const want = trimmed(requested);
  if (!want) return { effort: null, clamped: false, reason: null };
  const supported = Array.isArray(model?.supportedEfforts) ? model.supportedEfforts : [];
  if (supported.length === 0 || supported.includes(want)) return { effort: want, clamped: false, reason: null };
  const fallback = trimmed(model?.defaultEffort);
  return {
    effort: fallback,
    clamped: true,
    reason: `${model?.id || 'the selected model'} does not support "${want}" reasoning effort`
      + (fallback ? ` — using "${fallback}"` : ' — using the model default'),
  };
};

/**
 * Codex error identifiers that mean the SUBSCRIPTION is spent rather than the
 * request being wrong. Both spellings the protocol uses are listed because a
 * miss here degrades to a generic bench, which is the safe side.
 */
const QUOTA_ERROR_INFO = new Set(['usageLimitExceeded', 'sessionBudgetExceeded']);
const RATE_LIMIT_ERROR_INFO = new Set(['rateLimitExceeded', 'serverOverloaded']);
const AUTH_ERROR_INFO = new Set(['unauthorized']);

const errorInfoTag = (error) => {
  const info = error?.codexErrorInfo;
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') return Object.keys(info)[0] ?? null;
  return null;
};

/**
 * Map a `TurnError` (or a thrown transport error) onto the error category the
 * shared cooldown/fallback policy already understands.
 *
 * Returning a category rather than a bench duration keeps the policy in
 * `lib/providerCooldown.js` — one table, so a quota exhaustion benches for the
 * same window whichever path noticed it.
 */
export const classifyCodexTurnError = (error) => {
  const tag = errorInfoTag(error);
  const message = trimmed(error?.message) || 'The Codex turn failed';
  if (QUOTA_ERROR_INFO.has(tag)) return { category: ERROR_CATEGORIES.USAGE_LIMIT, message };
  if (RATE_LIMIT_ERROR_INFO.has(tag)) return { category: ERROR_CATEGORIES.RATE_LIMIT, message };
  if (AUTH_ERROR_INFO.has(tag)) return { category: ERROR_CATEGORIES.AUTH_ERROR, message };
  // 'context-length' is one of providerCooldown's SCHEMA_TYPE categories rather
  // than an ERROR_CATEGORIES member: an oversized prompt is REQUEST-specific, so
  // it must shrink and retry, never bench the subscription for every other call.
  if (tag === 'contextWindowExceeded') return { category: 'context-length', message };
  if (tag === 'cyberPolicy' || tag === 'misalignmentPolicyViolation') {
    return { category: ERROR_CATEGORIES.CONTENT_REFUSAL, message };
  }
  if (tag === 'httpConnectionFailed' || tag === 'responseStreamConnectionFailed'
    || tag === 'responseStreamDisconnected' || tag === 'responseTooManyFailedAttempts') {
    return { category: ERROR_CATEGORIES.NETWORK_ERROR, message };
  }
  if (tag === 'badRequest') return { category: ERROR_CATEGORIES.MODEL_NOT_FOUND, message };
  // No structured tag: fall back to the account module's text heuristics for
  // the one case that must not be missed — a sign-in that is simply gone.
  if (/\b(401|unauthorized|unauthenticated|invalid[_ -]?grant|token (?:expired|revoked)|re-?authenticate)\b/i.test(message)) {
    return { category: ERROR_CATEGORIES.AUTH_ERROR, message };
  }
  if (/\busage limit|quota (?:exceeded|exhausted)|out of credits\b/i.test(message)) {
    return { category: ERROR_CATEGORIES.USAGE_LIMIT, message };
  }
  return { category: ERROR_CATEGORIES.UNKNOWN, message };
};

/**
 * The error category for anything the transport can throw — a protocol/process
 * failure as well as a model-side `TurnError`.
 *
 * Two failure shapes reach a caller: a typed `ServerError` from the app-server
 * client (the binary is missing, the child died, a request timed out) and a
 * classified turn failure carried on `context.category`. Folding both here
 * means the cooldown/fallback decision reads ONE vocabulary — the same
 * `ERROR_CATEGORIES` every other provider path uses.
 */
export const classifyCodexTransportError = (err) => {
  const carried = err?.context?.category;
  if (typeof carried === 'string' && carried) return carried;
  switch (err?.code) {
    case CODEX_ERROR_CODES.runtimeMissing:
    case CODEX_ERROR_CODES.startFailed:
    case CODEX_ERROR_CODES.exited:
      return ERROR_CATEGORIES.SPAWN_ERROR;
    case CODEX_ERROR_CODES.timeout:
      return ERROR_CATEGORIES.TIMEOUT;
    case CODEX_ERROR_CODES.authRevoked:
      return ERROR_CATEGORIES.AUTH_ERROR;
    case CODEX_TURN_ERROR_CODES.turnInterrupted:
      return ERROR_CATEGORIES.CANCELED;
    default:
      return classifyCodexTurnError({ message: err?.message }).category;
  }
};

/** A fresh accumulator for one turn. */
export const createTurnAccumulator = (turnId = null) => ({
  turnId,
  deltas: [],
  finalText: null,
  usage: null,
  error: null,
  status: 'inProgress',
});

const appendText = (acc, text) => {
  if (typeof text !== 'string' || text === '') return;
  acc.deltas.push(text);
};

/**
 * Fold one server notification into the accumulator.
 *
 * Frames for another thread or another turn are ignored rather than merged —
 * one app-server connection is shared by every caller, so a concurrent turn's
 * deltas must never leak into this one's answer.
 *
 * Returns `true` when the turn has reached a terminal state.
 */
export const applyCodexTurnEvent = (acc, method, params) => {
  // Already terminal: report it as such so a late frame cannot settle the turn
  // a second time, and never fold it into the answer.
  if (!acc || acc.status !== 'inProgress') return true;
  if (!params || typeof params !== 'object') return false;
  if (acc.turnId && typeof params.turnId === 'string' && params.turnId !== acc.turnId) return false;

  switch (method) {
    case CODEX_TURN_NOTIFICATIONS.agentMessageDelta:
      appendText(acc, params.delta);
      return false;
    case CODEX_TURN_NOTIFICATIONS.itemCompleted:
      // The completed item is AUTHORITATIVE for its own text; the deltas were a
      // progress signal. Replacing rather than appending is what keeps a
      // retried/repaired stream from producing doubled prose.
      if (params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
        acc.finalText = acc.finalText === null ? params.item.text : `${acc.finalText}${params.item.text}`;
      }
      return false;
    case CODEX_TURN_NOTIFICATIONS.tokenUsage:
      acc.usage = normalizeCodexTokenUsage(params.tokenUsage) ?? acc.usage;
      return false;
    case CODEX_TURN_NOTIFICATIONS.error:
      // `willRetry` means the app-server is still working the turn — recording
      // it as terminal here would abandon a run that is about to succeed.
      if (params.willRetry === true) return false;
      acc.error = classifyCodexTurnError(params.error);
      acc.status = 'failed';
      return true;
    case CODEX_TURN_NOTIFICATIONS.turnCompleted: {
      const turn = params.turn;
      if (acc.turnId && turn?.id && turn.id !== acc.turnId) return false;
      acc.status = typeof turn?.status === 'string' ? turn.status : 'completed';
      if (acc.status === 'failed') acc.error = classifyCodexTurnError(turn?.error);
      return true;
    }
    default:
      return false;
  }
};

/**
 * The finished turn as PortOS's `{ text, usage }` contract, or a thrown-shaped
 * `{ error }`.
 *
 * A non-`completed` status NEVER yields text. That is the "partial output is
 * never accepted as complete structured data" rule: an interrupted turn's
 * half-written JSON would parse into plausible, wrong data, so the caller gets
 * an error and its own fallback path instead.
 */
export const finalizeCodexTurn = (acc) => {
  if (!acc) return { error: 'The Codex turn produced no result', category: ERROR_CATEGORIES.UNKNOWN };
  if (acc.status === 'failed') {
    return { error: acc.error?.message || 'The Codex turn failed', category: acc.error?.category || ERROR_CATEGORIES.UNKNOWN };
  }
  if (acc.status === 'interrupted') {
    return { error: 'The Codex turn was cancelled', category: ERROR_CATEGORIES.CANCELED, canceled: true };
  }
  if (acc.status !== 'completed') {
    return { error: 'The Codex turn ended without completing', category: ERROR_CATEGORIES.UNKNOWN };
  }
  const text = acc.finalText !== null ? acc.finalText : acc.deltas.join('');
  if (!text.trim()) {
    return { error: 'Codex returned an empty completion', category: ERROR_CATEGORIES.UNKNOWN };
  }
  return { text, usage: acc.usage };
};
