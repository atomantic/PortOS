/**
 * Local-LLM code review backend for the Review Loop's `lmstudio` / `ollama`
 * reviewer kinds. The follow-up agent (a CLI like Claude / Antigravity / Codex)
 * POSTs the PR diff to `/api/code-review/local`; we feed it through the
 * configured backend's OpenAI-compatible `/v1/chat/completions` endpoint with
 * a code-review system prompt and return the findings text the agent then
 * applies.
 *
 * Kept separate from `localLlm.js` (catalog/install/migrate) and the AI
 * toolkit runner (full-session orchestration with disk-backed run dirs) — a
 * single synchronous request/response is the right shape for a reviewer that
 * has to fit inside the agent's `curl` step.
 */

import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readResponseJson } from '../lib/readResponseJson.js'
import {
  LOCAL_LLM_REVIEWERS,
  DEFAULT_REVIEWERS,
  DEFAULT_REVIEW_STOP_MODE,
  REVIEWER_ALIASES,
  REVIEWER_VALUES,
  REVIEW_STOP_MODES,
  normalizeReviewUsernames,
  resolveReviewUsernames,
} from '../lib/validation.js'
import { getSettings, settingsEvents } from './settings.js'
import { getBaseUrl as getLmStudioBaseUrl } from './lmStudioManager.js'
import { getBaseUrl as getOllamaBaseUrl } from './ollamaManager.js'

// Both LM Studio (`:1234`) and Ollama (`:11434`) ship OpenAI-compatible
// `/v1/chat/completions`. Resolve through each manager's live `getBaseUrl()`
// so a runtime `updateConfig({ baseUrl })` from the local-LLM tab takes
// effect here too — otherwise the catalog UI and the reviewer would silently
// desync when a user relocates their LM Studio install.
const BACKEND_BASE_URLS = {
  lmstudio: () => getLmStudioBaseUrl(),
  ollama: () => getOllamaBaseUrl(),
}

export function isLocalLlmReviewer(backend) {
  return LOCAL_LLM_REVIEWERS.includes(backend)
}

/**
 * Resolve the global Code Review Defaults from `settings.codeReview`, falling
 * back to the hardcoded `['copilot']` / `all` / `false` defaults when the user
 * hasn't configured them yet. Filters out invalid enum values so a hand-edited
 * settings.json can't smuggle in bogus reviewer names. Returns a value-only
 * shape (no I/O) so the spawner and `GET /api/code-review/defaults` can share.
 */
export function pickCodeReviewDefaults(settings) {
  const raw = settings && typeof settings === 'object' ? settings.codeReview : null
  const reviewersIn = Array.isArray(raw?.reviewers) ? raw.reviewers : null
  const reviewers = reviewersIn
    ? Array.from(new Set(reviewersIn.map((r) => REVIEWER_ALIASES[r] || r).filter((r) => REVIEWER_VALUES.includes(r))))
    : []
  return {
    reviewers: reviewers.length ? reviewers : [...DEFAULT_REVIEWERS],
    // Arbitrary GitHub reviewer usernames appended to `--review-with` to gate the
    // merge. Normalized so a hand-edited settings.json can't smuggle in unsafe
    // tokens. Empty array = none configured (distinct from the copilot fallback
    // reviewers get).
    usernames: normalizeReviewUsernames(raw?.usernames),
    stopMode: REVIEW_STOP_MODES.includes(raw?.stopMode) ? raw.stopMode : DEFAULT_REVIEW_STOP_MODE,
    reviewerApplies: raw?.reviewerApplies === true,
    lmstudioModel: typeof raw?.lmstudioModel === 'string' && raw.lmstudioModel ? raw.lmstudioModel : null,
    ollamaModel: typeof raw?.ollamaModel === 'string' && raw.ollamaModel ? raw.ollamaModel : null,
    codexModel: typeof raw?.codexModel === 'string' && raw.codexModel ? raw.codexModel : null,
  }
}

/**
 * Convenience async wrapper that reads settings.json and returns the merged
 * defaults. Used by the lifecycle fallback and the AI Providers panel.
 *
 * Cached so the per-agent-completion fallback (`finalizeAgent`) doesn't pay
 * a `readFile + JSON.parse + stripStoreKeys` round-trip on every sweep —
 * during a busy CoS evaluation that's dozens of redundant disk reads. The
 * cache invalidates on any `settings:updated` event so the panel's save
 * takes effect immediately without a restart.
 */
let cachedDefaults = null
settingsEvents.on('settings:updated', () => { cachedDefaults = null })

/** Test-only: reset the memoized defaults cache to its uninitialized sentinel. */
export function __resetCodeReviewDefaultsCache() { cachedDefaults = null }

export async function getCodeReviewDefaults() {
  if (cachedDefaults) return cachedDefaults
  cachedDefaults = pickCodeReviewDefaults(await getSettings())
  return cachedDefaults
}

