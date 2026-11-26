import { PRIVATE_CREDENTIALS, putCredential } from '../services/privateKeyStore.js';
import { Router } from 'express';
import { z } from 'zod';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import { getAiAssignments, updateAiAssignment } from '../services/aiAssignments.js';
import { saveSubscriptionCosts } from '../services/subscriptionCosts.js';
import { savePlanTiers } from '../services/subscriptions.js';
import { saveApiBilledInstanceIds } from '../services/usageFleetBilling.js';
import {
  setCodexParallelLimit,
  syncParallelLimits,
  CODEX_PARALLEL_MIN,
  CODEX_PARALLEL_MAX,
  CODEX_PARALLEL_DEFAULT,
} from '../services/mediaJobQueue/index.js';
import { assertMediaRoutingConfig } from '../services/federatedMedia/routingPolicy.js';
import { assertConfiguredEidoverseInstalled, getInstanceFeatures, updateEidoverseWorldsRepo, updateEidoverseWorldsSource, updateInstanceFeature, updateInstanceFeatureGroup } from '../services/instanceFeatures.js';
import { getCredentialInventory } from '../services/credentialInventory.js';
import { installEidoverse } from '../services/eidoverse.js';
import { ensureEidoverseHost } from '../services/eidoverseHost.js';
import { isGitHubRepoUrl } from '../lib/repoUrl.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { isAllowedPython } from '../lib/pythonSetup.js';
import { CLOUD_IMAGE_GEN_MODES, CLOUD_VIDEO_GEN_MODES, HOSTED_MEDIA_BACKENDS, IMAGE_GEN_MODE } from '../lib/generationModes.js';
import { deepMerge, isPlainObject } from '../lib/objects.js';
import { partialWithoutDefaults } from '../lib/zodCompat.js';
import { resolveBackupConfig } from '../lib/backupConfig.js';
import { storableAutoUpdateConfig } from '../lib/sharedSchemas.js';
import { DEFAULT_UNTRUSTED_CONTENT_POLICY, untrustedContentSettingsSchema } from '../lib/untrustedContent.js';
import { skillsSettingsSchema } from '../lib/skillsValidation.js';
import { agentContextSettingsSchema } from '../lib/agent/agentContextValidation.js';
import { EFFORT_LEVELS } from '../lib/provider/providerModels.js';
import { federationSettingsSchema } from '../lib/federatedMediaValidation.js';
import { validateRequest } from '../lib/validateRequest.js';
import { codeReviewSettingsSchema, namedOrchestrationProfileSchema, orchestrationProfilesSettingsSchema } from '../lib/cos/cosValidation.js';
import { imessageConfigSchema, signalConfigSchema, beeperSettingsSchema, beeperSavedScopesSchema, spotifyConfigSchema, youtubeConfigSchema } from '../lib/mediaValidation.js';
import { pipelineEditorialChecksSettingsSchema } from '../lib/pipelineValidation.js';
import { privacySettingsSchema } from '../lib/privacyValidation.js';
import { filmLookSavedPresetsSchema } from '../lib/filmLookValidation.js';
import { dockerContainmentSettingsSchema } from '../lib/dockerContainmentValidation.js';
import { codeAnimationExecutionArmedSchema } from '../lib/codeAnimationContainment.js';
import {
  settingsPutSchema, settingsSlicePatchSchema, autoUpdateSettingsSchema, featureProviderConfigSchema, autofixerSettingsSchema,
  localLlmSettingsSchema, creativeDirectorSettingsSchema, musicSettingsSchema, seriesAutopilotSettingsSchema,
  imageGenGrokSettingsSchema, imageGenAgySettingsSchema, imageGenFalSettingsSchema,
  imageGenRunwaySettingsSchema, imageGenHiggsfieldSettingsSchema, imageGenGoogleSettingsSchema,
  renderDefaultsSettingsSchema, videoGenSettingsSchema
} from '../lib/settingsValidation.js';
import {
  privateCredentialParamsSchema, privateCredentialInputSchemaFor, harnessSettingsSchema,
  credentialBootstrapsSettingsSchema
} from '../lib/providerValidation.js';
import { backupConfigSchema } from '../lib/backupValidation.js';
import { sharingSettingsPatchSchema } from '../lib/sharingValidation.js';
import {
  locationSettingsSchema, hideFirstRunCardSchema, networkSetupPreferenceSchema, settingsEmbeddingsSchema, memoryClassifierSettingsSchema,
  apiAccessSettingsSchema, instanceFeatureSettingsSchema, instanceFeatureIdSchema, instanceFeatureUpdateSchema,
  instanceFeatureGroupSettingsSchema, instanceFeatureGroupIdSchema, instanceFeatureGroupUpdateSchema
} from '../lib/instanceSettingsValidation.js';
import { featurePrioritySettingsSchema } from '../lib/featurePriorityValidation.js';
import { layeredIntelligenceSettingsSchema } from '../lib/appValidation.js';
import { subscriptionCostsMapSchema, subscriptionPlanTiersMapSchema, usageApiBilledInstanceIdsSchema } from '../lib/usageValidation.js';

const router = Router();

