/**
 * "Is everything this provider needs actually installed and running?"
 *
 * The Providers page could already tell you whether the CLI binary a provider
 * shells out to exists (`providerRuntimeInstaller.js`). For a provider backed by
 * a LOCAL daemon that is only half the story: `opencode` can be perfectly
 * installed and the run still ends at
 *
 *     Cannot connect to API: Unable to connect. Is the computer able to access the url
 *
 * because `llama-server` was never installed, or was installed but never
 * started, or is running but serving a different model alias than the provider
 * asks for. Those are three distinct fixes, and none of them was visible from
 * the provider card — the user had to read a failed agent transcript to learn
 * that a second piece of software (and a multi-gigabyte model download) was
 * still missing.
 *
 * This module turns that into a per-provider requirements checklist:
 *
 *   1. runtime  — the daemon's binary is on PortOS's PATH (or something is
 *                 already answering, which proves it another way)
 *   2. server   — the endpoint the provider points at answers `GET /v1/models`
 *   3. model    — the provider's default model is one the endpoint serves
 *   4. catalog  — every OTHER model the provider offers is one the endpoint
 *                 serves, so a task or pipeline stage cannot pin an id that
 *                 only fails once the agent has already spawned
 *
 * Checks are reported in fix order, each with what to do about it. Only
 * local-daemon providers get a report at all (`localProviderRuntime.js` decides
 * which those are); everything else returns `null` and renders nothing. That
 * deliberately excludes a provider pointed at ANOTHER machine's OpenAI-compatible
 * server — an external endpoint is somebody else's install to run, so PortOS
 * neither probes this host for it nor offers to start it here.
 *
 * No LLM call is ever made here — `GET /v1/models` is a listing, so this is safe
 * to poll from a settings page under the no-cold-bootstrap policy in AGENTS.md.
 */

import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { isConfiguredDefaultModel } from '../lib/providerModels.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { actionCovers, describeRuntimeSetup, readRuntimeWeights, weightsBlockStart } from './localRuntimeSetup.js';
import { isAppInstalled as isLmStudioAppInstalled } from './lmStudioManager.js';

/**
 * Loopback daemons answer (or refuse the connection) in single-digit
 * milliseconds, so a short bound keeps a page poll snappy. A host that needs
 * longer than this to answer a model listing is not going to serve an agent run
 * either, and reporting it as unreachable points at the right fix.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Sized just under the Providers page's 20s poll so consecutive polls each get
 * a fresh answer (a daemon the user just started must show up on the next tick,
 * not two ticks later) while a reload landing on top of a poll still reuses it.
 * Within ONE request the promise cache below is what collapses providers that
 * share an endpoint.
 */
const PROBE_TTL_MS = 15_000;

/**
 * Same 60s TTL and reasoning as `providerRuntimeInstaller.js`'s status cache:
 * availability changes only when someone installs or removes a binary, and
 * `findCommandOnPath` is a SYNCHRONOUS PATH walk (a stat per directory), so an
 * uncached miss blocks the event loop on every 20s poll from every open tab.
 */
const BINARY_TTL_MS = 60_000;

/**
 * A `mtplx models --json` listing walks the cache directories to size them, so
 * it is far too expensive to repeat on every 20s page poll — and the answer
 * only changes when a `mtplx pull` finishes, which is minutes of downloading
 * away. Longer than the probe TTL for exactly that reason.
 */
const WEIGHTS_TTL_MS = 60_000;

// endpoint + key → { at, promise } — the PROMISE, not the settled value, so N
// providers sharing one endpoint in the same batch share one socket instead of
// all missing a not-yet-written cache entry at once. The key is part of the
// cache key because two providers can point at one authenticated endpoint with
// different credentials, and one of them getting the other's 401 would be a
// false "not running".
const probeCache = new Map();
// command → { at, path }
const binaryCache = new Map();
// runtime kind → { at, promise } — the local model cache behind a daemon that
// is NOT running, which is the only time PortOS cannot ask `/v1/models`.
const weightsCache = new Map();

/**
 * Ask an OpenAI-compatible endpoint what it serves. `llamaServerManager` runs the
 * same probe against the same daemons, so the request shape lives in one lib.
 * @returns {Promise<{reachable:boolean, models:string[]|null, error:string|null}>}
 *   `models: null` means reachable but the listing could not be read — distinct
 *   from `[]`, a server that is up with nothing loaded.
 */