/**
 * Reviewer-loop option resolver shared by `finalizeAgent` (agentLifecycle.js)
 * and the CLI cleanup path (agentCliSpawning.js): merges per-task metadata
 * with the user's Code Review Defaults, returning `{ reviewers, reviewStopMode,
 * reviewerApplies }` in the exact shape `cleanupAgentWorktree` expects.
 *
 * Pass `normalize` (server/lib/validation.js `normalizeReviewers`) so this
 * module doesn't have to import it directly — keeps validation.js as the
 * single source of truth for the reviewer enum & fallback rules.
 *
 * `codexModel` (the Codex CLI model tier for a `codex` reviewer) comes from the
 * Code Review Defaults panel. Unlike the local-LLM models — which the
 * `/api/code-review/local` endpoint injects server-side — the Codex CLI is
 * invoked directly by the follow-up agent, so this value has to ride along into
 * the follow-up's prompt.
 *
 * Errors in settings I/O fall back to the hardcoded defaults — settings read
 * failures shouldn't block agent completion.
 */
export async function resolveReviewLoopOptions(metadata, { normalize, isTruthyMeta }) {
  const defaults = await getCodeReviewDefaults().catch(() => null)
  const reviewers = normalize(metadata, defaults?.reviewers)
  // GitHub reviewer usernames: a task-level list (even empty) overrides the
  // global default; only fall back to the Code Review Defaults when the task
  // didn't pin its own. Mirrors the reviewers precedence.
  const usernames = resolveReviewUsernames(metadata?.usernames, defaults?.usernames)
  const reviewStopMode = metadata?.reviewStopMode || defaults?.stopMode || DEFAULT_REVIEW_STOP_MODE
  const reviewerApplies = metadata?.reviewerApplies !== undefined
    ? isTruthyMeta(metadata?.reviewerApplies)
    : (defaults?.reviewerApplies === true)
  const codexModel = defaults?.codexModel || null
  return { reviewers, usernames, reviewStopMode, reviewerApplies, codexModel }
}

const CODE_REVIEW_SYSTEM_PROMPT = `You are a careful senior code reviewer. The user will paste a unified PR diff. Review only what the diff changes (not the whole repo). Produce findings as a markdown list grouped by severity:

## Blocking
## Recommended
## Nits

For each finding, name the file:line (when known) and explain the issue + suggested fix in one or two sentences. If you find nothing in a section, omit it. If the diff is clean across all severities, reply with exactly: \`No findings.\``

/**
 * Run a single code-review request against the configured local-LLM backend.
 * Returns `{ ok, findings, model, backend, error? }`. Caller is responsible
 * for surfacing the text findings to the agent driving the review loop.
 *
 * @param {Object} opts
 * @param {'lmstudio'|'ollama'} opts.backend
 * @param {string} opts.model - Installed model id (e.g. `qwen2.5-coder:7b`).
 * @param {string} opts.diff - Unified diff text to review.
 * @param {number} [opts.timeoutMs=120000] - 2 min default — LM Studio cold-
 *   load of a large coder model regularly exceeds 30s but rarely 2 min.
 */
export async function runLocalCodeReview({ backend, model, diff, timeoutMs = 120000 } = {}) {
  if (!isLocalLlmReviewer(backend)) {
    return { ok: false, error: `Unsupported reviewer backend: ${backend}` }
  }
  if (!model || typeof model !== 'string') {
    return { ok: false, error: `No model configured for ${backend} reviewer — set one on the AI Providers → Code Review Defaults panel.` }
  }
  const trimmedDiff = typeof diff === 'string' ? diff.trim() : ''
  if (!trimmedDiff) {
    return { ok: false, error: 'Empty diff — nothing to review.' }
  }

  const baseUrl = BACKEND_BASE_URLS[backend]()
  const body = {
    model,
    messages: [
      { role: 'system', content: CODE_REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: `Review this PR diff:\n\n\`\`\`diff\n${trimmedDiff}\n\`\`\`` },
    ],
    temperature: 0.2,
    stream: false,
  }

  const response = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs).catch((err) => ({ ok: false, _fetchError: err.message }))

  if (response._fetchError !== undefined) {
    return { ok: false, backend, model, error: `${backend} request failed: ${response._fetchError}` }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { ok: false, backend, model, error: `${backend} API error ${response.status}: ${text.slice(0, 300)}` }
  }

  // Surface the server's raw error text instead of swallowing a non-JSON body to
  // null — a 200-with-HTML answer used to read as the misleading "no content".
  const data = await readResponseJson(response, { fallback: (raw) => ({ _nonJson: raw }) })
  if (data?._nonJson !== undefined) {
    return { ok: false, backend, model, error: `${backend} returned a non-JSON response: ${data._nonJson.slice(0, 300)}` }
  }
  const findings = data?.choices?.[0]?.message?.content
  if (!findings || typeof findings !== 'string') {
    return { ok: false, backend, model, error: `${backend} returned no content.` }
  }
  return { ok: true, backend, model, findings: findings.trim() }
}
