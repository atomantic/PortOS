import { Router } from 'express';
import { z } from 'zod';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import { getAiAssignments, updateAiAssignment } from '../services/aiAssignments.js';
import {
  setCodexParallelLimit,
  CODEX_PARALLEL_MIN,
  CODEX_PARALLEL_MAX,
  CODEX_PARALLEL_DEFAULT,
} from '../services/mediaJobQueue/index.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { isPlainObject } from '../lib/objects.js';
import { backupConfigSchema, sharingSettingsPatchSchema, featureProviderConfigSchema, codeReviewSettingsSchema, locationSettingsSchema, settingsEmbeddingsSchema, citySnapshotConfigSchema, imessageConfigSchema, spotifyConfigSchema, youtubeConfigSchema, apiAccessSettingsSchema, loraTrainingConfigSchema, pipelineEditorialChecksSettingsSchema, creativeDirectorSettingsSchema, validateRequest } from '../lib/validation.js';

const router = Router();

const aiAssignmentUpdateSchema = z.object({
  providerId: z.string().trim().max(128).nullable().optional(),
  model: z.string().trim().max(300).nullable().optional(),
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

// Write-path counterpart to the redaction above. Because GET /api/settings no
// longer returns these tokens, a client that GETs settings, rebuilds a full
// top-level object and PUTs it back (e.g. `patchSettingsSlice('imageGen.local',
// …)`) would otherwise drop the persisted token — `updateSettings` shallow-
// merges top-level keys, so an incoming `imageGen`/`civitai` replaces the
// stored object wholesale. PUT /api/settings is never the write path for these
// tokens (the dedicated /setup/hf-token and /loras/auth/civitai routes are), so
// re-inject the persisted value whenever an incoming parent object omits it.
// A parent absent from the patch needs nothing — the top-level merge keeps the
// stored object (token included) untouched.
const preserveWriteOnlyTokens = (next, current) => {
  const carryOver = (parentKey, tokenKey) => {
    const incoming = next[parentKey];
    const stored = current?.[parentKey]?.[tokenKey];
    if (isPlainObject(incoming) && !(tokenKey in incoming) && stored !== undefined) {
      next[parentKey] = { ...incoming, [tokenKey]: stored };
    }
  };
  carryOver('imageGen', 'hfToken');
  carryOver('civitai', 'apiKey');
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

// GET /api/settings/ai-assignments
router.get('/ai-assignments', asyncHandler(async (_req, res) => {
  res.json(await getAiAssignments());
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
    validateRequest(featureProviderConfigSchema.partial(), req.body.autofixer);
  }
  if (req.body?.calendarSync !== undefined) {
    validateRequest(featureProviderConfigSchema.partial(), req.body.calendarSync);
  }
  if (req.body?.codeReview !== undefined) {
    validateRequest(codeReviewSettingsSchema.partial(), req.body.codeReview);
  }
  // Creative Director scene-evaluation provider/model pin — validate the slice
  // when present so a malformed picker save can't write a bad provider config.
  if (req.body?.creativeDirector !== undefined) {
    validateRequest(creativeDirectorSettingsSchema.partial(), req.body.creativeDirector);
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
  // CyberCity snapshot capture config — validate the slice when present so a
  // malformed interval/cap can't reach disk and break the scheduler.
  if (req.body?.citySnapshots !== undefined) {
    validateRequest(citySnapshotConfigSchema.partial(), req.body.citySnapshots);
  }
  // iMessage ingestion config (#2151) — validate the slice when present so a
  // malformed enabled/interval can't reach disk and break the sync scheduler.
  if (req.body?.imessage !== undefined) {
    validateRequest(imessageConfigSchema.partial(), req.body.imessage);
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
  // Editorial-check enable/config slice (#1284) — validate when present so a
  // malformed save can't write a non-boolean enabled / non-object config the
  // registry would then choke on.
  if (req.body?.pipelineEditorialChecks !== undefined) {
    validateRequest(pipelineEditorialChecksSettingsSchema.partial(), req.body.pipelineEditorialChecks);
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
  const { secrets: _ignoredSecrets, catalogUserTypes: _ignoredTypes, ...settingsPatch } = req.body || {};
  // updateSettingsWith (not updateSettings) so we can re-inject persisted
  // write-only tokens the incoming patch omits, against the freshest snapshot
  // inside the write queue (see preserveWriteOnlyTokens).
  const merged = await updateSettingsWith((current) =>
    preserveWriteOnlyTokens({ ...current, ...settingsPatch }, current));
  // The queue caches codex.parallelLimit in-process; sync it from the
  // merged value so a save takes effect without a restart and without
  // re-reading the file.
  setCodexParallelLimit(merged.imageGen?.codex?.parallelLimit ?? CODEX_PARALLEL_DEFAULT);
  res.json(sanitizeSettingsForResponse(merged));
}));

export default router;
