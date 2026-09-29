import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDisabledSettings,
  buildPasswordSettings,
  isPasswordAuthEnabled,
  runResetPassword,
  USAGE,
} from './reset-password.js';

const withTempDataDir = async (fn) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'portos-reset-password-'));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
};

describe('isPasswordAuthEnabled', () => {
  it('is false when secrets.auth is absent, incomplete, or disabled', () => {
    expect(isPasswordAuthEnabled({})).toBe(false);
    expect(isPasswordAuthEnabled({ secrets: {} })).toBe(false);
    expect(isPasswordAuthEnabled({ secrets: { auth: { enabled: true } } })).toBe(false);
    expect(isPasswordAuthEnabled({ secrets: { auth: { enabled: false, passwordHash: 'h', salt: 's' } } })).toBe(false);
  });

  it('is true only with enabled + passwordHash + salt all present', () => {
    expect(isPasswordAuthEnabled({ secrets: { auth: { enabled: true, passwordHash: 'h', salt: 's' } } })).toBe(true);
  });
});

describe('buildDisabledSettings', () => {
  it('returns null when auth was already off — nothing to write', () => {
    expect(buildDisabledSettings({})).toBeNull();
    expect(buildDisabledSettings({ secrets: {} })).toBeNull();
  });

  it('drops secrets.auth and rotates passwordRiskRevision, preserving unrelated settings', () => {
    const before = { foo: 'bar', secrets: { auth: { enabled: true, passwordHash: 'h', salt: 's' }, other: 1 } };
    const next = buildDisabledSettings(before);
    expect(next.foo).toBe('bar');
    expect(next.secrets).toEqual({ other: 1 });
    expect(typeof next.passwordRiskRevision).toBe('string');
    expect(next.passwordRiskRevision.length).toBeGreaterThan(0);
  });
});

describe('buildPasswordSettings', () => {
  it('rejects a password shorter than 8 characters', async () => {
    await expect(buildPasswordSettings({}, 'short')).rejects.toThrow(/at least 8 characters/);
  });

  it('rejects a password longer than 256 characters', async () => {
    await expect(buildPasswordSettings({}, 'x'.repeat(257))).rejects.toThrow(/too long/);
  });

  it('produces a scrypt secrets.auth record that verifies against the given password', async () => {
    const before = { foo: 'bar', secrets: { other: 1 } };
    const next = await buildPasswordSettings(before, 'correct horse battery staple');
    expect(next.foo).toBe('bar');
    expect(next.secrets.other).toBe(1);
    expect(next.secrets.auth.enabled).toBe(true);
    expect(next.secrets.auth.kdf).toBe('scrypt');
    expect(typeof next.secrets.auth.salt).toBe('string');
    expect(typeof next.secrets.auth.passwordHash).toBe('string');

    const { hashPassword, constantEqual } = await import('../lib/portosAuthCore.js');
    const rehash = await hashPassword('correct horse battery staple', next.secrets.auth.salt);
    expect(constantEqual(rehash, next.secrets.auth.passwordHash)).toBe(true);
  });
});

describe('runResetPassword', () => {
  it('prints usage and exits 1 when called with no argument', async () => {
    const result = await runResetPassword(undefined, { dataDir: '/unused' });
    expect(result).toEqual({ code: 1, message: USAGE });
  });

  it('--status reports disabled against a settings.json that never mentions auth', async () => {
    await withTempDataDir(async (dataDir) => {
      const result = await runResetPassword('--status', { dataDir });
      expect(result).toEqual({ code: 0, message: '🔓 Password auth is disabled.' });
    });
  });

  it('sets a password, persists it, and revokes sessions; --status then reports enabled', async () => {
    await withTempDataDir(async (dataDir) => {
      const setResult = await runResetPassword('a-new-password', { dataDir });
      expect(setResult.code).toBe(0);
      expect(setResult.message).toMatch(/Password reset and all sessions revoked/);
      expect(setResult.message).toMatch(/npm run pm2:restart/);

      const settings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
      expect(isPasswordAuthEnabled(settings)).toBe(true);

      const sessions = JSON.parse(await readFile(join(dataDir, 'auth-sessions.json'), 'utf8'));
      expect(sessions).toEqual({ tokens: [] });

      const statusResult = await runResetPassword('--status', { dataDir });
      expect(statusResult).toEqual({ code: 0, message: '🔒 Password auth is enabled.' });
    });
  });

  it('rejects a too-short password without writing anything', async () => {
    await withTempDataDir(async (dataDir) => {
      const result = await runResetPassword('short', { dataDir });
      expect(result).toEqual({ code: 1, message: '❌ Password must be at least 8 characters.' });
      const statusResult = await runResetPassword('--status', { dataDir });
      expect(statusResult.message).toBe('🔓 Password auth is disabled.');
    });
  });

  it('--disable turns off a previously-set password and revokes sessions', async () => {
    await withTempDataDir(async (dataDir) => {
      await runResetPassword('a-new-password', { dataDir });
      const disableResult = await runResetPassword('--disable', { dataDir });
      expect(disableResult.code).toBe(0);
      expect(disableResult.message).toMatch(/disabled and all sessions revoked/);

      const statusResult = await runResetPassword('--status', { dataDir });
      expect(statusResult.message).toBe('🔓 Password auth is disabled.');
    });
  });

  it('--disable is a no-op when auth is already off', async () => {
    await withTempDataDir(async (dataDir) => {
      const result = await runResetPassword('--disable', { dataDir });
      expect(result).toEqual({ code: 0, message: '🔓 Password auth is already disabled — nothing to do.' });
    });
  });
});