const aiAssignmentUpdateSchema = z.object({
  providerId: z.string().trim().max(128).nullable().optional(),
  model: z.string().trim().max(300).nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
}).strict();

const eidoverseRepoSchema = z.object({
  worldsRepoUrl: z.string().trim().max(500).refine(isGitHubRepoUrl, 'Must be a GitHub repository URL'),
  worldsBranch: z.string().trim().max(255).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
}).strict();

// Server-authoritative bounds the client UI can render directly so the form
// clamp never drifts away from what the queue actually enforces. Stitched
// under `imageGen.codex.parallelLimitBounds` since that's where the field
// the bounds describe lives.
const PARALLEL_BOUNDS = Object.freeze({
  min: CODEX_PARALLEL_MIN,
  max: CODEX_PARALLEL_MAX,
  default: CODEX_PARALLEL_DEFAULT,
});
const LOCAL_PARALLEL_BOUNDS = Object.freeze({
  min: 1,
  max: 1,
  default: 1,
  memoryGoverned: true,
  description: 'Local model lanes stay at their memory-governed limit (1 render at a time).',
});

// Backends whose settings slice carries a render-lane parallelLimitBounds
// decoration. imageGen.codex is always decorated (even when absent); the rest
// only when the stored slice exists. `local` uses the memory-governed bounds.
const IMAGE_GEN_BOUNDED_BACKENDS = CLOUD_IMAGE_GEN_MODES.filter(mode => mode !== IMAGE_GEN_MODE.CODEX);

// Backends whose `videoGen.<backend>.apiKey` is write-only (#8997): redacted on
// read and re-injected on write when the incoming slice omits it.
const VIDEO_GEN_API_KEY_BACKENDS = [
  ...HOSTED_MEDIA_BACKENDS.filter(({ video, credentialId }) => video && credentialId).map(({ id }) => id),
  'topaz',
];

const withParallelBounds = (parent, backends) => {
  const out = { ...parent };
  for (const backend of backends) {
    if (parent?.[backend]) out[backend] = { ...parent[backend], parallelLimitBounds: PARALLEL_BOUNDS };
  }
  if (parent?.local) out.local = { ...parent.local, parallelLimitBounds: LOCAL_PARALLEL_BOUNDS };
  return out;
};

const decorateBounds = (settings) => ({
  ...settings,
  untrustedContent: { scopeAdherenceEnabled: settings.untrustedContent?.scopeAdherenceEnabled !== false, defaults: { ...DEFAULT_UNTRUSTED_CONTENT_POLICY, ...settings.untrustedContent?.defaults }, sources: settings.untrustedContent?.sources || {} },
  imageGen: {
    ...withParallelBounds(settings.imageGen, IMAGE_GEN_BOUNDED_BACKENDS),
    codex: {
      ...(settings.imageGen?.codex || {}),
      parallelLimitBounds: PARALLEL_BOUNDS,
    },
  },
  ...(settings.videoGen ? { videoGen: withParallelBounds(settings.videoGen, CLOUD_VIDEO_GEN_MODES) } : {}),
});

// Third-party API tokens that live OUTSIDE the `secrets.*` hierarchy but must
// never be echoed to the client (#1821). The Settings UI reads only their
// *presence* from dedicated status routes (`GET /api/image-gen/setup/hf-token-
// status`, `GET /api/loras/auth/civitai` → `hasKey`), never the raw value here,
// so stripping them is non-breaking. Sibling fields under each parent are
// preserved; arrays are left untouched (a legacy/malformed `civitai: ['x']`
// must not be spread into `{ '0': 'x' }`).
const redactExternalTokens = (settings) => {
  const next = { ...settings };
  if (isPlainObject(next.imageGen)) {
    const { hfToken, ...rest } = next.imageGen;
    next.imageGen = rest;
  }
  if (isPlainObject(next.civitai)) {
    const { apiKey, ...rest } = next.civitai;
    next.civitai = rest;
  }
  // Beeper access token (#30/#31) — write-only, same posture as
  // imageGen.hfToken / civitai.apiKey above. Since #31 the live credential is
  // AES-256-GCM in `beeper_credentials`, not here; this strip covers the LEGACY
  // plaintext field, which `beeperCredentials.resolveBeeperToken` still reads as
  // a fallback for an install that hand-edited one. Nothing writes it, and it
  // must never be echoed back to the client on a settings GET.
  if (isPlainObject(next.beeper)) {
    const { token, ...rest } = next.beeper;
    next.beeper = rest;
  }
  // fal.ai / reactor.inc video keys (#8997) — same write-only posture, but
  // nested one level deeper (`videoGen.fal.apiKey` / `videoGen.reactor.apiKey`),
  // since `hydratePrivateKeys` re-injects them into `settings.videoGen` on
  // every read (privateKeyStore.js). The Settings UI reads only presence, via
  // GET /api/settings/credentials.
  if (isPlainObject(next.videoGen)) {
    const videoGen = { ...next.videoGen };
    for (const backend of VIDEO_GEN_API_KEY_BACKENDS) {
      if (isPlainObject(videoGen[backend])) {
        const { apiKey, ...rest } = videoGen[backend];
        videoGen[backend] = rest;
      }
    }
    next.videoGen = videoGen;
  }
  return next;
};

