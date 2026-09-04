/**
 * Harnesses — the coding-agent CLIs/TUIs PortOS drives, seen as things you
 * MANAGE rather than as a footnote on a provider card.
 *
 * A harness is one binary (`opencode`, `claude`, `codex`, `agy`, `grok`,
 * `kimi`, `cursor-agent`) that several provider records share. Availability and
 * the fixed install/update/remove invocations live in
 * `providerRuntimeInstaller.js`; this module answers the two questions that
 * need the provider records too:
 *
 *   - **Which providers ride on this harness, and are any of them enabled?**
 *     Removing `opencode` takes eleven provider records offline at once, and a
 *     page offering that button has to say so before the click.
 *   - **Which models does this install of the harness know about?** Every
 *     vendor that can answer prints it in its own shape
 *     (`server/lib/harnessOutput.js` parses them), and the answer is only
 *     useful once it reaches the providers whose picker it feeds.
 *
 * **The model refresh is deliberately narrow.** It rewrites the `models` list of
 * a provider only when that provider draws from the harness's OWN catalog — no
 * local-runtime marker (`ollamaBacked`, `vllmBacked`, …) and no `gatewayBacked`.
 * An OpenCode wrapper pointed at a local Ollama daemon serves `ollama/*` ids
 * that `opencode models` never reports, and overwriting its list with
 * `opencode/*` would leave it pointing at models its own config cannot resolve.
 *
 * **No AI provider call happens here.** `<harness> models` reads the vendor's
 * own catalog endpoint or local config; it does not generate anything, and it
 * runs only from an explicit click on the Harnesses page — nothing on the boot
 * path calls it (root AGENTS.md, AI Provider Usage Policy).
 */

import { prepareCliSpawn } from '../lib/bufferedSpawn.js';
import { commandOutput } from '../lib/commandExists.js';
import { compareHarnessVersions, parseHarnessModels, parseNpmLatestVersion } from '../lib/harnessOutput.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { primeOpencodeCatalogCache } from '../lib/opencodeCatalogCache.js';
import { getOpencodeLocalProviderNamespace, isConfiguredDefaultModel } from '../lib/providerModels.js';
import { providerRuntimeKey } from '../lib/providerPrerequisites.js';
import { createStaleWhileRevalidate } from '../lib/staleWhileRevalidate.js';
import * as providerService from './providers.js';
import {
  PROVIDER_RUNTIMES,
  getProviderRuntime,
  getProviderRuntimeStatuses,
  getProviderRuntimeStatus,
} from './providerRuntimeInstaller.js';

/**
 * A vendor `models` subcommand can reach the vendor's catalog API, so it is
 * bounded well above the local `--version` probe but far below an agent run.
 */
const MODELS_PROBE_TIMEOUT_MS = 45_000;

/** `npm view` hits the registry; a slow or offline network must not hang the page. */
const REGISTRY_TIMEOUT_MS = 12_000;

/**
 * How long a registry answer stays good. The published version of a CLI changes
 * a few times a week at most, and the page re-reads the whole list after every
 * action — without this, four visits are four registry round trips per
 * npm-backed harness.
 *
 * `createStaleWhileRevalidate` rather than a hand-rolled TTL map, for the two
 * behaviors that matter on a page opened while a laptop is off the network: a
 * failed `npm view` keeps the last good answer and backs off instead of
 * re-spawning on every load, and a stale-but-real version renders immediately
 * while the refresh runs behind it. Keys are the five frozen package names in
 * `PROVIDER_RUNTIMES`, so the map needs no eviction.
 */
const latestVersions = createStaleWhileRevalidate({
  ttlMs: 6 * 60 * 60 * 1000,
  // One offline load must not mean six hours of no registry reads; a minute is
  // long enough that a page re-render doesn't re-spawn npm.
  failureBackoffMs: 60 * 1000,
});

/**
 * The latest published version of an npm-backed harness, or `null` when the
 * registry could not be reached or the row is not npm-backed.
 *
 * `null` is NOT-KNOWN, never "no update": `updateAvailable` below is computed
 * only from a definite comparison, so an offline install shows the version it
 * has and no false "out of date" badge.
 */
