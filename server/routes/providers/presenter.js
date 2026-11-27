import { EXECUTION_OPTION_DEFINITIONS } from '../../lib/executionOptions.js';
import { harnessForProvider } from '../../lib/provider/providerHarnesses.js';
import { presetSkipReason } from '../../services/provider/providerGraph.js';
import { withRefreshCapability } from '../../lib/aiToolkit/internal/modelFetchers.js';
import { applyModelAccess } from '../../lib/aiToolkit/internal/modelAccess.js';
import { harnessCatalogRuntime } from '../../services/harnesses.js';
import {
  isAuthoringOneShotProvider,
  isToolFreeOneShotProvider,
  enforcedPublicReviewPosturesForProvider,
  publicReviewPosturesForProvider,
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
} from '../../lib/provider/providerVendors.js';
import { htmlPagesProviderCapability } from '../../lib/provider/htmlPagesProvider.js';
import { isMtplxOpenCodeCli } from '../../lib/opencodeConfig.js';
import { buildTuiShellLaunch } from '../../lib/tuiShellLaunch.js';
import { isMaskedEnvVar } from '../../lib/credentialEnvVars.js';
import { presetDerivable, presetKind } from '../../lib/provider/providerPresets.js';
import { canReviewImages } from '../../lib/imageReviewProviders.js';
import {
  captureSystemCapabilities,
  withProviderHardwareCompatibility,
} from '../../lib/systemCapabilities.js';

/**
 * Sanitize a provider object for client responses.
 * Strips apiKey (replaces with hasApiKey boolean) and redacts secretEnvVars
 * values. An explicitly empty secret value stays empty so the client can
 * distinguish "configured but blank" from an unknown redacted value when it
 * paints provider readiness.
 */
const sanitizeProvider = (provider) => {
  if (!provider) return provider;
  const { apiKey, envVars, secretEnvVars, ...rest } = provider;
  const sanitized = {
    ...rest,
    hasApiKey: Boolean(apiKey),
    envVars: envVars ? { ...envVars } : {},
    secretEnvVars: secretEnvVars || []
  };
  // Redact secret-listed AND credential-named env vars (Secret box may be off)
  for (const key of Object.keys(sanitized.envVars)) {
    if (isMaskedEnvVar(key, secretEnvVars)) {
      sanitized.envVars[key] = sanitized.envVars[key] === '' ? '' : '***';
    }
  }
  return sanitized;
};

/**
 * Decorate a TUI provider with its launch command preview so the card can
 * render a "Launch in Shell" button without probing installed CLIs.
 *
 * DISPLAY ONLY — the launch itself goes through `shell:start { providerId }`,
 * which re-resolves this server-side and pairs it with the provider's env (see
 * `lib/tuiShellLaunch.js`). Publishing the line does not publish the env: those
 * values are secret and stay on the server.
 *
 * Non-TUI providers get no field at all: the button is TUI-only, and an absent
 * key (rather than an empty string) keeps "not a TUI" distinct from "a TUI
 * whose command line came back blank".
 */
const withTuiLaunchCommand = (provider) => {
  const launch = buildTuiShellLaunch(provider);
  return launch ? { ...provider, tuiCommandLine: launch.commandLine } : provider;
};

export const executionOptionKeysForHarness = id => Object.values(EXECUTION_OPTION_DEFINITIONS).filter(option => option.harnesses.includes(id)).map(option => option.key);

