/**
 * Skill Registry routes (`/api/skills`): progressive-disclosure reads over the
 * tiered agentskills.io skill directories, local-tier management, and the
 * external-directory config. See `services/skills/skillService.js`.
 *
 * Auth: under the normal `/api/*` gate. The POST/PUT writes need operator
 * authority by default (`lib/hostControlRoutes.js`): a skill is prompt text an
 * agent follows, so a password-free LAN caller must not author one.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  skillsListQuerySchema,
  skillsManageSchema,
  skillsSettingsSchema,
  skillsViewQuerySchema,
} from '../lib/skillsValidation.js';
import { getSkillsConfig, listSkills, manageSkill, updateSkillsConfig, viewSkill } from '../services/skills/skillService.js';

const router = Router();

// GET /api/skills — Level 0 index plus quarantine/shadow/ambiguity reports.
router.get('/', asyncHandler(async (req, res) => {
  res.json(await listSkills(validateRequest(skillsListQuerySchema, req.query)));
}));

// GET /api/skills/view?ref=…[&file=references/x.md] — Level 1, or Level 2 with `file`.
router.get('/view', asyncHandler(async (req, res) => {
  res.json(await viewSkill(validateRequest(skillsViewQuerySchema, req.query)));
}));

// POST /api/skills/manage — create | patch | write_file | remove_file | delete (local tier).
router.post('/manage', asyncHandler(async (req, res) => {
  res.json(await manageSkill(validateRequest(skillsManageSchema, req.body ?? {})));
}));

router.get('/config', asyncHandler(async (_req, res) => {
  res.json(await getSkillsConfig());
}));

router.put('/config', asyncHandler(async (req, res) => {
  res.json(await updateSkillsConfig(validateRequest(skillsSettingsSchema, req.body ?? {})));
}));

export default router;
