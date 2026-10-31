import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { execGit } from '../lib/execGit.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

const fixture = vi.hoisted(() => ({ state: null, disk: null, trusted: true, failSave: false, apps: {}, prs: {}, refs: {}, peers: [], beforeForge: null }));
const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-external-admission-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
vi.mock('../services/cosState.js', () => ({
  withStateLock: createFileWriteQueue(),
  loadState: async () => fixture.state,
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: fixture.trusted, ...structuredClone(fixture.disk) }),
  saveState: async state => {
    if (fixture.failSave) throw new Error('synthetic persistence failure');
    fixture.disk = structuredClone(state); fixture.state = state;
  },
}));
vi.mock('../services/apps.js', () => ({ getAppById: async id => fixture.apps[id] ?? null }));
vi.mock('../services/github.js', () => ({ execGh: async args => {
  const fields = Object.fromEntries(args.filter((_, index) => ['-f', '-F'].includes(args[index - 1]))
    .map(field => { const split = field.indexOf('='); return [field.slice(0, split), field.slice(split + 1)]; }));
  const repository = `${args[args.indexOf('--hostname') + 1]}/${fields.owner}/${fields.name}`;
  await fixture.beforeForge?.(repository);
  const ref = fixture.refs[repository];
  return JSON.stringify({ data: { repository: { nameWithOwner: `${fields.owner}/${fields.name}`,
    pullRequest: Number(fields.number) === 7 ? fixture.prs[repository] : null,
    ref: ref && `${ref.prefix}${ref.name}` === fields.baseRef ? ref : null } } });
} }));
vi.mock('../services/forgeExecOptions.js', () => ({ resolveForgeExecOptions: async cwd => ({ cwd, env: {} }) }));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: async () => ({ peers: fixture.peers }) }));
vi.mock('../services/cosAgentArchive.js', () => ({}));
vi.mock('../services/cosAgentFeedback.js', () => ({}));
vi.mock('../services/cosAgentIndex.js', () => ({}));
vi.mock('../services/cosAgentLifecycle.js', () => ({}));
vi.mock('../services/cosHealthMonitor.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));
vi.mock('../services/instances.js', () => ({ wakePeerProbe: vi.fn() }));

let app, auth, tokenA, tokenB, example, other;
const sessionA = '1'.repeat(64);
const sessionB = '2'.repeat(64);
const persist = () => { fixture.disk = structuredClone(fixture.state); };
const git = async (cwd, ...args) => (await execGit(args, cwd)).stdout.trim();
const post = (body, { token = tokenA, session = sessionA, headers = {} } = {}) => {
  let call = request(app).post('/api/cos/merge-admission/external');
  if (token) call = call.set('Authorization', `Bearer ${token}`);
  if (session) call = call.set('X-PortOS-Admission-Session', session);
  for (const [key, value] of Object.entries(headers)) call = call.set(key, value);
  return call.send(body);
};
const acquire = (repo = example, options) => post({ action: 'acquire', ...repo.input }, options);
const release = (token, options) => post({ action: 'release', token, outcome: 'leave-open' }, options);
const check = (token, options) => post({ action: 'check', token }, options);

async function makeRepository(name) {
  const repoPath = join(tempRoot, name);
  const worktreePath = join(tempRoot, `${name}-worktree`);
  await mkdir(repoPath);
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Example');
  await git(repoPath, 'config', 'user.email', 'example@example.com');
  await git(repoPath, 'commit', '--allow-empty', '-m', 'Synthetic fixture');
  await git(repoPath, 'remote', 'add', 'origin', `https://github.com/example/${name}.git`);
  await git(repoPath, 'worktree', 'add', '-b', 'feature', worktreePath);
  const headSha = await git(worktreePath, 'rev-parse', 'HEAD');
  const reviewFile = await git(worktreePath, 'rev-parse', '--path-format=absolute', '--git-path', 'portos-review-status');
  const input = { appId: name, worktreePath, prUrl: `https://github.com/example/${name}/pull/7`, headSha, baseSha: headSha, baseBranch: 'main' };
  return { repoPath, worktreePath, reviewFile, input, key: `github.com/example/${name}` };
}

beforeAll(async () => {
  await writeFile(join(tempRoot, 'settings.json'), '{}');
  await writeFile(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}');
  auth = await import('../services/auth.js');
  await auth.setPassword({ newPassword: 'synthetic-test-password' });
  tokenA = (await auth.createSession({ label: 'agent-key' })).token;
  tokenB = (await auth.createSession({ label: 'other-operator' })).token;
  example = await makeRepository('repo');
  other = await makeRepository('other');
  const { authGate, hostControlRouteGate } = await import('../services/authGate.js');
  const routes = (await import('./cosAgentRoutes.js')).default;
  app = express();
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/cos', routes);
  app.use(errorMiddleware);
});
afterAll(async () => {
  await globalThis.__portosGitSupervisorCleanup?.();
  cleanup();
});
beforeEach(async () => {
  fixture.trusted = true; fixture.failSave = false; fixture.peers = []; fixture.beforeForge = null;
  fixture.state = { agents: {}, mergeAdmissions: {} }; persist();
  fixture.apps = {}; fixture.prs = {}; fixture.refs = {};
  for (const repo of [example, other]) {
    const { input } = repo;
    fixture.apps[input.appId] = { id: input.appId, repoPath: repo.repoPath };
    fixture.prs[repo.key] = { url: input.prUrl, number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false,
      headRefName: 'feature', headRefOid: input.headSha, baseRefName: 'main', baseRefOid: 'a'.repeat(40) };
    fixture.refs[repo.key] = { prefix: 'refs/heads/', name: 'main', target: { __typename: 'Commit', oid: input.baseSha } };
    await writeFile(repo.reviewFile, `REVIEW_STATUS=clean\nREVIEW_HEAD=${input.headSha}\n`);
  }
});

describe('outside merge admission through the authenticated HTTP boundary', () => {
  it('fences the checked live base independently of the historical PR base on acquire and check', async () => {
    const historicalBase = fixture.prs[example.key].baseRefOid;
    expect(historicalBase).not.toBe(example.input.baseSha);
    expect((await acquire({ ...example, input: { ...example.input, baseSha: historicalBase } })).body)
      .toMatchObject({ admitted: false, reason: 'external-pr-changed' });
    expect(fixture.state.mergeAdmissions).toEqual({});
    const { body: granted } = await acquire();
    expect(granted).toMatchObject({ admitted: true, baseSha: example.input.baseSha, baseBranch: 'main' });
    expect((await check(granted.token)).body.admitted).toBe(true);
    fixture.refs[example.key].target.oid = 'f'.repeat(40);
    expect((await check(granted.token)).body).toMatchObject({ admitted: false, reason: 'external-pr-changed' });
    expect((await release(granted.token)).body.released).toBe(true);
    expect((await acquire()).body).toMatchObject({ admitted: false, reason: 'external-pr-changed' });
  });

  it.each(['deleted-ref', 'non-commit', 'head', 'repository'])('refuses acquisition with a %s forge target', async mode => {
    if (mode === 'deleted-ref') fixture.refs[example.key] = null;
    if (mode === 'non-commit') fixture.refs[example.key].target.__typename = 'Tag';
    if (mode === 'head') fixture.prs[example.key].headRefOid = 'f'.repeat(40);
    if (mode === 'repository') fixture.prs[example.key].url = other.input.prUrl;
    expect((await acquire()).body).toMatchObject({ admitted: false, reason: 'external-pr-changed' });
    expect(fixture.state.mergeAdmissions).toEqual({});
  });

  it('orders preparation across sessions, blocks legacy overtaking and refreshes only the base binding', async () => {
    const waiter = (input = example.input) => post({ action: 'prepare', ...input }, { session: sessionB });
    const first = (await post({ action: 'prepare', ...example.input })).body;
    expect(first.prepared).toBe(true);
    expect(fixture.state.mergeAdmissions).toEqual({});
    expect((await waiter()).body.prepared).toBe(false);
    expect((await acquire(example, { session: sessionB })).body.admitted).toBe(false);
    const nextBase = 'a'.repeat(40);
    fixture.refs[example.key].target.oid = nextBase;
    expect((await acquire()).body).toMatchObject({ admitted: false, reason: 'external-pr-changed' });
    const refreshed = { ...example.input, baseSha: nextBase };
    expect((await post({ action: 'prepare', ...refreshed })).body).toEqual(first);
    const lease = (await post({ action: 'acquire', ...refreshed })).body;
    expect(lease).toMatchObject({ admitted: true, baseSha: nextBase });
    expect((await release(lease.token)).body.released).toBe(true);
    expect((await waiter(refreshed)).body.prepared).toBe(true);
    // A foreign session cannot yield another session's turn.
    expect((await post({ action: 'yield', token: first.preparationToken }, { session: sessionB })).body)
      .toMatchObject({ admitted: false, reason: 'preparation-owner-mismatch' });
  });

  it('expires many abandoned external waiters together while preserving a polling session behind them', async () => {
    const polling = () => post({ action: 'prepare', ...example.input }, { session: sessionB });
    let now = Date.now();
    const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const first = (await post({ action: 'prepare', ...example.input })).body;
      expect(first.prepared).toBe(true);
      for (let index = 1; index <= 12; index++) {
        const session = index.toString(16).padStart(64, '0');
        expect((await post({ action: 'prepare', ...example.input }, { session })).body.prepared).toBe(false);
      }
      expect((await polling()).body.prepared).toBe(false);
      for (let minute = 0; minute < 3; minute++) {
        now += 60_000;
        expect((await polling()).body.prepared).toBe(false);
      }
      expect(fixture.state.mergePreparations[example.key]).toHaveLength(2);
      expect((await post({ action: 'yield', token: first.preparationToken })).body.yielded).toBe(true);
      expect((await polling()).body.prepared).toBe(true);
      expect(fixture.state.mergeAdmissions).toEqual({});
    } finally { date.mockRestore(); }
  });

  it('binds a real operator credential and separate run secret without creating CoS agents', async () => {
    const granted = await acquire();
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ admitted: true, repository: example.key, headSha: example.input.headSha });
    const token = granted.body.token;
    expect((await acquire()).body.token).toBe(token);
    expect((await check(token)).body.admitted).toBe(true);
    expect((await check(token, { token: tokenB })).body).toMatchObject({ admitted: false, reason: 'lease-owner-mismatch' });
    expect((await release(token, { session: sessionB })).body).toMatchObject({ admitted: false, reason: 'lease-owner-mismatch' });
    expect(fixture.state.agents).toEqual({});
    expect(JSON.stringify(fixture.disk)).not.toContain(sessionA);
    // An after-merge checkout/head change does not strand the owned release.
    fixture.prs[example.key].state = 'MERGED';
    expect((await release(token)).body.released).toBe(true);
    expect(fixture.state.mergeAdmissions).toEqual({});
  });

  it('refuses anonymous/peer callers, missing secrets and identity injection before admission', async () => {
    expect((await acquire(example, { token: null })).status).toBe(401);
    expect((await acquire(example, { session: null })).status).toBe(403);
    expect((await post({ action: 'acquire', ...example.input, agentId: 'parent-example' })).status).toBe(400);
    const { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } = await import('../lib/peerHttpClient.js');
    const secret = 'synthetic-pair-secret'.repeat(3);
    fixture.peers = [{ id: 'example-peer', instanceId: 'example-instance', syncSecret: secret, enabled: true }];
    const peer = await acquire(example, { token: null, headers: {
      [PEER_AUTH_HEADER]: derivePeerAuthToken(secret, 'example-instance'), [PEER_INSTANCE_HEADER]: 'example-instance',
    } });
    expect(peer.status).toBe(403);
    expect(fixture.state.mergeAdmissions).toEqual({});
  });

  it('serializes outside sessions on one repository but not across repositories', async () => {
    const [first, second] = await Promise.all([acquire(), acquire(example, { session: sessionB })]);
    expect([first.body.admitted, second.body.admitted].sort()).toEqual([false, true]);
    expect((await acquire(other)).body.admitted).toBe(true);
    const winner = first.body.admitted ? first : second;
    const loserSession = first.body.admitted ? sessionB : sessionA;
    await release(winner.body.token, { session: first.body.admitted ? sessionA : sessionB });
    expect((await acquire(example, { session: loserSession })).body.admitted).toBe(true);
  });

  it.each(['head', 'base', 'base-branch', 'repository', 'review', 'owner', 'checkout'])('withholds check when the %s proof changes and retains owned release', async mode => {
    const { body: granted } = await acquire();
    expect(granted.admitted).toBe(true);
    if (mode === 'head') fixture.prs[example.key].headRefOid = 'f'.repeat(40);
    if (mode === 'base') fixture.refs[example.key].target.oid = 'f'.repeat(40);
    if (mode === 'base-branch') fixture.prs[example.key].baseRefName = 'release';
    if (mode === 'repository') fixture.apps.repo.repoPath = other.repoPath;
    if (mode === 'review') await writeFile(example.reviewFile, `REVIEW_STATUS=clean\nREVIEW_HEAD=${'f'.repeat(40)}\n`);
    if (mode === 'checkout') fixture.state.mergeAdmissions[example.key].target.checkoutIdentity = 'different-checkout';
    if (mode === 'owner') fixture.state.agents.parent = { id: 'parent', status: 'running', metadata: { workspacePath: example.worktreePath } };
    persist();
    expect((await check(granted.token)).body.admitted).toBe(false);
    expect((await release(granted.token)).body.released).toBe(true);
  });

  it('keeps forge waits outside the state queue and rejects intervening same-repository ownership', async () => {
    let entered, resume;
    let paused = false;
    const started = new Promise(resolve => { entered = resolve; });
    const resumed = new Promise(resolve => { resume = resolve; });
    // Only the first example-repository proof waits on the forge.
    fixture.beforeForge = async repository => { if (repository === example.key && !paused) { paused = true; entered(); await resumed; } };
    const pending = acquire().then(response => response);
    await started;
    try {
      // These must settle while the outside network proof is still paused.
      expect((await acquire(other)).body.admitted).toBe(true);
      const intervening = await acquire(example, { session: sessionB });
      expect(intervening.body.admitted).toBe(true);
      const busy = await acquire(example, { session: '3'.repeat(64) });
      expect(busy.body).toMatchObject({ admitted: false, reason: 'owner-active-or-unverified' });
      expect((await release(intervening.body.token, { session: sessionB })).body.released).toBe(true);
    } finally { resume(); }
    expect((await pending).body).toMatchObject({ admitted: false, reason: 'lease-target-changed' });
    expect(fixture.state.mergeAdmissions[example.key]).toBeUndefined();
  });

  it('rechecks local review evidence after the forge request returns', async () => {
    fixture.beforeForge = () => writeFile(example.reviewFile, `REVIEW_STATUS=blocked\nREVIEW_HEAD=${example.input.headSha}\n`);
    expect((await acquire()).body).toMatchObject({ admitted: false, reason: 'review-evidence-incomplete' });
    expect(fixture.state.mergeAdmissions).toEqual({});
  });

  it('recovers an interrupted owner only after the bounded deadline and invalidates its token', async () => {
    const { body: first } = await acquire();
    expect((await acquire(example, { session: sessionB })).body.admitted).toBe(false);
    fixture.state.mergeAdmissions[example.key].acquiredAt = '2000-01-01T00:00:00Z'; persist();
    expect((await check(first.token)).body.reason).toBe('lease-expired');
    const { body: successor } = await acquire(example, { session: sessionB });
    expect(successor.admitted).toBe(true);
    expect(successor.token).not.toBe(first.token);
    expect((await release(first.token)).body.released).not.toBe(true);
    expect((await check(successor.token, { session: sessionB })).body.admitted).toBe(true);
  });

  it.each(['unreadable', 'stale', 'malformed', 'write'])('fails closed on %s state without granting or claiming release', async mode => {
    const { body: granted } = await acquire();
    if (mode === 'unreadable') fixture.trusted = false;
    if (mode === 'stale') fixture.disk.mergeAdmissions = {};
    if (mode === 'malformed') { fixture.state.mergeAdmissions[example.key].target = null; persist(); }
    if (mode === 'write') fixture.failSave = true;
    expect((await release(granted.token)).body.released).not.toBe(true);
    expect(fixture.state.mergeAdmissions[example.key]).toBeDefined();
    expect((await acquire(example, { session: sessionB })).body.admitted).not.toBe(true);
  });

  it('never remembers a grant whose persistence failed and rechecks revoked authority', async () => {
    fixture.failSave = true;
    expect((await acquire()).status).toBe(500);
    expect(fixture.state.mergeAdmissions).toEqual({});
    fixture.failSave = false;
    const ephemeral = (await auth.createSession({ label: 'synthetic-outside-session' })).token;
    const { body: granted } = await acquire(example, { token: ephemeral });
    expect(granted.admitted).toBe(true);
    await auth.revokeSession(ephemeral);
    expect((await check(granted.token, { token: ephemeral })).status).toBe(401);
    expect((await release(granted.token, { token: ephemeral })).status).toBe(401);
    expect(fixture.state.mergeAdmissions[example.key]).toBeDefined();
  });

  it('rechecks authority after asynchronous target proof before committing a grant', async () => {
    const ephemeral = (await auth.createSession({ label: 'synthetic-revoked-during-proof' })).token;
    fixture.beforeForge = () => auth.revokeSession(ephemeral);
    expect((await acquire(example, { token: ephemeral })).status).toBe(403);
    expect(fixture.state.mergeAdmissions).toEqual({});
  });

  it('preserves genuine local authority with auth off and refuses proxy/remote reachability', async () => {
    await auth.clearPassword({ currentPassword: 'synthetic-test-password' });
    try {
      expect((await acquire(example, { token: null, headers: { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' } })).status).toBe(403);
      const { body: granted } = await acquire(example, { token: null });
      expect(granted.admitted).toBe(true);
      expect((await release(granted.token, { token: null })).body.released).toBe(true);
    } finally {
      await auth.setPassword({ newPassword: 'synthetic-test-password' });
      tokenA = (await auth.createSession({ label: 'agent-key' })).token;
      tokenB = (await auth.createSession({ label: 'other-operator' })).token;
    }
  });
});