// Sub-keys this route must never clobber, because it isn't their write path.
// `updateSettings` shallow-merges TOP-LEVEL keys, so an incoming `imageGen` /
// `civitai` / `videoGen` object replaces the stored one wholesale — and a
// client that GETs settings, rebuilds the parent and PUTs it back (e.g.
// `patchSettingsSlice('imageGen.local', …)`) would drop any sub-key it never
// saw or never rendered. A parent absent from the patch needs nothing — the
// top-level merge keeps the stored object untouched.
//
//   - imageGen.hfToken / civitai.apiKey: write-only tokens, redacted out of
//     GET, owned by /setup/hf-token and /loras/auth/civitai. Re-injected only
//     when the incoming parent omits them, so those routes can still write.
const preserveExternallyOwnedKeys = (next, current) => {
  const carryOver = (parentKey, childKey) => {
    const incoming = next[parentKey];
    const stored = current?.[parentKey]?.[childKey];
    if (!isPlainObject(incoming) || childKey in incoming || stored === undefined) return;
    next[parentKey] = { ...incoming, [childKey]: stored };
  };
  // Same carryOver contract, one level deeper — for `videoGen.fal.apiKey` /
  // `videoGen.reactor.apiKey` (#8997), which live under a grandchild key
  // rather than a direct child of the top-level slice.
  const carryOverNested = (parentKey, childKey, grandchildKey) => {
    const incomingParent = next[parentKey];
    if (!isPlainObject(incomingParent)) return;
    const incoming = incomingParent[childKey];
    const stored = current?.[parentKey]?.[childKey]?.[grandchildKey];
    if (!isPlainObject(incoming) || grandchildKey in incoming) return;
    if (stored === undefined) return;
    next[parentKey] = { ...incomingParent, [childKey]: { ...incoming, [grandchildKey]: stored } };
  };
  carryOver('imageGen', 'hfToken');
  carryOver('civitai', 'apiKey');
  for (const backend of VIDEO_GEN_API_KEY_BACKENDS) carryOverNested('videoGen', backend, 'apiKey');
  // beeperSettingsSchema is `.strict()` with no `token`/`tokenExpiresAt`
  // field, so a valid `beeper` PUT through this route can never carry either
  // — without this, the generic top-level shallow merge (`{ ...current,
  // ...settingsPatch }`) would REPLACE `current.beeper` wholesale and silently
  // wipe out a legacy hand-edited token that `resolveBeeperToken` still falls
  // back to (#31's own credential lives in Postgres, out of reach of this
  // route entirely).
  carryOver('beeper', 'token');
  carryOver('beeper', 'tokenExpiresAt');
  return next;
};

// `federation` is the one top-level slice with more than one owning surface:
// Settings → Sharing writes `mediaProvider` and `strictPullAuthorization`, while
// Instances → Unattended render routing writes `mediaRouting`. The generic
// top-level shallow merge replaces the slice wholesale, so whichever PUT lands
// second silently reverts the other surface's freshly saved sub-key (#4703).
// Merging per sub-key here removes that class instead of narrowing it — and
// because `updateSettingsWith` runs inside the settings write queue, `current`
// is always the freshest persisted snapshot, not the one the client read.
//
// A SHALLOW per-sub-key merge is deliberately enough: every sub-key today has
// exactly one owning surface, so an incoming sub-key is a complete value for it.
// "Absent vs present-but-empty" falls straight out of the spread — an omitted
// sub-key keeps the stored value, while one sent as `{}` or `null` applies the
// clear the user actually asked for. A FUTURE sub-key written by two surfaces
// would need its own deeper merge added here.
const mergeFederationSlice = (next, current) => {
  if (!isPlainObject(next.federation) || !isPlainObject(current?.federation)) return next;
  next.federation = { ...current.federation, ...next.federation };
  return next;
};

// The backup slice is stored sparsely, so every response projects the EFFECTIVE
// schedule (`server/lib/backupConfig.js`) over the stored values. Without this the
// Settings screen had to guess what an omitted `enabled`/`cronExpression` meant,
// guessed the opposite of the scheduler, and then saved its guess back — silently
// cancelling a destination-only install's nightly backup (#6632). The stored keys
// stay sparse on disk; only the transport carries the resolved view.
const projectEffectiveBackup = (safe) => {
  const effective = resolveBackupConfig(safe.backup);
  return {
    ...safe,
    backup: {
      ...safe.backup,
      destPath: effective.destPath,
      enabled: effective.enabled,
      cronExpression: effective.cronExpression,
      retentionCount: effective.retentionCount
    }
  };
};

// Same reasoning for the auto-update slice: an install that only ticked the
// checkbox stores `{ enabled: true }`, and the Update tab would otherwise have to
// re-derive what an omitted channel/interval means — the mistake #6632 made for
// the backup schedule. The resolver is the scheduler's own.
const projectEffectiveAutoUpdate = (safe) => ({
  ...safe,
  autoUpdate: { ...safe.autoUpdate, ...storableAutoUpdateConfig(safe.autoUpdate) },
});