const probeEndpoint = (endpoint, apiKey = '') =>
  probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS, apiKey });

/** TTL-cached endpoint probe, shared across requests — see PROBE_TTL_MS. */
function probeEndpointCached(endpoint, apiKey = '') {
  const now = Date.now();
  const cacheKey = `${endpoint}
${apiKey}`;
  const cached = probeCache.get(cacheKey);
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.promise;
  // Sweep while we are here: entries are keyed by endpoint, and an edited or
  // deleted provider would otherwise leave its old endpoint behind forever.
  for (const [key, entry] of probeCache) {
    if (now - entry.at >= PROBE_TTL_MS) probeCache.delete(key);
  }
  // Written BEFORE the await so concurrent callers join this probe. A rejected
  // probe would poison the entry for its TTL, so drop it on failure —
  // `probeEndpoint` resolves for every expected failure, making this the
  // unexpected-throw path only.
  const promise = probeEndpoint(endpoint, apiKey).catch((err) => {
    probeCache.delete(cacheKey);
    throw err;
  });
  probeCache.set(cacheKey, { at: now, promise });
  return promise;
}

/**
 * What a runtime's own model cache holds, for the runtimes that have one PortOS
 * can read without starting them (today: MTPLX).
 *
 * This is the fact that turned the MTPLX checklist into a catch-22: "installed
 * ✓ / server not responding ✗ — use Start MTPLX, PortOS does this for you",
 * and Start then failed with "no model weights are cached, so its server exits
 * before it binds a port". Reading the cache HERE is what lets the checklist
 * say so up front and offer the download instead of the start.
 *
 * A cache that could not be read reports `'unknown'` — never `'empty'`, which
 * would claim a fact PortOS does not have, and so does a runtime with no cache
 * PortOS can read offline (`readRuntimeWeights` answers those without spending
 * a subprocess).
 *
 * TTL-cached — see WEIGHTS_TTL_MS.
 *
 * @returns {Promise<'unknown'|'empty'|'partial'|'ready'>}
 */
function readWeightsStateCached(kind) {
  const now = Date.now();
  const cached = weightsCache.get(kind);
  if (cached && now - cached.at < WEIGHTS_TTL_MS) return cached.promise;
  // Cached BEFORE the await so concurrent providers on one runtime share the
  // subprocess; dropped on an unexpected throw so a transient failure cannot
  // poison the entry for its whole TTL (same shape as the probe cache above).
  const promise = readRuntimeWeights(kind).catch((err) => {
    weightsCache.delete(kind);
    throw err;
  });
  weightsCache.set(kind, { at: now, promise });
  return promise;
}

/** TTL-cached PATH lookup for the handful of daemon binaries — see BINARY_TTL_MS. */
function findCommandCached(command) {
  const cached = binaryCache.get(command);
  if (cached && Date.now() - cached.at < BINARY_TTL_MS) return cached.path;
  const path = findCommandOnPath(command);
  binaryCache.set(command, { at: Date.now(), path });
  return path;
}

/**
 * One model id as the daemon's own listing spells it: trimmed, with any OpenCode
 * `<namespace>/` prefix stripped, since that prefix addresses the OpenCode
 * provider entry and never reaches the daemon's model list. `null` for anything
 * that does not name a model (blank, non-string, or a "use the CLI's own
 * default" sentinel).
 */
function bareModelId(model, kind) {
  if (typeof model !== 'string' || model.trim() === '' || isConfiguredDefaultModel(model)) return null;
  const trimmed = model.trim();
  return trimmed.startsWith(`${kind}/`) ? trimmed.slice(kind.length + 1) : trimmed;
}

/**
 * The model id the endpoint would be asked for — the provider's default.
 * Returns null when the provider selects no specific model.
 */
export function servedModelId(provider, kind) {
  return bareModelId(provider?.defaultModel, kind);
}

/**
 * The model ids this provider OFFERS beyond its pinned default — the catalog a
 * task or a pipeline stage picks a model out of.
 *
 * The pin is excluded because `modelCheck` already covers it; what is left is
 * the part of the provider nothing was checking. A provider that pins NO model
 * (the shipped OpenCode local wrappers all ship `defaultModel: null`) had no
 * model check at all, so its whole catalog could name ids the daemon has not
 * served since the day they were pulled — and every run dispatched onto one
 * died at spawn with no output instead of failing resolution up front (#6125).
 */
