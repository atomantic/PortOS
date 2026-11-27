import { invalidateModelObservation } from '../modelObservation.js';
/**
 * Per-provider requirements checklist for providers backed by a LOCAL daemon: the CLI binary being installed
 * (`providerRuntimeInstaller.js`) is only half the story, since a run still dies with "Cannot connect to API" when
 * the daemon is missing, stopped, or serving a different model alias than the provider asks for.
 *
 *   1. runtime  — the daemon is installed locally (or its endpoint already answers)
 *   2. server   — the provider's endpoint answers `GET /v1/models`
 *   3. model    — the provider's default model is one the endpoint serves
 *   4. catalog  — every OTHER model the provider offers is servable, so a task or stage cannot pin an id
 *                 that only fails after the agent has spawned
 *
 * Checks are reported in fix order, each with what to do about it. Only local-daemon providers get a report
 * (`localProviderRuntime.js` decides which); everything else returns `null`. A provider pointed at ANOTHER
 * machine's OpenAI-compatible server is excluded: that endpoint is somebody else's install to run.
 *
 * No LLM call is made here (`GET /v1/models` is a listing), so polling from a settings page is safe under the
 * no-cold-bootstrap policy in AGENTS.md.
 */

import { localRuntimeForProvider } from '../../lib/localProviderRuntime.js';
import { expandPageToken, getNavPageForPath } from '../../lib/navManifest.js';
import { bareLocalModelId } from '../../lib/provider/providerModels.js';
import { probeOpenAiModelsCached, resetOpenAiModelsProbeCache } from '../../lib/openAiModelsProbeCache.js';
import { aliasServedContextWindows } from '../../lib/provider/providerContextWindows.js';
import { managedOllamaContextLength } from '../../lib/ollamaContext.js';
import { findCommandOnPath } from '../../lib/processEnv.js';
import { actionCovers, describeRuntimeSetup, readRuntimeWeights, runtimeSetupBlockedReason, weightsBlockStart } from '../localRuntimeSetup.js';
import { detectRuntimeInstallation } from '../localRuntimeInstallation.js';

/**
 * Same 60s TTL as `providerRuntimeInstaller.js`'s status cache: availability changes only on install/remove, and
 * `findCommandOnPath` is a SYNCHRONOUS PATH walk, so an uncached miss blocks the event loop on every 20s poll.
 */
const BINARY_TTL_MS = 60_000;

/**
 * A `mtplx models --json` listing walks cache directories to size them, so it is too expensive for every 20s poll;
 * the answer only changes when a `mtplx pull` finishes. Longer than the probe TTL for that reason.
 */
const WEIGHTS_TTL_MS = 60_000;

// command → { at, path }
const binaryCache = new Map();
// runtime kind → { at, promise } — the local model cache behind a daemon that
// is NOT running, which is the only time PortOS cannot ask `/v1/models`.
const weightsCache = new Map();

/**
 * What a runtime's own model cache holds, for runtimes with one PortOS can read without starting them (today: MTPLX).
 * Reading it here lets the checklist offer the download up front instead of a Start that fails because no weights
 * are cached.
 *
 * A cache that could not be read reports `'unknown'`, never `'empty'` (a fact PortOS does not have); so does a
 * runtime with no offline-readable cache (`readRuntimeWeights` answers those without a subprocess).
 *
 * TTL-cached — see WEIGHTS_TTL_MS.
 *
 * @returns {Promise<'unknown'|'empty'|'partial'|'ready'>}
 */
function readWeightsStateCached(kind) {
  const now = Date.now();
  const cached = weightsCache.get(kind);
  if (cached && now - cached.at < WEIGHTS_TTL_MS) return cached.promise;
  // Cached BEFORE the await so concurrent providers on one runtime share the subprocess; dropped on an unexpected
    // throw so a transient failure cannot poison the entry for its TTL.
  const promise = readRuntimeWeights(kind).catch((err) => {
    weightsCache.delete(kind);
    throw err;
  });
  weightsCache.set(kind, { at: now, promise });
  return promise;
}

/** TTL-cached PATH lookup for the handful of daemon binaries — see BINARY_TTL_MS. */
function findCommandCached(command, resolve = () => findCommandOnPath(command)) {
  const cached = binaryCache.get(command);
  if (cached && Date.now() - cached.at < BINARY_TTL_MS) return cached.path;
  const path = resolve();
  binaryCache.set(command, { at: Date.now(), path });
  return path;
}

/**
 * The model id the endpoint would be asked for — the provider's default.
 * Returns null when the provider selects no specific model.
 */
export function servedModelId(provider, kind) {
  return bareLocalModelId(provider?.defaultModel, kind);
}