// Single sanitizer every settings response (GET load + PUT save) runs through,
// so a leak can't reappear on one path after being closed on the other: strip
// the top-level `secrets` hierarchy, redact external tokens (#1821), decorate
// server-authoritative bounds, then resolve the sparse backup schedule.
const sanitizeSettingsForResponse = (settings) => {
  const { secrets, ...safe } = settings;
  return projectEffectiveAutoUpdate(projectEffectiveBackup(decorateBounds(redactExternalTokens(safe))));
};

// GET /api/settings
router.get('/', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  res.json(sanitizeSettingsForResponse(settings));
}));

// GET /api/settings/media-share-candidates
// The local image/video models this instance COULD share as a federated media
// provider, so the Sharing tab can offer them. The peer-facing status endpoint
// can't answer this: it only ever describes already-allowlisted models, which
// is the chicken-and-egg that left imageModels/videoModels unconfigurable.
// Deliberately local-only (this is unshared local model inventory, which no
// peer should read) — it lives here, behind the normal /api/* auth gate,
// rather than on /api/federation/media/v1.
router.get('/media-share-candidates', asyncHandler(async (_req, res) => {
  const { listLocalMediaShareCandidates } = await import('../services/federatedMediaProvider.js');
  res.json(await listLocalMediaShareCandidates());
}));

// GET /api/settings/ai-assignments
router.get('/ai-assignments', asyncHandler(async (_req, res) => {
  res.json(await getAiAssignments());
}));

// GET /api/settings/features
router.get('/features', asyncHandler(async (_req, res) => {
  res.json(await getInstanceFeatures());
}));

// GET /api/settings/credentials
// Presence + source only. Supported integrations have a separate write-only setter.
router.get('/credentials', asyncHandler(async (_req, res) => {
  res.json(await getCredentialInventory());
}));

// Write-only, allowlisted integration credentials; no generic secrets access.
router.put('/credentials/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privateCredentialParamsSchema, req.params);
  const { value } = validateRequest(privateCredentialInputSchemaFor(id), req.body);
  const entry = PRIVATE_CREDENTIALS.find(item => item.id === id);
  await updateSettingsWith(current => {
    putCredential(current, entry, value);
    return current;
  });
  const inventory = await getCredentialInventory();
  res.json(inventory.credentials.find(item => item.id === id));
}));

// POST /api/settings/features/eidoverse/install
// Explicit consent boundary: no Eidoverse checkout or dependency install occurs
// until the user presses Install in Settings > Features.
router.post('/features/eidoverse/install', asyncHandler(async (req, res) => {
  const { worldsRepoUrl, worldsBranch } = validateRequest(eidoverseRepoSchema, req.body || {});
  const normalizedRepoUrl = await updateEidoverseWorldsRepo(worldsRepoUrl, worldsBranch);
  await installEidoverse({ worldsRepoUrl: normalizedRepoUrl, ...(worldsBranch !== undefined ? { worldsBranch } : {}) });
  res.status(201).json(await updateInstanceFeature('eidoverse', true));
}));

// PUT /api/settings/features/eidoverse/source
// Update the origin and optional runtime branch in place. Branch switches
// require a clean checkout; future app updates honor the selected branch.
router.put('/features/eidoverse/source', asyncHandler(async (req, res) => {
  const { worldsRepoUrl, worldsBranch } = validateRequest(eidoverseRepoSchema, req.body || {});
  await updateEidoverseWorldsSource(worldsRepoUrl, worldsBranch);
  res.json(await getInstanceFeatures());
}));

// POST /api/settings/features/eidoverse/host
// Lazily opens PortOS's TLS/WebSocket bridge. The external runtime stays a
// separately managed app; this listener only makes its existing web UI safe to
// embed when PortOS itself was opened over HTTPS.
router.post('/features/eidoverse/host', asyncHandler(async (_req, res) => {
  await assertConfiguredEidoverseInstalled();
  res.json(await ensureEidoverseHost());
}));

// The Beeper sweep scheduler and its realtime transport arm on the instance
// feature plus a stored token, and that gate used to be read at boot only — so
// turning the feature on left realtime down and no sweep registered until the
// next restart (fork issue #1, final live pass). Reconciling here closes that
// half; the credential paths close the other. Beeper sits in the `comms` group,
// so the group toggle moves the same gate — and so does the general settings
// PUT below, when it flips the user's own `settings.beeper.enabled` sync
// toggle: that save used to persist silently and never reach
// `startBeeperScheduler()` until a restart.
//
// Imported lazily inside the handler: a feature toggle is a rare path, and the
// arming module reaches the whole Beeper service graph (`ws` included), which
// has no business loading with every settings request.
const BEEPER_FEATURE_GROUP = 'comms';
async function reconcileBeeperArming(reason, options = {}) {
  const { reconcileBeeperIngestion } = await import('../services/beeper/beeperArming.js');
  // The flag is already persisted, so a reconcile failure must not turn a saved
  // toggle into a 500.
  await reconcileBeeperIngestion({ reason, ...options })
    .catch((err) => console.error(`❌ Beeper ingestion reconcile (${reason}) failed: ${err.message}`));
}

