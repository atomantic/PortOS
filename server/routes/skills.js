/**
 * Skill Registry routes (`/api/skills`): progressive-disclosure reads over the
 * tiered agentskills.io skill directories, local-tier management, the
 * external-directory and curator config, and the Skill Curator's pass,
 * lifecycle controls and mutation ledger. See `services/skills/skillService.js`
 * and `services/skills/skillCurator.js`.
 *
 * Auth: under the normal `/api/*` gate. The POST/PUT writes need operator
 * authority by default (`lib/hostControlRoutes.js`): a skill is prompt text an
 * agent follows, so a password-free LAN caller must not author one.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  skillLifecycleParamsSchema,
  skillsCuratorRunSchema,
  skillsLedgerParamsSchema,
  skillsLedgerQuerySchema,
  skillsListQuerySchema,
  skillsManageSchema,
  skillsSettingsSchema,
  skillsViewQuerySchema,
} from '../lib/skillsValidation.js';
import {
  applySkillLifecycleAction, getCuratorStatus, rollbackSkillLedgerEntry, runCuratorPass,
} from '../services/skills/skillCurator.js';
import { listLedger } from '../services/skills/skillLedger.js';
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

// POST /api/skills/edit — the same actions for the human editing through the
// PortOS UI, which a lock does not stop. The lock is a guard against an agent
// rewriting a curated skill by accident, not an authorization boundary.
router.post('/edit', asyncHandler(async (req, res) => {
  res.json(await manageSkill(validateRequest(skillsManageSchema, req.body ?? {}), { actor: 'user' }));
}));

// Skill Curator (#17391): deterministic, no provider calls.
router.get('/curator/status', asyncHandler(async (_req, res) => {
  res.json(await getCuratorStatus());
}));

router.post('/curator/run', asyncHandler(async (req, res) => {
  const { dryRun = false } = validateRequest(skillsCuratorRunSchema, req.body ?? {});
  res.json(await runCuratorPass({ dryRun }));
}));

router.get('/ledger', asyncHandler(async (req, res) => {
  res.json({ entries: await listLedger(validateRequest(skillsLedgerQuerySchema, req.query)) });
}));

router.post('/ledger/:entryId/rollback', asyncHandler(async (req, res) => {
  const { entryId } = validateRequest(skillsLedgerParamsSchema, req.params);
  res.json(await rollbackSkillLedgerEntry(entryId, { actor: 'user' }));
}));

router.get('/config', asyncHandler(async (_req, res) => {
  res.json(await getSkillsConfig());
}));

router.put('/config', asyncHandler(async (req, res) => {
  res.json(await updateSkillsConfig(validateRequest(skillsSettingsSchema, req.body ?? {})));
}));

// POST /api/skills/:ref/:action — pin | unpin | lock | unlock | archive | restore | adopt.
// Declared last so the literal two-segment routes above win. `ref` is a skill
// id or name, URL-encoded (`local%3Awriting%2Fnotes`).
router.post('/:ref/:action', asyncHandler(async (req, res) => {
  res.json(await applySkillLifecycleAction(validateRequest(skillLifecycleParamsSchema, req.params), { actor: 'user' }));
}));

export default router;
