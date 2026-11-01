import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { settleAuditFindings } from './auditFindings.js';

const forge = vi.hoisted(() => ({ execGh: vi.fn() }));
vi.mock('./github.js', () => forge);
vi.mock('./apps.js', () => ({ getAppById: async () => ({ repoPath: '/example/repo' }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ cwd: '/example/repo' }) }));
vi.mock('../lib/workTracker.js', () => ({
  resolveAppForgeTarget: async () => ({ tracker: 'github', target: { forge: 'github', fullName: 'example/repo', apiHost: 'github.example.com' } }),
  repoIssueUrlBase: () => 'https://github.example.com/example/repo/issues',
}));

const task = { metadata: { app: 'example', analysisType: 'security', auditDispositionVersion: '1' } };
const url = 'https://github.example.com/example/repo/issues/17';
const finding = (extra = {}) => ({ key: 'dispatch-authority', title: 'Example dispatch authority gap',
  path: 'dispatch.js', severity: 8, confidence: 'high', evidence: 'Mounted route accepted the synthetic remote request.',
  classification: 'actionable', disposition: { kind: 'issue', url }, ...extra });
const register = findings => ({ version: 1, findings });
let dir;
let deps;
const recordPath = id => join(dir, `${id}.json`);
const readRecord = async id => JSON.parse(await readFile(recordPath(id), 'utf8').catch(() => 'null'));
async function deliver(agentId, findings) {
  await writeFile(join(dir, `.agent-done-${agentId}`), JSON.stringify({
    summary: `Assessed example code.\nAUDIT_FINDINGS_JSON: ${JSON.stringify(register(findings))}`, payload: null,
  }));
}
const settle = (id = 'agent-one', currentTask = task) => settleAuditFindings({ task: currentTask, agentId: id, workspacePath: dir }, deps);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'audit-findings-'));
  forge.execGh.mockReset().mockResolvedValue(JSON.stringify({ html_url: url, state: 'open' }));
  deps = { getAgentRecord: readRecord, updateAgent: async (id, patch) => {
    const old = await readRecord(id);
    const next = { id, metadata: { auditDispositionVersion: 1, ...old?.metadata, ...patch.metadata } };
    await writeFile(recordPath(id), JSON.stringify(next));
    return readRecord(id);
  } };
});
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });

