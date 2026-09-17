import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { hasCredentialBootstrap, applyCredentialBootstrap, resolveCliSpawn, needsProcessGroup, processGroupKillable, trackDetachedGroup, signalDetachedGroups, resetDetachedGroupsForTests } from './credentialBootstrap.js';
import { PUBLIC_REVIEW_GATE_EXECUTION_PROFILE, PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE } from './agentExecutionProfiles.js';

vi.mock('./bufferedSpawn.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveWindowsExecutable: vi.fn(() => null),
}));

describe('credentialBootstrap', () => {
  describe('hasCredentialBootstrap', () => {
    it('is true only when a non-empty bootstrap command is named', () => {
      expect(hasCredentialBootstrap({ credentialBootstrap: { command: 'token-cli' } })).toBe(true);
      expect(hasCredentialBootstrap({ credentialBootstrap: { command: '' } })).toBe(false);
      expect(hasCredentialBootstrap({ credentialBootstrap: {} })).toBe(false);
      expect(hasCredentialBootstrap({ credentialBootstrap: null })).toBe(false);
      expect(hasCredentialBootstrap({})).toBe(false);
      expect(hasCredentialBootstrap(null)).toBe(false);
      expect(hasCredentialBootstrap(undefined)).toBe(false);
    });
  });

  describe('applyCredentialBootstrap', () => {
    it('wraps the harness command with the bootstrap CLI in front', () => {
      const provider = { credentialBootstrap: { command: 'token-cli', args: ['run'] } };
      expect(applyCredentialBootstrap(provider, 'opencode', ['run', '--print'])).toEqual({
        command: 'token-cli',
        args: ['run', 'opencode', 'run', '--print'],
        wrapped: true,
      });
    });

    it('defaults bootstrap args to empty when none are configured', () => {
      const provider = { credentialBootstrap: { command: 'token-cli' } };
      expect(applyCredentialBootstrap(provider, 'claude', ['-p', '-'])).toEqual({
        command: 'token-cli',
        args: ['claude', '-p', '-'],
        wrapped: true,
      });
    });

    it('returns the harness command unchanged when no bootstrap is configured', () => {
      expect(applyCredentialBootstrap({}, 'claude', ['-p', '-'])).toEqual({ command: 'claude', args: ['-p', '-'], wrapped: false });
      expect(applyCredentialBootstrap(null, 'claude', ['-p', '-'])).toEqual({ command: 'claude', args: ['-p', '-'], wrapped: false });
      expect(applyCredentialBootstrap({ credentialBootstrap: null }, 'claude', ['-p', '-'])).toEqual({
        command: 'claude',
        args: ['-p', '-'],
        wrapped: false,
      });
    });

    it('names the harness with harnessId instead of the raw command when configured', () => {
      const provider = { credentialBootstrap: { command: 'token-cli', args: ['run'], harnessId: 'claude-code' } };
      expect(applyCredentialBootstrap(provider, 'claude', ['-p', '-'])).toEqual({
        command: 'token-cli',
        args: ['run', 'claude-code', '-p', '-'],
        wrapped: true,
      });
    });

    it('inserts a configured separator between the harness command and its own args', () => {
      const provider = { credentialBootstrap: { command: 'token-cli', args: ['run'], argsSeparator: '--' } };
      expect(applyCredentialBootstrap(provider, 'claude', ['-p', '-'])).toEqual({
        command: 'token-cli',
        args: ['run', 'claude', '--', '-p', '-'],
        wrapped: true,
      });
    });

    it('omits the separator when the harness has no args to separate', () => {
      const provider = { credentialBootstrap: { command: 'token-cli', args: ['run'], argsSeparator: '--' } };
      expect(applyCredentialBootstrap(provider, 'claude', [])).toEqual({
        command: 'token-cli',
        args: ['run', 'claude'],
        wrapped: true,
      });
    });

    it('defaults missing harness args to an empty array', () => {
      expect(applyCredentialBootstrap({}, 'claude')).toEqual({ command: 'claude', args: [], wrapped: false });
      expect(applyCredentialBootstrap({ credentialBootstrap: { command: 'token-cli' } }, 'claude')).toEqual({
        command: 'token-cli',
        args: ['claude'],
        wrapped: true,
      });
    });
  });

  // A public-review posture's enforced recipe IS the sandbox: handing it to a
  // user-configured binary defeats both its argv and env allowlists. The skip is
  // keyed on the profile here, at the one point every spawn site goes through.
  describe('public-review postures', () => {
    const provider = { credentialBootstrap: { command: 'token-cli', args: ['run'] } };

    it.each([PUBLIC_REVIEW_GATE_EXECUTION_PROFILE, PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE])(
      'never wraps a %s spawn, even with a bootstrap configured', (safetyProfile) => {
        // `wrapped: false` matters as much as the argv here: an unwrapped
        // posture must also keep the unwrapped TEARDOWN, so the enforced recipe
        // is never spawned detached into a process group of its own (#7496).
        expect(applyCredentialBootstrap(provider, 'claude', ['--restricted'], { safetyProfile })).toEqual({
          command: 'claude',
          args: ['--restricted'],
          wrapped: false,
        });
        expect(resolveCliSpawn(provider, 'claude', ['--restricted'], process.env, { safetyProfile })).toEqual({
          command: 'claude',
          args: ['--restricted'],
          wrapped: false,
        });
        expect(needsProcessGroup(
          applyCredentialBootstrap(provider, 'claude', ['--restricted'], { safetyProfile }).wrapped,
          false,
        )).toBe(false);
      });

    it('still wraps an ordinary (profile-less or unknown-profile) spawn', () => {
      expect(applyCredentialBootstrap(provider, 'claude', [], { safetyProfile: null }).command).toBe('token-cli');
      expect(applyCredentialBootstrap(provider, 'claude', [], { safetyProfile: 'not-a-public-review-profile' }).command).toBe('token-cli');
    });
  });

  describe('resolveCliSpawn', () => {
    it('composes the credential-bootstrap wrap with Windows shim resolution', () => {
      const provider = { credentialBootstrap: { command: 'token-cli', args: ['run'] } };
      expect(resolveCliSpawn(provider, 'claude', ['-p', '-'], process.env)).toEqual({
        command: 'token-cli',
        args: ['run', 'claude', '-p', '-'],
        wrapped: true,
      });
    });

    it('falls through to the harness unchanged when no bootstrap is configured', () => {
      expect(resolveCliSpawn({}, 'claude', ['-p', '-'], process.env)).toEqual({ command: 'claude', args: ['-p', '-'], wrapped: false });
    });
  });

  describe('needsProcessGroup', () => {
    // The safety contract: a wrapped POSIX spawn MUST get its own process group,
    // because the direct child is the bootstrap wrapper and a per-pid SIGTERM
    // would leave the harness behind it running past stop/timeout/cancel (#7496).
    it('is true only for a wrapped spawn on POSIX', () => {
      expect(needsProcessGroup(true, false)).toBe(true);
      expect(needsProcessGroup(false, false)).toBe(false);
    });

    // Windows takes the taskkill /T branch in killProcessTree, which is
    // tree-wide rather than group-based, and `detached: true` there would open a
    // console window per spawn.
    it('is false on Windows even when wrapped', () => {
      expect(needsProcessGroup(true, true)).toBe(false);
      expect(needsProcessGroup(false, true)).toBe(false);
    });

    it('coerces a missing flag rather than leaking undefined into spawn options', () => {
      expect(needsProcessGroup(undefined, false)).toBe(false);
    });
  });

  describe('processGroupKillable', () => {
    it('returns the child itself when no process group is needed', () => {
      const child = { pid: 42, killed: false, kill: vi.fn() };
      expect(processGroupKillable(child, false)).toBe(child);
    });

    // The aiToolkit runner's stopRun (/runs Stop) reaches a non-ChildProcess
    // killable through its own `.kill()`, and its vendored killProcessTree has
    // no processGroup option — so the adapter is what makes that stop signal the
    // whole group instead of the wrapper alone.
    it('routes kill through a group signal and mirrors the live pid/killed state', () => {
      const killSpy = vi.fn();
      const child = { pid: 4242, killed: false, kill: killSpy };
      const killable = processGroupKillable(child, true);

      expect(killable.pid).toBe(4242);
      expect(killable.killed).toBe(false);

      killable.kill('SIGTERM');
      // POSIX + non-ChildProcess + processGroup → killProcessTree signals -pid,
      // which fails with ESRCH for this fake and falls back to the handle's own
      // kill. Either way the handle is reached, never bypassed.
      expect(killSpy).toHaveBeenCalledWith('SIGTERM');

      child.killed = true;
      expect(killable.killed).toBe(true);
    });

    it('defaults to SIGTERM when the toolkit calls kill() with no signal', () => {
      const killSpy = vi.fn();
      const killable = processGroupKillable({ pid: 7, killed: false, kill: killSpy }, true);
      killable.kill();
      expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    });
  });

  // Detaching is what gives stop/timeout/cancel its reach, but it also moves
  // the child OUT of the server's process group — so a shutdown driven by a
  // signal to THAT group stops reaching it. This registry is what lets the
  // shutdown handler restore exactly that lost reach across every detached
  // spawn site at once (agent runs, CLI runs, vision calls), rather than
  // sweeping each registry separately and forgetting one.
  describe('detached-group registry', () => {
    const fakeChild = (pid) => Object.assign(new EventEmitter(), { pid });

    beforeEach(() => { resetDetachedGroupsForTests(); });
    afterEach(() => { resetDetachedGroupsForTests(); });

    it.skipIf(process.platform === 'win32')('signals each tracked group and reports how many it reached', () => {
      // Spy so the negative pids never reach real process groups.
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      trackDetachedGroup(fakeChild(101), true);
      trackDetachedGroup(fakeChild(202), true);

      expect(signalDetachedGroups()).toBe(2);
      expect(killSpy).toHaveBeenCalledWith(-101, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(-202, 'SIGTERM');
      killSpy.mockRestore();
    });

    it.skipIf(process.platform === 'win32')('tracks nothing for an undetached spawn, and returns the child either way', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const child = fakeChild(303);

      expect(trackDetachedGroup(child, false)).toBe(child);
      expect(trackDetachedGroup(fakeChild(404), true)).toBeTruthy();

      expect(signalDetachedGroups()).toBe(1);
      expect(killSpy).not.toHaveBeenCalledWith(-303, expect.anything());
      killSpy.mockRestore();
    });

    it('forgets a group once its child closes, so a recycled pid is never signalled', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const child = fakeChild(505);
      trackDetachedGroup(child, true);

      child.emit('close', 0);

      expect(signalDetachedGroups()).toBe(0);
      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });

    // The load-bearing distinction: 'exit' fires when the WRAPPER is reaped,
    // 'close' waits for its stdio — which the harness is still holding in
    // exactly the case this registry exists for. Forgetting at 'exit' would drop
    // the group precisely when the orphaned harness is its only member.
    it.skipIf(process.platform === 'win32')('keeps tracking a group whose wrapper exited while the harness holds its stdio', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const child = fakeChild(515);
      trackDetachedGroup(child, true);

      child.emit('exit', 0, null);

      expect(signalDetachedGroups()).toBe(1);
      expect(killSpy).toHaveBeenCalledWith(-515, 'SIGTERM');
      killSpy.mockRestore();
    });

    it('forgets a group whose child failed to spawn at all', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const child = fakeChild(606);
      trackDetachedGroup(child, true);

      child.emit('error', new Error('ENOENT'));

      expect(signalDetachedGroups()).toBe(0);
      killSpy.mockRestore();
    });

    it('skips a pidless child rather than signalling group 0 — the server itself', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      trackDetachedGroup(fakeChild(undefined), true);
      trackDetachedGroup(fakeChild(0), true);

      expect(signalDetachedGroups()).toBe(0);
      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });

    it('treats an already-dead group as done, and logs any other failure without throwing', () => {
      const esrch = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw esrch; });
      const logFailure = vi.fn();
      trackDetachedGroup(fakeChild(707), true);

      expect(signalDetachedGroups('SIGTERM', logFailure)).toBe(0);
      expect(logFailure).not.toHaveBeenCalled();

      killSpy.mockImplementation(() => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); });
      // Nothing may propagate out of a signal handler.
      expect(() => signalDetachedGroups('SIGTERM', logFailure)).not.toThrow();
      expect(logFailure).toHaveBeenCalledTimes(1);
      expect(logFailure.mock.calls[0][0]).toContain('Group SIGTERM for pid 707');
      killSpy.mockRestore();
    });
  });
});