// The iTerm2 bridge connects only while its feature is on (#8114): turning it
// off must drop the connection now, and turning it on must serve an already-
// open iTerm2 view without a restart. Same persisted-flag rule as above.
async function reconcileItermOnToggle() {
  const { reconcileItermBridge } = await import('../services/itermBridge.js');
  await reconcileItermBridge({ reason: 'feature-toggle' })
    .catch((err) => console.error(`❌ iTerm2 bridge reconcile (feature-toggle) failed: ${err.message}`));
}

// Docker containment owns a shared egress network and per-run containers,
// networks and volumes (#12844): turning it on verifies the engine and sweeps
// orphans, turning it off cancels live runs and removes everything — now, not
// at the next restart. Same persisted-flag rule as above.
async function reconcileDockerContainmentOnToggle(result) {
  const enabled = result.features.find((feature) => feature.id === 'docker-containment')?.enabled === true;
  const { reconcileDockerContainment } = await import('../services/dockerContainment.js');
  await reconcileDockerContainment({ enabled, reason: 'feature-toggle' })
    .catch((err) => console.error(`❌ Docker containment reconcile (feature-toggle) failed: ${err.message}`));
}

// An interval-only Beeper save (no `enabled` flip) used to take effect only
// at the next process restart: the registered event's `intervalMs` is read
// once, at `schedule()` time (`createSettingsGatedSyncScheduler.js`), and
// `startBeeperScheduler()` deliberately no-ops once `beeper-sync` is already
// registered (fork issue #79). `restartBeeperScheduler()` is the fix — cancel
// and register fresh, which reads `getBeeperSyncConfig()` again and picks up
// whatever interval was just persisted. Lazily imported for the same reason
// `reconcileBeeperArming` above is: this is a rare save, and the scheduler
// module reaches the whole Beeper service graph.
async function restartBeeperSchedulerForIntervalChange(reason) {
  const { restartBeeperScheduler } = await import('../services/beeper/beeperScheduler.js');
  await restartBeeperScheduler()
    .catch((err) => console.error(`❌ Beeper scheduler restart (${reason}) failed: ${err.message}`));
}

// PUT /api/settings/features/:featureId
// `enabled` is nullable: null clears a grouped feature's override back to
// "inherit" (see instanceFeatureUpdateSchema and updateInstanceFeature).
router.put('/features/:featureId', asyncHandler(async (req, res) => {
  const featureId = validateRequest(instanceFeatureIdSchema, req.params.featureId);
  const { enabled } = validateRequest(instanceFeatureUpdateSchema, req.body || {});
  const result = await updateInstanceFeature(featureId, enabled);
  if (featureId === 'beeper') await reconcileBeeperArming('feature-toggle');
  if (featureId === 'iterm') await reconcileItermOnToggle();
  if (featureId === 'docker-containment') await reconcileDockerContainmentOnToggle(result);
  res.json(result);
}));

// PUT /api/settings/features/groups/:groupId (#40)
router.put('/features/groups/:groupId', asyncHandler(async (req, res) => {
  const groupId = validateRequest(instanceFeatureGroupIdSchema, req.params.groupId);
  const { enabled } = validateRequest(instanceFeatureGroupUpdateSchema, req.body || {});
  const result = await updateInstanceFeatureGroup(groupId, enabled);
  if (groupId === BEEPER_FEATURE_GROUP) await reconcileBeeperArming('feature-group-toggle');
  res.json(result);
}));

// PUT /api/settings/ai-assignments/:id
router.put('/ai-assignments/:id', asyncHandler(async (req, res) => {
  const payload = validateRequest(aiAssignmentUpdateSchema, req.body || {});
  res.json(await updateAiAssignment(req.params.id, payload));
}));

// GET /api/settings/orchestration-profiles
router.get('/orchestration-profiles', asyncHandler(async (_req, res) => {
  const { getOrchestrationProfiles } = await import('../services/orchestrationProfiles.js');
  res.json(await getOrchestrationProfiles());
}));

// POST /api/settings/orchestration-profiles
router.post('/orchestration-profiles', asyncHandler(async (req, res) => {
  const { saveOrchestrationProfile } = await import('../services/orchestrationProfiles.js');
  const payload = validateRequest(namedOrchestrationProfileSchema, req.body || {});
  const saved = await saveOrchestrationProfile(payload);
  res.status(201).json(saved);
}));

// PUT /api/settings/orchestration-profiles/:id
router.put('/orchestration-profiles/:id', asyncHandler(async (req, res) => {
  const { updateOrchestrationProfile } = await import('../services/orchestrationProfiles.js');
  const payload = validateRequest(namedOrchestrationProfileSchema.partial(), req.body || {});
  const updated = await updateOrchestrationProfile(req.params.id, payload);
  res.json(updated);
}));

// DELETE /api/settings/orchestration-profiles/:id
router.delete('/orchestration-profiles/:id', asyncHandler(async (req, res) => {
  const { deleteOrchestrationProfile } = await import('../services/orchestrationProfiles.js');
  const result = await deleteOrchestrationProfile(req.params.id);
  res.json(result);
}));

