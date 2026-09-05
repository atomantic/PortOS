/**
 * Presentation helpers for the Persistent Mind's temporary thinking sessions.
 *
 * The mechanism (saved presets, exact-or-refuse resolution, per-call receipts)
 * lives on the server. This module answers only the questions the Mind page has
 * to answer BEFORE the user commits: what exact route is about to be borrowed,
 * whether taking it can spend an account, and — afterwards — what a receipt
 * actually says versus what the provider never reported.
 *
 * Everything here is pure: no fetches, no provider probes. Previewing a preset
 * must never contact a provider, so the classification is deliberately a
 * READ of the already-loaded provider record, not a capability call.
 */

import { formatRuntime } from '../utils/formatters.js';
import {
  credentialSource,
  isApiProvider,
  isLocalInstanceProvider,
  isOllamaBackedProvider,
  isPrivateNetworkEndpoint,
  localBackendForProvider,
} from '../utils/providers.js';

/**
 * How a route is paid for, as far as the client can prove from the provider
 * record alone.
 *
 * - `local` — a daemon the user hosts, on this machine or elsewhere inside the
 *   private network. Running it spends no vendor account.
 * - `account` — a stored key, an inherited gateway key, a credential env var,
 *   or a vendor subscription stands behind it.
 * - `unknown` — cannot be determined. Treated as account-backed everywhere it
 *   matters, because guessing "free" is the one direction that costs money.
 */
export const MIND_ROUTE_BILLING = Object.freeze({
  LOCAL: 'local',
  ACCOUNT: 'account',
  UNKNOWN: 'unknown',
});

const isLocalBackedRecord = (provider) => Boolean(
  localBackendForProvider(provider) || isOllamaBackedProvider(provider)
  || provider?.llamaBacked === true || provider?.mtplxBacked === true
  || provider?.vllmBacked === true || provider?.sglangBacked === true,
);

/**
 * Does the inference run on hardware the user owns?
 *
 * Deliberately NOT `isLocalInstanceProvider` alone: that helper reads a BLANK
 * endpoint as local, which is right for an `ollama` record (every default it
 * falls back to is a loopback URL) and badly wrong for a cloud API provider
 * whose endpoint is implied by its id — calling that one free is exactly the
 * mistake this classification exists to prevent. So a bare API provider must
 * name a private-network endpoint, while a record already identified as a local
 * backend (or a CLI/TUI wrapper fronting one) may leave it blank.
 */
const isSelfHostedRoute = (provider) => (
  (isApiProvider(provider) && isPrivateNetworkEndpoint(provider?.endpoint))
  || (isLocalBackedRecord(provider)
    && (isLocalInstanceProvider(provider) || isPrivateNetworkEndpoint(provider?.endpoint)))
);

/**
 * Classify what sending on this provider can spend.
 *
 * @param {object|null|undefined} provider - a provider record from `GET /api/providers`
 * @returns {{billing: string, label: string, detail: string, spendsAccount: boolean}}
 */
export function classifyMindRouteBilling(provider) {
  if (!provider) {
    return {
      billing: MIND_ROUTE_BILLING.UNKNOWN,
      label: 'Routing unknown',
      detail: 'This provider is not in the current catalog, so PortOS cannot say whether sending spends an account. Treat it as billable.',
      spendsAccount: true,
    };
  }
  if (isSelfHostedRoute(provider)) {
    return {
      billing: MIND_ROUTE_BILLING.LOCAL,
      label: 'Local model',
      detail: 'Runs on hardware you host. Sending spends no account credit.',
      spendsAccount: false,
    };
  }
  if (credentialSource(provider).kind !== 'none') {
    return {
      billing: MIND_ROUTE_BILLING.ACCOUNT,
      label: 'Account-backed',
      detail: 'Backed by a credential or vendor subscription. Sending can use paid quota.',
      spendsAccount: true,
    };
  }
  return {
    billing: MIND_ROUTE_BILLING.UNKNOWN,
    label: 'Routing unknown',
    detail: 'PortOS cannot tell whether this route runs on your own hardware or against an account. Treat it as billable.',
    spendsAccount: true,
  };
}

/** "provider / model · high" — the one phrasing for an exact borrowed route. */
export function formatMindRoute({ providerId, model, effort } = {}, { providerName = null } = {}) {
  const provider = providerName || providerId || 'Unknown provider';
  const modelText = model || 'Unknown model';
  return `${provider} / ${modelText}${effort ? ` · ${effort}` : ''}`;
}

/**
 * Is this saved preset still exactly the route the composer is displaying?
 *
 * The server refuses a selection whose preset changed after acceptance, so the
 * composer must not offer to send a stale one. Labels are presentation and do
 * not participate — only the exact route does, mirroring
 * `samePersistentMindThinkingSelection` on the server.
 */
