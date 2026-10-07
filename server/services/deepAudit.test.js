import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { assignDeepAuditAttempt, deepAuditProgress, mergeDeepAuditReport } from '../lib/deepAudit.js';
import { prepareDeepAudit, checkpointDeepAudit } from './deepAudit.js';

vi.mock('./appQualitySchedule.js', () => ({ detectRepoCapabilities: async () => ({ capabilities: { api: true } }) }));

const blob = 'a'.repeat(40);
const scope = { revision: 'b'.repeat(40), inventoryHash: 'inventory-1', files: [
  { path: 'server/routes/example.js', blob, kind: 'blob' },
  { path: 'server/routes/other.js', blob, kind: 'blob' },
  { path: 'README.md', blob, kind: 'blob' },
], capabilities: { api: true }, exclusions: [], promptVersions: { contract: 1, category: 1 }, promptHash: 'prompt-1' };
const evidence = { method: 'Read each listed file and search all registered callers', observations: 'No concrete defects in this scenario',
  entryPoint: 'GET /example', exitPoint: 'JSON response', trace: 'route → service → store → response, including listed callers',
  scenario: 'Two writes overlap and the first write fails', expected: 'Serialize and preserve the second write', observed: 'The failure path releases the queue; regression test passes',
  challengedAssumption: 'Rechecked whether rejection strands the shared queue', conclusion: 'Queue tail catches rejection before next operation',
  command: 'npm test -- example.test.js', result: 'Both failure and concurrent write regression checks pass', review: 'Reviewed the diff and callers', delivery: 'No source change was needed' };
const task = { id: 'task-1', description: 'Audit the repository', metadata: { auditDepth: 'deep', app: 'example-app', fileIssues: true, deepAuditId: 'audit-1' } };
let database, report, pinned, deps;
beforeEach(() => {
  database = new Map(); report = null; pinned = structuredClone(scope);
  let tail = Promise.resolve();
  deps = {
    inventory: async () => structuredClone(pinned),
    write: async () => {}, read: async () => report,
    git: async () => ({ stdout: 'c'.repeat(40) }),
    // Simulate independent database reads, JSON serialization and serialized updates.
    mutate: (id, initial, fn) => {
      const result = tail.then(async () => {
        if (!database.has(id) && initial) database.set(id, JSON.stringify(initial));
        if (!database.has(id)) throw new Error('Deep audit ledger is unavailable');
        const next = await fn(JSON.parse(database.get(id)));
        database.set(id, JSON.stringify(next));
        return JSON.parse(database.get(id));
      });
      tail = result.catch(() => {});
      return result;
    },
  };
});
const saved = () => JSON.parse(database.get('audit-1'));
async function prepare(agentId, selected = task) {
  return prepareDeepAudit({ task: selected, agentId, workspacePath: '/example/repo' }, deps);
}
function payload(agentId, overrides = {}) {
  const ledger = saved();
  const attempt = ledger.attempts[agentId];
  return { version: 1, scopeHash: ledger.scopeHash, attemptId: agentId, prerequisiteHash: attempt.prerequisiteHash,
    pass: attempt.pass, units: ledger.units.filter(unit => attempt.unitIds.includes(unit.id)).map(unit => ({
      id: unit.id, status: 'evidenced', reason: 'Reviewed the full scenario with no surviving findings',
      sources: unit.files.map(path => ({ path, blob })), evidence,
    })), candidates: [], stopReason: 'Checkpoint; continue remaining passes', ...overrides };
}
async function finish(agentId, selected = task, success = true) {
  return checkpointDeepAudit({ task: selected, agentId, workspacePath: '/example/repo', success }, deps);
}

