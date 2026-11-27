// Persist reviewer health, choose available fallback groups, and report configuration faults.

import { commandExists } from '../lib/commandExists.js'
import { EXECUTION_OPTIONS_ERROR, codexSpeedProbeFailureMessage } from '../lib/executionOptions.js'
import { isCliReviewer, isProviderReviewer, isReviewer, REVIEWER_ALIASES, REVIEWER_VALUES, reviewerCliBinary } from '../lib/reviewerConfig.js'
import { activeReviewerGroupIndex, isReviewerConfigFault, reviewFailureDiagnostics } from '../lib/reviewerHealth.js'
import { getSettings, updateSettingsWith } from './settings.js'
import { getProviderReviewCapability, isTimeoutFailure, reviewProbeFields } from './codeReviewTransport.js'

export const REVIEWER_PAUSE_MS = 24 * 60 * 60 * 1000
const QUOTA_FAILURE = /quota|rate.?limit|usage.?limit|too many requests|\b(?:HTTP(?:\/[\d.]+)?|status[_ ]?code|status|code|error)\W{0,3}(?:429|402)\b|payment required|limit for the day|daily.?limit|session.?limit|plan.?limit|free.?limit|free.?tier|FreeTierError|err_free_used|allowance is used up|is used up|top up your balance|wallet billing|out of credits|credit balance (?:is )?too low|insufficient.?(?:credits|funds|balance)|exceeded (?:your )?(?:daily |current )?(?:quota|limit|allowance)|upgrade (?:your )?subscription|Upgrade to Pro/i

function isReviewerQuotaFailure(error) {
  if (!error) return false
  if (typeof error === 'object') {
    if (error.status === 429 || error.status === 402 || error.statusCode === 429 || error.statusCode === 402) return true
    if (error.name === 'FreeTierError' || error.providerErrorType === 'FreeTierError') return true
    if (error.code === 'insufficient_quota' || error.code === 'rate_limit_exceeded' || error.code === 'err_free_used') return true
    if (error.error && typeof error.error === 'object') {
      if (isReviewerQuotaFailure(error.error)) return true
    }
  }
  // Model-authored text/output cannot establish the provider's quota state.
  const message = typeof error === 'object'
    ? `${error.error || ''} ${error.message || ''} ${error.code || ''} ${error.stderr || ''}`
    : String(error)
  return QUOTA_FAILURE.test(message)
}

export const normalizeFallbackGroups = (groups) => Array.isArray(groups)
  ? groups.map(group => Array.from(new Set((Array.isArray(group) ? group : []).map(r => REVIEWER_ALIASES[r] || r).filter(isReviewer)))).filter(group => group.length)
  : []

export function pickAvailableReviewerGroups(raw, now = Date.now()) {
  const groups = normalizeFallbackGroups(raw?.reviewerFallbackGroups)
  const health = raw?.reviewerHealth && typeof raw.reviewerHealth === 'object' ? raw.reviewerHealth : {}
  return groups[activeReviewerGroupIndex(groups, health, now)]
    ?? (Array.isArray(raw?.reviewerFallbackGroups) ? [] : null)
}