// Declarative slice → schema table. Each slice is validated only when present
// (`!== undefined`), so null/false/'' payloads are checked like any other value.
// Dotted paths reach nested slices (the imageGen parent stays polymorphic; only
// its per-backend sub-slices have schemas). Federation routing and the local
// Python path also need checks beyond their schemas.
const SETTINGS_SLICE_VALIDATORS = [
  ['orchestrationProfiles', orchestrationProfilesSettingsSchema],
  ['filmLookPresets', filmLookSavedPresetsSchema],
  ['untrustedContent', untrustedContentSettingsSchema],
  ['skills', skillsSettingsSchema],
  ['harnesses', harnessSettingsSchema],
  ['credentialBootstraps', credentialBootstrapsSettingsSchema],
  ['backup', partialWithoutDefaults(backupConfigSchema)],
  ['autoUpdate', autoUpdateSettingsSchema],
  ['autofixer', autofixerSettingsSchema.partial()],
  ['calendarSync', featureProviderConfigSchema.partial()],
  ['codeReview', codeReviewSettingsSchema.partial()],
  ['creativeDirector', creativeDirectorSettingsSchema.partial()],
  ['music', musicSettingsSchema.partial()],
  ['location', locationSettingsSchema],
  ['networkSetupPreference', networkSetupPreferenceSchema],
  ['hideFirstRunCard', hideFirstRunCardSchema],
  ['embeddings', settingsEmbeddingsSchema.partial()],
  ['memoryClassifier', memoryClassifierSettingsSchema],
  ['localLlm', localLlmSettingsSchema],
  ['imessage', imessageConfigSchema.partial()],
  ['signal', signalConfigSchema.partial()],
  ['beeperSavedScopes', beeperSavedScopesSchema],
  ['beeper', beeperSettingsSchema],
  ['spotify', spotifyConfigSchema.partial()],
  ['youtube', youtubeConfigSchema.partial()],
  ['apiAccess', apiAccessSettingsSchema.partial()],
  ['dockerContainment', dockerContainmentSettingsSchema],
  ['codeAnimationExecutionArmed', codeAnimationExecutionArmedSchema.nullable()],
  ['instanceFeatures', instanceFeatureSettingsSchema],
  ['instanceFeatureGroups', instanceFeatureGroupSettingsSchema],
  ['featurePriorities', featurePrioritySettingsSchema],
  ['agentContext', agentContextSettingsSchema],
  ['pipelineEditorialChecks', pipelineEditorialChecksSettingsSchema.partial()],
  ['privacy', privacySettingsSchema.partial()],
  ['seriesAutopilot', seriesAutopilotSettingsSchema.partial()],
  ['imageGen.grok', imageGenGrokSettingsSchema.partial()],
  ['imageGen.agy', imageGenAgySettingsSchema.partial()],
  ['imageGen.runway', imageGenRunwaySettingsSchema.partial()],
  ['imageGen.fal', imageGenFalSettingsSchema.partial()],
  ['imageGen.higgsfield', imageGenHiggsfieldSettingsSchema.partial()],
  ['imageGen.google', imageGenGoogleSettingsSchema.partial()],
  ['renderDefaults', renderDefaultsSettingsSchema],
  ['videoGen', videoGenSettingsSchema],
  ['layeredIntelligence', layeredIntelligenceSettingsSchema.partial()],
  ['subscriptionCosts', subscriptionCostsMapSchema],
  ['subscriptionPlanTiers', subscriptionPlanTiersMapSchema],
  ['usageApiBilledInstanceIds', usageApiBilledInstanceIdsSchema],
  ['sharingDisplayName', sharingSettingsPatchSchema.shape.sharingDisplayName],
  ['sharingBio', sharingSettingsPatchSchema.shape.sharingBio],
  ['federation', federationSettingsSchema],
];

// Overlay parsed fields on the submitted slice to preserve forward-compatible
// fields, including nested fields stripped by Zod's default object policy.
const parseSettingsPatch = async (body) => {
  const patch = { ...body };
  for (const [path, schema] of SETTINGS_SLICE_VALIDATORS) {
    const [root, child] = path.split('.');
    const slice = child ? patch[root]?.[child] : patch[root];
    if (slice === undefined) continue;
    const parsed = validateRequest(schema, slice);
    const normalized = isPlainObject(parsed) ? deepMerge(slice, parsed) : parsed;
    patch[root] = child ? { ...patch[root], [child]: normalized } : normalized;
  }
  if (patch.federation !== undefined) {
    // The schema only proves a route is well-SHAPED. A route naming a peer that
    // is unknown, switched off, not a media provider, not allowlisted for that
    // model, or outside the tailnet is well-shaped and permanently unusable —
    // and unattended work has no human at the moment it fails, so it would just
    // break every future Creative Director / Commission render in silence.
    // Refuse it here, where there IS a human. See routingPolicy.js.
    await assertMediaRoutingConfig(patch.federation.mediaRouting);
  }
  // Every local media lane spawns this interpreter (and image gen spawns the
  // `mflux-generate` beside it), so hold it to the guard the setup routes use:
  // a python basename, never an arbitrary binary (#8751). A cleared value
  // (`''`/`null`) falls back to interpreter discovery, so it stays allowed.
  const localPython = patch.imageGen?.local?.pythonPath;
  if (localPython != null && localPython !== '' && !isAllowedPython(localPython)) {
    throw new ServerError('imageGen.local.pythonPath must be a python interpreter (basename python/python3/python3.NN)', {
      status: 400, code: 'INVALID_PYTHON_PATH',
    });
  }
  return patch;
};