describe('Deep coverage workflow across serialized restarts', () => {
  it('gives the agent exact evidence types and rejects array observations without crediting coverage', async () => {
    const prompt = await prepare('typed-report');
    const contract = JSON.parse(prompt.match(/```json\n([^]*?)\n```/)[1]);
    expect(contract.properties.version.const).toBe(1);
    expect(contract.properties.units.items.properties.evidence.additionalProperties)
      .toMatchObject({ type: 'string', minLength: 1, maxLength: 12000 });
    report = JSON.stringify(payload('typed-report', { units: payload('typed-report').units.map(unit => ({
      ...unit, evidence: { method: 'Read source and callers', observations: ['Inspected source'] },
    })) }));
    expect(await finish('typed-report')).toMatchObject({ complete: false, satisfiedPasses: 0 });
    report = JSON.stringify(payload('typed-report'));
    expect(await finish('typed-report')).toMatchObject({ complete: false, satisfiedPasses: 6 });
  });

  it('does not equate no findings, successful exit or all files scanned with complete discovery', async () => {
    for (const [index, pass] of ['static', 'trace', 'adversarial', 'challenge'].entries()) {
      const agentId = `agent-${index}`;
      const prompt = await prepare(agentId);
      expect(prompt).toContain(`pass ${pass}`);
      report = JSON.stringify(payload(agentId));
      const result = await finish(agentId);
      expect(result.discoveryComplete).toBe(index === 3);
      expect(result.complete).toBe(index === 3);
      expect(result.requiredPasses).toBe(24);
      expect(result.satisfiedPasses).toBe((index + 1) * 6);
    }
    expect(saved().units).toHaveLength(6); // includes root README, no suffix-based omissions
  });

  it('imports an interrupted partial checkpoint, resumes remaining units, and replays idempotently', async () => {
    await prepare('first');
    const first = payload('first'); first.units = first.units.slice(0, 1);
    report = JSON.stringify(first);
    const interrupted = await finish('first', task, false);
    expect(interrupted).toMatchObject({ complete: false, satisfiedPasses: 1 });
    report = null;
    expect(await finish('first', task, false)).toEqual(interrupted);
    await prepare('resumed');
    expect(saved().attempts.resumed.unitIds).toHaveLength(5);
    report = JSON.stringify(payload('resumed'));
    expect(await finish('resumed')).toMatchObject({ satisfiedPasses: 6, complete: false });
  });

  it.each(['absent', 'malformed', 'forged unit', 'wrong blob', 'missing evidence', 'wrong pass', 'forged scope', 'incomplete inventory', 'invented complete flag'])('%s never credits discovery', async failure => {
    await prepare('a');
    const p = payload('a');
    if (failure === 'forged unit') p.units[0].id = 'unassigned';
    if (failure === 'wrong blob') p.units[0].sources[0].blob = 'e'.repeat(40);
    if (failure === 'missing evidence') p.units[0].evidence = {};
    if (failure === 'wrong pass') p.pass = 'challenge';
    if (failure === 'forged scope') p.scopeHash = 'forged';
    if (failure === 'incomplete inventory') p.units.find(unit => unit.sources.length > 1).sources.pop();
    if (failure === 'invented complete flag') p.complete = true;
    report = failure === 'absent' ? null : failure === 'malformed' ? '{' : JSON.stringify(p);
    expect(await finish('a')).toMatchObject({ complete: false, satisfiedPasses: 0 });
  });

  it('keeps blocked units and untriaged candidates visible after the first finding', async () => {
    await prepare('a'); const p = payload('a');
    p.units[0].status = 'blocked';
    p.candidates = [{ id: 'finding-1', unitId: p.units[1].id, finding: 'An error can lose the queued write', disposition: 'pending', resolution: 'Needs a reproduction' }];
    report = JSON.stringify(p);
    expect(await finish('a')).toMatchObject({ blockedUnits: 1, pendingCandidates: 1, complete: false });
    await prepare('b'); expect(saved().attempts.b.pass).toBe('static');
    expect(saved().attempts.b.unitIds).toEqual([p.units[0].id]);
  });

  it.each(['revision', 'files', 'capabilities', 'promptVersions', 'exclusions'])('invalidates changed %s while retaining stale history', async field => {
    await prepare('a'); report = JSON.stringify(payload('a')); await finish('a');
    pinned[field] = field === 'files' ? [...pinned.files, { path: 'new.js', blob }] : field === 'revision' ? 'd'.repeat(40) : { changed: true };
    await prepare('b');
    expect(saved().generation).toBe(2);
    expect(saved().invalidated[0].units[0].evidence.static).toBeDefined();
    expect(deepAuditProgress(saved()).satisfiedPasses).toBe(0);
    report = JSON.stringify({ ...payload('b'), attemptId: 'a' });
    expect(await finish('a')).toMatchObject({ complete: false, satisfiedPasses: 0 });
  });

  it('refuses source drift during inspection and accounts it as partial', async () => {
    await prepare('a'); report = JSON.stringify(payload('a')); pinned.revision = 'f'.repeat(40);
    expect(await finish('a')).toMatchObject({ complete: false, satisfiedPasses: 0 });
    expect(saved().invalidReason).toContain('Source changed');
  });

  it('requires separate challenge identity bound to preceding evidence', async () => {
    for (const agent of ['static', 'trace', 'adversarial']) { await prepare(agent); report = JSON.stringify(payload(agent)); await finish(agent); }
    await prepare('challenge'); const p = payload('challenge');
    let ledger = saved();
    ledger.units[0].evidence.trace.reason = 'Evidence changed after challenge assignment';
    expect(() => mergeDeepAuditReport(ledger, 'challenge', p)).toThrow('prerequisite evidence changed');
    ledger = saved();
    delete ledger.attempts.static;
    const attempt = assignDeepAuditAttempt(ledger, 'static');
    expect(() => mergeDeepAuditReport(ledger, 'static', { ...p, attemptId: 'static', prerequisiteHash: attempt.prerequisiteHash })).toThrow('Independent pass prerequisites');
  });

  it('requires reasoned inapplicability in all independent passes', async () => {
    for (const agent of ['a', 'b', 'c', 'd']) {
      await prepare(agent); const p = payload(agent);
      p.units.forEach(unit => { unit.status = 'inapplicable'; unit.reason = 'Documentation-only subsystem has no executable concurrency path; inspected linked declarations'; });
      report = JSON.stringify(p); await finish(agent);
    }
    expect(deepAuditProgress(saved())).toMatchObject({ discoveryComplete: true, statuses: { inapplicable: 6 } });
  });

  it('separates discovery from a revision-bound post-fix and delivery outcome', async () => {
    const fix = { ...task, metadata: { ...task.metadata, fileIssues: false } };
    for (const agent of ['a', 'b', 'c', 'd']) { await prepare(agent, fix); report = JSON.stringify(payload(agent)); await finish(agent, fix); }
    expect(deepAuditProgress(saved())).toMatchObject({ discoveryComplete: true, deliveryComplete: false });
    await prepare('fix', fix);
    report = JSON.stringify(payload('fix', { validationRevision: 'e'.repeat(40) }));
    expect(await finish('fix', fix)).toMatchObject({ complete: false });
    pinned.revision = 'c'.repeat(40);
    report = JSON.stringify(payload('fix', { validationRevision: 'c'.repeat(40) }));
    expect(await finish('fix', fix)).toMatchObject({ complete: true, deliveryComplete: true });
  });

  it('keeps quick and legacy tasks free of ledger work, refuses cross-app resume', async () => {
    const legacy = { id: 'legacy', metadata: {} };
    expect(await prepare('a', legacy)).toBeNull();
    expect(await finish('a', legacy)).toBeNull();
    expect(database.size).toBe(0);
    await prepare('a');
    await expect(prepare('b', { ...task, metadata: { ...task.metadata, app: 'another-app' } })).rejects.toThrow('same app');
  });
});