/**
 * The model ids this provider OFFERS beyond its pinned default — the catalog a task or stage picks from.
 *
 * The pin is excluded because `modelCheck` covers it. A provider that pins NO model (the shipped OpenCode local
 * wrappers) otherwise had no model check, so a catalog id the daemon no longer serves died at spawn with no output
 * instead of failing resolution up front.
 */
function offeredModelIds(provider, kind) {
  const pinned = servedModelId(provider, kind);
  const ids = (Array.isArray(provider?.models) ? provider.models : [])
    .map((model) => bareLocalModelId(model, kind))
    .filter((id) => id !== null && id !== pinned);
  return [...new Set(ids)];
}

/**
 * The fix hint for a check the one-click setup button already covers.
 *
 * `setup.actionLabel` names a button rendered below the checklist, so the hint points AT it; a runtime this host
 * cannot set up says why instead of pointing at a doc.
 *
 * `null` means no button covers this and the caller falls back to its own prose. `covers` is the action the check
 * needs: an install-only button does nothing for a `server` check.
 */
function setupHint(setup, capability) {
  if (!setup) return null;
  if (setup.blockedReason) return setup.blockedReason;
  // `capability` is one of `installs` / `starts` / `provisions`, asked of the action table rather than matched
    // against the action's spelling, so renaming an action cannot silently drop the hint.
  return actionCovers(setup.action, capability)
    ? `Use “${setup.actionLabel}” below — PortOS does this for you.`
    : null;
}

/**
 * What a runtime's own model cache says while its server is down — the half of the model check
 * `GET /v1/models` cannot answer because nothing is listening.
 *
 * `capability` is one of `installs` / `starts` / `provisions` (the axes `localRuntimeSetup.js` declares).
 *
 * `null` when there is nothing to add, so the caller keeps its own prose.
 */
function weightsDetail(runtime, weights) {
  // A runtime whose local setup is not "a model cache" describes its own states (vLLM's is a compose project never
    // cloned or prepared); "no model weights cached" would send the operator after the wrong first step. Keyed by
    // STATE so the next runtime supplies whichever states read wrong for it.
  const override = runtime.setupStateDetail?.[weights];
  if (override) return override;
  if (weights === 'empty') return `${runtime.label} has no model weights cached, so its server exits before it binds a port.`;
  if (weights === 'partial') return `${runtime.label}'s cache holds only an unfinished download — no complete checkpoint to serve.`;
  if (weights === 'ready') return 'Weights are cached locally; this can be confirmed once the server is running.';
  return null;
}

/**
 * The page that manages this runtime, named the way the sidebar names it.
 *
 * Server lifecycle lives on Models → Runtimes and the weights catalog on LLMs, so a fixed breadcrumb would send some
 * runtimes to the wrong sibling. Resolving it from the route each runtime already links to keeps prose and link
 * agreeing without this module knowing which pages exist.
 *
 * `null` for a runtime with no page (vLLM, SGLang) — callers drop the clause rather than invent a destination.
 */
const managePage = (runtime) => getNavPageForPath(runtime.manageUrl)?.breadcrumb ?? null;

