import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/modelDeduplication.js', () => ({ rectifyModelDuplicates: vi.fn() }));
const deduplication = await import('../services/modelDeduplication.js');

const lifecycle = vi.hoisted(() => ({ onDisconnect: null, stopRun: vi.fn(async () => true) }));

vi.mock('../services/systemResources.js', () => ({
  getSystemResourceReport: vi.fn(),
  triageSystemResources: vi.fn(),
}));
vi.mock('../lib/sseDownload.js', () => ({
  onClientDisconnect: vi.fn((_req, _res, callback) => { lifecycle.onDisconnect = callback; }),
}));
vi.mock('../services/runner.js', () => ({
  stopRun: lifecycle.stopRun,
}));

const resources = await import('../services/systemResources.js');
const { default: routes } = await import('./systemResources.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/system-resources', routes);
  app.use(errorMiddleware);
  return app;
};

describe('system resources routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.onDisconnect = null;
  });

  it('runs a fresh report only when explicitly requested', async () => {
    resources.getSystemResourceReport.mockResolvedValue({ generatedAt: '2026-08-16T00:00:00.000Z' });
    const response = await request(makeApp()).post('/api/system-resources/report').send({});
    expect(response.status).toBe(200);
    expect(resources.getSystemResourceReport).toHaveBeenCalledWith({ force: true });
  });

  it('rejects report input instead of accepting filesystem hints', async () => {
    const response = await request(makeApp()).post('/api/system-resources/report').send({ path: '/example' });
    expect(response.status).toBe(400);
    expect(resources.getSystemResourceReport).not.toHaveBeenCalled();
  });

  it('normalizes optional picker values before AI triage', async () => {
    resources.triageSystemResources.mockResolvedValue({ triage: { summary: 'Healthy' } });
    const response = await request(makeApp()).post('/api/system-resources/triage').send({
      providerId: 'codex',
      model: '  ',
      effort: '',
    });
    expect(response.status).toBe(200);
    expect(resources.triageSystemResources).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      model: undefined,
      effort: undefined,
      onRunCreated: expect.any(Function),
      onRunSettled: expect.any(Function),
    }));
  });

  it('stops active and late-created AI runs after a client disconnect', async () => {
    let hooks;
    resources.triageSystemResources.mockImplementation(async (input) => {
      hooks = input;
      input.onRunCreated('run-active');
      return { triage: { summary: 'Healthy' } };
    });

    const response = await request(makeApp()).post('/api/system-resources/triage').send({ providerId: 'codex' });
    expect(response.status).toBe(200);

    lifecycle.onDisconnect();
    hooks.onRunCreated('run-late');
    await Promise.resolve();

    expect(lifecycle.stopRun).toHaveBeenCalledWith('run-active');
    expect(lifecycle.stopRun).toHaveBeenCalledWith('run-late');
    hooks.onRunSettled('run-active');
    hooks.onRunSettled('run-late');
  });

  it('rejects unsupported effort and unknown fields', async () => {
    const badEffort = await request(makeApp()).post('/api/system-resources/triage').send({
      providerId: 'codex', effort: 'turbo',
    });
    const extra = await request(makeApp()).post('/api/system-resources/triage').send({
      providerId: 'codex', path: '/private/example',
    });
    expect(badEffort.status).toBe(400);
    expect(extra.status).toBe(400);
    expect(resources.triageSystemResources).not.toHaveBeenCalled();
  });
});

it('validates duplicate requests and replaces a verified weight through the route', async () => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const actual = await vi.importActual('../services/modelDeduplication.js');
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'dedupe-route-')));
  const local = join(root, 'local');
  const external = join(root, 'pinokio');
  await fs.mkdir(local);
  await fs.mkdir(external);
  const sourcePath = join(local, 'example.gguf');
  const targetPath = join(external, 'example.gguf');
  const bytes = Buffer.alloc(10 * 1024 * 1024, 3);
  await fs.writeFile(sourcePath, bytes);
  await fs.writeFile(targetPath, bytes);
  deduplication.rectifyModelDuplicates.mockImplementation((pairs) => actual.rectifyModelDuplicates(pairs, {
    roots: { local: [local], external: [external] },
  }));
  const app = makeApp();
  const invalid = await request(app).post('/api/system-resources/duplicates/rectify').send({ pairs: [] });
  expect(invalid.status).toBe(400);
  const escaped = await request(app).post('/api/system-resources/duplicates/rectify').send({
    pairs: [{ sourcePath, targetPath: join(root, 'outside.gguf') }],
  });
  expect(escaped.status).toBe(400);
  const result = await request(app).post('/api/system-resources/duplicates/rectify').send({
    pairs: [{ sourcePath, targetPath }],
  });
  expect(result.status).toBe(200);
  expect(result.body.success).toBe(true);
  expect((await fs.stat(sourcePath)).ino).toBe((await fs.stat(targetPath)).ino);
  await fs.rm(root, { recursive: true, force: true });
});
