import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { canonicalSnapshotChecksum } from '../lib/snapshotChecksum.js';
import { assignDeepAuditAttempt, createDeepAuditLedger, deepAuditAssignment, deepAuditInstructions, deepAuditProgress,
  mergeDeepAuditReport, refreshDeepAuditScope } from '../lib/deepAudit.js';
import { checkpointDeepAudit } from './deepAudit.js';

vi.mock('./appQualitySchedule.js', () => ({ detectRepoCapabilities: async () => ({ capabilities: { api: true } }) }));

const blob = 'a'.repeat(40);
const scope = { revision: 'b'.repeat(40), inventoryHash: 'inventory-1', files: [
  { path: 'server/routes/example.js', blob, kind: 'blob' },
  { path: 'server/routes/other.js', blob, kind: 'blob' },
  { path: 'README.md', blob, kind: 'blob' },
], capabilities: { api: true }, exclusions: [], promptVersions: { contract: 1, category: 1 }, promptHash: 'prompt-1' };
const evidence = { inbound: 'routes/example.js caller', outbound: 'store/example.js dependency', boundaryObservations: 'Failure returns through route and store boundary', unresolvedBoundaries: 'None after tracing the pinned callers', boundaryFailures: 'Store rejection reaches the route error handler', boundaryChallenge: 'Independently traced rejection across route/store boundary', method: 'Read each listed file and search all registered callers', observations: 'No concrete defects in this scenario',
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
// Deep launches no longer create ledgers; seed one the way retained legacy ledgers were written.
async function prepare(agentId, selected = task, seedScope = pinned) {
  if (!selected.metadata?.auditDepth) return null;
  const scope = structuredClone(seedScope);
  const initial = createDeepAuditLedger({ id: selected.metadata.deepAuditId || 'audit-1', appId: selected.metadata.app, category: 'code-quality', scope,
    delivery: selected.metadata.fileIssues === true ? 'file-issues' : 'fix' });
  const ledger = await deps.mutate(initial.id, initial, current => {
    const refreshed = refreshDeepAuditScope(current, scope);
    assignDeepAuditAttempt(refreshed, agentId);
    return refreshed;
  });
  const prefix = `.portos-deep-${canonicalSnapshotChecksum(agentId).slice(0, 24)}`;
  const paths = { ledgerPath: `${prefix}-ledger.json`, assignmentPath: `${prefix}-assignment.json`, reportPath: `${prefix}-report.json` };
  await deps.write(paths.ledgerPath, ledger);
  await deps.write(paths.assignmentPath, deepAuditAssignment(ledger, ledger.attempts[agentId]));
  return deepAuditInstructions({ ledger, attempt: ledger.attempts[agentId], ...paths });
}
function payload(agentId, overrides = {}) {
  const ledger = saved();
  const attempt = ledger.attempts[agentId];
  return { version: 1, scopeHash: ledger.scopeHash, attemptId: agentId, prerequisiteHash: attempt.prerequisiteHash,
    pass: attempt.pass, units: ledger.units.filter(unit => attempt.unitIds.includes(unit.id)).map(unit => ({
      id: unit.id, status: 'evidenced', reason: 'Reviewed the full scenario with no surviving findings',
      sources: unit.files.map(path => ({ path, blob })), evidence: structuredClone(evidence),
    })), candidates: [], stopReason: 'Checkpoint; continue remaining passes', ...overrides };
}
async function finish(agentId, selected = task, success = true) {
  return checkpointDeepAudit({ task: selected, agentId, workspacePath: '/example/repo', success }, deps);
}

describe('Deep coverage workflow across serialized restarts', () => {
  it('batches serialized resumes without crediting omitted or out-of-batch units', async () => {
    pinned.files = Array.from({ length: 10 }, (_, i) => ({ path: `area-${i}/source.js`, blob, kind: 'blob' }));
    const writes = new Map();
    deps.write = async (path, value) => writes.set(path, structuredClone(value));
    const seen = new Set();
    for (let i = 0; i < 12 && seen.size < 30; i++) {
      const id = `batch-${i}`;
      await prepare(id);
      const ledger = saved();
      const attempt = ledger.attempts[id];
      expect(attempt.unitIds.length).toBeLessThanOrEqual(12);
      if (attempt.pass === 'static') for (const unit of attempt.unitIds) { expect(seen.has(unit)).toBe(false); seen.add(unit); }
      const projection = [...writes].find(([path]) => path.endsWith('-assignment.json') && writes.get(path).attempt.id === id)[1];
      expect(projection.units.map(unit => unit.id)).toEqual(attempt.unitIds);
      expect(projection).not.toHaveProperty('invalidated');
      expect(projection).not.toHaveProperty('attempts');
      expect(projection.progress.requiredPasses).toBe(120);
      if (i === 0) {
        const outside = ledger.units.find(unit => !attempt.unitIds.includes(unit.id));
        report = JSON.stringify(payload(id, { units: [{ ...payload(id).units[0], id: outside.id }] }));
        expect(await finish(id)).toMatchObject({ complete: false, satisfiedPasses: 0 });
      }
      report = JSON.stringify(payload(id));
      expect(await finish(id)).toMatchObject({ complete: false, discoveryComplete: false });
    }
    expect(seen.size).toBe(30);
    expect(Object.values(saved().attempts).some(attempt => attempt.pass === 'trace')).toBe(true);
  });

  it('preserves findings outside the batch and rejects candidate identity collisions', async () => {
    pinned.files = Array.from({ length: 5 }, (_, i) => ({ path: `area-${i}/source.js`, blob, kind: 'blob' }));
    await prepare('first');
    const firstUnit = saved().attempts.first.unitIds[0];
    const candidate = { id: 'first-finding', unitId: firstUnit, finding: 'Inspect the failure path', disposition: 'pending', resolution: 'Requires later validation' };
    report = JSON.stringify(payload('first', { candidates: [candidate] }));
    await finish('first');
    for (let i = 0; i < 3; i++) {
      const id = `advance-${i}`; await prepare(id); report = JSON.stringify(payload(id)); await finish(id);
    }
    await prepare('second');
    const before = deepAuditProgress(saved()).satisfiedPasses;
    const secondUnit = saved().attempts.second.unitIds[0];
    for (const invalid of [candidate, { ...candidate, unitId: secondUnit }]) {
      report = JSON.stringify(payload('second', { candidates: [invalid] }));
      expect(await finish('second')).toMatchObject({ satisfiedPasses: before, complete: false });
      expect(saved().candidates['first-finding'].unitId).toBe(firstUnit);
    }
    report = JSON.stringify(payload('second'));
    await finish('second');
    expect(saved().candidates['first-finding']).toMatchObject(candidate);
  });

  it('bounds publication retries while retaining all previously completed coverage', async () => {
    pinned.files = Array.from({ length: 5 }, (_, i) => ({ path: `area-${i}/source.js`, blob, kind: 'blob' }));
    for (let i = 0; i < 8; i++) {
      const id = `discovery-${i}`;
      await prepare(id);
      report = JSON.stringify(payload(id));
      await finish(id, task, false);
    }
    expect(deepAuditProgress(saved())).toMatchObject({ discoveryComplete: true, deliveryComplete: false });
    await prepare('delivery-retry');
    expect(saved().attempts['delivery-retry']).toMatchObject({ deliveryOnly: true, pass: 'challenge' });
    expect(saved().attempts['delivery-retry'].unitIds).toHaveLength(12);
    report = JSON.stringify(payload('delivery-retry'));
    expect(await finish('delivery-retry', task, false)).toMatchObject({ satisfiedPasses: 60, deliveryComplete: false });
    await prepare('published'); report = JSON.stringify(payload('published'));
    expect(await finish('published')).toMatchObject({ satisfiedPasses: 60, complete: true });
  });

  it('partitions 1626 files without omissions and advances other partitions past a persistent blocker', async () => {
    pinned.files = Array.from({ length: 1626 }, (_, i) => ({ path: `large/${String(i).padStart(4, '0')}.js`, blob, kind: 'blob' }));
    await prepare('first');
    const initial = saved();
    expect(initial.groups).toHaveLength(3);
    for (const group of initial.groups) {
      const owned = initial.units.filter(unit => unit.groupId === group.id).flatMap(unit => unit.files);
      expect(owned).toEqual(pinned.files.map(file => file.path));
      expect(new Set(owned).size).toBe(1626);
    }
    expect(initial.units.every(unit => unit.files.length <= 24)).toBe(true);
    const p = payload('first'); p.units[0].status = 'blocked';
    const blocked = p.units[0].id;
    report = JSON.stringify(p); await finish('first', task, false);
    const passes = new Set();
    for (let i = 0; i < 3; i++) {
      const id = `resume-${i}`; await prepare(id);
      const ledger = saved(), attempt = ledger.attempts[id];
      passes.add(attempt.pass);
      expect(attempt.unitIds).not.toContain(blocked);
      expect(new Set(ledger.units.filter(unit => attempt.unitIds.includes(unit.id)).flatMap(unit => unit.files)).size).toBeLessThanOrEqual(96);
      report = JSON.stringify(payload(id)); await finish(id);
    }
    expect([...passes]).toEqual(['trace', 'adversarial', 'challenge']);
    expect(deepAuditProgress(saved())).toMatchObject({ blockedUnits: 1, complete: false, reviewedUnits: 11 });
    expect(saved().units.find(unit => unit.id === blocked).evidence.trace).toBeUndefined();
  });

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
    expect(saved().attempts.resumed).toMatchObject({ pass: 'trace', unitIds: [first.units[0].id] });
    report = JSON.stringify(payload('resumed'));
    expect(await finish('resumed')).toMatchObject({ satisfiedPasses: 2, complete: false });
    expect(saved().units.filter(unit => !unit.evidence.static)).toHaveLength(5);
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
    await prepare('b'); expect(saved().attempts.b.pass).toBe('trace');
    expect(saved().attempts.b.unitIds).not.toContain(p.units[0].id);
    expect(saved().candidates['finding-1'].disposition).toBe('pending');
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
  });
});

