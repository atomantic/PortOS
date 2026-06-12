import { Router } from 'express';
import { z } from 'zod';
import { getSettings, updateSettings } from '../services/settings.js';
import { getAiAssignments, updateAiAssignment } from '../services/aiAssignments.js';
import {
  setCodexParallelLimit,
  CODEX_PARALLEL_MIN,
  CODEX_PARALLEL_MAX,
  CODEX_PARALLEL_DEFAULT,
} from '../services/mediaJobQueue/index.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { backupConfigSchema, sharingSettingsPatchSchema, featureProviderConfigSchema, codeReviewSettingsSchema, locationSettingsSchema, settingsEmbeddingsSchema, citySnapshotConfigSchema, apiAccessSettingsSchema, validateRequest } from '../lib/validation.js';

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

// GET /api/settings
router.get('/', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const { secrets, ...safe } = settings;
  res.json(decorateBounds(safe));
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
  // Per-API external-access flags (voice/sdapi). Validate the slice when present
  // so a malformed toggle save can't write a non-boolean exposed/requireAuth to
  // disk (the registry would then silently treat it as its default).
  if (req.body?.apiAccess !== undefined) {
    validateRequest(apiAccessSettingsSchema.partial(), req.body.apiAccess);
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
  const merged = await updateSettings(settingsPatch);
  // The queue caches codex.parallelLimit in-process; sync it from the
  // merged value so a save takes effect without a restart and without
  // re-reading the file.
  setCodexParallelLimit(merged.imageGen?.codex?.parallelLimit ?? CODEX_PARALLEL_DEFAULT);
  const { secrets, ...safe } = merged;
  res.json(decorateBounds(safe));
}));

export default router;
