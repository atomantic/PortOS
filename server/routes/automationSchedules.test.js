import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import * as scheduler from '../services/automationScheduler.js';
import { getAgentById } from '../services/agent/agentPersonalities.js';
import { logAction } from '../services/history.js';
import { getAccountById } from '../services/platformAccounts.js';
import router from './automationSchedules.js';

vi.mock('../services/automationScheduler.js', () => ({
  getAllSchedules: vi.fn(),
  getSchedulesByAgent: vi.fn(),
  getSchedulesByAccount: vi.fn(),
  getStats: vi.fn(),
  getScheduleById: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  toggleSchedule: vi.fn(),
  runNow: vi.fn(),
}));
vi.mock('../services/agent/agentPersonalities.js', () => ({ getAgentById: vi.fn() }));
vi.mock('../services/platformAccounts.js', () => ({ getAccountById: vi.fn() }));
vi.mock('../services/history.js', () => ({ logAction: vi.fn() }));

const base = '/api/agents/schedules';
const payload = {
  agentId: 'agent-example',
  accountId: 'account-example',
  action: { type: 'monitor' },
  schedule: { type: 'interval', intervalMs: 60_000 },
};
const parsedPayload = { ...payload, enabled: true, action: { type: 'monitor', params: {} } };
const saved = { id: 'schedule-example', ...parsedPayload };
const schedulePath = `${base}/${saved.id}`;
const auditDetails = { agentId: saved.agentId, action: saved.action.type };

const app = express();
app.use(express.json());
app.use(base, router);
app.use(errorMiddleware);

