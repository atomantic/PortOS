import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../../testHelper.js';
import { createPromptsRoutes } from './prompts.js';
import { createProviderStatusRoutes } from './providerStatus.js';

// #10024 — the prompt-write and usage-limit routes used to hand `req.body`
// straight to services that write prompt files / regex-match a string. Pinned
// through the standalone defaults (no host ServerError), which is also the
// shape a standalone toolkit consumer sees.
const appFor = (path, router) => {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
};

const promptsService = () => ({
  getStage: vi.fn().mockReturnValue({ name: 'x' }),
  getStageTemplate: vi.fn().mockResolvedValue('tpl'),
  getVariable: vi.fn().mockReturnValue({ content: 'c' }),
  updateStageConfig: vi.fn().mockResolvedValue(),
  updateStageTemplate: vi.fn().mockResolvedValue(),
  previewPrompt: vi.fn().mockResolvedValue('rendered'),
  createVariable: vi.fn().mockResolvedValue(),
  updateVariable: vi.fn().mockResolvedValue(),
});

describe('toolkit prompts routes validate their bodies', () => {
  it('rejects wrong-typed bodies with a 400 VALIDATION_ERROR and never reaches the service', async () => {
    const svc = promptsService();
    const app = appFor('/api/prompts', createPromptsRoutes(svc));

    const cases = [
      ['put', '/api/prompts/stages/x', { config: 'nope' }],
      ['put', '/api/prompts/stages/x', { template: 42 }],
      ['post', '/api/prompts/stages/x/preview', ['not', 'a', 'map']],
      ['post', '/api/prompts/variables', { key: 'bad key!', content: 'c' }],
      ['post', '/api/prompts/variables', { content: 'no key' }],
      ['put', '/api/prompts/variables/k', ['x']],
    ];
    for (const [verb, url, body] of cases) {
      const res = await request(app)[verb](url).send(body);
      expect(res.status, `${verb} ${url} ${JSON.stringify(body)}`).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    expect(svc.updateStageConfig).not.toHaveBeenCalled();
    expect(svc.updateStageTemplate).not.toHaveBeenCalled();
    expect(svc.previewPrompt).not.toHaveBeenCalled();
    expect(svc.createVariable).not.toHaveBeenCalled();
    expect(svc.updateVariable).not.toHaveBeenCalled();
  });

  it('still passes valid bodies through, keeping the variable payload beside its key', async () => {
    const svc = promptsService();
    const app = appFor('/api/prompts', createPromptsRoutes(svc));

    expect((await request(app).put('/api/prompts/stages/x').send({ config: { model: 'm' }, template: 't' })).status).toBe(200);
    expect(svc.updateStageConfig).toHaveBeenCalledWith('x', { model: 'm' });
    expect(svc.updateStageTemplate).toHaveBeenCalledWith('x', 't');

    expect((await request(app).post('/api/prompts/stages/x/preview').send({ a: 1 })).status).toBe(200);
    expect(svc.previewPrompt).toHaveBeenCalledWith('x', { a: 1 });

    expect((await request(app).post('/api/prompts/variables').send({ key: 'my-var', content: 'c', name: 'N' })).status).toBe(201);
    expect(svc.createVariable).toHaveBeenCalledWith('my-var', { content: 'c', name: 'N' });
  });
});

describe('toolkit provider-status usage-limit route validates its body', () => {
  it('400s a non-string waitTime instead of letting the status service throw a 500', async () => {
    const status = { markUsageLimit: vi.fn().mockResolvedValue({ ok: true }) };
    const app = appFor('/api/status', createProviderStatusRoutes(status));

    const bad = await request(app).post('/api/status/p1/usage-limit').send({ waitTime: { hours: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    expect(status.markUsageLimit).not.toHaveBeenCalled();

    const ok = await request(app).post('/api/status/p1/usage-limit').send({ message: 'm', waitTime: '2 hours' });
    expect(ok.status).toBe(200);
    expect(status.markUsageLimit).toHaveBeenCalledWith('p1', { message: 'm', waitTime: '2 hours' });
  });
});