function offeredModelIds(provider, kind) {
  const pinned = servedModelId(provider, kind);
  const ids = (Array.isArray(provider?.models) ? provider.models : [])
    .map((model) => bareModelId(model, kind))
    .filter((id) => id !== null && id !== pinned);
  return [...new Set(ids)];
}

/**
 * The fix hint for a check the one-click setup button already covers.
 *
 * `setup.actionLabel` names a button rendered right below the checklist, so the
 * hint points AT it rather than repeating a terminal recipe — and a runtime this
 * host cannot set up at all says why instead of sending the user to a doc that
 * would not help them either.
 *
 * `null` means "no button covers this", and the caller falls back to its own
 * prose. `covers` is the action the check needs: an install-only button does
 * nothing for a `server` check.
 */
function setupHint(setup, capability) {
  if (!setup) return null;
  if (setup.blockedReason) return setup.blockedReason;
  // `capability` is one of `installs` / `starts` / `provisions`, asked of the
  // action table rather than matched against the action's spelling. The old
  // substring test worked only because every action name happened to contain
  // the word — `provision-start` does not contain `pull`, and a hint that
  // vanishes when an action is renamed fails no test.
  return actionCovers(setup.action, capability)
    ? `Use “${setup.actionLabel}” below — PortOS does this for you.`
    : null;
}

/**
 * What a runtime's own model cache says while its server is down — the half of
 * the model check `GET /v1/models` cannot answer because nothing is listening.
 *
 * `capability` is one of `installs` / `starts` / `provisions` — the axes
 * `localRuntimeSetup.js` declares for every action.
 *
 * `null` when there is nothing to add, so the caller keeps its own prose.
 */
function weightsDetail(runtime, weights) {
  // A runtime whose local setup is not "a model cache" describes its own states
  // — vLLM's is a compose project that was never cloned or prepared, and
  // "no model weights cached" would send the operator after a download that was
  // never the first step. Keyed by STATE rather than one override per divergence,
  // so the next runtime supplies whichever states read wrong for it.
  const override = runtime.setupStateDetail?.[weights];
  if (override) return override;
  if (weights === 'empty') return `${runtime.label} has no model weights cached, so its server exits before it binds a port.`;
  if (weights === 'partial') return `${runtime.label}'s cache holds only an unfinished download — no complete checkpoint to serve.`;
  if (weights === 'ready') return 'Weights are cached locally; this can be confirmed once the server is running.';
  return null;
}

/** The `runtime` check — is the daemon's software here at all? */
function runtimeCheck(runtime, { onPath, appInstalled, installed, reachable, setup }) {
  const detail = onPath ? `\`${runtime.command}\` is on PortOS's PATH.`
    : appInstalled ? `${runtime.label} is installed as an app.`
      : reachable ? `Something is already serving ${runtime.endpoint}.`
        : `\`${runtime.command}\` was not found on PortOS's PATH.`;
  const fixHint = installed ? null
    : setupHint(setup, 'installs')
      || (runtime.manageUrl ? `Install ${runtime.label} from Models → LLMs.`
        : `Use the setup button below to install ${runtime.label}.`);
  return { id: 'runtime', label: `${runtime.label} installed`, ok: installed, detail, fixHint };
}

/** The `server` check — is it running where THIS provider points? */
function serverCheck(runtime, { installed, result, setup, weights = 'unknown' }) {
  if (result.reachable) {
    return {
      id: 'server',
      label: `${runtime.label} server responding`,
      ok: true,
      detail: `${runtime.endpoint} answered.`,
      fixHint: null,
    };
  }
  const start = `Start ${runtime.label}${runtime.manageUrl ? ' from Models → LLMs' : ''}.`;
  const fallback = installed
    ? `${start} ${runtime.modelsHint}`
    : `Install ${runtime.label} first, then start it. ${runtime.modelsHint}`;
  // Name the blocker in the SAME line that says nothing answered. Otherwise the
  // checklist reads "installed ✓ / not responding — just press Start", and
  // Start is the thing that cannot work until the weights land.
  const blocked = weightsBlockStart(weights) ? weightsDetail(runtime, weights) : null;
  return {
    id: 'server',
    label: `${runtime.label} server responding`,
    ok: false,
    detail: `Nothing answered at ${runtime.endpoint}${result.error ? ` (${result.error})` : ''}.${blocked ? ` ${blocked}` : ''}`,
    fixHint: setupHint(setup, 'starts') || fallback,
  };
}

