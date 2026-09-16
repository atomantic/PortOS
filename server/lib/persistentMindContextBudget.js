/**
 * Local provider context-budget / fitness failures for Persistent Mind wakes.
 *
 * When the pinned local window (numCtx / known context) is below the wake's
 * request token budget, retrying the same wake only climbs failureCount and
 * surfaces a vague "Provider unavailable or wake failed" in the public mind
 * state. That class of failure is not transient: the operator (or a granted
 * local-context tool) must raise numCtx or shrink the mind context.
 *
 * Soft transport failures stay on the interrupted + backoff path. Secrets and
 * prompt bodies never appear in the public pause copy — only the two token
 * counts when the providerStatus message already named them.
 */

/** Prefix shared by every stored/public context-budget pause reason. */
export const CONTEXT_BUDGET_PAUSE_REASON_PREFIX =
  'Local context window too small';

const KNOWN_BELOW_BUDGET_RE =
  /known\s+(\d+)[-\s]?token\s+context\s+is\s+below\s+the\s+(\d+)[-\s]?token\s+request\s+budget/i;

/** Matches promptRunner's CONTEXT_LENGTH_CATEGORY on refused-before-dispatch errors. */
const CONTEXT_LENGTH_CATEGORIES = new Set(['context-length', 'context_length', 'context-window']);

function errorText(errorOrMessage) {
  if (typeof errorOrMessage === 'string') return errorOrMessage;
  return String(errorOrMessage?.message || errorOrMessage || '');
}

function attachedCategory(errorOrMessage) {
  if (!errorOrMessage || typeof errorOrMessage !== 'object') return null;
  const value = errorOrMessage.errorAnalysis?.category
    || errorOrMessage.category
    || errorOrMessage.errorCategory
    || null;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Parse known/required token counts from a providerStatus / promptRunner message.
 * @returns {{ known: number, required: number } | null}
 */
export function parseContextBudgetTokens(errorOrMessage) {
  const text = errorText(errorOrMessage);
  const match = text.match(KNOWN_BELOW_BUDGET_RE);
  if (!match) return null;
  const known = Number(match[1]);
  const required = Number(match[2]);
  if (!Number.isFinite(known) || !Number.isFinite(required) || known <= 0 || required <= 0) {
    return null;
  }
  return { known, required };
}

/**
 * Human-actionable pause copy. Includes both token counts when present and
 * points at provider numCtx / mind context controls — never prompts or secrets.
 */
export function formatContextBudgetPauseReason({ known = null, required = null } = {}) {
  const counts = Number.isFinite(known) && Number.isFinite(required) && known > 0 && required > 0
    ? `known ${known}-token context is below the ${required}-token request budget`
    : 'known context is below the request token budget';
  return `${CONTEXT_BUDGET_PAUSE_REASON_PREFIX}: ${counts}. Raise provider numCtx (Settings → AI providers) or shrink mind context, then resume.`;
}

export function contextBudgetPauseReasonFrom(errorOrMessage) {
  const tokens = parseContextBudgetTokens(errorOrMessage);
  return formatContextBudgetPauseReason(tokens || {});
}

/**
 * True for the non-transient local context-fitness class: known window below
 * request budget (message and/or attached context-length category).
 */
export function isContextBudgetFitnessError(errorOrMessage) {
  if (errorOrMessage == null || errorOrMessage === '') return false;
  if (parseContextBudgetTokens(errorOrMessage)) return true;
  const category = attachedCategory(errorOrMessage);
  // promptRunner stamps CONTEXT_LENGTH_CATEGORY on refuse-before-dispatch
  // errors; trust that signal even when the message is terse.
  if (category && CONTEXT_LENGTH_CATEGORIES.has(category)) return true;
  return false;
}

/**
 * True when durable pauseReason / lastError is (or clearly describes) a
 * context-budget autopause — including raw providerStatus messages still
 * stored from before this classifier existed.
 */
export function isContextBudgetPauseReason(reason) {
  if (typeof reason !== 'string' || !reason.trim()) return false;
  if (reason.startsWith(CONTEXT_BUDGET_PAUSE_REASON_PREFIX)) return true;
  return parseContextBudgetTokens(reason) != null;
}

/**
 * Public-safe pause / lastError text for a context-budget failure.
 * Re-formats raw provider messages so the UI never depends on a provider
 * name prefix while still keeping the numbers when present.
 */
export function publicContextBudgetReason(reasonOrError) {
  if (reasonOrError == null || reasonOrError === '') return null;
  if (typeof reasonOrError === 'string' && reasonOrError.startsWith(CONTEXT_BUDGET_PAUSE_REASON_PREFIX)) {
    return reasonOrError;
  }
  if (!isContextBudgetFitnessError(reasonOrError) && !isContextBudgetPauseReason(reasonOrError)) {
    return null;
  }
  return contextBudgetPauseReasonFrom(reasonOrError);
}
