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
import { SYSTEM_STAGE_KEYS } from '../lib/promptSystemStages.js';

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
    expect(r.body).toMatchObject({ isSystemStage: false, canDelete: true, usedBy: [], warning: null });
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

  // The guard and the usage report must agree on the SAME list — the drift
  // between two hand-copied arrays is what #3314 removed.
  it('guards exactly the keys the usage endpoint calls system stages', async () => {
    for (const key of SYSTEM_STAGE_KEYS) {
      const usage = await request(app).get(`/api/prompts/${key}/usage`);
      expect(usage.body.isSystemStage).toBe(true);
      const del = await request(app).delete(`/api/prompts/${key}`);
      expect(del.status).toBe(400);
    }
  });
});
