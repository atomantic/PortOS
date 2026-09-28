/**
 * Digital Twin settings — read and update.
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { settingsUpdateInputSchema } from '../../lib/digitalTwinValidation.js';
import { changedHostControlSettingsPaths } from '../../lib/hostControlRoutes.js';
import { requireHostControl } from '../../services/authGate.js';

const router = Router();
const INSTRUCTION_SETTINGS = ['autoInjectToCoS', 'includePrivacyContext', 'activePersonaId'];

/**
 * GET /api/digital-twin/settings
 * Get digital twin settings
 */
router.get('/settings', asyncHandler(async (req, res) => {
  const meta = await digitalTwinService.loadMeta();
  res.json(meta.settings);
}));

/**
 * PUT /api/digital-twin/settings
 * Update digital twin settings
 */
router.put('/settings', asyncHandler(async (req, res) => {
  const data = validateRequest(settingsUpdateInputSchema, req.body);
  const named = INSTRUCTION_SETTINGS.filter(key => Object.hasOwn(data, key));
  if (named.length) {
    const current = await digitalTwinService.loadMeta();
    if (changedHostControlSettingsPaths(named, data, current.settings).length) {
      let authorized = false;
      requireHostControl(req, res, () => { authorized = true; });
      if (!authorized) return;
    } else {
      // A remote whole-form save may resend these unchanged values. Do not
      // write them back: an operator can change one while updateSettings awaits
      // its current meta, and this request has no authority to undo that change.
      for (const key of named) delete data[key];
    }
  }
  const settings = await digitalTwinService.updateSettings(data);
  res.json(settings);
}));

export default router;