export async function reportReviewerFailure(reviewer, error, now = Date.now()) {
  if (!isReviewer(reviewer)) return false
  const result = error && typeof error === 'object' ? error : { error }
  const message = String(result.error || result.message || 'Reviewer failed')
  const code = typeof result.code === 'string' ? result.code : null
  const explicitReason = typeof result.reason === 'string' ? result.reason : null
  const isConfigFault = explicitReason === 'configuration' || isReviewerConfigFault(code)
  const isMalformed = explicitReason === 'malformed' || code === 'MALFORMED_REVIEW'
  const isQuota = explicitReason === 'quota' || (!isTimeoutFailure(message) && isReviewerQuotaFailure(result))
  const isExplicitUnavailable = explicitReason === 'unavailable'

  // Input limits are not provider health, quota, or configuration failures.
  if (['REVIEW_CONTEXT_CAPACITY', 'REVIEW_BUDGET_EXHAUSTED', 'REVIEW_INCOMPLETE', 'REVIEW_BATCH_FAILED'].includes(code)
      && !isQuota && !isConfigFault && !isExplicitUnavailable) return false

  const isProvider = isProviderReviewer(reviewer)

  if (!isConfigFault && !isMalformed && !isQuota && !isExplicitUnavailable && !isProvider) {
    return false
  }

  // The failure count and pause decision derive from the persisted record
  // inside the serialized update, so concurrent failures each see the others.
  // Reviewer telemetry is not a user action. The standalone claim bridge must
  // not initialize the live user-action database while updating local health.
  let shouldPause = false
  let pauseReason = null
  await updateSettingsWith((current) => {
    const existing = current.codeReview?.reviewerHealth?.[reviewer] || {}
    const failureCount = (Number(existing.failureCount) || 0) + 1
    const isRepeatedFailure = failureCount >= 2
    shouldPause = isQuota || isExplicitUnavailable || isRepeatedFailure || (Number(existing.pausedUntil) > now)
    pauseReason = isQuota ? 'quota' : (isExplicitUnavailable ? 'unavailable' : (isRepeatedFailure ? 'unavailable' : (existing.reason || 'unavailable')))

    let entry
    if (isMalformed) {
      entry = {
        ...(Number(existing.pausedUntil) > now
          ? { pausedUntil: existing.pausedUntil } : {}),
        code,
        reason: 'malformed',
        failureCount,
        lastFailureAt: now,
        diagnostics: reviewFailureDiagnostics(result.diagnostics),
      }
    } else if (isConfigFault) {
      entry = { code, reason: 'configuration', failureCount, lastFailureAt: now,
        ...reviewProbeFields({ ...result, code }),
      }
    } else if (shouldPause) {
      entry = {
        pausedUntil: Number(existing.pausedUntil) > now ? existing.pausedUntil : now + REVIEWER_PAUSE_MS,
        reason: pauseReason,
        failureCount,
        lastFailureAt: now,
        ...(message && message !== 'Reviewer failed' ? { message } : {}),
      }
    } else {
      entry = {
        reason: 'provider_error',
        failureCount,
        lastFailureAt: now,
        ...(message && message !== 'Reviewer failed' ? { message } : {}),
      }
    }

    if (result.diagnostics?.cli) entry.diagnostics = reviewFailureDiagnostics(result.diagnostics)
    return {
      ...current,
      codeReview: {
        ...(current.codeReview || {}),
        reviewerHealth: {
          ...(current.codeReview?.reviewerHealth || {}),
          [reviewer]: entry,
        },
      },
    }
  }, { skipUserAction: true })
  if (isProvider) {
    const providerId = reviewer.slice('provider:'.length)
    if (isQuota) {
      import('./provider/providerStatus.js')
        .then(({ markProviderUsageLimit }) => markProviderUsageLimit(providerId, { message }))
        .catch(() => {})
    } else if (shouldPause) {
      import('./provider/providerStatus.js')
        .then(({ markProviderUnavailable }) => markProviderUnavailable(providerId, { reason: pauseReason, message, waitTimeMs: REVIEWER_PAUSE_MS }))
        .catch(() => {})
    }
  }
  return true
}

export async function reportReviewerSuccess(reviewer, now = Date.now()) {
  if (!isReviewer(reviewer)) return false
  if (!(await getSettings())?.codeReview?.reviewerHealth?.[reviewer]) return false
  let cleared = false
  await updateSettingsWith((current) => {
    const health = current.codeReview?.reviewerHealth
    const prior = health?.[reviewer]
    if (!prior || (!isReviewerConfigFault(prior.code) && Number(prior.pausedUntil) > now)) return current
    const remaining = Object.fromEntries(Object.entries(health).filter(([key]) => key !== reviewer))
    cleared = true
    return {
      ...current,
      codeReview: {
        ...Object.fromEntries(Object.entries(current.codeReview || {}).filter(([key]) => key !== 'reviewerHealth')),
        ...(Object.keys(remaining).length ? { reviewerHealth: remaining } : {}),
      },
    }
  }, { skipUserAction: true })
  return cleared
}

