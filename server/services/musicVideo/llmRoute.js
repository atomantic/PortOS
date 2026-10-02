/**
 * Music Video — which LLM runs a text stage (#9545).
 *
 * Direction, shot planning, the autonomous brief/lyrics and code authoring all
 * resolve their provider here, in one fixed order:
 *
 *   1. a pin on the request (`providerId`/`model`/`effort`) — authoritative,
 *      API or TUI alike;
 *   2. the pin saved on the project's automation brief (`automation.llm`);
 *   3. nothing pinned: an enabled, launchable, hardware-compatible TUI provider
 *      (the active provider when it is one), so the work shows up as an
 *      attachable Shell session instead of an invisible API call;
 *   4. the install's active provider (no eligible TUI) — a usable route, never
 *      an error just because no TUI is configured.
 *
 * A pin whose provider no longer resolves is not honored silently: the route
 * carries `requestedProviderId` so the summary shows what it replaced.
 *
 * Image-reading stages (plate review, auto-review) deliberately do NOT resolve
 * here: they take an explicit reviewer and already refuse, before dispatch, a
 * provider that cannot read images (a TUI other than Codex's, a tool-using CLI).
 * Only text stages prefer a TUI.
 *
 * Nothing here calls a provider: it only reads the provider registry.
 */

import { isTuiProvider } from '../../lib/providerTypes.js';
import { resolveCliEffort } from '../../lib/providerModels.js';
import { captureSystemCapabilities, isHardwareCompatible, withProviderHardwareCompatibility } from '../../lib/systemCapabilities.js';
import { normalizeMusicVideoLlm } from '../../lib/musicVideoAutomation.js';

const transportOf = (provider) => (provider?.type === 'tui' ? 'tui' : provider?.type === 'cli' ? 'cli' : 'api');

async function launchable(provider) {
  const { buildTuiShellLaunch } = await import('../../lib/tuiShellLaunch.js');
  return buildTuiShellLaunch(provider) !== null;
}

/**
 * The TUI provider an unpinned text stage should use, or null. Never throws: a
 * registry read failure just means "no preference".
 */
export async function preferredTuiProvider() {
  // Lazy: the provider registry (and its toolkit) is only needed when nothing is pinned.
  const { getActiveProvider, listProviders } = await import('../providers.js');
  const providers = await listProviders().catch(() => []);
  const capabilities = captureSystemCapabilities();
  const eligible = [];
  for (const provider of providers) {
    if (!isTuiProvider(provider) || provider.enabled === false) continue;
    if (!isHardwareCompatible(withProviderHardwareCompatibility(provider, capabilities).hardwareCompatibility)) continue;
    if (!(await launchable(provider))) continue;
    eligible.push(provider);
  }
  if (!eligible.length) return null;
  const active = await getActiveProvider().catch(() => null);
  return eligible.find((provider) => provider.id === active?.id) || eligible[0];
}

function describe({ provider, selectedModel, effort, source, requestedProviderId }) {
  return {
    providerId: provider.id,
    model: selectedModel || null,
    // The level the run will actually use: clamped to the provider's ladder, and
    // none for a provider with no effort control (every API provider).
    effort: provider.type === 'api' ? null : resolveCliEffort(effort, provider, selectedModel) || null,
    transport: transportOf(provider),
    source,
    ...(requestedProviderId ? { requestedProviderId } : {}),
  };
}

/**
 * Resolve the provider, model and effort a Music Video stage runs on.
 *
 * @param {object} [input]
 * @param {string} [input.providerId] request pin
 * @param {string} [input.model]
 * @param {string} [input.effort]
 * @param {object|null} [input.automation] the project's automation brief; its `llm` pin applies when the request pins nothing
 * @returns {Promise<{ provider: object|null, selectedModel: string|null, route: object|null }>}
 *   `route` carries the effective providerId/model/effort (clamped)/transport/source.
 *   `provider: null` when nothing resolves, so the caller throws its own typed error.
 */
export async function resolveMusicVideoLlm({ providerId, model, effort, automation = null } = {}) {
  // Lazy: promptRunner drags the whole provider runtime, and callers that import this file for
  // its pure helpers (or whose suites mock it) shouldn't pay for it at load.
  const { resolveProviderAndModel } = await import('../promptRunner.js');
  const saved = normalizeMusicVideoLlm(automation?.llm);
  const pin = providerId
    ? { providerId, model, effort, source: 'pinned' }
    : saved ? { ...saved, source: 'brief' } : null;

  let requestedProviderId = null;
  if (pin) {
    const { provider, selectedModel } = await resolveProviderAndModel({ providerId: pin.providerId, model: pin.model || undefined });
    if (provider?.id === pin.providerId) {
      return { provider, selectedModel, route: describe({ provider, selectedModel, effort: pin.effort, source: pin.source }) };
    }
    requestedProviderId = pin.providerId;
  }

  const tui = await preferredTuiProvider();
  if (tui) {
    const { provider, selectedModel } = await resolveProviderAndModel({ providerId: tui.id });
    if (provider) {
      return { provider, selectedModel, route: describe({ provider, selectedModel, effort: pin?.effort, source: 'tui-preferred', requestedProviderId }) };
    }
  }

  const { provider, selectedModel } = await resolveProviderAndModel({});
  if (!provider) return { provider: null, selectedModel: null, route: null };
  return { provider, selectedModel, route: describe({ provider, selectedModel, effort: pin?.effort, source: 'active', requestedProviderId }) };
}

/** The `effort` argument for a run: only present when the route has one. */
export const effortArg = (route) => (route?.effort ? { effort: route.effort } : {});

/**
 * Remember the route a stage ran on in the project's brief so the page can show
 * it (and a reload still does). Only projects with an automation brief carry
 * one; best-effort — a failed write never fails the stage it describes.
 * Returns the persisted project, or null when nothing was written.
 */
export async function recordLlmRoute(projectId, stage, route) {
  if (!route) return null;
  try {
    const { mutateProjectRecord } = await import('./projects.js');
    const at = new Date().toISOString();
    const written = await mutateProjectRecord(projectId, (current) => (current.automation
      ? { project: { ...current, automation: { ...current.automation, routes: { ...(current.automation.routes || {}), [stage]: { ...route, at } } } }, written: true }
      : { project: current, written: false }));
    return written?.written ? written.project : null;
  } catch (err) {
    console.warn(`⚠️ Music Video ${stage}: could not record the LLM route for ${projectId}: ${err.message}`);
    return null;
  }
}
