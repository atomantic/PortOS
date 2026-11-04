import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runHarnessActionSupervisor, spawnHarnessActionSupervisor } from './harnessActionSupervisor.js';

const proof = { candidate: '1.2.4', expiresAt: 12345, identity: { path: '/fixture/cli' } };
const owner = { id: 'review-owner', runtime: 'opencode', action: 'update', holdId: null };
const input = { ownerId: owner.id, runtime: owner.runtime, action: owner.action, reviewed: proof };

function fixture() {
  const events = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const deps = {
    admission: { harnessActions: {
      operation: () => owner,
      enter: vi.fn(() => events.push('enter')),
      verify: vi.fn(() => events.push('verify')),
    } },
    runtimeFor: () => ({ id: 'opencode' }),
    matchesReview: vi.fn(async () => { events.push('proof'); return true; }),
    authorize: vi.fn(async () => { events.push('authorize'); }),
    drain: vi.fn(async () => { events.push('drain'); }),
    launch: vi.fn(() => { events.push('spawn'); return child; }),
    out: new PassThrough(), err: new PassThrough(), supervisorPid: 12345,
  };
  return { events, child, deps };
}

describe('harness action supervisor', () => {
  it('enters and rechecks the reviewed executable before launching in the same group', async () => {
    const { events, child, deps } = fixture();
    const result = runHarnessActionSupervisor(input, deps);
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
    expect(events).toEqual(['proof', 'enter', 'authorize', 'proof', 'verify', 'spawn']);
    expect(deps.launch).toHaveBeenCalledWith('opencode', { action: 'update', detached: false, verifiedCommand: '/fixture/cli' });
    child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    expect(await result).toBe(0);
    expect(events.at(-1)).toBe('drain');
  });

  it('does not launch when the review changes after entry or the journal is no longer idle', async () => {
    const { deps } = fixture();
    deps.matchesReview.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(runHarnessActionSupervisor(input, deps)).rejects.toThrow('reviewed executable or ticket changed');
    expect(deps.admission.harnessActions.enter).toHaveBeenCalledOnce();
    expect(deps.launch).not.toHaveBeenCalled();
    deps.matchesReview.mockResolvedValue(true);
    deps.admission.harnessActions.verify.mockImplementation(() => { throw new Error('Recovered work'); });
    await expect(runHarnessActionSupervisor(input, deps)).rejects.toThrow('Recovered work');
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('does not start the vendor after cancellation during the post-approval proof', async () => {
    const { deps } = fixture();
    let finishProof;
    deps.matchesReview.mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { finishProof = resolve; }));
    const controller = new AbortController();
    const result = runHarnessActionSupervisor(input, { ...deps, signal: controller.signal });
    await vi.waitFor(() => expect(finishProof).toBeTypeOf('function'));
    controller.abort(new Error('cancelled'));
    finishProof(true);
    await expect(result).rejects.toThrow('cancelled');
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('rejects a different action before entry', async () => {
    const { deps } = fixture();
    await expect(runHarnessActionSupervisor({ ...input, action: 'install' }, deps)).rejects.toThrow('ownership');
    expect(deps.admission.harnessActions.enter).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('runs a Harnesses-page update through the fixed vendor command without inventing review evidence', async () => {
    const { events, child, deps } = fixture();
    const result = runHarnessActionSupervisor({ ...input, reviewed: null }, deps);
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
    expect(events).toEqual(['enter', 'authorize', 'verify', 'spawn']);
    expect(deps.launch).toHaveBeenCalledWith('opencode', { action: 'update', detached: false });
    child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    expect(await result).toBe(0);
  });

  it('carries private uninstall evidence to the final launcher', async () => {
    const { child, deps } = fixture();
    const uninstallOwner = { ...owner, action: 'uninstall' };
    const uninstallTarget = { prefix: '/fixture/npm-prefix', executable: '/fixture/npm-prefix/bin/opencode' };
    deps.admission.harnessActions.operation = () => uninstallOwner;
    const result = runHarnessActionSupervisor({ ownerId: owner.id, runtime: owner.runtime, action: 'uninstall', uninstallTarget }, deps);
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
    expect(deps.launch).toHaveBeenCalledWith('opencode', { action: 'uninstall', detached: false, uninstallTarget });
    child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    expect(await result).toBe(0);
  });

  it('starts a group-leader wrapper and passes review evidence only through its private stdin', () => {
    const child = { stdin: new PassThrough() };
    const spawnImpl = vi.fn(() => child);
    const chunks = [];
    child.stdin.on('data', chunk => chunks.push(chunk));
    spawnHarnessActionSupervisor(input, { spawnImpl });
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(1);
    expect(args[0]).not.toContain('/fixture/cli');
    expect(options).toMatchObject({ detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(input);
  });
});
