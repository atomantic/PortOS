import { Router } from 'express';
import { getSettings, updateSettings } from '../services/settings.js';
import {
  setCodexParallelLimit,
  CODEX_PARALLEL_MIN,
  CODEX_PARALLEL_MAX,
  CODEX_PARALLEL_DEFAULT,
} from '../services/mediaJobQueue/index.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { backupConfigSchema, sharingSettingsPatchSchema, featureProviderConfigSchema, codeReviewSettingsSchema, validateRequest } from '../lib/validation.js';

const router = Router();

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
  const merged = await updateSettings(req.body);
  // The queue caches codex.parallelLimit in-process; sync it from the
  // merged value so a save takes effect without a restart and without
  // re-reading the file.
  setCodexParallelLimit(merged.imageGen?.codex?.parallelLimit ?? CODEX_PARALLEL_DEFAULT);
  const { secrets, ...safe } = merged;
  res.json(decorateBounds(safe));
}));

export default router;
