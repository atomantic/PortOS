import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

// Job skill template routes (#8762): the name is a URL segment Express has
// already decoded, so it must never reach the filesystem unchecked, and the
// save is host control — a skill template is the prompt a job's agent runs.
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn().mockResolvedValue(false),
}));

const fsCalls = vi.hoisted(() => ({ write: vi.fn(async () => {}), read: vi.fn(async () => 'template body') }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...await importOriginal(),
  ensureDir: vi.fn(async () => {}),
  writeFileGuarded: fsCalls.write,
  tryReadFile: fsCalls.read,
}));

vi.mock('../services/autonomousJobs.js', async () => {
  const templates = await vi.importActual('../services/autonomousJobs/skillTemplates.js');
  const { JOB_SKILL_MAP } = await vi.importActual('../services/autonomousJobs/constants.js');
  return {
    listJobSkillTemplates: vi.fn(async () => []),
    loadJobSkillTemplate: templates.loadJobSkillTemplate,
    saveJobSkillTemplate: templates.saveJobSkillTemplate,
    getJobEffectivePrompt: vi.fn(async () => ''),
    getJob: vi.fn(async () => null),
    JOB_SKILL_MAP,
  };
});

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { JOB_SKILL_MAP } from '../services/autonomousJobs/constants.js';
import { createPortOSPromptsRoutes } from './prompts.js';

const SKILL = Object.values(JOB_SKILL_MAP)[0];

const buildApp = (remoteAddress) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress });
    next();
  });
  app.use(authGate);
  app.use(hostControlRouteGate);
  app.use(express.json());
  app.use('/api/prompts', createPortOSPromptsRoutes({ services: { prompts: {} } }));
  app.use(errorMiddleware);
  return app;
};

describe('job skill template routes (#8762)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a traversal or unknown name with 400 and touches no file', async () => {
    for (const name of ['..%2F..%2Fx', '..%2FAGENTS', 'not-a-known-skill']) {
      const put = await request(buildApp('127.0.0.1')).put(`/api/prompts/skills/jobs/${name}`).send({ content: 'x' });
      expect(put.status).toBe(400);
      const get = await request(buildApp('127.0.0.1')).get(`/api/prompts/skills/jobs/${name}`);
      expect(get.status).toBe(400);
    }
    expect(fsCalls.write).not.toHaveBeenCalled();
    expect(fsCalls.read).not.toHaveBeenCalled();
  });

  it('refuses a remote password-free caller and lets the local operator save', async () => {
    const remote = await request(buildApp('192.0.2.10')).put(`/api/prompts/skills/jobs/${SKILL}`).send({ content: 'x' });
    expect(remote.status).toBe(403);
    expect(remote.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(fsCalls.write).not.toHaveBeenCalled();

    const local = await request(buildApp('127.0.0.1')).put(`/api/prompts/skills/jobs/${SKILL}`).send({ content: 'x' });
    expect(local.status).toBe(200);
    expect(fsCalls.write).toHaveBeenCalledTimes(1);
    expect(fsCalls.write.mock.calls[0][0]).toMatch(new RegExp(`${SKILL}\\.md$`));
  });
});