/** The `runtime` check — is the daemon's software here at all? */
function runtimeCheck(runtime, { installation, installed, reachable, setup }) {
  let detail;
  if (installation === 'path') detail = `\`${runtime.command}\` is on PortOS's PATH.`;
  else if (installation === 'app') detail = `${runtime.label} is installed as an app.`;
  else if (installation === 'managed') detail = `${runtime.label} is installed locally.`;
  else if (reachable) detail = `Something is already serving ${runtime.endpoint}.`;
  else detail = `No local ${runtime.label} installation was found.`;
  const page = managePage(runtime);
  const fixHint = installed ? null
    : setupHint(setup, 'installs')
      || (page ? `Install ${runtime.label} from ${page}.`
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
  const page = managePage(runtime);
  const start = `Start ${runtime.label}${page ? ` from ${page}` : ''}.`;
  const modelsHint = expandPageToken(runtime.modelsHint, runtime);
  const fallback = installed
    ? `${start} ${modelsHint}`
    : `Install ${runtime.label} first, then start it. ${modelsHint}`;
  // Name the blocker in the same line that says nothing answered, or the checklist says "just press Start" when
    // Start cannot work until the weights land.
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
 * The `detail`/`fixHint` a model-facing check reports when the endpoint never answered, or answered unreadably.
 * A listing PortOS could not read is reported as unknown, never missing, so the user chases the actionable check.
 */
function unreadableListing(runtime, probeError, weights, setup) {
  // A server that answered 401 IS responding; the fix is to paste its key onto this provider, not to start a
    // container that is already up.
  const detail = probeError === 'authentication required'
    ? `${runtime.label} refused the model listing without an API key — paste the server's key on this provider.`
    : weightsDetail(runtime, weights) || 'Cannot be checked until the server responds.';
  // An unservable cache is the ONE unknown here that has a fix: the download
  // that makes a start possible at all.
  const fixHint = weightsBlockStart(weights) ? setupHint(setup, 'provisions') : null;
  return { detail, fixHint };
}

/**
 * The `model` check — does the running daemon serve what this provider asks for? An alias mismatch
 * (`llama-server --alias dflash` vs a provider pinned to `dspark`) fails HERE rather than inside a dead agent run.
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
  // Say WHY only one id is listed: a daemon serving one model per process is not "missing" the others, and
    // otherwise the checklist reads as a missing multi-gigabyte download.
  const oneModel = runtime.servesOneModel
    ? ` ${runtime.label} serves one model per process${runtime.aliasFlag ? `, answering under the id its \`${runtime.aliasFlag}\` set rather than the weights' own name` : ''}.`
    : '';
  const detail = served.length === 0
    ? `${runtime.label} is running but has no model loaded.`
    : `${runtime.label} is serving ${listed}${served.length > 3 ? ` +${served.length - 3} more` : ''}.${oneModel}`;
  // A runtime whose served id is a launch-line LABEL can be renamed onto the weights it already runs, so the
    // mismatch is fixable from either end and the hint names both.
  const renameTo = served.length > 0 && runtime.aliasFlag ? wanted : null;
  const page = managePage(runtime);
  const fixHint = served.length === 0
    ? (page
      ? `No model is loaded. Start a preset from ${page}.`
      : 'No model is loaded. Use the setup controls on this card to load one.')
    : renameTo
      ? `Same server, two names for it — nothing needs downloading. Use the button below to point this provider at ${listed}, or “Serve as \`${wanted}\`” to relaunch ${runtime.label} on the weights it already has under that id.`
      : `This provider will send \`${wanted}\`, but the running server only accepts ${listed}. Use the button below to match them${page ? ` (or change the loaded weights on ${page})` : ''}.`;
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
 * `modelCheck` validates the pin; this validates the rest of the provider's `models` list, which is what a task or
 * stage picks from. Without it a provider that pins nothing passed readiness while its catalog named ids the
 * daemon no longer served, and a stage pinned to one died at spawn.
 *
 * `servesOneModel` runtimes are graded leniently: llama.cpp, MTPLX, vLLM, SGLang and Slotstream run ONE checkpoint
 * per process, so a catalog listing other presets is normal and one servable id is all they need. A multi-model
 * daemon (Ollama, LM Studio) serves everything it holds, so there any unservable id is a real pin waiting to fail.
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
  // "every run fails" is only true when the pin cannot carry the provider either; otherwise only a stage that
    // pinned one of these ids dies.
  const nothingDispatchable = unserved.length === offered.length && !(pinned && served.includes(pinned));
  const page = managePage(runtime);
  const detail = nothingDispatchable
    ? `${runtime.label} serves none of them (${listed}${more}), so every run dispatched onto this provider fails before producing output.`
    : `${runtime.label} does not serve ${listed}${more}, so a task or stage pinned to one of those fails at spawn.`;
  return {
    id: 'catalog',
    label,
    ok: false,
    detail,
    fixHint: `Refresh this provider's models so it only offers ids the server serves${page ? `, or pull the missing ones from ${page}.` : `. ${expandPageToken(runtime.modelsHint, runtime)}`}`,
    unservedModels: unserved,
  };
}

/**
 * The requirements checklist for one provider, or `null` when it does not depend on a local daemon.
 *
 * Deps are injectable so the suite can drive every combination without a daemon or a real PATH.
 *
 * @param {object} provider - the RAW provider record (endpoint + envVars intact; a sanitized copy redacts secret
 *   env values, which would hide a custom base URL)
 * @param {{findCommand?:Function, probe?:Function}} [deps]
 */
export async function getProviderReadiness(provider, deps = {}) {
  const runtime = localRuntimeForProvider(provider);
  if (!runtime) return null;

  const readInstallation = deps.readInstallation || ((kind) => detectRuntimeInstallation(kind, {
    findCommand: deps.findCommand || findCommandCached, isAppInstalled: deps.isAppInstalled,
  }));
  const probe = deps.probe || probeOpenAiModelsCached;

  // The wrapper's own key: a vLLM container behind `VLLM_API_KEY` 401s an unauthenticated `/v1/models`, which
    // would leave the model check permanently unknown on a healthy stack.
  const result = await probe(runtime.endpoint, provider?.apiKey || '');
  // A daemon that answers is installed, whatever PATH says — Ollama's macOS app
  // and LM Studio both serve without putting a CLI on PortOS's PATH.
  const installation = await readInstallation(runtime.kind);
  const installed = Boolean(installation) || result.reachable;

  // Only worth asking when the daemon is installed and NOT answering: a running server's `/v1/models` is the
    // better answer, and an uninstalled runtime has no cache to read.
  const weights = installed && !result.reachable
    ? await (deps.readWeights || readWeightsStateCached)(runtime.kind)
    : 'unknown';

  // Resolved BEFORE the checks so each unmet one can point at the button that
  // fixes it rather than at a setup doc.
  const blockedReason = result.reachable ? null : await runtimeSetupBlockedReason(runtime);
  const setup = describeRuntimeSetup(runtime.kind, { installed, running: result.reachable, weights, blockedReason });
  const standby = runtime.standbyWhenStopped === true
    && installed
    && !result.reachable
    && !blockedReason
    && !weightsBlockStart(weights);

  const checks = [
    runtimeCheck(runtime, { installation, installed, reachable: result.reachable, setup }),
    serverCheck(runtime, { installed, result, setup, weights }),
  ];
  const wanted = servedModelId(provider, runtime.kind);
  // The probe returns `models: null` on every unreachable path, so this
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
    // Standby is separate from `ready`: no endpoint is available now, but an installed model-selecting runtime is
        // not missing setup merely because no model was chosen to occupy resources.
    standby,
    standbyDetail: standby ? expandPageToken(runtime.standbyDetail, runtime) : null,
    checks,
    // What this daemon is SERVING right now. Observed runtime state, so it rides the readiness payload and must
        // never reach `providers.json`; the provider card budgets its meter from it.
    contextWindows: aliasServedContextWindows(provider, runtime, result.contextWindows),
    // The window PortOS holds this daemon at, from BOTH rungs (the provider's `numCtx` and the ambient
        // `OLLAMA_CONTEXT_LENGTH`). Runtime state like the served windows; the browser cannot read server env, so
        // without it the meter would promise a window a run is then refused for.
    runtimeContextWindow: managedOllamaContextLength(provider),
    // What a one-click setup button can do about the unmet checks, or `null` when nothing is auto-fixable (see
        // `localRuntimeSetup.js`); lets the card offer the ACTION beside the failing check.
    setup,
  };
}

/**
 * Readiness for every ENABLED provider that needs a local daemon, keyed by provider id. Providers with no local
 * dependency are omitted, so the client can treat "absent" as "nothing to report".
 *
 * Disabled providers are skipped: a stock install ships most local presets disabled, and probing them would spend
 * most of every poll on cards for providers the user cannot run.
 *
 * @param {object[]} providers - RAW provider records
 */
export async function getProviderReadinessMap(providers, deps = {}) {
  const list = (Array.isArray(providers) ? providers : []).filter((provider) => provider?.enabled !== false);
  // One PATH scan per distinct binary and one probe per distinct endpoint per batch, including when the caller
    // injects its own probe (which would bypass the module-level caches).
  const findCommand = memoize(deps.findCommand || findCommandCached);
  const readInstallation = memoize(deps.readInstallation || ((kind) => detectRuntimeInstallation(kind, {
    findCommand, isAppInstalled: deps.isAppInstalled,
  })));
  const probe = memoize(deps.probe || probeOpenAiModelsCached);
  // Same reasoning as the two above: one `mtplx models` subprocess per batch,
  // not one per provider pointed at the same runtime.
  const readWeights = memoize(deps.readWeights || readWeightsStateCached);

  const entries = await Promise.all(list.map(async (provider) => {
    const readiness = await getProviderReadiness(provider, { readInstallation, probe, readWeights });
    return readiness ? [provider.id, readiness] : null;
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

/**
 * Per-batch memo (the returned promise is shared, not awaited). EVERY argument is folded into the key: keying on
 * the first alone dropped the probe's API key, so the batch path probed a key-gated container unauthenticated.
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
 * Drops the probe caches so the next read reflects a daemon just started, stopped, or installed — called by the
 * llama-server lifecycle routes.
 */
export function resetProviderReadinessCache() {
  invalidateModelObservation('provider-readiness');
  // The endpoint listing cache lives in `lib/openAiModelsProbeCache.js`; the dispatch path's context gate shares
    // it, so a daemon relaunched at a different context size must invalidate BOTH readers.
  resetOpenAiModelsProbeCache();
  binaryCache.clear();
  weightsCache.clear();
}
