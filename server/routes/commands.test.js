import { EventEmitter } from 'events';
import { resolve } from 'path';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../lib/testHelper.js';
import { errorEvents, errorMiddleware } from '../lib/errorHandler.js';
import { ALLOWED_COMMANDS } from '../lib/commandSecurity.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: spawnMock,
}));

vi.mock('../services/history.js', () => ({
  logAction: vi.fn(),
}));

vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/workspaceRoots.js', () => ({
  isWithinAllowedRoots: vi.fn(),
  outsideAllowedRootsMessage: vi.fn((realPath) => `workspacePath is outside allowed directories: ${realPath}`),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    realpathSync: vi.fn(),
  };
});

vi.mock('../services/auth.js', async () => {
  const { extractToken } = await import('../../lib/portosAuthCore.js');
  return {
    extractToken,
    isAuthEnabled: vi.fn().mockResolvedValue(false),
    verifySession: vi.fn(async token => token === 'example-operator-session'),
    verifyPassword: vi.fn(async password => password === 'example-peer-password'),
  };
});

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  settingsEvents: new EventEmitter(),
}));

import { authGate } from '../services/authGate.js';
import { isAuthEnabled } from '../services/auth.js';
import { existsSync, realpathSync, statSync } from 'fs';
import { isWithinAllowedRoots } from '../lib/workspaceRoots.js';
import commandsRoutes from './commands.js';

const WORKSPACE_PATH = resolve('fixtures', 'command-workspace');
const OUTSIDE_PATH = resolve('fixtures', '..', 'outside-workspace');

function createChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function createApp(io = { emit: vi.fn() }, { remoteAddress, withAuthGate = true } = {}) {
  const app = express();
  app.set('io', io);
  app.use(express.json());
  if (remoteAddress !== undefined) app.use((req, _res, next) => {
    // Model the server's socket observation, never an HTTP header.
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress });
    next();
  });
  if (withAuthGate) app.use(authGate);
  app.use('/api/commands', commandsRoutes);
  app.use(errorMiddleware);
  return { app, io };
}

function allowWorkspace(realPath = WORKSPACE_PATH) {
  existsSync.mockReturnValue(true);
  statSync.mockReturnValue({ isDirectory: () => true });
  realpathSync.mockReturnValue(realPath);
  isWithinAllowedRoots.mockReturnValue(true);
}

