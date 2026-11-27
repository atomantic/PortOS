/**
 * Harnesses — the coding-agent CLIs/TUIs PortOS drives, seen as things you MANAGE.
 *
 * A harness is one binary (`opencode`, `kilo`, `openchamber`, `claude`, `codex`, `agy`,
 * `grok`, `kimi`, `cursor-agent`) that several provider records share. Availability and the
 * install/update/remove invocations live in `providerRuntimeInstaller.js`; this module adds
 * what needs the provider records:
 *
 *   - **Which providers ride on this harness, and are any enabled?** Removing `opencode`
 *     takes many provider records offline at once; the page must say so before the click.
 *   - **Which models does this install of the harness know about?** Parsed per vendor by
 *     `server/lib/harnessOutput.js` and pushed to the providers whose picker it feeds.
 *
 * **The model refresh is deliberately narrow.** It rewrites a provider's `models` only when
 * that provider draws from the harness's OWN catalog: no local-runtime marker
 * (`ollamaBacked`, `vllmBacked`, ...) and no `gatewayBacked`. An OpenCode wrapper pointed at
 * a local Ollama daemon serves `ollama/*` ids that `opencode models` never reports.
 *
 * **No AI provider call happens here.** `<harness> models` reads the vendor's catalog or
 * local config and runs only from an explicit click on the Harnesses page, never on boot.
 */

import { isDeepStrictEqual } from 'node:util';
import { prepareCliSpawn } from '../lib/bufferedSpawn.js';
import { hasCredentialBootstrap, resolveCliSpawn } from '../lib/credentialBootstrap.js';
import { commandOutput } from '../lib/commandExists.js';
import { compareHarnessVersions, parseHarnessModels, parseNpmLatestVersion } from '../lib/harnessOutput.js';
import { isDerivedPreset } from '../lib/provider/providerGraphRecords.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { primeOpencodeCatalogCache } from '../lib/opencodeCatalogCache.js';
import { getOpencodeLocalProviderNamespace, isConfiguredDefaultModel } from '../lib/provider/providerModels.js';
import { providerRuntimeKey } from '../lib/provider/providerPrerequisites.js';
import { createStaleWhileRevalidate } from '../lib/staleWhileRevalidate.js';
import * as providerService from './provider/providers.js';
import { providerGraphEnabled } from './provider/providerGraph.js';
import {
  PROVIDER_RUNTIMES,
  getProviderRuntime,
  getProviderRuntimeStatuses,
  getProviderRuntimeStatus,
} from './provider/providerRuntimeInstaller.js';

/** A vendor `models` subcommand can reach the vendor's catalog API: bounded above the local `--version` probe but far below an agent run. */
const MODELS_PROBE_TIMEOUT_MS = 45_000;

/** `npm view` hits the registry; a slow or offline network must not hang the page. */
const REGISTRY_TIMEOUT_MS = 12_000;

/**
 * How long a registry answer stays good (a CLI's published version changes a few times a
 * week). `createStaleWhileRevalidate` so that a failed `npm view` keeps the last good answer
 * and backs off, and a stale version renders immediately while the refresh runs. Keys are
 * the frozen package names in `PROVIDER_RUNTIMES`, so no eviction is needed.
 */
const latestVersions = createStaleWhileRevalidate({
  ttlMs: 6 * 60 * 60 * 1000,
  // One offline load must not mean six hours of no registry reads.
  failureBackoffMs: 60 * 1000,
});

/**
 * The latest published version of an npm-backed harness, or `null` (not known) when the
 * registry is unreachable or the row isn't npm-backed. `null` is never "no update":
 * `updateAvailable` is computed only from a definite comparison.
 */
export async function getLatestPublishedVersion(packageName, { fresh = false, run = commandOutput } = {}) {
  if (typeof packageName !== 'string' || packageName === '') return null;
  return latestVersions.read(packageName, async () => {
    // `prepareCliSpawn`: `npm` is a `.cmd` shim on Windows and `execFile` under
    // `shell: false` does no PATHEXT search, so a bare 'npm' would never run there.
    const probe = prepareCliSpawn('npm', ['view', packageName, 'version']);
    const stdout = await run(probe.command, probe.args, { timeoutMs: REGISTRY_TIMEOUT_MS });
    const version = parseNpmLatestVersion(stdout);
    // THROW, don't cache a null: an unreachable registry is a failure the backoff should pace.
    if (!version) throw new Error(`npm view ${packageName} returned no version`);
    return version;
  }, fresh ? { wait: 'fresh' } : {}).catch(() => null);
}