const saveSettingsPatch = async (body, slicePatch) => {
  // User-defined catalog types moved out of settings.json into PostgreSQL
  // (`catalog_user_types`, #1001). The `/api/catalog/types` routes are the only
  // write path; a `catalogUserTypes` key in a PUT /api/settings body (legacy
  // client, restore bundle) is stripped below alongside `secrets` so it can't
  // write a dead, unread slice back into settings.json (which the boot import
  // would then re-import and rename aside on the next restart, churning state).
  // Strip `secrets` from the incoming PUT body so an authenticated session
  // (or stolen cookie) can't disable the auth gate or clobber other secrets
  // by sending `{ "secrets": { ... } }` directly to /api/settings — that
  // would bypass the current-password proof the /api/auth/password routes
  // require. Secrets are write-only through their dedicated routes
  // (/api/auth/password, /api/github/secrets, etc.).
  // subscriptionCosts, subscriptionPlanTiers and usageApiBilledInstanceIds are
  // excluded from the generic shallow spread below and routed through their
  // dedicated savers — the same merge PUT /api/usage/subscriptions and PUT
  // /api/usage/fleet-billing use — so a restore dump cannot persist an
  // unvalidated slice, and a shallow `{ ...current, ...settingsPatch }` cannot
  // replace a map by dropping keys the incoming patch did not mention.
  const {
    secrets: _ignoredSecrets,
    passwordRiskRevision: _ignoredPasswordRiskRevision,
    catalogUserTypes: _ignoredTypes,
    // Retired with the native usage account editor (#15272): a restore dump or
    // legacy client must not write the dead slice back.
    usageNativeAccountSelections: _ignoredNativeAccountSelections,
    subscriptionCosts: subscriptionCostsPatch,
    subscriptionPlanTiers: subscriptionPlanTiersPatch,
    usageApiBilledInstanceIds: apiBilledPatch,
    ...initialSettingsPatch
  } = body || {};
  // updateSettingsWith (not updateSettings) so the multi-owner `federation`
  // slice merges per sub-key and persisted write-only tokens the incoming patch
  // omits get re-injected — both against the freshest snapshot inside the write
  // queue (see mergeFederationSlice / preserveExternallyOwnedKeys).
  // `actor: 'user'` is what separates a save made HERE — a human on the Settings
  // page — from every other `save()` caller (schedulers, sync hooks, feature
  // writes), which keep the `'system'` default in the operator-action ledger (#5594).
  let settingsPatch = initialSettingsPatch;
  let previousBeeperEnabled;
  let previousBeeperIntervalMinutes;
  let previousBeeperConnection;
  let previousBeeperGates;
  let merged = await updateSettingsWith(async (current) => {
    // Read inside the queue, against the freshest persisted snapshot (same
    // reasoning as `mergeFederationSlice` above) — a stale pre-image here could
    // read a no-op as a flip, or a real flip as a no-op.
    if (slicePatch) {
      const { slicePath, partial } = slicePatch;
      const [root, child] = slicePath.split('.');
      const parent = isPlainObject(current[root]) ? current[root] : {};
      const existing = child ? parent[child] : current[root];
      // Shallow merge at exactly the selected slice: objects/arrays/null supplied
      // as values replace that key, including explicit clearing.
      const updated = { ...(isPlainObject(existing) ? existing : {}), ...partial };
      settingsPatch = { [root]: child ? { ...parent, [child]: updated } : updated };
      // The request partial is already normalized. Recheck the merged slice
      // against the shared contracts without rewriting stored, omitted fields.
      await parseSettingsPatch(settingsPatch);
    }
    previousBeeperEnabled = current?.beeper?.enabled === true;
    previousBeeperIntervalMinutes = current?.beeper?.intervalMinutes;
    previousBeeperConnection = JSON.stringify([current?.beeper?.baseUrl, current?.beeper?.allowNonLoopbackBaseUrl]);
    previousBeeperGates = JSON.stringify([current?.instanceFeatures?.beeper, current?.instanceFeatureGroups?.comms]);
    // Provider picker and promotion controls save independent keys in this
    // slice. Merge while holding the settings write queue to retain both.
    const next = { ...current, ...settingsPatch };
    if (settingsPatch.autofixer !== undefined) {
      next.autofixer = { ...current.autofixer, ...settingsPatch.autofixer };
    }
    return preserveExternallyOwnedKeys(
      mergeFederationSlice(next, current),
      current,
    );
  }, { actor: 'user' });
  if (settingsPatch.instanceFeatures?.eidoverse !== undefined) {
    const { reconcileEidoverseRuntime } = await import('../services/eidoverseRuntime.js');
    await reconcileEidoverseRuntime()
      .catch((err) => console.error(`⚠️ Eidoverse startup deferred: ${err.message}`));
  }
  // A beeper save that flips `enabled` never armed the scheduler until a
  // restart. `startBeeperScheduler()` is the only thing that registers the
  // sweep, and it's reached exclusively through `reconcileBeeperArming` —
  // which the feature and comms-group toggles call, but this generic PUT path
  // never did. `undefined` counts as `false` on both sides, matching how
  // `getBeeperSyncConfig()` reads the stored flag, so an install that has
  // never touched the Beeper card doesn't read as a flip. Fires AFTER the
  // write above so the reconcile (and the scheduler's own re-read) see the
  // value that was actually persisted, not the request body.
  const nextBeeperEnabled = merged?.beeper?.enabled === true;
  const beeperIntervalChanged = merged?.beeper?.intervalMinutes !== previousBeeperIntervalMinutes;
  if (nextBeeperEnabled !== previousBeeperEnabled) {
    // Fork issue #94: the flip branch does NOT always get a fresh
    // registration. `reconcileBeeperArming` only registers the scheduler when
    // it is not already registered (fork issue #79's re-registration guard in
    // beeperArming.js), and a true→false save deliberately leaves the
    // scheduler registered — it just gates per tick (see the true→false test
    // beside this route's other Beeper tests) — so a false→true flip right
    // after finds it already registered and the reconcile below is a no-op
    // for the scheduler. Capture that "already registered" state BEFORE
    // reconciling: if this save also changed the interval, the still-
    // registered event is holding the stale `intervalMs`
    // `createSettingsGatedSyncScheduler.js` locked in at `schedule()` time, so
    // restart explicitly to pick up what was just persisted.
    const { isBeeperSchedulerRegistered } = await import('../services/beeper/beeperScheduler.js');
    const wasSchedulerRegisteredBeforeReconcile = isBeeperSchedulerRegistered();
    await reconcileBeeperArming('sync-toggle');
    if (nextBeeperEnabled && beeperIntervalChanged && wasSchedulerRegisteredBeforeReconcile) {
      await restartBeeperSchedulerForIntervalChange('sync-toggle-interval-change');
    }
  } else if (beeperIntervalChanged) {
    // Fork issue #79: an interval-only change (no `enabled` flip) still has to
    // take effect without a restart.
    await restartBeeperSchedulerForIntervalChange('interval-change');
  }
  const beeperConnectionChanged = JSON.stringify([merged?.beeper?.baseUrl, merged?.beeper?.allowNonLoopbackBaseUrl]) !== previousBeeperConnection;
  const beeperGatesChanged = JSON.stringify([merged?.instanceFeatures?.beeper, merged?.instanceFeatureGroups?.comms]) !== previousBeeperGates;
  if (beeperConnectionChanged || beeperGatesChanged) {
    await reconcileBeeperArming('connection-settings', { restartSocket: beeperConnectionChanged });
  }
  if (subscriptionCostsPatch !== undefined) {
    const costs = await saveSubscriptionCosts(subscriptionCostsPatch, { actor: 'user' });
    merged = { ...merged, subscriptionCosts: costs };
  }
  if (subscriptionPlanTiersPatch !== undefined) {
    const tiers = await savePlanTiers(subscriptionPlanTiersPatch, { actor: 'user' });
    merged = { ...merged, subscriptionPlanTiers: tiers };
  }
  if (apiBilledPatch !== undefined) {
    const ids = await saveApiBilledInstanceIds(apiBilledPatch, { actor: 'user' });
    merged = { ...merged, usageApiBilledInstanceIds: ids };
  }
  // The queue caches parallel limits in-process; sync them from the
  // merged value so a save takes effect without a restart and without
  // re-reading the file.
  syncParallelLimits(merged);
  setCodexParallelLimit(merged.imageGen?.codex?.parallelLimit ?? CODEX_PARALLEL_DEFAULT);
  // Series Autopilot crons re-register themselves off settings.js's
  // `settings:updated` event (see seriesAutopilotScheduler.js) — the save above
  // already emitted it — so an added/removed/edited schedule takes effect
  // immediately without a restart, and this route stays decoupled from the
  // autopilot pipeline graph.
  if (settingsPatch.untrustedContent !== undefined) {
    const { clearPendingMergeAssessmentHolds } = await import('../services/prWatcher.js');
    await clearPendingMergeAssessmentHolds()
      .catch((err) => console.error(`❌ Could not re-arm pending-merge assessments after a policy save: ${err.message}`));
  }
  return sanitizeSettingsForResponse(merged);
};

// PUT remains a top-level replacement contract for whole-form and older callers.
router.put('/', asyncHandler(async (req, res) => {
  const patch = await parseSettingsPatch(validateRequest(settingsPutSchema, req.body));
  res.json(await saveSettingsPatch(patch));
}));

router.patch('/slice', asyncHandler(async (req, res) => {
  const patch = validateRequest(settingsSlicePatchSchema, req.body);
  res.json(await saveSettingsPatch({}, patch));
}));

export default router;