/**
 * The `detail`/`fixHint` a model-facing check reports when the endpoint never
 * answered, or answered unreadably. Shared by both such checks so a listing
 * PortOS could not read is reported as unknown, never as missing — the user
 * chases the check that IS actionable.
 */
function unreadableListing(runtime, probeError, weights, setup) {
  // A server that answered 401 IS responding — "until the server responds"
  // would send the user to start a container that is already up, when the
  // actual fix is to paste its key onto this provider.
  const detail = probeError === 'authentication required'
    ? `${runtime.label} refused the model listing without an API key — paste the server's key on this provider.`
    : weightsDetail(runtime, weights) || 'Cannot be checked until the server responds.';
  // An unservable cache is the ONE unknown here that has a fix: the download
  // that makes a start possible at all.
  const fixHint = weightsBlockStart(weights) ? setupHint(setup, 'provisions') : null;
  return { detail, fixHint };
}

/**
 * The `model` check — does the running daemon serve what this provider asks
 * for? This is the alias mismatch: `llama-server --alias dflash` against a
 * provider pinned to `dspark` fails HERE rather than inside a dead agent run.
 */
function modelCheck(runtime, wanted, served, probeError = null, { weights = 'unknown', setup = null } = {}) {
  const label = `Model \`${wanted}\` available`;
  if (!Array.isArray(served)) {
    return { id: 'model', label, ok: null, ...unreadableListing(runtime, probeError, weights, setup) };
  }
  if (served.includes(wanted)) {
    return { id: 'model', label, ok: true, detail: `${runtime.label} is serving \`${wanted}\`.`, fixHint: null };
  }
  const listed = served.slice(0, 3).map((id) => `\`${id}\``).join(', ');
  // WHY only one id is listed, in the same line that lists it. A daemon that
  // serves one model per process is not "missing" the others — nothing was ever
  // started under those names — and without saying so the checklist reads as a
  // missing multi-gigabyte download, which is the wrong fix and an expensive one
  // to chase.
  const oneModel = runtime.servesOneModel
    ? ` ${runtime.label} serves one model per process${runtime.aliasFlag ? `, answering under the id its \`${runtime.aliasFlag}\` set rather than the weights' own name` : ''}.`
    : '';
  const detail = served.length === 0
    ? `${runtime.label} is running but has no model loaded.`
    : `${runtime.label} is serving ${listed}${served.length > 3 ? ` +${served.length - 3} more` : ''}.${oneModel}`;
  // A runtime whose served id is a launch-line LABEL can be renamed onto the
  // weights it is already running — no download, no model swap. That makes the
  // mismatch fixable from EITHER end, so the hint names both rather than
  // implying the provider is the only thing that may move.
  const renameTo = served.length > 0 && runtime.aliasFlag ? wanted : null;
  const fixHint = served.length === 0
    ? (runtime.manageUrl
      ? 'No model is loaded. Start a preset from Models → LLMs.'
      : 'No model is loaded. Use the setup controls on this card to load one.')
    : renameTo
      ? `Same server, two names for it — nothing needs downloading. Use the button below to point this provider at ${listed}, or “Serve as \`${wanted}\`” to relaunch ${runtime.label} on the weights it already has under that id.`
      : `This provider will send \`${wanted}\`, but the running server only accepts ${listed}. Use the button below to match them${runtime.manageUrl ? ', or change the loaded weights on the Models → LLMs page' : ''}.`;
  return {
    id: 'model',
    label,
    ok: false,
    detail,
    fixHint,
    servedModels: served,
    // The id a one-click relaunch would put on the launch line, or null when
    // this runtime has no label of its own to change.
    renameTo,
  };
}

/**
 * The `catalog` check — can this provider dispatch the models it OFFERS?
 *
 * `modelCheck` above validates the pin. This validates everything else in the
 * provider's `models` list, which is what a task or a pipeline stage actually
 * picks from. Without it a provider that pins nothing (every shipped OpenCode
 * local wrapper) passed readiness while its whole catalog named ids the daemon
 * stopped serving — a stage pinned to one spawned, produced no output, and died
 * at spawn time rather than failing resolution up front (#6125).
 *
 * `servesOneModel` runtimes are graded leniently on purpose: llama.cpp, MTPLX,
 * vLLM, SGLang and Slotstream run ONE checkpoint per process, so a catalog
 * listing the other presets is normal configuration rather than rot. One
 * servable id is all such a provider ever needs. A multi-model daemon (Ollama,
 * LM Studio) serves everything it holds at once, so there any unservable id is
 * a real pin waiting to fail.
 */