/**
 * The newest version this copy's own updater can reach. A Homebrew copy compares against
 * Homebrew (an npm release Homebrew hasn't published is an update nothing here can perform);
 * npm stays the answer when Homebrew cannot say.
 */
async function resolveLatestVersion(runtime, status, { fresh, run, fetchImpl }) {
  const npm = await getLatestPublishedVersion(runtime.npmPackage, { fresh, run });
  const channel = status.installChannel;
  // Decided before the cache: its key is the package name, which a tap formula can share with an unrelated homebrew-core one.
  if (!channel || channel.thirdPartyTap) return { latestVersion: npm, latestVersionSource: 'npm', npmAheadVersion: null };
  const brew = await latestVersions.read(`homebrew:${channel.kind}:${channel.name}`, async () => {
    const { fetchHomebrewLatestVersion } = await import('../lib/homebrewPackage.js');
    const version = await fetchHomebrewLatestVersion(channel, { fetchImpl });
    if (!version) throw new Error(`Homebrew has no version for ${channel.name}`);
    return version;
  }, fresh ? { wait: 'fresh' } : {}).catch(() => null);
  if (!brew) return { latestVersion: npm, latestVersionSource: 'npm', npmAheadVersion: null };
  return { latestVersion: brew, latestVersionSource: 'homebrew', npmAheadVersion: compareHarnessVersions(brew, npm) === -1 ? npm : null };
}

/** Test-only: drop cached registry answers so the next read re-queries. */
export function __resetLatestVersionCache() {
  latestVersions.clear();
}

/**
 * Does this provider draw its models from the harness's own catalog? True only for a plain
 * wrapper that resolves to NO backend namespace. `getOpencodeLocalProviderNamespace` covers
 * `gatewayBacked`, every legacy per-runtime boolean and the `orcarouterBacked` alias, so old
 * records classify correctly with no migration.
 *
 * **This tests the ABSENCE of a marker, a class that grows on its own** (every un-marked
 * provider joins it). `harnesses.test.js` walks the shipped seed and pins which records a
 * refresh may rewrite, so a new seeded provider or a harness gaining `modelsArgs` must move
 * that list on purpose; the failure it guards is silent: replacing a working `models` list
 * with ids the record's backend cannot resolve.
 */
export const usesHarnessCatalog = (provider) =>
  !getOpencodeLocalProviderNamespace(provider) && !declaresOwnOpencodeProvider(provider);

/**
 * The harness runtime whose OWN catalog feeds this provider's models, or `null` for a
 * record that keeps its own catalog. The full precondition for {@link refreshHarnessModels}:
 * the binary must enumerate its models (`modelsArgs` or `listModels`) and the record must be
 * a plain wrapper ({@link usesHarnessCatalog}). A custom binary has no runtime row and
 * answers `null`. Shared by the provider card's Refresh Models button
 * (`server/routes/providers/presenter.js`) and the seed pin in tests so they can't drift.
 */
export const harnessCatalogRuntime = (provider) => {
  const runtime = getProviderRuntime(providerRuntimeKey(provider));
  return (runtime?.modelsArgs || runtime?.listModels) && usesHarnessCatalog(provider) ? runtime : null;
};

/**
 * Does this record hand-declare its own OpenCode provider entries? The `*Backed` markers are
 * written only by PortOS's editor, so a hand-written `OPENCODE_CONFIG_CONTENT` with
 * `provider: { myco: ... }` is invisible to them, and a refresh would replace its curated
 * list with a catalog its config cannot resolve. A declared provider entry IS the backend
 * marker. Seeded Zen wrappers ship no `provider` key; unparseable config declares nothing.
 */
function declaresOwnOpencodeProvider(provider) {
  const stored = provider?.envVars?.OPENCODE_CONFIG_CONTENT;
  if (typeof stored !== 'string' || stored === '') return false;
  let parsed = null;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return false;
  }
  return Object.keys(parsed?.provider || {}).length > 0;
}

