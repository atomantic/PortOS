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

function createApp(io = { emit: vi.fn() }) {
  const app = express();
  app.set('io', io);
  app.use(express.json());
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