describe('commands routes', () => {
  const errorEventListener = vi.fn();

  beforeAll(() => {
    // Production registers the Socket.IO error bridge. Keep EventEmitter's
    // reserved `error` event from throwing while error responses are tested.
    errorEvents.on('error', errorEventListener);
  });

  afterAll(() => {
    errorEvents.off('error', errorEventListener);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    isAuthEnabled.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('host-control authorization through the real auth gate', () => {
    const basic = `Basic ${Buffer.from(':example-peer-password').toString('base64')}`;

    it.each([
      ['password-free remote peer', false, {}],
      ['spoofed forwarding headers', false, { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '::1' }],
      ['authenticated Basic peer', true, { Authorization: basic }],
      ['unauthenticated password-protected peer', true, {}],
      ['invalid operator session', true, { Authorization: 'Bearer invalid-session' }],
    ])('rejects %s before spawning or stopping a process', async (_name, enabled, headers) => {
      const child = createChildProcess();
      spawnMock.mockReturnValue(child);
      const local = createApp().app;
      const started = await request(local).post('/api/commands/execute').send({ command: 'pwd' });
      expect(started.status).toBe(202);
      spawnMock.mockClear();
      isAuthEnabled.mockResolvedValue(enabled);
      const { app } = createApp(undefined, { remoteAddress: '192.0.2.10' });
      app.set('trust proxy', true);

      for (const path of ['/api/commands/execute', `/api/commands/${started.body.commandId}/stop`]) {
        const pending = request(app).post(path).send({ command: 'npx --yes example-package' });
        for (const [key, value] of Object.entries(headers)) pending.set(key, value);
        const response = await pending;
        expect(response.status).toBe(enabled && !headers.Authorization?.startsWith('Basic') ? 401 : 403);
        expect(response.body.code).toBe(response.status === 401 ? 'AUTH_REQUIRED' : 'HOST_CONTROL_FORBIDDEN');
      }
      expect(spawnMock).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      child.emit('close', 0);
    });

    it.each(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'])(
      'keeps password-free local command control on %s', async remoteAddress => {
        const child = createChildProcess();
        spawnMock.mockReturnValue(child);
        const { app } = createApp(undefined, { remoteAddress });
        const started = await request(app).post('/api/commands/execute').send({ command: 'pwd' });
        expect(started.status).toBe(202);
        const stopped = await request(app).post(`/api/commands/${started.body.commandId}/stop`);
        expect(stopped.status).toBe(200);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      },
    );

    it.each([
      ['Cookie', 'portos_auth=example-operator-session'],
      ['Authorization', 'Bearer example-operator-session'],
    ])('allows authenticated operator commands through %s', async (header, value) => {
      isAuthEnabled.mockResolvedValue(true);
      const child = createChildProcess();
      spawnMock.mockReturnValue(child);
      const { app } = createApp(undefined, { remoteAddress: '192.0.2.10' });
      const started = await request(app).post('/api/commands/execute').set(header, value).send({ command: 'pwd' });
      expect(started.status).toBe(202);
      const stopped = await request(app).post(`/api/commands/${started.body.commandId}/stop`).set(header, value);
      expect(stopped.status).toBe(200);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('fails closed when mounted without the global auth gate', async () => {
      const { app } = createApp(undefined, { withAuthGate: false });
      const response = await request(app).post('/api/commands/execute').send({ command: 'pwd' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/commands/execute', () => {
    it('rejects a missing command before touching the filesystem or process boundary', async () => {
      const { app } = createApp();

      const response = await request(app)
        .post('/api/commands/execute')
        .send({ workspacePath: WORKSPACE_PATH });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('MISSING_COMMAND');
      expect(existsSync).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('rejects a workspace path that does not exist', async () => {
      existsSync.mockReturnValue(false);
      const { app } = createApp();

      const response = await request(app)
        .post('/api/commands/execute')
        .send({ command: 'pwd', workspacePath: WORKSPACE_PATH });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_PATH');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('rejects a workspace path that is not a directory', async () => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ isDirectory: () => false });
      const { app } = createApp();

      const response = await request(app)
        .post('/api/commands/execute')
        .send({ command: 'pwd', workspacePath: WORKSPACE_PATH });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_PATH');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('rejects a symlink target outside the allowed workspace roots', async () => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ isDirectory: () => true });
      realpathSync.mockReturnValue(OUTSIDE_PATH);
      isWithinAllowedRoots.mockReturnValue(false);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { app } = createApp();

      const response = await request(app)
        .post('/api/commands/execute')
        .send({ command: 'pwd', workspacePath: WORKSPACE_PATH });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_PATH');
      expect(realpathSync).toHaveBeenCalledWith(WORKSPACE_PATH);
      expect(isWithinAllowedRoots).toHaveBeenCalledWith(OUTSIDE_PATH);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns FORBIDDEN for a command outside the operator allowlist', async () => {
      allowWorkspace();
      const { app, io } = createApp();

      const response = await request(app)
        .post('/api/commands/execute')
        .send({ command: 'definitely-not-allowed', workspacePath: WORKSPACE_PATH });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
      expect(spawnMock).not.toHaveBeenCalled();
      expect(io.emit).not.toHaveBeenCalledWith(
        expect.stringMatching(/^command:/),
        expect.anything(),
      );
    });

    it('starts an allowed command and relays its output and completion over Socket.IO', async () => {
      allowWorkspace();
      const child = createChildProcess();
      spawnMock.mockReturnValue(child);
      const { app, io } = createApp();

      const response = await request(app)
        .post('/api/commands/execute')
        .send({ command: 'pwd', workspacePath: WORKSPACE_PATH });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ commandId: expect.any(String), status: 'started' });
      expect(spawnMock).toHaveBeenCalledWith('pwd', [], expect.objectContaining({
        cwd: WORKSPACE_PATH,
        shell: false,
      }));

      child.stdout.emit('data', Buffer.from('workspace output'));
      child.stderr.emit('data', Buffer.from('workspace warning'));
      child.emit('close', 0);

      const eventPrefix = `command:${response.body.commandId}`;
      expect(io.emit).toHaveBeenCalledWith(`${eventPrefix}:data`, {
        data: 'workspace output',
        stream: 'stdout',
      });
      expect(io.emit).toHaveBeenCalledWith(`${eventPrefix}:data`, {
        data: 'workspace warning',
        stream: 'stderr',
      });
      expect(io.emit).toHaveBeenCalledWith(`${eventPrefix}:complete`, expect.objectContaining({
        success: true,
        exitCode: 0,
        output: 'workspace outputworkspace warning',
      }));
    });
  });

  describe('POST /api/commands/:id/stop', () => {
    it('terminates an active command and reports it stopped', async () => {
      const child = createChildProcess();
      spawnMock.mockReturnValue(child);
      const { app } = createApp();

      const started = await request(app)
        .post('/api/commands/execute')
        .send({ command: 'pwd' });
      const response = await request(app)
        .post(`/api/commands/${started.body.commandId}/stop`);

      expect(started.status).toBe(202);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ stopped: true });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('returns NOT_ACTIVE for an unknown command id', async () => {
      const { app } = createApp();

      const response = await request(app)
        .post('/api/commands/missing-command/stop');

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_ACTIVE');
    });
  });

  it('GET /api/commands/allowed returns the sorted operator allowlist', async () => {
    const { app } = createApp();

    const response = await request(app).get('/api/commands/allowed');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(Array.from(ALLOWED_COMMANDS).sort());
  });
});