/**
 * The `vendor/` namespaces a record's stored model ids already use, or an empty set for bare
 * ids. `opencode models` prints every namespace the local OpenCode is authenticated for, so
 * an unfiltered refresh could write `anthropic/*` ids into a record keyed to
 * `OPENCODE_API_KEY` and offer models that bill another account. A refresh updates a
 * record's catalog; it does not widen what the record is for.
 */
const storedNamespaces = (provider) => new Set(
  (provider?.models || [])
    .filter((id) => typeof id === 'string' && id.includes('/'))
    .map((id) => id.slice(0, id.indexOf('/'))),
);

/**
 * Every provider record this harness's runtime row answers for. Keyed on
 * `providerRuntimeKey`, which returns `null` for an explicit path or a `PATH` override:
 * attributing those would inflate the removal warning and let a refresh rewrite a record
 * from a catalog printed by a DIFFERENT binary than the one it spawns.
 */
const providersForHarness = (providers, runtime) => {
  const names = new Set([runtime.id, ...runtime.aliases]);
  return providers.filter((provider) => names.has(providerRuntimeKey(provider)));
};

/** Every harness with its runtime status and linked providers. Publishes counts and ids, never resolved filesystem paths (a global bin directory embeds the host account name). */
export async function listHarnesses({ fresh = false, run = commandOutput, fetchImpl, ...probeDeps } = {}) {
  const [statuses, providers] = await Promise.all([
    getProviderRuntimeStatuses({ ...probeDeps, fresh }),
    // `listProviders()`, not `getAllProviders()`, which resolves an envelope.
    providerService.listProviders(),
  ]);

  return Promise.all(PROVIDER_RUNTIMES.map(async (runtime) => {
    const status = statuses[runtime.id] || {};
    const linked = providersForHarness(providers, runtime);
    // Gated on `installed`: nothing renders `latestVersion` for an uninstalled row and
    // `updateAvailable` needs a definite installed version, so ungated, every shipped-but-
    // uninstalled harness would cost an `npm view` on each cache-cold page load.
    const { latestVersion, latestVersionSource, npmAheadVersion } = runtime.npmPackage && status.installed
      ? await resolveLatestVersion(runtime, status, { fresh, run, fetchImpl })
      : { latestVersion: null, latestVersionSource: null, npmAheadVersion: null };
    return {
      ...status,
      id: runtime.id,
      label: runtime.label,
      command: runtime.command,
      vendor: runtime.vendor,
      package: runtime.npmPackage,
      latestVersion,
      latestVersionSource,
      npmAheadVersion,
      // Only a DEFINITE "installed < latest" prompts; the Update button is always offered.
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
 * The target records bucketed by the credential their probe must run under. A bootstrap CLI
 * mints auth for ONE account and `<harness> models` prints THAT account's catalog, so a probe
 * answers only for records sharing its credential: one bucket per distinct
 * `credentialBootstrap`, plus one for records naming none (`probeAs: null`, probed bare).
 * A mixed set never degrades to one bare probe, since "bare" is another account's answer.
 * Deep equality, not a serialized key, so key order doesn't split one account in two.
 */
const credentialProbeGroups = (targets) => {
  const groups = [];
  for (const target of targets) {
    // The RECORD to probe as (`resolveCliSpawn` takes a provider); null spawns bare.
    const probeAs = hasCredentialBootstrap(target) ? target : null;
    const bucket = groups.find((group) => isDeepStrictEqual(
      group.probeAs?.credentialBootstrap ?? null,
      probeAs?.credentialBootstrap ?? null,
    ));
    if (bucket) bucket.targets.push(target);
    else groups.push({ probeAs, targets: [target] });
  }
  return groups;
};

/**
 * Write one probe's catalog to the records that probe answers for; returns the ids rewritten.
 *
 * A DERIVED preset never receives this write directly: its `models` IS its service's catalog
 * narrowed, so re-derivation would discard it and the catalog would stay stale. Refresh the
 * SERVICE once per `serviceId`, reusing this call's fetched catalog via an injected
 * `harnessModels` (no second probe, no re-entry into `refreshHarnessModels`).
 */
async function applyHarnessCatalog(runtime, models, targets) {
  const updated = [];
  const derivedProviderIdsByService = new Map();
  for (const provider of targets) {
    if (isDerivedPreset(provider) && providerGraphEnabled()) {
      const ids = derivedProviderIdsByService.get(provider.serviceId) || [];
      ids.push(provider.id);
      derivedProviderIdsByService.set(provider.serviceId, ids);
      continue;
    }
    // Hold the record's namespace scope; an empty filter result means the harness lists
    // nothing for this record, so skip rather than blank a working list.
    const scope = storedNamespaces(provider);
    const scoped = scope.size === 0
      ? models
      : models.filter((id) => scope.has(id.slice(0, id.indexOf('/'))));
    if (scoped.length === 0) {
      console.log(`⏭️ ${runtime.label}: ${provider.id} lists no models in its own namespace — left alone`);
      continue;
    }
    // A `*-configured-default` sentinel is the "send no --model" marker, never printed by the
    // vendor and rendered by the editor's picker from this list, so it survives the rewrite.
    const next = [...(provider.models || []).filter(isConfiguredDefaultModel), ...scoped];
    // Keep a stored default that survived the refresh, else fall to the first id.
    const defaultModel = next.includes(provider.defaultModel) ? provider.defaultModel : next[0];
    // Serialized: each write is a read-modify-write of the same providers.json.
    await providerService.updateProvider(provider.id, { models: next, defaultModel });
    updated.push(provider.id);
  }
  if (derivedProviderIdsByService.size > 0) {
    // Deferred so this file doesn't drag the provider-graph module into every caller.
    const { refreshServiceCatalog } = await import('./provider/providerServices.js');
    const alreadyListed = async () => ({ ok: true, models });
    for (const [serviceId, providerIds] of derivedProviderIdsByService) {
      const outcome = await refreshServiceCatalog(serviceId, { harnessModels: alreadyListed }).catch((err) => {
        console.error(`❌ ${runtime.label}: could not refresh service "${serviceId}"'s catalog: ${err?.message || err}`);
        return null;
      });
      if (outcome?.service?.catalog?.state !== 'failed') updated.push(...providerIds);
    }
  }
  return updated;
}

/**
 * Ask a harness which models it knows about and write the answer to every provider drawing
 * from its own catalog. One probe per credential ({@link credentialProbeGroups}): a record
 * whose auth comes from a bootstrap CLI is probed THROUGH that CLI, never the ambient one.
 *
 * Refuses rather than guesses: unknown id, no `models` subcommand, not installed, or a probe
 * that parses to nothing (more likely a vendor output change or signed-out CLI than zero
 * models; blanking every picker on that guess is worse). Refusals are per-bucket, so `reason`
 * also appears on a partial success.
 *
 * `providerId` narrows the run to that record's bucket (a provider card's button), so it
 * can't spawn an unrelated record's bootstrap CLI. The Harnesses page omits it.
 *
 * `probeOnly` lists without writing records. A caller already holding the provider-graph
 * queue (`refreshServiceCatalog`) must use it: record writes await a graph reconcile that
 * queues behind that caller and never returns.
 *
 * @returns {Promise<{ok:boolean, reason?:string, models:string[], updated:string[]}>}
 */
export async function refreshHarnessModels(id, { run = commandOutput, providerId = null, listModels, probeOnly = false, ...probeDeps } = {}) {
  const runtime = getProviderRuntime(id);
  if (!runtime) return { ok: false, reason: 'Unknown harness.', models: [], updated: [] };
  // `listModels` replaces `modelsArgs` for a harness whose catalog needs more than argv +
  // stdout (Codex's is an `app-server` JSON-RPC handshake); callers may override it in tests.
  const listModelsImpl = listModels || runtime.listModels;
  if (!runtime.modelsArgs && !listModelsImpl) {
    return {
      ok: false,
      reason: `${runtime.label} has no command for listing its models, so PortOS cannot refresh them from here.`,
      noLister: true,
      models: [],
      updated: [],
    };
  }
  const findCommand = probeDeps.findCommand || findCommandOnPath;

  // Resolved before the probe: the credential each probe runs under belongs to the records
  // WRITTEN, not the clicked card or the ambient account.
  const targets = providersForHarness(await providerService.listProviders(), runtime).filter(usesHarnessCatalog);
  const buckets = credentialProbeGroups(targets);
  const scoped = providerId ? buckets.filter((b) => b.targets.some((t) => t.id === providerId)) : buckets;
  if (providerId && scoped.length === 0) {
    return { ok: false, reason: `${providerId} does not draw its models from ${runtime.label}.`, models: [], updated: [] };
  }
  // No targets still runs one bare probe so the page can show what the harness lists.
  const groups = scoped.length ? scoped : [{ probeAs: null, targets: [] }];

  // The same injected runner answers the availability probe (one child-process boundary).
  // Cache-respecting to avoid doubling the wait. Asked only when a BARE probe will run: a
  // credentialed harness is reached through its bootstrap CLI and need not be on PATH.
  const notInstalled = `${runtime.label} is not installed on this host.`;
  const probesBare = groups.some((group) => !group.probeAs);
  const installed = probesBare
    ? Boolean((await getProviderRuntimeStatus(runtime.id, { ...probeDeps, probeCommand: run }))?.installed)
    : false;

  // `opencode models` reads an on-disk catalog OpenCode refreshes silently and not at all
  // when its fetch fails (`lib/opencodeCatalogCache.js`), so prime it or the button re-reads a
  // stale catalog and reports success. Best-effort; gated on a probe able to run.
  if (runtime.id === 'opencode' && (installed || groups.some((group) => group.probeAs))) {
    const catalog = await primeOpencodeCatalogCache();
    console.log(`📚 ${runtime.label} catalog: ${catalog.primed ? 'refreshed' : 'left alone'} — ${catalog.reason}`);
  }

  // Probe buckets CONCURRENTLY (each has its own 45s cap); only the WRITES are serialized.
  const probed = await Promise.all(groups.map(async (group) => {
    if (!group.probeAs && !installed) return { group, failure: notInstalled };
    // Resolve as the version probe does: an npm harness is a `.cmd` shim on Windows that
    // `execFile` refuses. A credentialed bucket skips the PATH walk (`resolveCliSpawn`
    // resolves the bootstrap binary's shim).
    const resolved = group.probeAs ? null : await findCommand(runtime.command);
    if (listModelsImpl) {
      // A harness-specific lister owns its spawn shape; per-bucket so one credential's
      // failure doesn't fail the others.
      const listed = await listModelsImpl({
        probeAs: group.probeAs,
        resolvedCommand: resolved || runtime.command,
        env: process.env,
        timeoutMs: MODELS_PROBE_TIMEOUT_MS,
      }).catch((err) => ({ error: err?.message || `${runtime.label} failed to list its models.` }));
      if (Array.isArray(listed) && listed.length > 0) return { group, listed };
      return { group, failure: Array.isArray(listed) ? `${runtime.label} returned no models.` : listed.error };
    }
    const probe = resolveCliSpawn(group.probeAs, resolved || runtime.command, [...runtime.modelsArgs], process.env);
    const listed = parseHarnessModels(runtime.id, await run(probe.command, probe.args, { timeoutMs: MODELS_PROBE_TIMEOUT_MS }));
    if (listed.length > 0) return { group, listed };
    // Name what RAN; only send the user to a terminal when one could help (not for a credentialed harness).
    const ran = `\`${probe.command} ${probe.args.join(' ')}\` returned no models.`;
    return { group, failure: group.probeAs ? ran : `${ran} Sign in to ${runtime.label} in a terminal, then try again.` };
  }));

  const seen = new Set();
  const updated = [];
  const failures = [];
  for (const { group, listed, failure } of probed) {
    if (failure) {
      failures.push(failure);
      continue;
    }
    for (const model of listed) seen.add(model);
    if (!probeOnly) updated.push(...await applyHarnessCatalog(runtime, listed, group.targets));
  }

  // `reason` also rides on a PARTIAL success: a card's button checking `updated` for its own
  // id needs the failed bucket's message.
  const reason = failures.length ? failures.join(' ') : undefined;
  const models = [...seen];
  if (models.length === 0) return { ok: false, reason, models: [], updated: [] };
  console.log(`🔄 ${runtime.label}: ${models.length} models → ${updated.length} provider(s)`);
  return { ok: true, reason, models, updated };
}