export async function getLatestPublishedVersion(packageName, { fresh = false, run = commandOutput } = {}) {
  if (typeof packageName !== 'string' || packageName === '') return null;
  return latestVersions.read(packageName, async () => {
    // `prepareCliSpawn`, like the version and models probes: `npm` is a `.cmd`
    // shim on Windows and `execFile` under `shell: false` targets the literal
    // string with no PATHEXT search, so a bare 'npm' never runs there —
    // `latestVersion` would be permanently null and the staleness detection this
    // page exists for silently dead.
    const probe = prepareCliSpawn('npm', ['view', packageName, 'version']);
    const stdout = await run(probe.command, probe.args, { timeoutMs: REGISTRY_TIMEOUT_MS });
    const version = parseNpmLatestVersion(stdout);
    // THROW, don't cache a null: an unreachable registry is a failure the
    // backoff should pace, not an answer worth remembering for six hours.
    if (!version) throw new Error(`npm view ${packageName} returned no version`);
    return version;
  }, fresh ? { wait: 'fresh' } : {}).catch(() => null);
}

/** Test-only: drop cached registry answers so the next read re-queries. */
export function __resetLatestVersionCache() {
  latestVersions.clear();
}

/**
 * Does this provider draw its models from the harness's own catalog?
 *
 * True only for a plain wrapper: one that resolves to NO backend namespace —
 * neither a local runtime nor a hosted gateway. That single check covers both
 * carve-outs because `getOpencodeLocalProviderNamespace` resolves the modern
 * `gatewayBacked` marker, every legacy per-runtime boolean, AND the legacy
 * `orcarouterBacked` alias — so a record written before any of those existed is
 * classified correctly with no migration.
 *
 * **This is a test for the ABSENCE of a marker, which is a class that grows on
 * its own** — every un-marked provider joins it. That is deliberate (a record
 * with no backend really does run the harness's own models) but it is not
 * self-policing, so `harnesses.test.js` walks the shipped seed and pins exactly
 * which records a refresh may rewrite. A new seeded provider, or a harness that
 * gains `modelsArgs`, has to move that list on purpose. The failure it guards
 * is silent in the worst direction: a refresh replacing a working `models` list
 * with ids that record's own backend cannot resolve.
 */
export const usesHarnessCatalog = (provider) =>
  !getOpencodeLocalProviderNamespace(provider) && !declaresOwnOpencodeProvider(provider);

/**
 * Does this record hand-declare its own OpenCode provider entries?
 *
 * The `*Backed` / `gatewayBacked` markers above are only ever written by
 * PortOS's own editor, so a user who hand-wrote an `OPENCODE_CONFIG_CONTENT`
 * with `provider: { myco: … }` and a model list scoped to it is invisible to
 * them — and one Refresh click would replace that curated list with the
 * harness's own catalog, which their config cannot resolve. A declared provider
 * entry IS the backend marker for those records.
 *
 * The seeded Zen wrappers ship `{"permission":"allow"}` with no `provider` key,
 * so they stay in the class. An unparseable config declares nothing.
 */
function declaresOwnOpencodeProvider(provider) {
  const stored = provider?.envVars?.OPENCODE_CONFIG_CONTENT;
  if (typeof stored !== 'string' || stored === '') return false;
  let parsed = null;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return false; // unparseable — it declares nothing OpenCode can read either
  }
  return Object.keys(parsed?.provider || {}).length > 0;
}

/**
 * The `vendor/` namespaces a record's stored model ids already use, or an empty
 * set when it stores bare ids.
 *
 * `opencode models` prints every namespace the local OpenCode is authenticated
 * for, not just `opencode/*` — so on a box where the user has run
 * `opencode auth login <vendor>`, an unfiltered refresh would write
 * `anthropic/*` ids into a record named "OpenCode Zen CLI" whose key field is
 * `OPENCODE_API_KEY`, and its picker would then offer models that bill a
 * different account. A refresh updates a record's catalog; it does not widen
 * what that record is for.
 *
 * Empty for a harness whose ids are bare (agy, grok, cursor) — there is no
 * namespace to hold, so nothing is filtered.
 */