it('enrolls newly discovered workflows without shrinking the mechanically inventoried scope', async () => {
  await prepare('a');
  const p = payload('a');
  p.additionalUnits = [{ subsystem: 'server/routes', scenario: 'restart during response streaming', files: ['server/routes/example.js'], reason: 'A stateful streaming route needs its own recovery trace' }];
  report = JSON.stringify(p);
  expect(await finish('a')).toMatchObject({ totalUnits: 7, requiredPasses: 28, complete: false });
  await prepare('b');
  expect(saved().attempts.b.pass).toBe('trace');
  expect(saved().units.find(unit => unit.scenario === 'restart during response streaming').evidence).toEqual({});
  expect(deepAuditProgress(saved()).requiredPasses).toBe(28);
});

it('does not combine post-fix batches from different source revisions and reassigns cleared units', async () => {
  pinned.files = Array.from({ length: 5 }, (_, i) => ({ path: `area-${i}/source.js`, blob, kind: 'blob' }));
  const fix = { ...task, metadata: { ...task.metadata, fileIssues: false } };
  for (let i = 0; i < 8; i++) {
    const agent = `discovery-${i}`;
    await prepare(agent, fix); report = JSON.stringify(payload(agent)); await finish(agent, fix);
  }
  await prepare('x', fix);
  const firstIds = saved().attempts.x.unitIds;
  expect(firstIds).toHaveLength(12);
  report = JSON.stringify(payload('x', { validationRevision: pinned.revision }));
  expect(await finish('x', fix)).toMatchObject({ complete: false });
  await prepare('y', fix);
  expect(saved().attempts.y.unitIds).toHaveLength(3);
  pinned.revision = 'd'.repeat(40);
  report = JSON.stringify(payload('y', { validationRevision: pinned.revision }));
  expect(await finish('y', fix)).toMatchObject({ discoveryComplete: true, deliveryComplete: false, complete: false });
  const ledger = saved();
  expect(ledger.units.filter(unit => unit.evidence['post-fix'])).toHaveLength(3);
  expect(assignDeepAuditAttempt(ledger, 'cleared').unitIds).toEqual(firstIds);
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


it('migrates a serialized v2 generation transactionally without crediting old receipts or losing enrolled findings', async () => {
  pinned.promptVersions.contract = 2;
  pinned.files = Array.from({ length: 50 }, (_, i) => ({ path: `large/${String(i).padStart(3, '0')}.js`, blob, kind: 'blob' }));
  const groups = ['normal', 'failure', 'concurrency-recovery', 'enrolled workflow'].map(scenario => ({
    id: canonicalSnapshotChecksum({ category: 'code-quality', subsystem: 'large', scenario }),
    category: 'code-quality', subsystem: 'large', scenario, files: pinned.files.map(file => file.path),
    evidence: { static: { status: 'evidenced', agentId: 'old-agent', evidence, sources: pinned.files.map(({ path, blob }) => ({ path, blob })) } },
  }));
  const old = { version: 1, id: 'audit-1', appId: 'example-app', category: 'code-quality', delivery: 'file-issues',
    scope: structuredClone(pinned), scopeHash: canonicalSnapshotChecksum(pinned), generation: 1,
    units: groups, invalidated: [], attempts: { 'old-agent': { generation: 1, pass: 'static', unitIds: groups.map(group => group.id) } },
    candidates: { legacy: { id: 'legacy', unitId: groups[0].id, finding: 'Verified broken source link', disposition: 'confirmed', resolution: 'Pinned target is absent' } } };
  database.set('audit-1', JSON.stringify(old));
  pinned.promptVersions.contract = 3;
  await prepare('migrated');
  const ledger = saved();
  expect(ledger).toMatchObject({ generation: 2, coverageMigration: { priorRequiredPasses: 16, requiredPasses: 48 } });
  expect(ledger.groups).toHaveLength(4);
  expect(ledger.units).toHaveLength(12);
  expect(deepAuditProgress(ledger).satisfiedPasses).toBe(0);
  expect(ledger.invalidated).toHaveLength(1);
  expect(ledger.invalidated[0].units[0].evidence.static.agentId).toBe('old-agent');
  expect(ledger.candidates.legacy).toMatchObject({ unitId: groups[0].id, groupScoped: true, disposition: 'confirmed' });
  await prepare('migrated');
  expect(saved().invalidated).toHaveLength(1);
  const legacy = saved().candidates.legacy;
  report = JSON.stringify(payload('migrated', { candidates: [{ id: legacy.id, unitId: legacy.unitId,
    finding: legacy.finding, disposition: 'confirmed', resolution: 'Rechecked the pinned broken link' }] }));
  expect(await finish('migrated')).toMatchObject({ satisfiedPasses: 12, complete: false, pendingRemediations: 1 });
  expect(saved().candidates.legacy.groupScoped).toBe(true);
  expect(await finish('old-agent')).toMatchObject({ satisfiedPasses: 12, complete: false });
});

it('requires cross-boundary evidence before accepting a trace', async () => {
  await prepare('static'); report = JSON.stringify(payload('static')); await finish('static');
  await prepare('trace');
  const p = payload('trace');
  for (const unit of p.units) delete unit.evidence.boundaryObservations;
  report = JSON.stringify(p);
  expect(await finish('trace')).toMatchObject({ satisfiedPasses: 6, complete: false });
  expect(saved().reason).toContain('Missing trace evidence');
});

it('checkpoints against a real Git inventory and refuses tracked and untracked drift', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-audit-test-'));
  try {
    await execGit(['init'], directory);
    await writeFile(join(directory, 'source.js'), 'export const value = 1;\n');
    await execGit(['add', '.'], directory);
    await execGit(['-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-m', 'fixture'], directory);
    const realDeps = { ...deps, inventory: undefined };
    const checkpoint = () => checkpointDeepAudit({ task, agentId: 'git-agent', workspacePath: directory, success: true }, realDeps);
    await writeFile(join(directory, 'untracked.js'), 'new source');
    await prepare('git-agent');
    report = null;
    expect(await checkpoint()).toMatchObject({ complete: false });
    expect(saved().reason).toContain('clean source snapshot');
    await rm(join(directory, 'untracked.js'));
    await writeFile(join(directory, 'source.js'), 'changed source');
    expect(await checkpoint()).toMatchObject({ complete: false });
    expect(saved().reason).toContain('clean source snapshot');
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

it('rejects a late static report after its partition has advanced through independent review', async () => {
  await prepare('static-a'); await prepare('static-b');
  const late = payload('static-b');
  report = JSON.stringify(payload('static-a')); await finish('static-a');
  for (const id of ['trace', 'adversarial', 'challenge']) {
    await prepare(id); report = JSON.stringify(payload(id)); await finish(id);
  }
  expect(deepAuditProgress(saved()).satisfiedPasses).toBe(24);
  report = JSON.stringify(late);
  expect(await finish('static-b')).toMatchObject({ satisfiedPasses: 24 });
  expect(saved().reason).toContain('prerequisite evidence changed');
  expect(saved().units.every(unit => unit.evidence.static.agentId === 'static-a')).toBe(true);
  expect(saved().attempts['static-b'].reportHash).toBeUndefined();
});
