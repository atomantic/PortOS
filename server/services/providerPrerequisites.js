/**
 * Provider prerequisites, probed.
 *
 * `lib/providerPrerequisites.js` decides what a provider is missing given the
 * facts; this module supplies the facts and exposes the two shapes PortOS
 * needs:
 *
 *   - `getProviderPrerequisiteMap(providers)` — the whole collection's verdict,
 *     for decorating `GET /api/providers` so the AI Providers page reads the
 *     same answer the router uses instead of deriving its own.
 *   - `getProviderPrerequisiteReadinessMap(providers)` — strict tri-state
 *     readiness for authoritative choices that cannot treat unprobed as ready.
 *   - `prerequisitesMetForRouting(provider, providers)` — the gate the
 *     fallback-provider chain in `aiToolkit/providerStatus.js` consults.
 *
 * The provider-page map and fallback route stay synchronous and read only what
 * the runtime probe has already cached. The strict readiness map is async: its
 * authoritative callers await a cold/expired probe before publishing choices.
 * This keeps `GET /api/providers` off the multi-second `--version` sweep while
 * preventing a Persistent Mind turn from receiving an empty, stale catalog.
 *
 * The result is permissive in three deliberate ways. An un-probed runtime
 * yields no finding, so the first pick after boot behaves exactly as it did
 * before and the refresh it triggers makes later picks accurate. An EXPIRED
 * probe is likewise no answer, so a CLI installed by hand stops being skipped
 * within the TTL rather than until the next restart. And routing acts only on
 * `ROUTING_BLOCKING_CODES` (the missing binary), never on the credential
 * findings the card also shows. Never the other way round: taking a working
 * provider out of the fallback chain is worse than the late ENOENT this
 * prevents.
 *
 * No LLM call is made here. Probing a CLI is a `--version` spawn, so this is
 * safe under the no-cold-bootstrap policy in AGENTS.md.
 */

import { blocksRouting, describeMissingPrerequisites, providerPrerequisites, providerRuntimeKey } from '../lib/providerPrerequisites.js';
import { PROVIDER_GATEWAYS } from '../lib/providerGateways.js';
import { inferTuiCommand } from '../lib/providerVendors.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { delimiter, isAbsolute } from 'path';
import {
  getProviderRuntime,
  getProviderRuntimeStatus,
  getProviderRuntimeStatuses,
  peekProviderRuntimeStatuses,
} from './providerRuntimeInstaller.js';

/**
 * Per gateway id, does the sibling API provider of that id hold the key an
 * OpenCode wrapper inherits at spawn time?
 *
 * `null` (cannot tell) when there is no provider collection to look in —
 * distinct from `false` ("looked, and the sibling has no key"), which is what a
 * present-but-keyless or deleted sibling gives. Accepts a raw map (keyed by id)
 * or a sanitized array.
 *
 * A map keyed by gateway id rather than one boolean, so a wrapper is only ever
 * judged against ITS OWN sibling — an OrcaRouter key must never satisfy an
 * OpenRouter wrapper.
 */
const gatewayKeyState = (providers) => {
  if (!providers || typeof providers !== 'object') return null;
  const entries = Array.isArray(providers) ? providers : Object.values(providers);
  // An EMPTY collection is "nothing loaded", not "the sibling is gone" — the
  // same `null`-vs-`false` distinction the whole module runs on.
  if (entries.length === 0) return null;
  return Object.fromEntries(PROVIDER_GATEWAYS.map((gateway) => {
    const sibling = entries.find((p) => p?.id === gateway.id);
    return [gateway.id, sibling?.hasApiKey === true || Boolean(sibling?.apiKey)];
  }));
};

// Coalesced background refresh — one probe in flight at a time, so a failure
// storm picking a fallback per failed run doesn't fan out a `--version` spawn
// per CLI per run. Errors are logged and swallowed: this runs outside the
// request lifecycle, where an unhandled rejection kills the process.
let refreshInFlight = null;
const refreshRuntimesInBackground = () => {
  if (refreshInFlight) return;
  refreshInFlight = getProviderRuntimeStatuses()
    .catch((err) => console.error(`❌ Provider runtime probe failed: ${err.message}`))
    .finally(() => { refreshInFlight = null; });
};

/**
 * The cached runtime statuses, plus a background refresh for any runtime this
 * batch wanted and the cache had nothing current for.
 *
 * Scoped to runtimes the table actually covers: a custom command will never
 * appear in the probe's answer, so re-requesting it per call would be a refresh
 * that can never succeed.
 */
const runtimeSnapshotFor = (keys) => {
  const runtimes = peekProviderRuntimeStatuses();
  if (keys.some((key) => key && !runtimes[key] && getProviderRuntime(key))) refreshRuntimesInBackground();
  return runtimes;
};

const forProvider = (provider, runtimes, gatewayKeySet) => providerPrerequisites(provider, {
  // `undefined` (no entry in the map) is NOT PROBED — normalize it to the
  // module's `null` sentinel rather than letting it fall through as a value.
  runtime: runtimes?.[providerRuntimeKey(provider) ?? ''] ?? null,
  gatewayKeySet,
});

const effectiveProcessCommand = (provider) => {
  const configured = typeof provider?.command === 'string' ? provider.command.trim() : '';
  if (configured) return configured;
  return provider?.type === 'tui' ? inferTuiCommand(provider?.id) : 'claude';
};

const configuredCommandIsNormalized = (provider) => typeof provider?.command !== 'string'
  || provider.command === ''
  || provider.command === provider.command.trim();