function catalogCheck(runtime, offered, served, probeError = null, { weights = 'unknown', setup = null, pinned = null } = {}) {
  const label = `Offered models available (${offered.length})`;
  if (!Array.isArray(served)) {
    return { id: 'catalog', label, ok: null, ...unreadableListing(runtime, probeError, weights, setup) };
  }
  const unserved = offered.filter((id) => !served.includes(id));
  const ok = runtime.servesOneModel ? unserved.length < offered.length : unserved.length === 0;
  if (ok) {
    const detail = unserved.length === 0
      ? `${runtime.label} is serving every model this provider offers.`
      : `${runtime.label} is serving ${offered.length - unserved.length} of them; it runs one model per process, so the rest are presets nothing was started under.`;
    return { id: 'catalog', label, ok: true, detail, fixHint: null };
  }
  const listed = unserved.slice(0, 3).map((id) => `\`${id}\``).join(', ');
  const more = unserved.length > 3 ? ` +${unserved.length - 3} more` : '';
  // "every run fails" is only true when the pin cannot carry the provider
  // either — otherwise the provider still runs, and only a stage that pinned one
  // of these ids dies.
  const nothingDispatchable = unserved.length === offered.length && !(pinned && served.includes(pinned));
  const detail = nothingDispatchable
    ? `${runtime.label} serves none of them (${listed}${more}), so every run dispatched onto this provider fails before producing output.`
    : `${runtime.label} does not serve ${listed}${more}, so a task or stage pinned to one of those fails at spawn.`;
  return {
    id: 'catalog',
    label,
    ok: false,
    detail,
    fixHint: `Refresh this provider's models so it only offers ids the server serves${runtime.manageUrl ? ', or pull the missing ones from Models → LLMs.' : `. ${runtime.modelsHint}`}`,
    unservedModels: unserved,
  };
}

/**
 * The requirements checklist for one provider, or `null` when the provider does
 * not depend on a local daemon.
 *
 * Deps are injectable so the suite can drive every combination without a daemon
 * or a real PATH on the host.
 *
 * @param {object} provider - the RAW provider record (endpoint + envVars intact;
 *   a sanitized copy has its secret env values redacted, which would hide a
 *   custom base URL)
 * @param {{findCommand?:Function, probe?:Function}} [deps]
 */