describe('Automation schedules routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue({ id: saved.agentId });
    getAccountById.mockResolvedValue({ id: saved.accountId, agentId: saved.agentId });
  });

  it.each([
    { query: '', service: scheduler.getAllSchedules, args: [] },
    { query: '?agentId=agent-example', service: scheduler.getSchedulesByAgent, args: [saved.agentId] },
    { query: '?accountId=account-example', service: scheduler.getSchedulesByAccount, args: [saved.accountId] },
  ])('lists schedules with filter "$query"', async ({ query, service, args }) => {
    service.mockResolvedValue([saved]);
    const { status, body } = await request(app).get(`${base}${query}`);
    expect(status).toBe(200);
    expect(body).toEqual([saved]);
    expect(service).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it('rejects a repeated list filter before reading schedules', async () => {
    const { status, body } = await request(app).get(`${base}?agentId=first&agentId=second`);
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(scheduler.getSchedulesByAgent).not.toHaveBeenCalled();
  });

  it('returns stats at the static path without looking up a schedule ID', async () => {
    const stats = { total: 2, enabled: 1, active: 1, totalRuns: 3, byAction: { monitor: 2 } };
    scheduler.getStats.mockResolvedValue(stats);
    const { status, body } = await request(app).get(`${base}/stats`);
    expect(status).toBe(200);
    expect(body).toEqual(stats);
    expect(scheduler.getScheduleById).not.toHaveBeenCalled();
  });

  it('reads one schedule by ID', async () => {
    scheduler.getScheduleById.mockResolvedValue(saved);
    const { status, body } = await request(app).get(schedulePath);
    expect(status).toBe(200);
    expect(body).toEqual(saved);
    expect(scheduler.getScheduleById).toHaveBeenCalledExactlyOnceWith(saved.id);
  });

  it('creates a schedule with defaults after confirming account ownership and records the action', async () => {
    scheduler.createSchedule.mockResolvedValue(saved);
    const { status, body } = await request(app).post(base).send(payload);
    expect(status).toBe(201);
    expect(body).toEqual(saved);
    expect(getAgentById).toHaveBeenCalledExactlyOnceWith(saved.agentId);
    expect(getAccountById).toHaveBeenCalledExactlyOnceWith(saved.accountId);
    expect(scheduler.createSchedule).toHaveBeenCalledExactlyOnceWith(parsedPayload);
    expect(logAction).toHaveBeenCalledExactlyOnceWith('create', 'automation-schedule', saved.id, auditDetails);
  });

  it('rejects invalid schedule timing before looking up the owner', async () => {
    const { status, body } = await request(app).post(base).send({
      ...payload,
      schedule: { type: 'interval' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(getAgentById).not.toHaveBeenCalled();
    expect(getAccountById).not.toHaveBeenCalled();
    expect(scheduler.createSchedule).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'AGENT_NOT_FOUND', statusCode: 404, lookup: getAgentById, result: null },
    { code: 'ACCOUNT_NOT_FOUND', statusCode: 404, lookup: getAccountById, result: null },
    {
      code: 'ACCOUNT_AGENT_MISMATCH',
      statusCode: 400,
      lookup: getAccountById,
      result: { id: saved.accountId, agentId: 'other-agent' },
    },
  ])('refuses creation with $code before writing or auditing', async ({ code, statusCode, lookup, result }) => {
    lookup.mockResolvedValue(result);
    const { status, body } = await request(app).post(base).send(payload);
    expect(status).toBe(statusCode);
    expect(body.code).toBe(code);
    expect(scheduler.createSchedule).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('updates without supplying omitted fields and records the action', async () => {
    const update = { rateLimit: { maxPerDay: 3 } };
    const updated = { ...saved, enabled: false, ...update };
    scheduler.updateSchedule.mockResolvedValue(updated);
    const { status, body } = await request(app).put(schedulePath).send(update);
    expect(status).toBe(200);
    expect(body).toEqual(updated);
    expect(scheduler.updateSchedule).toHaveBeenCalledExactlyOnceWith(saved.id, update);
    expect(logAction).toHaveBeenCalledExactlyOnceWith('update', 'automation-schedule', saved.id, auditDetails);
  });

  it('deletes a schedule and records the deletion', async () => {
    scheduler.deleteSchedule.mockResolvedValue(true);
    const { status, body } = await request(app).delete(schedulePath);
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(scheduler.deleteSchedule).toHaveBeenCalledExactlyOnceWith(saved.id);
    expect(logAction).toHaveBeenCalledExactlyOnceWith('delete', 'automation-schedule', saved.id, {});
  });

  it('passes explicit false through the toggle route and records it', async () => {
    const disabled = { ...saved, enabled: false };
    scheduler.toggleSchedule.mockResolvedValue(disabled);
    const { status, body } = await request(app).post(`${schedulePath}/toggle`).send({ enabled: false });
    expect(status).toBe(200);
    expect(body).toEqual(disabled);
    expect(scheduler.toggleSchedule).toHaveBeenCalledExactlyOnceWith(saved.id, false);
    expect(logAction).toHaveBeenCalledExactlyOnceWith('toggle', 'automation-schedule', saved.id, { enabled: false });
  });

  it('runs a schedule immediately and records the action', async () => {
    scheduler.runNow.mockResolvedValue(saved);
    const { status, body } = await request(app).post(`${schedulePath}/run`);
    expect(status).toBe(200);
    expect(body).toEqual(saved);
    expect(scheduler.runNow).toHaveBeenCalledExactlyOnceWith(saved.id);
    expect(logAction).toHaveBeenCalledExactlyOnceWith('run', 'automation-schedule', saved.id, auditDetails);
  });

  it.each([
    { method: 'put', path: schedulePath, service: scheduler.updateSchedule, input: { enabled: 'false' } },
    { method: 'post', path: `${schedulePath}/toggle`, service: scheduler.toggleSchedule, input: {} },
    { method: 'post', path: `${schedulePath}/toggle`, service: scheduler.toggleSchedule, input: { enabled: 'false' } },
  ])('validates $method $path with $input before writing or auditing', async ({ method, path, service, input }) => {
    const { status, body } = await request(app)[method](path).send(input);
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(service).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'get', path: schedulePath, service: scheduler.getScheduleById, result: null },
    { method: 'put', path: schedulePath, service: scheduler.updateSchedule, result: null, input: { enabled: true } },
    { method: 'delete', path: schedulePath, service: scheduler.deleteSchedule, result: false },
    { method: 'post', path: `${schedulePath}/toggle`, service: scheduler.toggleSchedule, result: null, input: { enabled: true } },
    { method: 'post', path: `${schedulePath}/run`, service: scheduler.runNow, result: null },
  ])('returns 404 from $method $path when the schedule is missing', async ({ method, path, service, result, input }) => {
    service.mockResolvedValue(result);
    const { status, body } = await request(app)[method](path).send(input);
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
    expect(logAction).not.toHaveBeenCalled();
  });
});
