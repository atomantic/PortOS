import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const makeLogProcess = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn(),
}));
vi.mock('../services/appProcessStatus.js', () => ({
  resolveRegisteredProcess: vi.fn(),
}));

vi.mock('../services/pm2.js', () => ({
  buildEnv: vi.fn((pm2Home) => ({ ...(pm2Home ? { PM2_HOME: pm2Home } : {}) })),
  getLogs: vi.fn(),
  spawnPm2: vi.fn(),
}));

import * as appProcessStatus from '../services/appProcessStatus.js';
import * as pm2Service from '../services/pm2.js';
import logsRoutes from './logs.js';

const createApp = () => {
  const app = express();
  app.use('/api/logs', logsRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('log routes PM2_HOME resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appProcessStatus.resolveRegisteredProcess.mockResolvedValue({ pm2Home: null });
    pm2Service.getLogs.mockResolvedValue('line');
    pm2Service.spawnPm2.mockImplementation(() => {
      const child = makeLogProcess();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
  });

  it.each(['--force', '-1', '.hidden', 'x'.repeat(121)])('rejects unsafe name %s before static or streaming PM2 reads', async (name) => {
    for (const follow of ['false', 'true']) {
      const response = await request(createApp()).get(`/api/logs/${name}?follow=${follow}`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_PROCESS_NAME');
    }
    expect(pm2Service.getLogs).not.toHaveBeenCalled();
    expect(pm2Service.spawnPm2).not.toHaveBeenCalled();
    expect(appProcessStatus.resolveRegisteredProcess).not.toHaveBeenCalled();
  });

  it.each(['all', 'unrelated-host-proc'])('rejects unregistered process %s with 400 UNKNOWN_PROCESS before static or streaming PM2 reads', async (name) => {
    appProcessStatus.resolveRegisteredProcess.mockResolvedValue(null);
    for (const follow of ['false', 'true']) {
      const response = await request(createApp()).get(`/api/logs/${name}?follow=${follow}`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('UNKNOWN_PROCESS');
    }
    expect(appProcessStatus.resolveRegisteredProcess).toHaveBeenCalledWith(name);
    expect(pm2Service.getLogs).not.toHaveBeenCalled();
    expect(pm2Service.spawnPm2).not.toHaveBeenCalled();
  });

  it.each(['1-worker', '_worker'])('reads accepted anchored name %s', async (name) => {
    appProcessStatus.resolveRegisteredProcess.mockResolvedValue({ pm2Home: null });
    const response = await request(createApp()).get(`/api/logs/${name}`);
    expect(response.status).toBe(200);
    expect(pm2Service.getLogs).toHaveBeenCalledWith(name, 100, null);
  });

  it('fetches static logs for a process from its resolved custom PM2 home', async () => {
    appProcessStatus.resolveRegisteredProcess.mockResolvedValue({ pm2Home: '/tmp/example-pm2' });

    const response = await request(createApp()).get('/api/logs/example-api?lines=50');

    expect(response.status).toBe(200);
    expect(appProcessStatus.resolveRegisteredProcess).toHaveBeenCalledWith('example-api');
    expect(pm2Service.getLogs).toHaveBeenCalledWith('example-api', 50, '/tmp/example-pm2');
  });

  it('returns the error envelope when a static process log read fails', async () => {
    pm2Service.getLogs.mockRejectedValueOnce(new Error('PM2 log read failed'));

    const response = await request(createApp()).get('/api/logs/example-api');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: 'PM2 log read failed',
      code: 'INTERNAL_ERROR',
      timestamp: expect.any(Number),
    });
    expect(response.body).not.toHaveProperty('logs');
  });

  it('follows a process from its resolved custom PM2 home', async () => {
    appProcessStatus.resolveRegisteredProcess.mockResolvedValue({ pm2Home: '/tmp/example-pm2' });

    const response = await request(createApp()).get('/api/logs/example-api?follow=true');

    expect(response.status).toBe(200);
    expect(appProcessStatus.resolveRegisteredProcess).toHaveBeenCalledWith('example-api');
    expect(pm2Service.buildEnv).toHaveBeenCalledWith('/tmp/example-pm2');
    expect(pm2Service.spawnPm2).toHaveBeenCalledWith(
      ['logs', 'example-api', '--raw', '--lines', '100'],
      { env: { PM2_HOME: '/tmp/example-pm2' } }
    );
  });

  it('follows a process from the default PM2 home when no custom home resolves', async () => {
    appProcessStatus.resolveRegisteredProcess.mockResolvedValue({ pm2Home: null });

    const response = await request(createApp()).get('/api/logs/example-api?follow=true&lines=25');

    expect(response.status).toBe(200);
    expect(pm2Service.buildEnv).toHaveBeenCalledWith(null);
    expect(pm2Service.spawnPm2).toHaveBeenCalledWith(
      ['logs', 'example-api', '--raw', '--lines', '25'],
      { env: {} }
    );
  });

  it('ends the SSE response when spawning the log process emits an error without close', async () => {
    pm2Service.spawnPm2.mockImplementation(() => {
      const child = makeLogProcess();
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    });

    const response = await request(createApp()).get('/api/logs/example-api?follow=true');

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error\ndata: {"error":"spawn failed"}\n\n');
    expect(response.text).not.toContain('event: close');
  });

  it('keeps fragmented stdout and stderr separate and flushes their final lines before closing', async () => {
    pm2Service.spawnPm2.mockImplementation(() => {
      const child = makeLogProcess();
      queueMicrotask(() => {
        const text = Buffer.from('caf\u00e9 ready\nstdout tail');
        child.stdout.emit('data', text.subarray(0, 4));
        child.stderr.emit('data', Buffer.from('warning\nstderr tail'));
        child.stdout.emit('data', text.subarray(4));
        child.emit('close', 1);
      });
      return child;
    });

    const response = await request(createApp()).get('/api/logs/example-api?follow=true');
    const frames = response.text.trim().split('\n\n').map(frame => {
      const [event, data] = frame.split('\n');
      return { event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) };
    });

    expect(frames.map(({ event, data }) => [event, data.line ?? data.code])).toEqual([
      ['connected', undefined],
      ['stderr', 'warning'],
      ['stdout', 'caf\u00e9 ready'],
      ['stdout', 'stdout tail'],
      ['stderr', 'stderr tail'],
      ['close', 1],
    ]);
  });

  it('rejects lines query parameter > 5000 with 400', async () => {
    const response = await request(createApp()).get('/api/logs/example-api?lines=100000000');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects lines query parameter < 1 with 400', async () => {
    const response = await request(createApp()).get('/api/logs/example-api?lines=-5');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects non-numeric lines query parameter with 400', async () => {
    const response = await request(createApp()).get('/api/logs/example-api?lines=abc');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

});
