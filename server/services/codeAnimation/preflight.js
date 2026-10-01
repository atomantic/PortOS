/** Data-only preview. No provider invocation, tool probe, or execution grant. */
import { getProductionProject } from './projects.js';
import { getProviderById, getSelectableProviders } from '../providers.js';
import { applyModelAccess } from '../../lib/aiToolkit/internal/modelAccess.js';
import { harnessForProvider, providerRouteMode } from '../../lib/providerHarnesses.js';
import { effortLevelsForProvider, hasEffortFlag, isConfiguredDefaultModel, antigravityBaseModels } from '../../lib/providerModels.js';
import { isCompositeProviderId } from '../../lib/providerRef.js';
import { isVisionCapableCliProvider } from '../../lib/localModelHeuristics.js';
import { isVisionCapableCodexTuiProvider } from '../../lib/codex.js';
import { ServerError } from '../../lib/errorHandler.js';

const substitutionOf = requested => requested?.substitution === 'allowed' ? 'allowed' : 'pinned';

/** Pure route capability map: what the selected route can honestly do. No tool or provider probe. */
function routeCapabilities(provider, mode) {
  const accepted = mode === 'api' || isVisionCapableCliProvider(provider) || isVisionCapableCodexTuiProvider(provider);
  return {
    packageImportExport: true,
    // API text may carry structured, validated package files without shell/tools.
    textPackageOutput: Boolean(mode),
    // The route can receive images, but no render/inspection adapter is wired yet.
    imageInputAccepted: Boolean(accepted),
    imageInspection: false,
    visualReview: false,
    research: false,
    toolsDeclared: mode === 'api' ? [] : null,
  };
}

/**
 * Compare the route that actually ran with the pinned route. Pinned mode throws on
 * any substitution; an opted-in substitution is returned as a recorded decision.
 */
export function _recordEffectiveRoute(resolved, requested, runResult) {
  const ran = runResult?.fallbackProvider || runResult?.provider || null;
  const effective = { providerId: ran?.id ?? resolved.providerId, model: runResult?.model ?? resolved.model, effort: resolved.effort };
  const substituted = effective.providerId !== resolved.providerId || effective.model !== resolved.model || Boolean(runResult?.usedFallback);
  const policy = substitutionOf(requested);
  if (substituted && policy === 'pinned') {
    throw new ServerError('The pinned authoring route was substituted; refusing to record it as the requested route.', { status: 409, code: 'AUTHORING_ROUTE_SUBSTITUTED' });
  }
  return { effective, substituted, substitution: policy, decision: substituted ? { optedIn: true, from: resolved.providerId, to: effective.providerId } : null };
}

export async function preflightProductionProject(id) {
  const project = await getProductionProject(id);
  const requested = project.localSettings;
  const problems = [];
  const result = { requested, resolved: null, effective: null, executed: false, problems,
    substitution: substitutionOf(requested), allowFallback: substitutionOf(requested) === 'allowed',
    capabilities: { packageImportExport: true, authoringDispatch: false, renderTools: false, imageInspection: false, research: false },
    notes: ['Settings preview only. Authoring, rendering, visual inspection and research adapters are not connected; use package export/import.'],
  };
  if (!requested.providerId) {
    problems.push('Select an authoring provider explicitly.');
    return result;
  }
  const { providers } = await getSelectableProviders();
  const provider = providers.find(item => item.id === requested.providerId)
    || (isCompositeProviderId(requested.providerId) ? applyModelAccess(await getProviderById(requested.providerId)) : null);
  if (!provider || provider.enabled === false) {
    problems.push('The selected provider is missing or disabled.');
    return result;
  }
  // Use the runner's own model resolution, including saved argv pins. Loading
  // this helper does not create a run or call a provider.
  const { resolveEffectiveModel } = await import('../promptRunner.js');
  const model = resolveEffectiveModel(provider, requested.model);
  const harness = harnessForProvider(provider)?.id ?? null;
  const mode = providerRouteMode(provider);
  const connectionId = provider.serviceId ?? null;
  const effortLevels = mode === 'api' ? [] : effortLevelsForProvider(provider, model) || [];
  const effort = requested.effort || provider.effort || null;
  result.capabilities = { ...result.capabilities, ...routeCapabilities(provider, mode) };
  result.resolved = { providerId: provider.id, harness, connectionId, mode, model, effort: null };
  if (!mode || !harness) problems.push('The selected route has no recognized authoring harness or mode.');
  if (requested.mode && requested.mode !== mode) problems.push('The saved execution mode no longer matches the selected route.');
  if (requested.connectionId && requested.connectionId !== connectionId) problems.push('The saved connection no longer matches the selected route.');
  const catalog = (provider.models || []).map(item => typeof item === 'string' ? item : item.id);
  const selectable = harness === 'antigravity' ? antigravityBaseModels(catalog) : catalog;
  if (!model || isConfiguredDefaultModel(model)) problems.push('Select a concrete model; the harness default cannot establish model provenance.');
  else if (!selectable.includes(model)) problems.push('The resolved model is not in this route’s selectable catalog.');
  if (requested.model && requested.model !== model) problems.push('The selected model would be replaced by the provider configuration.');
  if (mode !== 'api' && hasEffortFlag(provider.args || [])) problems.push('Saved provider arguments pin reasoning effort; remove that pin before comparing explicit settings.');
  else if (effort && !effortLevels.includes(effort)) problems.push('The requested or configured reasoning effort is unsupported by this route and model.');
  else result.resolved.effort = effort;
  result.effortLevels = effortLevels;
  return result;
}