export function sameMindRoute(left, right) {
  if (!left || !right) return false;
  return ['providerId', 'model'].every((key) => left[key] === right[key])
    && (left.effort || '') === (right.effort || '');
}

/** Find one saved preset by id, or null. Never falls back to another preset. */
export function findMindThinkingPreset(presets, presetId) {
  if (!presetId) return null;
  return (Array.isArray(presets) ? presets : []).find((preset) => preset.id === presetId) || null;
}

const PRESET_ID_MAX = 64;

/**
 * Mint a stable, server-legal preset id from a label.
 *
 * Must satisfy the server's `^[A-Za-z0-9][A-Za-z0-9_-]*$`. A label that reduces
 * to nothing (emoji, CJK) still gets an id, because refusing to save a preset
 * over its display name would be a worse failure than a generated id.
 */
export function mintMindPresetId(label, existingIds = []) {
  const taken = new Set(existingIds);
  const slug = String(label || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, PRESET_ID_MAX - 4);
  const base = /^[A-Za-z0-9]/.test(slug) ? slug : `preset${slug ? `-${slug}` : ''}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, PRESET_ID_MAX);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, PRESET_ID_MAX);
}

/**
 * Render a call receipt's usage block.
 *
 * `state: 'unknown'` is a real answer — the provider reported nothing — and it
 * must read as unknown rather than as a free call. Never coerce a missing count
 * or price to zero.
 */
export function formatMindCallUsage(usage) {
  if (usage?.state !== 'reported') return 'Usage unknown';
  const parts = [];
  if (usage.totalTokens !== null && usage.totalTokens !== undefined) {
    parts.push(`${usage.totalTokens.toLocaleString()} tokens`);
  } else if (usage.inputTokens !== null && usage.inputTokens !== undefined) {
    parts.push(`${usage.inputTokens.toLocaleString()} in`);
  }
  if (usage.costUsd !== null && usage.costUsd !== undefined) {
    parts.push(`$${usage.costUsd.toFixed(4)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Usage unknown';
}

/**
 * Wall time of a call or turn — "Elapsed unknown" when nothing measured it.
 *
 * The one phrasing, so the route card and the receipt list cannot disagree
 * about what an unmeasured span reads as. A measured zero is a real value and
 * renders as one.
 */
export function formatMindElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'Elapsed unknown';
  return formatRuntime(ms) || '0ms';
}

const OUTCOME_LABELS = Object.freeze({
  completed: 'Completed',
  failed: 'Failed',
  denied: 'Refused',
  interrupted: 'Interrupted',
});

/** Human label for a receipt/turn outcome; an unrecognized value is unknown. */
export function formatMindCallOutcome(outcome) {
  return OUTCOME_LABELS[outcome] || 'Outcome unknown';
}

const TERMINAL_TURN_STATUSES = Object.freeze(['completed', 'failed', 'denied', 'interrupted']);

/**
 * Terminal outcome of one turn, from its own status when it has one and
 * otherwise from its last receipt. A turn that is still running reads as
 * `running`, never as a silent success.
 */
export function mindTurnOutcome(turn) {
  if (TERMINAL_TURN_STATUSES.includes(turn?.status)) return turn.status;
  const calls = Array.isArray(turn?.calls) ? turn.calls : [];
  const last = calls[calls.length - 1];
  if (TERMINAL_TURN_STATUSES.includes(last?.outcome)) return last.outcome;
  return turn?.completedAt ? 'completed' : 'running';
}

/**
 * Wall time of a turn, preferring its own timestamps and falling back to the
 * sum of its receipts. Returns null — never 0 — when neither is available.
 */
export function mindTurnElapsedMs(turn) {
  const startedAt = Date.parse(turn?.startedAt);
  const completedAt = Date.parse(turn?.completedAt);
  if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt) {
    return completedAt - startedAt;
  }
  const calls = Array.isArray(turn?.calls) ? turn.calls : [];
  const measured = calls.filter((call) => Number.isFinite(call?.elapsedMs));
  return measured.length > 0 ? measured.reduce((total, call) => total + call.elapsedMs, 0) : null;
}

/** Only the turns that borrowed a preset — the ones this page is accountable for. */
export function temporaryMindTurns(turnExecutions) {
  return (Array.isArray(turnExecutions) ? turnExecutions : [])
    .filter((turn) => Boolean(turn?.thinkingPresetId)
      || (Array.isArray(turn?.calls) && turn.calls.some((call) => call?.temporaryRoute === true)));
}
