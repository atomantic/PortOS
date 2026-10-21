import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const engineState = vi.hoisted(() => ({ resolve: null }));
vi.mock('./dockerEngine.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveDockerEngine: vi.fn(async () => engineState.resolve()),
}));

const {
  __resetDockerContainmentState, getDockerContainmentStatus, reconcileDockerContainment, runContained,
} = await import('./dockerContainment.js');

/** A ready engine whose CLI answers from `responses` (first matching prefix wins) and records every call. */
function fakeEngine(responses = []) {
  const calls = [];
  const capture = vi.fn(async (args) => {
    calls.push(args.join(' '));
    const hit = responses.find(([prefix]) => args.join(' ').startsWith(prefix));
    return hit ? { success: true, stdout: '', stderr: '', ...hit[1] } : { success: true, stdout: '', stderr: '' };
  });
  return { state: 'ready', ready: true, message: 'ready', engine: { kind: 'native', label: 'Docker Engine', context: 'default' }, cli: { bin: 'docker', globalArgs: [], capture }, calls };
}

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'portos-contained-svc-')));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

beforeEach(() => {
  __resetDockerContainmentState();
  engineState.resolve = vi.fn(() => { throw new Error('Docker must not be consulted'); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('reconcileDockerContainment', () => {
  it('makes no Docker call at boot or on a status read while the feature is off', async () => {
    expect(await reconcileDockerContainment({ enabled: false, reason: 'boot' })).toEqual({ enabled: false, changed: false });
    expect(await getDockerContainmentStatus({ enabled: false })).toMatchObject({ state: 'disabled', engine: null, images: [] });
    expect(engineState.resolve).not.toHaveBeenCalled();
  });

  it('creates the egress network and sweeps orphans when turned on, and removes everything when turned off', async () => {
    const engine = fakeEngine([
      ['network inspect', { success: false }],
      ['ps --all', { stdout: 'portos-contained-rold\trold\n' }],
      ['network ls', { stdout: 'portos-contained-egress\tshared\nportos-contained-net-rold\trold\n' }],
      ['volume ls', { stdout: `portos-contained-work-aaa\trold\taaa\t${Date.now() - 2 * 86_400_000}\nportos-contained-work-bbb\trnew\tbbb\t${Date.now()}\nportos-contained-npm-cache\tshared\t\t${Date.now()}\n` }],
    ]);
    engineState.resolve = vi.fn(() => engine);
    const on = await reconcileDockerContainment({ enabled: true, reason: 'feature-toggle' });
    expect(on).toMatchObject({ enabled: true, changed: true, removed: { containers: 1, networks: 1, volumes: 1 } });
    expect(engine.calls).toContain('network create --label org.portos.containment.run=shared portos-contained-egress');
    expect(engine.calls).toContain('rm --force portos-contained-rold');
    expect(engine.calls).toContain('network rm portos-contained-net-rold');
    expect(engine.calls).toContain('volume rm --force portos-contained-work-aaa');
    expect(engine.calls).not.toContain('network rm portos-contained-egress');
    expect(engine.calls).not.toContain('volume rm --force portos-contained-work-bbb');

    engine.calls.length = 0;
    const off = await reconcileDockerContainment({ enabled: false, reason: 'feature-toggle' });
    expect(off).toMatchObject({ enabled: false, changed: true });
    expect(engine.calls).toEqual(expect.arrayContaining([
      'network rm portos-contained-egress',
      'volume rm --force portos-contained-work-bbb',
      'volume rm --force portos-contained-npm-cache',
    ]));
  });
});

it("leaves another process's live run alone: only stopped containers, and a fresh run network survives", async () => {
  const freshRun = `r${Date.now().toString(36)}abcdef12`;
  const engine = fakeEngine([
    ['network inspect', { success: true }],
    ['ps --all', { stdout: `portos-contained-proxy-${freshRun}\t${freshRun}\tcreated\n` }],
    ['network ls', { stdout: `portos-contained-net-${freshRun}\t${freshRun}\n` }],
  ]);
  engineState.resolve = vi.fn(() => engine);
  await reconcileDockerContainment({ enabled: true, reason: 'boot' });
  const ps = engine.calls.find((call) => call.startsWith('ps --all'));
  expect(ps).toContain('--filter status=exited');
  expect(ps).not.toContain('status=running');
  expect(engine.calls.some((call) => call.startsWith('rm --force') || call.startsWith('network rm'))).toBe(false);
});

// These refusals sit behind the mount-source check, which accepts only absolute POSIX paths. A
// Windows host's temp dir is refused there first (the resolver also refuses win32 hosts outright,
// see dockerEngine.test.js), so the ordering below is only observable on a POSIX host.
const POSIX_HOST = process.platform !== 'win32';

describe('runContained refusals', () => {
  it.runIf(!POSIX_HOST)('refuses a non-POSIX worktree path at the mount check, before any image probe', async () => {
    const engine = fakeEngine();
    expect(await runContained({ worktree: repo, phase: 'validate', command: 'npm test', deps: { engine } }))
      .toMatchObject({ status: 'refused', state: 'mount-refused', contained: false });
    expect(engine.calls).toEqual([]);
  });

  it.runIf(POSIX_HOST)('refuses when the pinned image is not pulled, without creating anything', async () => {
    writeFileSync(join(repo, '.nvmrc'), '24\n');
    const engine = fakeEngine([['image inspect', { success: false }]]);
    const result = await runContained({ worktree: repo, phase: 'validate', command: 'npm test', deps: { engine } });
    expect(result).toMatchObject({ status: 'refused', code: 'CONTAINMENT_UNAVAILABLE', state: 'image-missing', contained: false });
    expect(engine.calls.every((call) => call.startsWith('image inspect'))).toBe(true);
  });

  it.runIf(POSIX_HOST)('refuses a Node major with no pinned image rather than testing under another runtime', async () => {
    writeFileSync(join(repo, '.nvmrc'), '18\n');
    const engine = fakeEngine();
    const result = await runContained({ worktree: repo, phase: 'validate', command: 'npm test', deps: { engine } });
    expect(result).toMatchObject({ status: 'refused', state: 'unsupported-node' });
    expect(result.reason).toContain('Node 18');
    expect(engine.calls).toEqual([]);
    const overridden = await runContained({
      worktree: repo, phase: 'validate', command: 'npm test', deps: { engine: fakeEngine([['image inspect', { success: false }]]) },
      settings: { imageOverrides: { 18: `node:18-bookworm-slim@sha256:${'a'.repeat(64)}` } },
    });
    expect(overridden).toMatchObject({ status: 'refused', state: 'image-missing', image: `node:18-bookworm-slim@sha256:${'a'.repeat(64)}` });
  });

  it.runIf(POSIX_HOST)('refuses to mount the data directory or a credential store as the worktree', async () => {
    const engine = fakeEngine();
    expect(await runContained({ worktree: repo, phase: 'validate', command: 'npm test', dataDir: repo, deps: { engine } }))
      .toMatchObject({ status: 'refused', state: 'mount-refused' });
    expect(engine.calls).toEqual([]);
  });
});