describe('persisted audit disposition workflow', () => {
  it('retains an interrupted checkpoint, carries it to a new run, and deduplicates issue readback without creating issues', async () => {
    await writeFile(join(dir, '.agent-audit-findings-agent-one.json'), JSON.stringify(register([finding()])));
    expect(await settle()).toMatchObject({ status: 'incomplete', findings: 1 });
    expect((await readRecord('agent-one')).metadata.auditFindings.report.findings).toHaveLength(1);
    const resumed = { metadata: { ...task.metadata, resumedFromAgentId: 'agent-one' } };
    await deliver('agent-two', [finding()]);
    expect(await settle('agent-two', resumed)).toMatchObject({ status: 'complete', findings: 1 });
    await rm(join(dir, '.agent-done-agent-two'));
    expect(await settle('agent-two', resumed)).toMatchObject({ status: 'complete', findings: 1 });
    expect((await readRecord('agent-two')).metadata.auditFindings.report.findings).toEqual([finding()]);
    expect(forge.execGh.mock.calls.every(([args]) => args[0] === 'api')).toBe(true);
  });

  it('cannot hide an omitted unresolved row or a malformed checkpoint behind an empty final register', async () => {
    await writeFile(join(dir, '.agent-audit-findings-agent-one.json'), JSON.stringify(register([
      finding({ disposition: { kind: 'unresolved', reason: 'Tracker creation failed' } }),
    ])));
    await deliver('agent-one', []);
    expect(await settle()).toMatchObject({ status: 'incomplete', findings: 1, unresolved: 1 });
    await writeFile(join(dir, '.agent-audit-findings-agent-one.json'), '{"findings":');
    expect(await settle()).toMatchObject({ status: 'incomplete', findings: 1, reason: 'Final findings register missing or invalid' });
  });

  it('fails closed on missing predecessor evidence but preserves compatibility with untagged historical runs', async () => {
    const resumed = { metadata: { ...task.metadata, resumedFromAgentId: 'agent-before' } };
    await deliver('agent-one', []);
    expect(await settle('agent-one', resumed)).toMatchObject({ status: 'incomplete', reason: 'Previous run findings register unavailable' });
    await writeFile(recordPath('agent-before'), JSON.stringify({ id: 'agent-before', metadata: { auditDispositionVersion: 1 } }));
    expect(await settle('agent-one', resumed)).toMatchObject({ status: 'incomplete', reason: 'Previous run findings register unavailable' });
    await writeFile(recordPath('agent-before'), JSON.stringify({ id: 'agent-before', metadata: {} }));
    expect(await settle('agent-one', resumed)).toMatchObject({ status: 'complete', findings: 0 });
  });

  it('stops verification below the finalizer deadline and never lets a late read overwrite the incomplete receipt', async () => {
    vi.useFakeTimers();
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let lateResolve;
    forge.execGh.mockImplementationOnce(() => { entered(); return new Promise(resolve => { lateResolve = resolve; }); });
    deps.verificationBudgetMs = 100;
    await deliver('agent-one', [finding(), finding({ key: 'second-boundary' })]);
    const pending = settle();
    await started;
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ status: 'incomplete', unresolved: 2 });
    lateResolve(JSON.stringify({ html_url: url, state: 'open' }));
    await Promise.resolve();
    expect(forge.execGh).toHaveBeenCalledTimes(1);
    expect((await readRecord('agent-one')).metadata.auditFindings).toMatchObject({ status: 'incomplete',
      results: [{ key: 'dispatch-authority', status: 'unchecked' }, { key: 'second-boundary', status: 'unchecked' }] });
  });

  it.each(['unreachable', 'closed', 'not-planned', 'pull-request', 'other-repository'])('retains actionable rows when issue verification is %s, then safely retries', async failure => {
    if (failure === 'unreachable') forge.execGh.mockRejectedValueOnce(new Error('offline'));
    else forge.execGh.mockResolvedValueOnce(JSON.stringify({ html_url: failure === 'other-repository' ? url.replace('/repo/', '/other/') : url,
      state: failure === 'closed' || failure === 'not-planned' ? 'closed' : 'open',
      ...(failure === 'not-planned' ? { state_reason: 'not_planned' } : {}), ...(failure === 'pull-request' ? { pull_request: {} } : {}) }));
    await deliver('agent-one', [finding()]);
    expect(await settle()).toMatchObject({ status: 'incomplete', unresolved: 1 });
    expect((await readRecord('agent-one')).metadata.auditFindings.report.findings).toEqual([finding()]);
    expect(await settle()).toMatchObject({ status: 'complete', unresolved: 0 });
  });

  it('accepts an issue a concurrent claim closed as completed before verification ran', async () => {
    forge.execGh.mockResolvedValueOnce(JSON.stringify({ html_url: url, state: 'closed', state_reason: 'completed' }));
    await deliver('agent-one', [finding()]);
    expect(await settle()).toMatchObject({ status: 'complete', unresolved: 0 });
  });

  it('requires reachable commit evidence and explicit validation without executing model-supplied commands', async () => {
    await execGit(['init'], dir);
    await writeFile(join(dir, 'dispatch.js'), 'export const authorized = true;\n');
    await execGit(['add', 'dispatch.js'], dir);
    await execGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Add synthetic boundary'], dir);
    const commit = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
    const fixed = finding({ disposition: { kind: 'fixed', commit, validation: 'Synthetic mounted route regression and authorized control passed.' } });
    await deliver('agent-one', [fixed]);
    expect(await settle()).toMatchObject({ status: 'complete' });
    await deliver('agent-one', [{ ...fixed, path: 'unrelated.js' }]);
    expect(await settle()).toMatchObject({ status: 'incomplete', unresolved: 1 });
    expect(forge.execGh).not.toHaveBeenCalled();
  });

  it('accepts a fix merged to the fetched default branch after the audit branch was cut', async () => {
    const commitAll = async message => {
      await execGit(['add', '-A'], dir);
      await execGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message], dir);
      return (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
    };
    await execGit(['init', '-b', 'main'], dir);
    await writeFile(join(dir, 'dispatch.js'), 'export const authorized = false;\n');
    const base = await commitAll('Base');
    await writeFile(join(dir, 'dispatch.js'), 'export const authorized = true;\n');
    const merged = await commitAll('Fix through another PR');
    await execGit(['checkout', '-b', 'audit', base], dir);
    const fixed = finding({ disposition: { kind: 'fixed', commit: merged, validation: 'Sibling PR regression passed.' } });
    await deliver('agent-one', [fixed]);
    // Unfetched, the commit is reachable from no published ref: still unverified.
    expect(await settle()).toMatchObject({ status: 'incomplete', unresolved: 1 });
    await execGit(['update-ref', 'refs/remotes/origin/main', merged], dir);
    await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], dir);
    expect(await settle()).toMatchObject({ status: 'complete', unresolved: 0 });
  });

  it('keeps candidate confidence separate and refuses a persistence failure', async () => {
    await deliver('agent-one', [finding({ classification: 'candidate', confidence: 'low',
      disposition: { kind: 'unresolved', reason: 'Trace the deferred consumer before claiming impact.' } })]);
    expect(await settle()).toMatchObject({ status: 'complete', unconfirmed: 1, unresolved: 0 });
    expect((await readRecord('agent-one')).metadata.auditFindings.report.findings[0].confidence).toBe('low');
    deps.updateAgent = vi.fn().mockRejectedValue(new Error('disk unavailable'));
    await expect(settle()).rejects.toThrow('disk unavailable');
  });
});