export function reviewerConfigFaultsFromHealth(raw) {
  const health = raw?.reviewerHealth && typeof raw.reviewerHealth === 'object' ? raw.reviewerHealth : {}
  return Object.fromEntries(Object.entries(health)
    .filter(([, entry]) => isReviewerConfigFault(entry?.code))
    .map(([reviewer, entry]) => [reviewer, {
      code: entry.code,
      lastFailureAt: entry.lastFailureAt || null,
      ...(entry.code === EXECUTION_OPTIONS_ERROR && codexSpeedProbeFailureMessage(entry.probeFailure) ? {
        ...reviewProbeFields(entry), message: codexSpeedProbeFailureMessage(entry.probeFailure, entry.probeStage),
      } : {}),
    }]))
}

/**
 * Drop a stored `REVIEWER_UNSUPPORTED` fault for a reviewer this machine can
 * review with now (a command set since, or a harness this version runs that an
 * older one refused): the stale fault would otherwise keep warning until the
 * next review happened to run. `capable` is `getProviderReviewCapability()`'s
 * set — only a provider positively confirmed capable clears its fault, so an
 * unreadable provider store clears nothing.
 */
export function withoutResolvedUnsupportedFaults(configFaults, capable) {
  return Object.fromEntries(Object.entries(configFaults).filter(([reviewer, fault]) => (
    fault.code !== 'REVIEWER_UNSUPPORTED' || !capable.has(reviewer)
  )))
}

export async function getReviewerConfigHealth() {
  const [settings, { capable }] = await Promise.all([getSettings(), getProviderReviewCapability()])
  const configFaults = withoutResolvedUnsupportedFaults(reviewerConfigFaultsFromHealth(settings?.codeReview), capable)
  const malformedReviews = Object.fromEntries(Object.entries(settings?.codeReview?.reviewerHealth || {})
    .filter(([, entry]) => entry?.code === 'MALFORMED_REVIEW')
    .map(([reviewer, entry]) => [reviewer, {
      lastFailureAt: entry.lastFailureAt || null, diagnostics: reviewFailureDiagnostics(entry.diagnostics),
    }]))
  return {
    status: Object.keys(configFaults).length || Object.keys(malformedReviews).length ? 'warning' : 'ok',
    configFaults,
    ...(Object.keys(malformedReviews).length ? { malformedReviews } : {}),
  }
}

// Warn-only availability probe. A separate TTL notices binaries installed or removed mid-session.
const REVIEWER_CLI_INSTALLED_TTL_MS = 5 * 60 * 1000
// Matches imageGen/{grok,agy,codex}.js's own checkConnection() probes for
// these same binaries — a plain 5s default (commandExists's fallback, sized
// for lightweight tools like `brew --version`) previously clocked these
// heavier agentic CLIs as falsely uninstalled under a cold start.
const REVIEWER_CLI_PROBE_TIMEOUT_MS = 15_000
let cachedInstalled = null
let cachedInstalledExpiresAt = 0

/** Test-only: reset the memoized reviewer-CLI-installed cache. */
export function __resetReviewerCliInstalledCache() { cachedInstalled = null; cachedInstalledExpiresAt = 0 }

export async function getReviewerCliInstalled() {
  if (cachedInstalled && cachedInstalledExpiresAt > Date.now()) return cachedInstalled
  const cliReviewers = REVIEWER_VALUES.filter(isCliReviewer)
  const entries = await Promise.all(cliReviewers.map(async (reviewer) => {
    const binary = reviewerCliBinary(reviewer)
    return [reviewer, binary ? await commandExists(binary, undefined, { timeoutMs: REVIEWER_CLI_PROBE_TIMEOUT_MS }) : true]
  }))
  cachedInstalled = Object.fromEntries(entries)
  cachedInstalledExpiresAt = Date.now() + REVIEWER_CLI_INSTALLED_TTL_MS
  return cachedInstalled
}