it('pins an actual Git inventory and refuses tracked and untracked drift', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-audit-test-'));
  try {
    await execGit(['init'], directory);
    await writeFile(join(directory, 'source.js'), 'export const value = 1;\n');
    await execGit(['add', '.'], directory);
    await execGit(['-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-m', 'fixture'], directory);
    const inspect = () => prepareDeepAudit({ task, agentId: 'git-agent', workspacePath: directory }, { ...deps, inventory: undefined });
    await inspect();
    const pinned = saved().scope;
    expect(pinned.promptVersions.contract).toBe(2);
    expect(pinned.files).toHaveLength(1);
    expect(pinned.files[0]).toMatchObject({ path: 'source.js', kind: 'blob' });
    await writeFile(join(directory, 'untracked.js'), 'new source');
    await expect(inspect()).rejects.toThrow('clean source snapshot');
    await rm(join(directory, 'untracked.js'));
    await writeFile(join(directory, 'source.js'), 'changed source');
    await expect(inspect()).rejects.toThrow('clean source snapshot');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it('enrolls newly discovered workflows without shrinking the mechanically inventoried scope', async () => {
  await prepare('a');
  const p = payload('a');
  p.additionalUnits = [{ subsystem: 'server/routes', scenario: 'restart during response streaming', files: ['server/routes/example.js'], reason: 'A stateful streaming route needs its own recovery trace' }];
  report = JSON.stringify(p);
  expect(await finish('a')).toMatchObject({ totalUnits: 7, requiredPasses: 28, complete: false });
  await prepare('b');
  expect(saved().attempts.b.pass).toBe('static');
  expect(saved().attempts.b.unitIds).toHaveLength(1);
});

it('does not combine post-fix checks from different source revisions', async () => {
  const fix = { ...task, metadata: { ...task.metadata, fileIssues: false } };
  for (const agent of ['a', 'b', 'c', 'd']) { await prepare(agent, fix); report = JSON.stringify(payload(agent)); await finish(agent, fix); }
  await prepare('x', fix); await prepare('y', fix);
  const x = payload('x', { validationRevision: 'c'.repeat(40) });
  const y = payload('y', { validationRevision: 'd'.repeat(40) });
  x.units = x.units.slice(0, 3); y.units = y.units.slice(3);
  pinned.revision = 'c'.repeat(40); report = JSON.stringify(x); await finish('x', fix);
  pinned.revision = 'd'.repeat(40); report = JSON.stringify(y);
  expect(await finish('y', fix)).toMatchObject({ discoveryComplete: true, deliveryComplete: false, complete: false });
  expect(saved().units.filter(unit => unit.evidence['post-fix'])).toHaveLength(3);
});

it('keeps scheduled and custom resume identities stable across task ids', async () => {
  const scheduled = { ...task, metadata: { ...task.metadata, deepAuditId: undefined } };
  await prepare('a', scheduled);
  await prepare('b', { ...scheduled, id: 'next-scheduled-task' });
  expect(database.size).toBe(1);
});

it('reopens remediation when a resolved candidate belongs to an older tested revision', async () => {
  const fix = { ...task, metadata: { ...task.metadata, fileIssues: false } };
  for (const agent of ['a', 'b', 'c', 'd']) { await prepare(agent, fix); report = JSON.stringify(payload(agent)); await finish(agent, fix); }
  await prepare('fix', fix);
  pinned.revision = 'c'.repeat(40);
  report = JSON.stringify(payload('fix', { validationRevision: pinned.revision }));
  await finish('fix', fix);
  const ledger = saved();
  ledger.candidates.example = { disposition: 'resolved', resolvedRevision: 'd'.repeat(40) };
  expect(deepAuditProgress(ledger)).toMatchObject({ discoveryComplete: true, deliveryComplete: true, remediationComplete: false, pendingRemediations: 1, complete: false });
  ledger.candidates.example.resolvedRevision = ledger.validationRevision;
  expect(deepAuditProgress(ledger)).toMatchObject({ remediationComplete: true, complete: true });
});
