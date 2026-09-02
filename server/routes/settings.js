import { Router } from 'express';
import { z } from 'zod';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import { getAiAssignments, updateAiAssignment } from '../services/aiAssignments.js';
import { saveSubscriptionCosts } from '../services/subscriptionCosts.js';
import { saveApiBilledInstanceIds } from '../services/usageFleetBilling.js';
import {
  setCodexParallelLimit,
  CODEX_PARALLEL_MIN,
  CODEX_PARALLEL_MAX,
  CODEX_PARALLEL_DEFAULT,
} from '../services/mediaJobQueue/index.js';
import { assertMediaRoutingConfig } from '../services/federatedMedia/routingPolicy.js';
import { assertConfiguredEidoverseInstalled, getInstanceFeatures, updateEidoverseWorldsRepo, updateEidoverseWorldsSource, updateInstanceFeature } from '../services/instanceFeatures.js';
import { installEidoverse } from '../services/eidoverse.js';
import { ensureEidoverseHost } from '../services/eidoverseHost.js';
import { isGitHubRepoUrl } from '../lib/repoUrl.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { isPlainObject } from '../lib/objects.js';
import { agentContextSettingsSchema } from '../lib/agentContextValidation.js';
import { EFFORT_LEVELS } from '../lib/providerModels.js';
import { backupConfigSchema, sharingSettingsPatchSchema, featureProviderConfigSchema, autofixerSettingsSchema, codeReviewSettingsSchema, locationSettingsSchema, settingsEmbeddingsSchema, localLlmSettingsSchema, openWorldSnapshotConfigSchema, imessageConfigSchema, signalConfigSchema, spotifyConfigSchema, youtubeConfigSchema, apiAccessSettingsSchema, instanceFeatureSettingsSchema, instanceFeatureIdSchema, instanceFeatureUpdateSchema, loraTrainingConfigSchema, pipelineEditorialChecksSettingsSchema, creativeDirectorSettingsSchema, musicSettingsSchema, federationSettingsSchema, privacySettingsSchema, seriesAutopilotSettingsSchema, layeredIntelligenceSettingsSchema, imageGenGrokSettingsSchema, imageGenAgySettingsSchema, renderDefaultsSettingsSchema, videoGenSettingsSchema, subscriptionCostsMapSchema, usageApiBilledInstanceIdsSchema, validateRequest } from '../lib/validation.js';

const router = Router();

const aiAssignmentUpdateSchema = z.object({
  providerId: z.string().trim().max(128).nullable().optional(),
  model: z.string().trim().max(300).nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
}).strict();

const eidoverseRepoSchema = z.object({
  worldsRepoUrl: z.string().trim().max(500).refine(isGitHubRepoUrl, 'Must be a GitHub repository URL'),
}).strict();

