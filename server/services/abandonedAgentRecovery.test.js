import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { reconcileAbandonedAgent } from './abandonedAgentRecovery.js';
let data, gate, request, deps, operation, hold;
const save = (path, value) => fs.writeFileSync(path, JSON.stringify(value));
beforeEach(() => {
  data = fs.mkdtempSync(join(tmpdir(), 'abandoned-agent-'));
  gate = createMaintenanceAdmission(data);
  request = { agentId: 'agent-example', runId: randomUUID(), reason: 'Operator confirms duplicate was abandoned', confirmAbandoned: true };
  fs.mkdirSync(join(data, 'cos'), { recursive: true });
  fs.mkdirSync(join(data, 'runs', request.runId), { recursive: true });
  save(join(data, 'cos', 'state.json'), { agents: {} });
  save(join(data, 'runs', request.runId, 'metadata.json'), { id: request.runId, agentId: request.agentId,
    taskId: 'example-task', workspacePath: join(data, 'cos', 'worktrees', request.agentId), endTime: null, success: null });
  fs.writeFileSync(join(data, 'runs', request.runId, 'output.txt'), '');
  fs.writeFileSync(join(data, 'cos', 'run-events.jsonl'), [
    { kind: 'run.handoff', data: { pid: 12345 } },
    { kind: 'run.interrupted', data: { reason: 'killed-by-user' } },
  ].map(e => JSON.stringify({ eventId: randomUUID(), runId: request.runId, agentId: request.agentId, taskId: 'example-task', ...e })).join('\n'));
  operation = gate.admit('agent', request.agentId);
  gate.admit('provider', 'other-work');
  hold = gate.begin({ owner: 'Operator', reason: 'Recovery' }).hold;
  deps = { data, gate, isDead: () => true, runner: async () => [], git: async () => ({ stdout: '' }) };
});
afterEach(() => fs.rmSync(data, { recursive: true, force: true }));
it('records abandonment, preserves unrelated work and hold, and replays without claiming success', async () => {
  const receipt = await reconcileAbandonedAgent(request, deps);
  expect(receipt).toMatchObject({ disposition: 'abandoned', operation: { id: operation.id } });
  expect(gate.status()).toMatchObject({ state: 'draining', hold, blockers: [{ resource: 'other-work' }] });
  expect(JSON.parse(fs.readFileSync(join(gate.directory, `abandoned-${request.runId}.json`)))).toEqual(receipt);
  expect(await reconcileAbandonedAgent(request, deps)).toMatchObject({ ...receipt, replayed: true });
  expect(JSON.parse(fs.readFileSync(join(data, 'runs', request.runId, 'metadata.json'))).success).toBeNull();
});
it.each(['live pid', 'runner owner', 'bad runner', 'agent owner', 'saved output', 'workspace', 'branch', 'bad metadata', 'bad events', 'not user-killed', 'unsettled', 'runner reservation', 'archived output', 'later live handoff'])('preserves ownership for %s and leaves the journal usable', async problem => {
  if (problem === 'live pid') deps.isDead = () => false;
  if (problem === 'runner owner') deps.runner = async () => [{ id: request.agentId }];
  if (problem === 'bad runner') deps.runner = async () => null;
  if (problem === 'agent owner') save(join(data, 'cos', 'state.json'), { agents: { [request.agentId]: { status: 'paused' } } });
  if (problem === 'saved output') fs.writeFileSync(join(data, 'runs', request.runId, 'output.txt'), 'unsaved work');
  if (problem === 'workspace') fs.mkdirSync(join(data, 'cos', 'worktrees', request.agentId), { recursive: true });
  if (problem === 'branch') deps.git = async () => ({ stdout: 'preserved-branch' });
  if (problem === 'bad metadata') fs.writeFileSync(join(data, 'runs', request.runId, 'metadata.json'), '{');
  if (problem === 'bad events') fs.writeFileSync(join(data, 'cos', 'run-events.jsonl'), '{');
  if (problem === 'not user-killed') fs.writeFileSync(join(data, 'cos', 'run-events.jsonl'), JSON.stringify({ agentId: request.agentId, runId: request.runId, taskId: 'example-task', kind: 'run.completed' }));
  if (problem === 'unsettled') operation.markUnsettled();
  if (problem === 'archived output') fs.mkdirSync(join(data, 'cos', 'agents', '2020-01-01', request.agentId), { recursive: true });
  if (problem === 'later live handoff') {
    const path = join(data, 'cos', 'run-events.jsonl');
    const events = fs.readFileSync(path, 'utf8').split('\n');
    events.splice(1, 0, JSON.stringify({ eventId: randomUUID(), runId: request.runId, agentId: request.agentId, taskId: 'example-task', kind: 'run.handoff', data: { pid: 888 } }));
    fs.writeFileSync(path, events.join('\n')); deps.isDead = pid => pid !== 888;
  }
  if (problem === 'runner reservation') gate.recoverOwned('runner', request.agentId);
  await expect(reconcileAbandonedAgent(request, deps)).rejects.toThrow();
  expect(gate.status().state).toBe('draining');
  expect(gate.status().blockers).toContainEqual(expect.objectContaining({ resource: request.agentId }));
});
it('refuses a changed hold between runner inspection and the journal transaction', async () => {
  deps.runner = async () => { gate.resume({ id: hold.id, revision: hold.revision }); gate.begin({ owner: 'Other', reason: 'Other hold' }); return []; };
  await expect(reconcileAbandonedAgent(request, deps)).rejects.toThrow('hold changed');
  expect(gate.status().blockers).toContainEqual(expect.objectContaining({ resource: request.agentId }));
});
it('never spends an old receipt to clear a replacement reservation', async () => {
  await reconcileAbandonedAgent(request, deps);
  gate.recoverOwned('agent', request.agentId);
  await expect(reconcileAbandonedAgent(request, deps)).rejects.toThrow('evidence changed');
  expect(gate.status().blockers).toContainEqual(expect.objectContaining({ resource: request.agentId }));
});

it('reuses a fully published receipt when the journal removal did not commit', async () => {
  const path = join(gate.directory, 'state.json');
  const before = fs.readFileSync(path);
  const receipt = await reconcileAbandonedAgent(request, deps);
  fs.writeFileSync(path, before); // disposable fixture: receipt-first interruption
  expect(await reconcileAbandonedAgent(request, deps)).toEqual(receipt);
  expect(gate.status().blockers).toEqual([expect.objectContaining({ resource: 'other-work' })]);
});

it('refuses a malformed prior receipt without stranding the journal lock', async () => {
  fs.writeFileSync(join(gate.directory, `abandoned-${request.runId}.json`), '{');
  await expect(reconcileAbandonedAgent(request, deps)).rejects.toThrow();
  expect(gate.status().state).toBe('draining');
  expect(gate.status().blockers).toContainEqual(expect.objectContaining({ resource: request.agentId }));
});
