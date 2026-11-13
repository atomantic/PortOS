import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const f = vi.hoisted(() => ({ agents: [], active: [], pulls: [], tags: [], runs: {}, fail: false, malformed: false }));
vi.mock('./cosClaimOwnershipState.js', () => ({ readClaimOwnershipAgents: async () => f.agents }));
vi.mock('./agentState.js', () => ({ getActiveAgentIds: () => f.active }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async path => ({ isGithub: true, host: 'github.com', fullName: path.endsWith('other') ? 'example/other' : 'example/repo' }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({}) }));
vi.mock('./github.js', () => ({ execGh: vi.fn(async args => {
  if (f.fail) throw new Error('Forge unavailable');
  const path = args.at(-1);
  if (path.includes('/pulls?')) return JSON.stringify(f.pulls);
  if (path.includes('/git/matching-refs/')) return JSON.stringify(f.tags);
  const status = new URL('https://example.com/' + path).searchParams.get('status');
  return JSON.stringify(f.malformed ? {} : { total_count: f.runs[status] ?? 0 });
}) }));
import { releasePreflight } from './releasePreflight.js';
import { execGh } from './github.js';

let root, repo, sibling, other;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'release-preflight-'));
  repo = join(root, 'repo');
  sibling = join(root, 'candidate');
  other = join(root, 'other');
  await materializeGitRepo(repo);
  await writeFile(join(repo, 'package.json'), '{"version":"1.2.3"}');
  await execGit(['add', 'package.json'], repo);
  await execGit(['commit', '-m', 'Set fixture version'], repo);
  await materializeGitRepo(other);
  await execGit(['worktree', 'add', '-b', 'codex/release-agent-old', sibling, 'main'], repo);
});
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
beforeEach(() => {
  Object.assign(f, { agents: [], active: [], pulls: [], tags: [], runs: {}, fail: false, malformed: false });
  vi.clearAllMocks();
});
const run = extra => releasePreflight({ repoPath: repo, agentId: 'agent-current', version: '1.2.3', ...extra });
const agent = (status, path = repo, type = 'do-release') => ({ id: 'agent-old', status,
  metadata: { taskAnalysisType: type, workspacePath: path, releaseCandidateRecovery: { status: 'held' } } });

describe('release startup pre-flight', () => {
  it('starts fresh after an interrupted candidate without requiring historical recovery metadata', async () => {
    f.agents = [agent('completed')];
    expect(await run({ version: undefined })).toEqual({ ok: true });
    expect((await execGit(['show-ref', '--verify', 'refs/heads/codex/release-agent-old'], repo)).exitCode).toBe(0);
  });
  it('recognizes running release and synchronization owners across worktrees, while allowing another repository', async () => {
    f.agents = [agent('running', sibling)];
    expect(await run()).toEqual({ ok: false, reason: 'release-agent-active' });
    f.agents = [agent('running', sibling, 'release-sync')];
    expect(await run()).toEqual({ ok: false, reason: 'release-agent-active' });
    f.agents = [agent('running', other)];
    expect(await run()).toEqual({ ok: true });
    expect(await run({ agentId: 'agent-old' })).toEqual({ ok: true });
  });
  it('keeps a completed record active while its process remains registered and refuses unreadable ownership', async () => {
    f.agents = [agent('completed')]; f.active = ['agent-old'];
    expect(await run()).toEqual({ ok: false, reason: 'release-agent-active' });
    f.agents = null;
    expect(await run()).toEqual({ ok: false, reason: 'release-ownership-unavailable' });
  });
  it('refuses an open promotion or the exact proposed version tag, allowing a tag prefix match', async () => {
    f.pulls = [{ number: 12 }];
    expect(await run()).toEqual({ ok: false, reason: 'release-promotion-active' });
    f.pulls = []; f.tags = [{ ref: 'refs/tags/v1.2.30' }];
    expect(await run()).toEqual({ ok: true });
    f.tags.push({ ref: 'refs/tags/v1.2.3' });
    expect(await run()).toEqual({ ok: false, reason: 'release-tag-present' });
    expect(await run({ version: '1.2.4' })).toEqual({ ok: true });
  });
  it('checks unfinished workflow statuses across the whole history, including old re-runs', async () => {
    f.runs = { waiting: 1 };
    expect(await run()).toEqual({ ok: false, reason: 'release-workflow-active' });
    expect(execGh.mock.calls.some(([args]) => args.at(-1).includes('status=waiting'))).toBe(true);
  });
  it('propagates forge failures and malformed responses instead of treating them as an idle repository', async () => {
    f.fail = true;
    await expect(run()).rejects.toThrow('Forge unavailable');
    f.fail = false; f.malformed = true;
    await expect(run()).rejects.toThrow('Invalid release workflow response');
  });
});