const prerequisiteReadinessFor = (provider, runtimes, gatewayKeySet) => {
  const effectiveProvider = provider?.command
    ? provider
    : { ...provider, command: effectiveProcessCommand(provider) };
  const runtimeKey = providerRuntimeKey(effectiveProvider);
  const runtime = runtimes?.[runtimeKey ?? ''] ?? null;
  const { missing } = forProvider(effectiveProvider, runtimes, gatewayKeySet);
  if (missing.length > 0) {
    return {
      status: 'blocked',
      reasonCodes: [...new Set(missing.map((entry) => entry.code).filter(Boolean))],
    };
  }
  if (runtimeKey && getProviderRuntime(runtimeKey) && !runtime) {
    return { status: 'unknown', reasonCodes: ['runtime-unprobed'] };
  }
  return { status: 'ready', reasonCodes: [] };
};

const processProviderRuntimeStatus = (provider, { cwd = null, deferCwdDependent = false } = {}) => {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return null;
  if (!configuredCommandIsNormalized(provider)) return { installed: false, reasonCode: 'command' };
  const command = effectiveProcessCommand(provider);
  const effectiveProvider = { ...provider, command };
  const runtimeKey = providerRuntimeKey(effectiveProvider);
  if (runtimeKey && getProviderRuntime(runtimeKey)) return null;
  const env = { ...process.env, ...(provider?.envVars || {}) };
  const explicitRelativeCommand = /[\\/]/.test(command) && !isAbsolute(command);
  const relativePathEntry = String(env.PATH || env.Path || '')
    .split(delimiter)
    .some((entry) => entry === '' || !isAbsolute(entry));
  if (deferCwdDependent && !cwd && (explicitRelativeCommand || relativePathEntry)) return null;
  return findCommandOnPath(command, { env, ...(cwd ? { cwd } : {}) })
    ? { installed: true }
    : { installed: false };
};

/**
 * `{ [providerId]: { met, missing } }` for a whole provider collection.
 * @param {Array<object>} providers — raw or sanitized provider records
 */
export function getProviderPrerequisiteMap(providers) {
  const list = Array.isArray(providers) ? providers : [];
  if (list.length === 0) return {};
  const runtimes = runtimeSnapshotFor(list.map(providerRuntimeKey));
  const gatewayKeySet = gatewayKeyState(list);
  return Object.fromEntries(list.map((provider) => [provider.id, forProvider(provider, runtimes, gatewayKeySet)]));
}

/**
 * A strict, non-secret prerequisite verdict for authoritative task choices.
 * Unlike routing, this distinguishes a cold/expired runtime probe from a known
 * runnable provider so callers that promise a provider choice can fail closed.
 * Commands outside the fixed installer table are resolved against the same
 * configured PATH/explicit-path rules the child process uses. `candidates`
 * limits expensive runtime probes while `providers` remains the full sibling
 * set used for inherited credential checks. A catalog may defer cwd-dependent
 * commands, then its execution path must call again with the selected app cwd.
 */
export async function getProviderPrerequisiteReadinessMap(providers, {
  candidates = providers,
  cwd = null,
  deferCwdDependent = false,
} = {}) {
  const list = Array.isArray(providers) ? providers : [];
  const targetList = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0 || targetList.length === 0) return {};
  const processProviders = targetList.map((provider) => {
    const command = effectiveProcessCommand(provider);
    return { ...provider, command };
  });
  const runtimeKeys = processProviders.map(providerRuntimeKey);
  const cached = peekProviderRuntimeStatuses();
  const missingRuntimeKeys = [...new Set(runtimeKeys
    .filter((key) => key && getProviderRuntime(key) && !cached[key]))];
  const probed = await Promise.all(missingRuntimeKeys.map(async (key) => [
    key,
    await getProviderRuntimeStatus(key),
  ]));
  const runtimes = { ...cached, ...Object.fromEntries(probed) };
  const gatewayKeySet = gatewayKeyState(list);
  return Object.fromEntries(targetList.map((provider, index) => {
    const effectiveProvider = processProviders[index];
    const customRuntime = processProviderRuntimeStatus(provider, { cwd, deferCwdDependent });
    const verdict = customRuntime?.installed === false
      ? { status: 'blocked', reasonCodes: [customRuntime.reasonCode || 'runtime'] }
      : prerequisiteReadinessFor(effectiveProvider, runtimes, gatewayKeySet);
    return [provider.id, verdict];
  }));
}

/**
 * Can this provider run right now, as far as the already-probed facts say?
 *
 * The gate the fallback chain uses. Returns `true` for anything not KNOWN to be
 * un-runnable — see the module note above — and logs the one line that explains
 * a skip, which is the whole point of the change: a run that used to die on
 * `spawn codex ENOENT` now says which binary is absent and moves on to the next
 * candidate.
 *
 * @param {object} provider
 * @param {object|Array} providers — the sibling collection (for inherited keys)
 * @returns {boolean}
 */
export function prerequisitesMetForRouting(provider, providers) {
  const runtimes = runtimeSnapshotFor([providerRuntimeKey(provider)]);
  const { missing } = forProvider(provider, runtimes, gatewayKeyState(providers));
  if (!blocksRouting(missing)) return true;
  console.log(`⛔ Skipping fallback ${provider?.id || 'provider'}: ${describeMissingPrerequisites(missing)}`);
  return false;
}

/** Test-only: drop the in-flight refresh handle so a suite starts clean. */
export function __resetPrerequisiteRefresh() {
  refreshInFlight = null;
}
