import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';

const makeLogProcess = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn(),
  resolvePm2HomeForProcess: vi.fn(),
}));

vi.mock('../services/pm2.js', () => ({
  buildEnv: vi.fn((pm2Home) => ({ ...(pm2Home ? { PM2_HOME: pm2Home } : {}) })),
  getLogs: vi.fn(),
  spawnPm2: vi.fn(),
}));

import * as appsService from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';
import logsRoutes from './logs.js';

const createApp = () => {
  const app = express();
  app.use('/api/logs', logsRoutes);
  return app;
};

describe('log routes PM2_HOME resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pm2Service.getLogs.mockResolvedValue('line');
    pm2Service.spawnPm2.mockImplementation(() => {
      const child = makeLogProcess();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
  });

  it('uses the app custom home for every process in the app log response', async () => {
    appsService.getAppById.mockResolvedValue({
      id: 'app-1',
      name: 'Example App',
      pm2Home: '/tmp/example-pm2',
      pm2ProcessNames: ['example-api', 'example-ui'],
    });

    const response = await request(createApp()).get('/api/logs/app/app-1?lines=250');

    expect(response.status).toBe(200);
    expect(pm2Service.getLogs).toHaveBeenNthCalledWith(1, 'example-api', 250, '/tmp/example-pm2');
    expect(pm2Service.getLogs).toHaveBeenNthCalledWith(2, 'example-ui', 250, '/tmp/example-pm2');
  });

  it('keeps app log responses on the default home when no custom home is configured', async () => {
    appsService.getAppById.mockResolvedValue({
      id: 'app-1',
      name: 'Example App',
      pm2ProcessNames: ['example-api'],
    });

    const response = await request(createApp()).get('/api/logs/app/app-1');

    expect(response.status).toBe(200);
    expect(pm2Service.getLogs).toHaveBeenCalledWith('example-api', 100, undefined);
  });

  it('fetches static logs for a process from its resolved custom PM2 home', async () => {
    appsService.resolvePm2HomeForProcess.mockResolvedValue('/tmp/example-pm2');

    const response = await request(createApp()).get('/api/logs/example-api?lines=50');

    expect(response.status).toBe(200);
    expect(appsService.resolvePm2HomeForProcess).toHaveBeenCalledWith('example-api');
    expect(pm2Service.getLogs).toHaveBeenCalledWith('example-api', 50, '/tmp/example-pm2');
  });

  it('follows a process from its resolved custom PM2 home', async () => {
    appsService.resolvePm2HomeForProcess.mockResolvedValue('/tmp/example-pm2');

    const response = await request(createApp()).get('/api/logs/example-api?follow=true');

    expect(response.status).toBe(200);
    expect(appsService.resolvePm2HomeForProcess).toHaveBeenCalledWith('example-api');
    expect(pm2Service.buildEnv).toHaveBeenCalledWith('/tmp/example-pm2');
    expect(pm2Service.spawnPm2).toHaveBeenCalledWith(
      ['logs', 'example-api', '--raw', '--lines', '100'],
      { env: { PM2_HOME: '/tmp/example-pm2' } }
    );
  });

  it('follows a process from the default PM2 home when no custom home resolves', async () => {
    appsService.resolvePm2HomeForProcess.mockResolvedValue(null);

    const response = await request(createApp()).get('/api/logs/example-api?follow=true&lines=25');

    expect(response.status).toBe(200);
    expect(pm2Service.buildEnv).toHaveBeenCalledWith(null);
    expect(pm2Service.spawnPm2).toHaveBeenCalledWith(
      ['logs', 'example-api', '--raw', '--lines', '25'],
      { env: {} }
    );
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
});
