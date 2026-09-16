import { describe, it, expect, vi } from 'vitest';
import { hasCredentialBootstrap, applyCredentialBootstrap, resolveCliSpawn } from './credentialBootstrap.js';
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
      });
    });

    it('defaults bootstrap args to empty when none are configured', () => {
      const provider = { credentialBootstrap: { command: 'token-cli' } };
      expect(applyCredentialBootstrap(provider, 'claude', ['-p', '-'])).toEqual({
        command: 'token-cli',
        args: ['claude', '-p', '-'],
      });
    });

    it('returns the harness command unchanged when no bootstrap is configured', () => {
      expect(applyCredentialBootstrap({}, 'claude', ['-p', '-'])).toEqual({ command: 'claude', args: ['-p', '-'] });
      expect(applyCredentialBootstrap(null, 'claude', ['-p', '-'])).toEqual({ command: 'claude', args: ['-p', '-'] });
      expect(applyCredentialBootstrap({ credentialBootstrap: null }, 'claude', ['-p', '-'])).toEqual({
        command: 'claude',
        args: ['-p', '-'],
      });
    });

    it('names the harness with harnessId instead of the raw command when configured', () => {
      const provider = { credentialBootstrap: { command: 'token-cli', args: ['run'], harnessId: 'claude-code' } };
      expect(applyCredentialBootstrap(provider, 'claude', ['-p', '-'])).toEqual({
        command: 'token-cli',
        args: ['run', 'claude-code', '-p', '-'],
      });
    });

    it('inserts a configured separator between the harness command and its own args', () => {
      const provider = { credentialBootstrap: { command: 'token-cli', args: ['run'], argsSeparator: '--' } };
      expect(applyCredentialBootstrap(provider, 'claude', ['-p', '-'])).toEqual({
        command: 'token-cli',
        args: ['run', 'claude', '--', '-p', '-'],
      });
    });

    it('omits the separator when the harness has no args to separate', () => {
      const provider = { credentialBootstrap: { command: 'token-cli', args: ['run'], argsSeparator: '--' } };
      expect(applyCredentialBootstrap(provider, 'claude', [])).toEqual({
        command: 'token-cli',
        args: ['run', 'claude'],
      });
    });

    it('defaults missing harness args to an empty array', () => {
      expect(applyCredentialBootstrap({}, 'claude')).toEqual({ command: 'claude', args: [] });
      expect(applyCredentialBootstrap({ credentialBootstrap: { command: 'token-cli' } }, 'claude')).toEqual({
        command: 'token-cli',
        args: ['claude'],
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
        expect(applyCredentialBootstrap(provider, 'claude', ['--restricted'], { safetyProfile })).toEqual({
          command: 'claude',
          args: ['--restricted'],
        });
        expect(resolveCliSpawn(provider, 'claude', ['--restricted'], process.env, { safetyProfile })).toEqual({
          command: 'claude',
          args: ['--restricted'],
        });
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
      });
    });

    it('falls through to the harness unchanged when no bootstrap is configured', () => {
      expect(resolveCliSpawn({}, 'claude', ['-p', '-'], process.env)).toEqual({ command: 'claude', args: ['-p', '-'] });
    });
  });
});