const storedNamespaces = (provider) => new Set(
  (provider?.models || [])
    .filter((id) => typeof id === 'string' && id.includes('/'))
    .map((id) => id.slice(0, id.indexOf('/'))),
);

/**
 * Every provider record this harness's runtime row actually answers for.
 *
 * Keyed on `providerRuntimeKey`, the same helper the provider cards use, rather
 * than on a bare basename: it deliberately returns `null` for a provider
 * configured with an explicit path (`/opt/tools/opencode`) or carrying its own
 * `PATH` override, because the PATH-scanning runtime table says nothing about
 * those. Attributing them here would inflate the removal warning and — worse —
 * let a model refresh rewrite a record from a catalog printed by a DIFFERENT
 * binary than the one that record spawns.
 */
const providersForHarness = (providers, runtime) => {
  const names = new Set([runtime.id, ...runtime.aliases]);
  return providers.filter((provider) => names.has(providerRuntimeKey(provider)));
};

/**
 * Every harness, with its runtime status and the providers riding on it.
 *
 * Publishes counts and ids, never resolved filesystem paths — same rule as
 * `GET /api/providers/runtimes`, since a global bin directory embeds the host
 * account name.
 */
export async function listHarnesses({ fresh = false, run = commandOutput, ...probeDeps } = {}) {
  const [statuses, providers] = await Promise.all([
    getProviderRuntimeStatuses({ ...probeDeps, fresh }),
    // `listProviders()`, not `getAllProviders()`: that one resolves an ENVELOPE
    // (`{ activeProvider, providers: [...] }`), and reaching past it by hand is
    // the mistake its own docblock records.
    providerService.listProviders(),
  ]);

  return Promise.all(PROVIDER_RUNTIMES.map(async (runtime) => {
    const status = statuses[runtime.id] || {};
    const linked = providersForHarness(providers, runtime);
    const latestVersion = runtime.npmPackage
      ? await getLatestPublishedVersion(runtime.npmPackage, { fresh, run })
      : null;
    return {
      ...status,
      id: runtime.id,
      label: runtime.label,
      command: runtime.command,
      vendor: runtime.vendor,
      package: runtime.npmPackage,
      latestVersion,
      // Only a DEFINITE "installed < latest" is an update prompt. A missing
      // version on either side leaves this false, and the row still offers the
      // Update button — the user can always ask for one.
      updateAvailable: compareHarnessVersions(status.version, latestVersion) === -1,
      providers: linked.map((provider) => ({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        enabled: provider.enabled === true,
        // Which of these the model refresh would actually rewrite.
        usesHarnessCatalog: usesHarnessCatalog(provider),
      })),
    };
  }));
}

/**
 * Ask a harness which models it knows about, and write the answer to every
 * provider that draws from its own catalog.
 *
 * Refuses rather than guesses in three cases, each with its own reason string:
 * an id not in the table, a harness with no `models` subcommand, and a harness
 * that is not installed. A probe that RUNS but parses to nothing also refuses —
 * an empty catalog is far more likely to be a vendor output change or a
 * signed-out CLI than a real "this harness has zero models", and blanking every
 * picker on that guess is worse than reporting the probe as failed.
 *
 * @returns {Promise<{ok:boolean, reason?:string, models:string[], updated:string[]}>}
 */