export async function getProviderReadiness(provider, deps = {}) {
  const runtime = localRuntimeForProvider(provider);
  if (!runtime) return null;

  const findCommand = deps.findCommand || findCommandCached;
  const probe = deps.probe || probeEndpointCached;

  // The wrapper's own key: a vLLM container is started behind `VLLM_API_KEY`
  // and 401s an unauthenticated `/v1/models`, which would leave the model check
  // permanently unknown on an otherwise-healthy stack.
  const result = await probe(runtime.endpoint, provider?.apiKey || '');
  // A daemon that answers is installed, whatever PATH says — Ollama's macOS app
  // and LM Studio both serve without putting a CLI on PortOS's PATH.
  const onPath = Boolean(runtime.command && findCommand(runtime.command));
  // LM Studio ships as a macOS app bundle whose `lms` shim the user opts into
  // separately, so PATH alone says "not installed" for a perfectly installed
  // copy. The Models → LLMs page already counts the bundle (`localLlm.getStatus`);
  // without the same signal here the card would render "LM Studio installed"
  // and "install LM Studio" two lines apart, and send the user after the wrong
  // fix — the real one is "start its server".
  const appInstalled = runtime.kind === 'lmstudio' && (deps.isAppInstalled || isLmStudioAppInstalled)();
  const installed = onPath || appInstalled || result.reachable;

  // What the runtime's own model cache holds. Only worth asking when the daemon
  // is installed and NOT answering: a running server's `/v1/models` is the
  // better answer, and an uninstalled runtime has no cache to read.
  const weights = installed && !result.reachable
    ? await (deps.readWeights || readWeightsStateCached)(runtime.kind)
    : 'unknown';

  // Resolved BEFORE the checks so each unmet one can point at the button that
  // fixes it rather than at a setup doc.
  const setup = describeRuntimeSetup(runtime.kind, { installed, running: result.reachable, weights });
  const standby = runtime.standbyWhenStopped === true
    && installed
    && !result.reachable
    && !weightsBlockStart(weights);

  const checks = [
    runtimeCheck(runtime, { onPath, appInstalled, installed, reachable: result.reachable, setup }),
    serverCheck(runtime, { installed, result, setup, weights }),
  ];
  const wanted = servedModelId(provider, runtime.kind);
  // `probeEndpoint` returns `models: null` on every unreachable path, so this
  // needs no second reachability test.
  if (wanted) checks.push(modelCheck(runtime, wanted, result.models, result.error, { weights, setup }));
  const offered = offeredModelIds(provider, runtime.kind);
  if (offered.length > 0) checks.push(catalogCheck(runtime, offered, result.models, result.error, { weights, setup, pinned: wanted }));

  return {
    kind: runtime.kind,
    label: runtime.label,
    endpoint: runtime.endpoint,
    manageUrl: runtime.manageUrl,
    // `ready` is strict: a check that could not be evaluated (`ok: null`) is not
    // a pass, so the card never claims a provider is good to go on unknowns.
    ready: checks.every((check) => check.ok === true),
    // Standby is deliberately separate from `ready`: no endpoint is currently
    // available, but an installed model-selecting runtime is not missing setup
    // merely because no model was chosen to occupy resources right now.
    standby,
    standbyDetail: standby ? runtime.standbyDetail : null,
    checks,
    // What a one-click "set this up for me" button can do about the unmet
    // checks, or `null` when nothing here is auto-fixable (see
    // `localRuntimeSetup.js`). Carried on the readiness payload so the card
    // offers the ACTION next to the failing check instead of sending the user
    // out of the app.
    setup,
  };
}

/**
 * Readiness for every ENABLED provider that needs a local daemon, keyed by
 * provider id. Providers with no local dependency are omitted entirely, so the
 * client can treat "absent" as "nothing to report".
 *
 * Disabled providers are skipped: a stock install ships most of the local
 * presets disabled, and probing daemons for providers the user switched off
 * spends most of every poll on cards that would show the checklist for a
 * provider they cannot run anyway.
 *
 * @param {object[]} providers - RAW provider records
 */
export async function getProviderReadinessMap(providers, deps = {}) {
  const list = (Array.isArray(providers) ? providers : []).filter((provider) => provider?.enabled !== false);
  // One PATH scan per distinct binary and one probe per distinct endpoint for
  // the whole batch — including when the caller injects its own probe, which
  // would otherwise bypass the module-level caches that normally collapse them.
  const findCommand = memoize(deps.findCommand || findCommandCached);
  const probe = memoize(deps.probe || probeEndpointCached);
  // Same reasoning as the two above: one `mtplx models` subprocess per batch,
  // not one per provider pointed at the same runtime.
  const readWeights = memoize(deps.readWeights || readWeightsStateCached);

  const entries = await Promise.all(list.map(async (provider) => {
    // Spread `deps` first so any other injected dep (isAppInstalled) survives,
    // then override the three the batch memoizes.
    const readiness = await getProviderReadiness(provider, { ...deps, findCommand, probe, readWeights });
    return readiness ? [provider.id, readiness] : null;
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

/**
 * Per-batch memo (the returned promise is shared, not awaited). EVERY argument
 * is forwarded and folded into the key — a memo that keyed on the first argument
 * alone silently dropped the probe's API key, so the batch path (which is what
 * `GET /api/providers/readiness` uses) probed a key-gated container
 * unauthenticated while the single-provider path authenticated fine.
 */
function memoize(fn) {
  const seen = new Map();
  return (...args) => {
    const key = args.join('\n');
    if (!seen.has(key)) seen.set(key, fn(...args));
    return seen.get(key);
  };
}

/**
 * Drops the probe caches so the next read reflects a daemon that was just
 * started, stopped, or installed — called by the llama-server lifecycle routes,
 * which change exactly what these caches remember.
 */
export function resetProviderReadinessCache() {
  probeCache.clear();
  binaryCache.clear();
  weightsCache.clear();
}
