import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const installer = vi.hoisted(() => ({
  getOpenCodeInstallStatus: vi.fn(),
  spawnOpenCodeInstaller: vi.fn(),
  stopOpenCodeInstaller: vi.fn(),
  OPENCODE_NPM_PACKAGE: 'opencode-ai@latest',
}));

vi.mock('../services/opencodeInstaller.js', () => installer);

import { createPortOSProviderRoutes } from './providers.js';

const app = () => {
  const toolkit = { services: { providers: {} }, routes: { providers: Router() } };
  const server = express();
  server.use(express.json());
  server.use('/api/providers', createPortOSProviderRoutes(toolkit));
  server.use(errorMiddleware);
  return server;
};

const makeChild = () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
};

describe('OpenCode Providers installer routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only install readiness booleans', async () => {
    installer.getOpenCodeInstallStatus.mockResolvedValueOnce({ installed: false, npmAvailable: true });

    const response = await request(app()).get('/api/providers/opencode/installation');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ installed: false, npmAvailable: true });
  });

  it('streams a verified completion after the fixed installer exits', async () => {
    const child = makeChild();
    installer.getOpenCodeInstallStatus
      .mockResolvedValueOnce({ installed: false, npmAvailable: true })
      .mockResolvedValueOnce({ installed: true, npmAvailable: true });
    installer.spawnOpenCodeInstaller.mockReturnValueOnce(child);

    const responsePromise = request(app()).post('/api/providers/opencode/install').then((response) => response);
    await vi.waitFor(() => expect(installer.spawnOpenCodeInstaller).toHaveBeenCalledOnce());
    child.stdout.end('added OpenCode\n');
    child.stderr.end();
    child.emit('close', 0);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('Running npm install --global opencode-ai@latest.');
    expect(response.text).toContain('added OpenCode');
    expect(response.text).toContain('OpenCode is installed and available to PortOS.');
  });

  it('reports an unusable CLI after npm exits successfully', async () => {
    const child = makeChild();
    installer.getOpenCodeInstallStatus
      .mockResolvedValueOnce({ installed: false, npmAvailable: true })
      .mockResolvedValueOnce({ installed: false, npmAvailable: true });
    installer.spawnOpenCodeInstaller.mockReturnValueOnce(child);

    const responsePromise = request(app()).post('/api/providers/opencode/install').then((response) => response);
    await vi.waitFor(() => expect(installer.spawnOpenCodeInstaller).toHaveBeenCalledOnce());
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenCode is not runnable by PortOS');
  });

  it('fails the stream without spawning when npm is absent', async () => {
    installer.getOpenCodeInstallStatus.mockResolvedValueOnce({ installed: false, npmAvailable: false });

    const response = await request(app()).post('/api/providers/opencode/install');

    expect(response.status).toBe(200);
    expect(response.text).toContain('npm is not available');
    expect(installer.spawnOpenCodeInstaller).not.toHaveBeenCalled();
  });
});