// Server-authoritative bounds the client UI can render directly so the form
// clamp never drifts away from what the queue actually enforces. Stitched
// under `imageGen.codex.parallelLimitBounds` since that's where the field
// the bounds describe lives.
const decorateBounds = (settings) => ({
  ...settings,
  imageGen: {
    ...(settings.imageGen || {}),
    codex: {
      ...(settings.imageGen?.codex || {}),
      parallelLimitBounds: {
        min: CODEX_PARALLEL_MIN,
        max: CODEX_PARALLEL_MAX,
        default: CODEX_PARALLEL_DEFAULT,
      },
    },
  },
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
//   - videoGen.acceptedModelTerms: the install's restricted-model license
//     acknowledgements, owned exclusively by /api/video-gen/model-terms — which
//     is where an id is checked against a model that actually declares it. The
//     stored value ALWAYS wins here, so a settings save can neither drop an
//     acknowledgement (silently 403ing every gated render) nor mint one that
//     no model's terms gate would ever match.
const preserveExternallyOwnedKeys = (next, current) => {
  const carryOver = (parentKey, childKey, { alwaysStored = false } = {}) => {
    const incoming = next[parentKey];
    const stored = current?.[parentKey]?.[childKey];
    if (!isPlainObject(incoming)) return;
    if (!alwaysStored && childKey in incoming) return;
    if (stored === undefined) {
      if (alwaysStored && childKey in incoming) {
        const { [childKey]: _dropped, ...rest } = incoming;
        next[parentKey] = rest;
      }
      return;
    }
    next[parentKey] = { ...incoming, [childKey]: stored };
  };
  carryOver('imageGen', 'hfToken');
  carryOver('civitai', 'apiKey');
  carryOver('videoGen', 'acceptedModelTerms', { alwaysStored: true });
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

// Single sanitizer every settings response (GET load + PUT save) runs through,
// so a leak can't reappear on one path after being closed on the other: strip
// the top-level `secrets` hierarchy, redact external tokens (#1821), then
// decorate server-authoritative bounds.
const sanitizeSettingsForResponse = (settings) => {
  const { secrets, ...safe } = settings;
  return decorateBounds(redactExternalTokens(safe));
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

// POST /api/settings/features/eidoverse/install
// Explicit consent boundary: no Eidoverse checkout or dependency install occurs
// until the user presses Install in Settings > Features.
router.post('/features/eidoverse/install', asyncHandler(async (req, res) => {
  const { worldsRepoUrl } = validateRequest(eidoverseRepoSchema, req.body || {});
  const normalizedRepoUrl = await updateEidoverseWorldsRepo(worldsRepoUrl);
  await installEidoverse({ worldsRepoUrl: normalizedRepoUrl });
  res.status(201).json(await updateInstanceFeature('eidoverse', true));
}));

// PUT /api/settings/features/eidoverse/source
// Update the origin of the existing Worlds checkout in place. The working tree,
// managed-app path, and world data remain untouched; future app updates pull
// from the newly selected repository.
router.put('/features/eidoverse/source', asyncHandler(async (req, res) => {
  const { worldsRepoUrl } = validateRequest(eidoverseRepoSchema, req.body || {});
  await updateEidoverseWorldsSource(worldsRepoUrl);
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

// PUT /api/settings/features/:featureId
router.put('/features/:featureId', asyncHandler(async (req, res) => {
  const featureId = validateRequest(instanceFeatureIdSchema, req.params.featureId);
  const { enabled } = validateRequest(instanceFeatureUpdateSchema, req.body || {});
  res.json(await updateInstanceFeature(featureId, enabled));
}));

// PUT /api/settings/ai-assignments/:id
router.put('/ai-assignments/:id', asyncHandler(async (req, res) => {
  const payload = validateRequest(aiAssignmentUpdateSchema, req.body || {});
  res.json(await updateAiAssignment(req.params.id, payload));
}));

// PUT /api/settings
router.put('/', asyncHandler(async (req, res) => {
  // Settings is a polymorphic store but the backup sub-object has a known
  // schema. Validate that slice when it's present so a malformed Backup-tab
  // save doesn't reach disk (the runtime guards downstream are belt-and-
  // suspenders, but per project convention all inputs are validated).
  if (req.body?.backup !== undefined) {
    validateRequest(backupConfigSchema.partial(), req.body.backup);
  }
  if (req.body?.sharingDisplayName !== undefined || req.body?.sharingBio !== undefined) {
    validateRequest(sharingSettingsPatchSchema.partial(), {
      sharingDisplayName: req.body.sharingDisplayName,
      sharingBio: req.body.sharingBio,
    });
  }
  // Per-feature AI provider assignments — validate each slice when present so
  // a malformed picker save can't write a non-string providerId/model to disk.
  if (req.body?.autofixer !== undefined) {
    validateRequest(autofixerSettingsSchema.partial(), req.body.autofixer);
  }
  if (req.body?.calendarSync !== undefined) {
    validateRequest(featureProviderConfigSchema.partial(), req.body.calendarSync);
  }
  if (req.body?.codeReview !== undefined) {
    validateRequest(codeReviewSettingsSchema.partial(), req.body.codeReview);
  }
  // Creative Director's treatment, plan, and scene-evaluation provider/model
  // pins — validate the slice when present so a malformed picker save can't
  // write a bad provider config.
  if (req.body?.creativeDirector !== undefined) {
    validateRequest(creativeDirectorSettingsSchema.partial(), req.body.creativeDirector);
  }
  // Music studio slice (#2911) — the chiptune provider pin + publish prefs.
  if (req.body?.music !== undefined) {
    validateRequest(musicSettingsSchema.partial(), req.body.music);
  }
  if (req.body?.federation !== undefined) {
    validateRequest(federationSettingsSchema, req.body.federation);
    // The schema only proves a route is well-SHAPED. A route naming a peer that
    // is unknown, switched off, not a media provider, not allowlisted for that
    // model, or outside the tailnet is well-shaped and permanently unusable —
    // and unattended work has no human at the moment it fails, so it would just
    // break every future Creative Director / Commission render in silence.
    // Refuse it here, where there IS a human. See routingPolicy.js.
    await assertMediaRoutingConfig(req.body.federation.mediaRouting);
  }
  // Home location ({ lat, lon }) read by the weather_now voice tool. The schema
  // already makes both fields optional + nullable (clearing falls back to the
  // tool default), and the refine enforces both-or-neither — so validate the
  // whole slice rather than .partial()ing away that pairing rule.
  if (req.body?.location !== undefined) {
    validateRequest(locationSettingsSchema, req.body.location);
  }
  if (req.body?.embeddings !== undefined) {
    validateRequest(settingsEmbeddingsSchema.partial(), req.body.embeddings);
  }
  if (req.body?.localLlm !== undefined) {
    validateRequest(localLlmSettingsSchema, req.body.localLlm);
  }
  // OpenWorld snapshot capture config — validate the slice when present so a
  // malformed interval/cap can't reach disk and break the scheduler.
  if (req.body?.openWorldSnapshots !== undefined) {
    validateRequest(openWorldSnapshotConfigSchema.partial(), req.body.openWorldSnapshots);
  }
  // The settings slice predates the OpenWorld rename. Keep accepting the old
  // property so an older client can still update capture settings safely.
  const legacySnapshotSettingsKey = ['city', 'Snapshots'].join('');
  if (req.body?.[legacySnapshotSettingsKey] !== undefined) {
    validateRequest(openWorldSnapshotConfigSchema.partial(), req.body[legacySnapshotSettingsKey]);
  }
  // iMessage ingestion config (#2151) — validate the slice when present so a
  // malformed enabled/interval can't reach disk and break the sync scheduler.
  if (req.body?.imessage !== undefined) {
    validateRequest(imessageConfigSchema.partial(), req.body.imessage);
  }
  // Signal ingestion config (#2154) — validate the slice when present so a
  // malformed enabled/interval can't reach disk and break the sync scheduler.
  if (req.body?.signal !== undefined) {
    validateRequest(signalConfigSchema.partial(), req.body.signal);
  }
  // Spotify ingestion config (#2152) — validate the slice when present so a
  // malformed enabled/interval can't reach disk and break the sync scheduler.
  if (req.body?.spotify !== undefined) {
    validateRequest(spotifyConfigSchema.partial(), req.body.spotify);
  }
  // YouTube watch-history scrape config (#2153) — validate the slice when present
  // so a malformed enabled/interval can't reach disk and break the sync scheduler.
  if (req.body?.youtube !== undefined) {
    validateRequest(youtubeConfigSchema.partial(), req.body.youtube);
  }
  // LoRA training config (caption provider + training defaults) — validate
  // the slice when present so a malformed save can't write bad bounds the
  // trainer would then pass to the python child.
  if (req.body?.loraTraining !== undefined) {
    validateRequest(loraTrainingConfigSchema.partial(), req.body.loraTraining);
  }
  // Per-API external-access flags (voice/sdapi). Validate the slice when present
  // so a malformed toggle save can't write a non-boolean exposed/requireAuth to
  // disk (the registry would then silently treat it as its default).
  if (req.body?.apiAccess !== undefined) {
    validateRequest(apiAccessSettingsSchema.partial(), req.body.apiAccess);
  }
  if (req.body?.instanceFeatures !== undefined) {
    validateRequest(instanceFeatureSettingsSchema, req.body.instanceFeatures);
  }
  // Local MCP agent-context opt-in. Validate the whole strict slice so an
  // unknown scope/profile cannot silently broaden what the server exposes.
  if (req.body?.agentContext !== undefined) {
    validateRequest(agentContextSettingsSchema, req.body.agentContext);
  }
  // Editorial-check enable/config slice (#1284) — validate when present so a
  // malformed save can't write a non-boolean enabled / non-object config the
  // registry would then choke on.
  if (req.body?.pipelineEditorialChecks !== undefined) {
    validateRequest(pipelineEditorialChecksSettingsSchema.partial(), req.body.pipelineEditorialChecks);
  }
  // Privacy Center opt-out recheck config (#2145) — validate the slice when
  // present so a malformed cron / non-boolean autonomy toggle can't reach disk
  // and break the recheck scheduler. Both autonomy toggles default OFF.
  if (req.body?.privacy !== undefined) {
    validateRequest(privacySettingsSchema.partial(), req.body.privacy);
  }
  // Scheduled Series Autopilot config (#2174) — validate the slice when present
  // so an invalid cron (rejected by the schema's isValidCronExpression refine) or
  // bad seriesId can't reach disk and leave an "enabled" schedule that never fires.
  // `.partial()` so a PUT that only carries { schedules } still validates.
  if (req.body?.seriesAutopilot !== undefined) {
    validateRequest(seriesAutopilotSettingsSchema.partial(), req.body.seriesAutopilot);
  }
  // Grok Imagegen settings slice (#2859) — validate when present so a malformed
  // save can't write a bad aspect ratio (which lands verbatim in the grok
  // prompt) or a non-boolean enabled gate to disk. The imageGen parent stays
  // polymorphic; only the grok sub-slice has a schema here.
  if (req.body?.imageGen?.grok !== undefined) {
    validateRequest(imageGenGrokSettingsSchema.partial(), req.body.imageGen.grok);
  }
  if (req.body?.imageGen?.agy !== undefined) {
    validateRequest(imageGenAgySettingsSchema.partial(), req.body.imageGen.agy);
  }
  // Per-surface render defaults (#3231) — validate when present so a typo'd
  // target key or a non-enum backend can't persist a slice the render-target
  // resolver would then silently ignore (or worse, hand an invalid model id
  // to a cloud CLI's argv).
  if (req.body?.renderDefaults !== undefined) {
    validateRequest(renderDefaultsSettingsSchema, req.body.renderDefaults);
  }
  // Install-wide video render pin (#3231 Phase 4) — validate when present so a
  // non-enum backend can't persist a mode resolveVideoMode would choke on.
  if (req.body?.videoGen !== undefined) {
    validateRequest(videoGenSettingsSchema, req.body.videoGen);
  }
  // Install-level Layered Intelligence settings (#2515) — validate the slice when
  // present so a malformed `trustShellSources` can't persist and silently unlock
  // full-shell custom `cmd` sources install-wide.
  if (req.body.layeredIntelligence) {
    validateRequest(layeredIntelligenceSettingsSchema.partial(), req.body.layeredIntelligence);
  }
  // Subscription plan prices — the same schema PUT /api/usage/subscriptions
  // enforces, so a legacy client or restore bundle can't write a junk family
  // key or an over-cap price through the generic settings endpoint. Without it
  // the value persists, reads back as "not priced", and is silently deleted by
  // the next save from the usage page.
  if (req.body?.subscriptionCosts !== undefined) {
    validateRequest(subscriptionCostsMapSchema, req.body.subscriptionCosts);
  }
  // Same schema PUT /api/usage/fleet-billing's store uses, so a restore dump
  // can't write an unbounded or non-string list through the generic endpoint.
  if (req.body?.usageApiBilledInstanceIds !== undefined) {
    validateRequest(usageApiBilledInstanceIdsSchema, req.body.usageApiBilledInstanceIds);
  }
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
  // subscriptionCosts and usageApiBilledInstanceIds are excluded from the
  // generic shallow spread below and routed through their dedicated savers —
  // the same merge PUT /api/usage/subscriptions and PUT /api/usage/fleet-billing
  // use — so a restore dump can't persist an unvalidated slice, and a shallow
  // `{ ...current, ...settingsPatch }` can't replace a map by dropping keys
  // the incoming patch didn't mention.
  const {
    secrets: _ignoredSecrets,
    catalogUserTypes: _ignoredTypes,
    subscriptionCosts: subscriptionCostsPatch,
    usageApiBilledInstanceIds: apiBilledPatch,
    ...settingsPatch
  } = req.body || {};
  // updateSettingsWith (not updateSettings) so the multi-owner `federation`
  // slice merges per sub-key and persisted write-only tokens the incoming patch
  // omits get re-injected — both against the freshest snapshot inside the write
  // queue (see mergeFederationSlice / preserveExternallyOwnedKeys).
  // `actor: 'user'` is what separates a save made HERE — a human on the Settings
  // page — from every other `save()` caller (schedulers, sync hooks, feature
  // writes), which keep the `'system'` default in the operator-action ledger (#5594).
  let merged = await updateSettingsWith((current) =>
    preserveExternallyOwnedKeys(
      mergeFederationSlice({ ...current, ...settingsPatch }, current),
      current,
    ), { actor: 'user' });
  if (subscriptionCostsPatch !== undefined) {
    const costs = await saveSubscriptionCosts(subscriptionCostsPatch, { actor: 'user' });
    merged = { ...merged, subscriptionCosts: costs };
  }
  if (apiBilledPatch !== undefined) {
    const ids = await saveApiBilledInstanceIds(apiBilledPatch, { actor: 'user' });
    merged = { ...merged, usageApiBilledInstanceIds: ids };
  }
  // The queue caches codex.parallelLimit in-process; sync it from the
  // merged value so a save takes effect without a restart and without
  // re-reading the file.
  setCodexParallelLimit(merged.imageGen?.codex?.parallelLimit ?? CODEX_PARALLEL_DEFAULT);
  // Series Autopilot crons re-register themselves off settings.js's
  // `settings:updated` event (see seriesAutopilotScheduler.js) — the save above
  // already emitted it — so an added/removed/edited schedule takes effect
  // immediately without a restart, and this route stays decoupled from the
  // autopilot pipeline graph.
  res.json(sanitizeSettingsForResponse(merged));
}));

export default router;
