/** Explicit operator abandonment, never a successful-run or cleanup verdict. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PATHS } from '../lib/paths.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { execGit } from '../lib/execGit.js';
import { getActiveAgentsFromRunner } from './cosRunnerClient.js';

const inputSchema = z.object({
  agentId: z.string().regex(/^agent-[a-zA-Z0-9-]+$/), runId: z.string().uuid(),
  reason: z.string().trim().min(10).max(500), confirmAbandoned: z.literal(true),
}).strict();
const refuse = message => { throw Object.assign(new Error(message), { code: 'MAINTENANCE_STALE' }); };
const digest = text => createHash('sha256').update(text).digest('hex');
const absent = path => { try { fs.lstatSync(path); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } };
const dead = pid => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
};

export async function reconcileAbandonedAgent(input, deps = {}) {
  const request = inputSchema.parse(input);
  const data = deps.data ?? PATHS.data;
  const gate = deps.gate ?? maintenance;
  const isDead = deps.isDead ?? dead;
  const hold = gate.status().hold;
  if (!hold) refuse('Begin a maintenance hold before reconciliation.');
  const runner = await (deps.runner ?? getActiveAgentsFromRunner)();
  if (!Array.isArray(runner) || runner.some(row => !row || typeof row.id !== 'string' || row.id === request.agentId))
    refuse('Runner ownership is active or unreadable.');
  const workspace = join(data, 'cos', 'worktrees', request.agentId);
  const git = deps.git ?? (args => execGit(args, PATHS.installRoot));
  const branches = await git(['branch', '--list', `*${request.agentId}*`]);
  const worktrees = await git(['worktree', 'list', '--porcelain']);
  if (branches.stdout.trim() || worktrees.stdout.split('\n').includes(`worktree ${workspace}`))
    refuse('Preserved Git work needs recovery before abandonment.');
  const receiptPath = join(gate.directory, `abandoned-${request.runId}.json`);
  const readReceipt = () => {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.version !== 1 || receipt.disposition !== 'abandoned' || receipt.runId !== request.runId
      || receipt.agentId !== request.agentId || receipt.reason !== request.reason || !receipt.operation?.id)
      refuse('The existing abandonment receipt does not match this request.');
    return receipt;
  };
  let evidence;
  const validate = operation => {
    const state = JSON.parse(fs.readFileSync(join(data, 'cos', 'state.json'), 'utf8'));
    if (!state.agents || Array.isArray(state.agents) || typeof state.agents !== 'object'
      || Object.hasOwn(state.agents, request.agentId)) refuse('Agent ownership is present or unreadable.');
    if (!absent(workspace) || !absent(join(data, 'cos', 'agents', request.agentId)))
      refuse('Retained agent output or workspace needs recovery.');
    const agentsDirectory = join(data, 'cos', 'agents');
    if (!absent(agentsDirectory) && fs.readdirSync(agentsDirectory).some(date => /^\d{4}-\d{2}-\d{2}$/.test(date)
      && !absent(join(agentsDirectory, date, request.agentId)))) refuse('Archived agent output needs recovery.');
    const raw = fs.readFileSync(join(data, 'runs', request.runId, 'metadata.json'), 'utf8');
    const run = JSON.parse(raw);
    const runWorkspace = run.workspacePath?.startsWith('~/') ? join(homedir(), run.workspacePath.slice(2)) : run.workspacePath;
    if (run.id !== request.runId || run.agentId !== request.agentId || !runWorkspace
      || resolve(runWorkspace) !== resolve(workspace) || run.endTime != null || run.success != null)
      refuse('Run identity or unfinished outcome does not match.');
    if (fs.readFileSync(join(data, 'runs', request.runId, 'output.txt')).length !== 0)
      refuse('Run output is not empty; inspect and recover it instead.');
    // Read both retained generations strictly: missing archive is normal, malformed data is not.
    const events = [];
    for (const name of ['run-events.1.jsonl', 'run-events.jsonl']) {
      const path = join(data, 'cos', name);
      if (name.includes('.1.') && absent(path)) continue;
      for (const line of fs.readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.runId === request.runId || event.agentId === request.agentId) events.push(event);
      }
    }
    if (!events.length || events.some(e => e.runId !== request.runId || e.agentId !== request.agentId || e.taskId !== run.taskId))
      refuse('Run event identity is incomplete or changed.');
    const last = events.at(-1);
    if (last.kind !== 'run.interrupted' || last.data?.reason !== 'killed-by-user')
      refuse('The last durable event is not a user interruption.');
    const handoffs = events.filter(e => e.kind === 'run.handoff');
    if (!handoffs.length || handoffs.some(e => !isDead(e.data?.pid)) || !isDead(operation.pid)) refuse('An owner process may still be alive.');
    evidence = { metadataHash: digest(raw), eventsHash: digest(JSON.stringify(events)), interruptionEventId: last.eventId };
  };
  return gate.reconcileAbandonedAgent({ hold, agentId: request.agentId,
    validate: operation => {
      try { validate(operation); } catch (error) { refuse(error.message); }
    },
    replay: () => {
      try { return { ...readReceipt(), replayed: true }; } catch (error) { refuse(error.message); }
    },
    publish: operation => {
      if (!absent(receiptPath)) {
        let prior;
        try { prior = readReceipt(); } catch (error) { refuse(error.message); }
        if (JSON.stringify(prior.operation) !== JSON.stringify(operation)
          || JSON.stringify(prior.evidence) !== JSON.stringify(evidence)) refuse('Recovery evidence changed since receipt publication.');
        return prior;
      }
      const receipt = { version: 1, disposition: 'abandoned', agentId: request.agentId, runId: request.runId,
        reason: request.reason, at: new Date().toISOString(), operation, evidence };
      const pending = `${receiptPath}.${randomUUID()}.pending`;
      const fd = fs.openSync(pending, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(receipt) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(pending, receiptPath);
      if (process.platform !== 'win32') {
        const dir = fs.openSync(gate.directory, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
      return receipt;
    },
  });
}
