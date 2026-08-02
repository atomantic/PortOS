import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// The job-skill routes reach into autonomousJobs (PM2 + fs); this suite only
// covers the stage/system-stage contract, so stub the module out entirely.
vi.mock('../services/autonomousJobs.js', () => ({
  listJobSkillTemplates: vi.fn(async () => []),
  loadJobSkillTemplate: vi.fn(async () => null),
  saveJobSkillTemplate: vi.fn(async () => {}),
  getJobEffectivePrompt: vi.fn(async () => ''),
  getJob: vi.fn(async () => null),
  JOB_SKILL_MAP: {},
}));

import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSPromptsRoutes } from './prompts.js';
import { PROTECTED_STAGE_KEYS, SYSTEM_STAGE_KEYS, stageReferencedBy } from '../lib/promptSystemStages.js';

// Referenced by `server/` source but deliberately NOT in the curated badge
// set — the case #3335 exists for.
const REFERENCED_STAGE = 'pipeline-series-concept-judge';

const STAGES = {
  'brain-classifier': { name: 'Brain Classifier', description: 'Classify a thought' },
  'my-own-stage': { name: 'My Own Stage', description: 'User authored' },
};

function makeApp(overrides = {}) {
  const deleteStage = vi.fn(async () => {});
  const toolkit = {
    services: {
      prompts: {
        getStages: () => STAGES,
        getStage: (name) => STAGES[name] || null,
        getStageTemplate: async () => 'body',
        deleteStage,
        ...overrides,
      },
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/prompts', createPortOSPromptsRoutes(toolkit));
  app.use(errorMiddleware);
  return { app, deleteStage };
}

describe('prompts routes — system stages', () => {
  let app;
  let deleteStage;
  beforeEach(() => {
    ({ app, deleteStage } = makeApp());
  });

  // The wire body is the contract the Prompt Manager consumes; the client
  // suite mocks apiPrompts, so this is the only place the shape is pinned.
  it('GET / returns the stage map AND the system-stage key list', async () => {
    const r = await request(app).get('/api/prompts');
    expect(r.status).toBe(200);
    expect(r.body.stages).toEqual(STAGES);
    expect(r.body.systemStages).toEqual(SYSTEM_STAGE_KEYS);
    expect(r.body.systemStages).toContain('cos-task-enhance');
  });

  it('GET /:stage/usage reports a system stage with its usage list', async () => {
    const r = await request(app).get('/api/prompts/brain-classifier/usage');
    expect(r.status).toBe(200);
    expect(r.body.isSystemStage).toBe(true);
    expect(r.body.canDelete).toBe(false);
    expect(r.body.usedBy).toEqual(['Brain thought classification']);
    expect(r.body.warning).toMatch(/system stage/i);
  });

  it('GET /:stage/usage reports a user stage as deletable with no usage', async () => {
    const r = await request(app).get('/api/prompts/my-own-stage/usage');
    expect(r.body).toMatchObject({
      isSystemStage: false, canDelete: true, usedBy: [], referencedBy: [], warning: null,
    });
  });

  it('GET /:stage/usage names the source files for a referenced non-system stage', async () => {
    const r = await request(app).get(`/api/prompts/${REFERENCED_STAGE}/usage`);
    expect(r.status).toBe(200);
    // The badge stays curated-only; only protection widens.
    expect(r.body.isSystemStage).toBe(false);
    expect(r.body.usedBy).toEqual([]);
    expect(r.body.canDelete).toBe(false);
    expect(r.body.referencedBy).toEqual(stageReferencedBy(REFERENCED_STAGE));
    expect(r.body.referencedBy.length).toBeGreaterThan(0);
    expect(r.body.warning).toMatch(/resolves this stage by name/i);
  });

  it('GET /:stage/usage still lists call sites alongside a curated stage', async () => {
    const r = await request(app).get('/api/prompts/brain-classifier/usage');
    expect(r.body.referencedBy).toEqual(stageReferencedBy('brain-classifier'));
  });

  it('DELETE /:stage refuses a system stage without force', async () => {
    const r = await request(app).delete('/api/prompts/brain-classifier');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('SYSTEM_STAGE_PROTECTED');
    expect(deleteStage).not.toHaveBeenCalled();
  });

  it('DELETE /:stage honors ?force=true on a system stage', async () => {
    const r = await request(app).delete('/api/prompts/brain-classifier?force=true');
    expect(r.status).toBe(200);
    expect(deleteStage).toHaveBeenCalledWith('brain-classifier');
  });

  it('DELETE /:stage deletes a user stage outright', async () => {
    const r = await request(app).delete('/api/prompts/my-own-stage');
    expect(r.status).toBe(200);
    expect(deleteStage).toHaveBeenCalledWith('my-own-stage');
  });

  it('DELETE /:stage refuses a referenced non-system stage without force', async () => {
    const r = await request(app).delete(`/api/prompts/${REFERENCED_STAGE}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('SYSTEM_STAGE_PROTECTED');
    expect(deleteStage).not.toHaveBeenCalled();
  });

  it('DELETE /:stage honors ?force=true on a referenced non-system stage', async () => {
    const r = await request(app).delete(`/api/prompts/${REFERENCED_STAGE}?force=true`);
    expect(r.status).toBe(200);
    expect(deleteStage).toHaveBeenCalledWith(REFERENCED_STAGE);
  });

  // The guard and the usage report must agree on the SAME list — the drift
  // between two hand-copied arrays is what #3314 removed. #3335 widened the
  // guard past the badge, so `canDelete` (not `isSystemStage`) is what has to
  // match it.
  it('guards exactly the keys the usage endpoint reports as undeletable', async () => {
    for (const key of PROTECTED_STAGE_KEYS) {
      const usage = await request(app).get(`/api/prompts/${encodeURIComponent(key)}/usage`);
      expect(usage.body.canDelete, `${key} usage`).toBe(false);
      const del = await request(app).delete(`/api/prompts/${encodeURIComponent(key)}`);
      expect(del.status, `${key} delete`).toBe(400);
    }
  });

  it('still badges only the curated system stages', async () => {
    for (const key of SYSTEM_STAGE_KEYS) {
      const usage = await request(app).get(`/api/prompts/${key}/usage`);
      expect(usage.body.isSystemStage).toBe(true);
    }
    const badged = PROTECTED_STAGE_KEYS.filter((key) => SYSTEM_STAGE_KEYS.includes(key));
    expect(badged).toHaveLength(SYSTEM_STAGE_KEYS.length);
    expect(PROTECTED_STAGE_KEYS.length).toBeGreaterThan(SYSTEM_STAGE_KEYS.length * 5);
  });
});