/**
 * The shape a provider takes on its way OUT to the client: secrets stripped,
 * plus the derived `canRefreshModels` flag the AI Providers page reads to
 * decide whether to offer a "Refresh Models" button (#3620).
 *
 * Order matters, and BOTH derivations run on the RAW provider, before
 * sanitization. `canRefreshModels`: the ollama row of the fetcher table keys
 * partly on `envVars.ANTHROPIC_BASE_URL`, which `sanitizeProvider` redacts to
 * `'***'` when the user marked it secret — deriving after would silently drop
 * the Refresh button for a Claude-Ollama provider. `tuiCommandLine`: the same
 * trap one layer down, since `buildTuiInvocation` consults `envVars` for the
 * Bedrock model mapping (`CLAUDE_CODE_USE_BEDROCK`) — a redacted `'***'` reads
 * truthy, so a card whose provider has that var marked secret and switched OFF
 * would advertise a Bedrock-mapped model the real launch never uses.
 *
 * These PortOS routes SHADOW the toolkit's own (which decorate the same way);
 * the toolkit keeps its copy so it stays correct standalone. Both decorate on
 * the way out only — the field is never persisted.
 */
export const presentProvider = (provider, capabilities = captureSystemCapabilities()) => {
  const decorated = withProviderHardwareCompatibility(
    withTuiLaunchCommand(withRefreshCapability(provider)),
    capabilities,
  );
  // Derived on read from the raw provider. This is an explicit capability of
  // the maintained public-review recipe, not a client-side guess based on a
  // provider name or a user-writable `args` list.
  // `publicReviewPostures` is the value the schedule UI filters on, so a stage
  // offers exactly the providers this install can actually run it on;
  // `publicReviewEnforcedPostures` is the subset backed by a vendor sandbox
  // recipe. The two booleans are derived from it and kept for existing consumers.
  const publicReviewPostures = publicReviewPosturesForProvider(provider);
  // Narrow `models` to the install's declared entitlement, LAST, so every
  // derivation above still reads the provider's full advertised catalog. The
  // untouched list rides along as `modelCatalog` — the editor seeds its
  // "Available Models" box from it, so an ordinary Save on a scoped provider
  // cannot persist the narrowed list over the real one.
  const scoped = applyModelAccess(decorated);
  const htmlPagesModels = isMtplxOpenCodeCli(provider)
    ? [...new Set([...(scoped.models ?? []), scoped.defaultModel])]
        .filter((model) => htmlPagesProviderCapability(provider, model)?.kind === 'opencode-mtplx')
    : [];
  return sanitizeProvider({
    ...scoped,
    htmlPagesModels,
    // The RAW record's key: an inherited or materialized one rides
    // NON-enumerably (`withGatewayApiKey`, the composite resolver), so the
    // decorating spreads above dropped it — re-carried here so `hasApiKey`
    // reports the key the run would actually use (#7564).
    apiKey: provider?.apiKey,
    executionOptionKeys: executionOptionKeysForHarness(harnessForProvider(provider)?.id),
    // The UNION of the two refresh paths, because the button asks only
    // whether SOME path can serve this record. Which one actually serves it is
    // decided in `POST /:id/refresh-models`, and the two must stay in step or
    // a card offers a button the route refuses.
    canRefreshModels: decorated.canRefreshModels || Boolean(harnessCatalogRuntime(provider)),
    toolFreeOneShot: isToolFreeOneShotProvider(provider),
    // Can run a Music Video frame check: sees an image with no host-writing tool (#15576).
    imageReview: canReviewImages(provider),
    authoringOneShot: isAuthoringOneShotProvider(provider),
    publicReviewPostures,
    publicReviewEnforcedPostures: enforcedPublicReviewPosturesForProvider(provider),
    publicReviewSupported: publicReviewPostures.includes(PUBLIC_REVIEW_NO_TOOL_POSTURE),
    publicReviewActionsSupported: publicReviewPostures.includes(PUBLIC_REVIEW_ACTIONS_POSTURE),
    // Preset structure (#7565): `derived` when the record names the service it
    // is materialized from, else `legacy`; and whether a legacy record is a
    // candidate for "Convert to derived preset": pure over the record, AND not
    // refused by the last reconcile pass — the conversion re-runs that pass, so
    // a record it just left legacy would only fail again (#7565).
    presetKind: presetKind(provider),
    presetDerivable: presetDerivable(provider) && !presetSkipReason(provider?.id),
  });
};