export async function refreshHarnessModels(id, { run = commandOutput, ...probeDeps } = {}) {
  const runtime = getProviderRuntime(id);
  if (!runtime) return { ok: false, reason: 'Unknown harness.', models: [], updated: [] };
  if (!runtime.modelsArgs) {
    return {
      ok: false,
      reason: `${runtime.label} has no command for listing its models, so PortOS cannot refresh them from here.`,
      models: [],
      updated: [],
    };
  }
  // The SAME injected runner answers the availability probe, so a caller (and a
  // test) drives one child-process boundary rather than two. Cache-respecting:
  // the page rendered from a probe seconds ago, and re-spawning the binary for
  // a 15s worst case ahead of the 45s models probe would double the wait on a
  // user-facing button. A binary that broke since then still refuses below.
  const findCommand = probeDeps.findCommand || findCommandOnPath;
  const status = await getProviderRuntimeStatus(runtime.id, { ...probeDeps, probeCommand: run });
  if (!status?.installed) {
    return { ok: false, reason: `${runtime.label} is not installed on this host.`, models: [], updated: [] };
  }

  // `opencode models` prints from an on-disk catalog OpenCode refreshes on its
  // own — silently, and not at all on a host where its fetch fails (see
  // `lib/opencodeCatalogCache.js`). Without this the button faithfully re-reads
  // a catalog frozen weeks ago and reports success, while the same account on
  // another machine lists models this one has never heard of. Best-effort by
  // design: a refusal or a failed fetch leaves the probe below unchanged.
  if (runtime.id === 'opencode') {
    const catalog = await primeOpencodeCatalogCache();
    console.log(`📚 ${runtime.label} catalog: ${catalog.primed ? 'refreshed' : 'left alone'} — ${catalog.reason}`);
  }

  // Resolve and `prepareCliSpawn` exactly as the version probe does. An
  // npm-installed harness is a `.cmd` shim on Windows, which `execFile` under
  // `shell: false` refuses outright — the probe would answer nothing and the
  // page would tell a signed-in user to go sign in.
  const resolved = await findCommand(runtime.command);
  const probe = prepareCliSpawn(resolved || runtime.command, [...runtime.modelsArgs]);
  const stdout = await run(probe.command, probe.args, { timeoutMs: MODELS_PROBE_TIMEOUT_MS });
  const models = parseHarnessModels(runtime.id, stdout);
  if (models.length === 0) {
    return {
      ok: false,
      reason: `\`${runtime.command} ${runtime.modelsArgs.join(' ')}\` returned no models. Sign in to ${runtime.label} in a terminal, then try again.`,
      models: [],
      updated: [],
    };
  }

  const targets = providersForHarness(await providerService.listProviders(), runtime).filter(usesHarnessCatalog);
  const updated = [];
  for (const provider of targets) {
    // Hold the record's namespace scope (see `storedNamespaces`). A filter that
    // matched nothing means the harness no longer lists anything this record is
    // for — skip it rather than blanking a working list on that evidence.
    const scope = storedNamespaces(provider);
    const scoped = scope.size === 0
      ? models
      : models.filter((id) => scope.has(id.slice(0, id.indexOf('/'))));
    if (scoped.length === 0) {
      console.log(`⏭️ ${runtime.label}: ${provider.id} lists no models in its own namespace — left alone`);
      continue;
    }
    // A `*-configured-default` sentinel is NOT a model the vendor will ever
    // print — it is the "send no --model, let the CLI use its own default"
    // marker (`resolveCliModel` maps it to null). Dropping it would silently
    // repin an agy/grok wrapper onto a concrete model AND remove the option
    // from the editor's picker, which renders it from this same list. So it
    // survives the rewrite rather than reading as an orphaned id.
    const next = [...(provider.models || []).filter(isConfiguredDefaultModel), ...scoped];
    // A stored default the harness no longer lists would leave the record
    // pinned to a model its own picker cannot show. Keep it when it survived
    // the refresh, otherwise fall to the first id (sentinel first when there
    // is one, then whatever the vendor listed newest-first).
    const defaultModel = next.includes(provider.defaultModel) ? provider.defaultModel : next[0];
    // Serialized rather than batched: each write is a read-modify-write of the
    // same providers.json, and Promise.all would have them clobber each other.
    await providerService.updateProvider(provider.id, { models: next, defaultModel });
    updated.push(provider.id);
  }
  console.log(`🔄 ${runtime.label}: ${models.length} models → ${updated.length} provider(s)`);
  return { ok: true, models, updated };
}
