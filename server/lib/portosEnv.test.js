import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as fileUtils from './fileUtils.js';
import { parseEnvContents, readPortosEnvValue, upsertPortosEnvLine } from './portosEnv.js';
import { __setVaultEnvPathForTests, decryptValue, encryptValue, ensureVaultKey } from './vaultCrypto.js';

// Hold the real atomic replacement after the caller has read its pre-image.
// The competing public writer must wait before reading that same file.
function holdNextWrite(error) {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const atomicWrite = fileUtils.atomicWrite;
  vi.spyOn(fileUtils, 'atomicWrite').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await resume.promise;
    if (error) throw error;
    return atomicWrite(...args);
  });
  return { entered: entered.promise, release: resume.resolve };
}

describe('shared installation .env transactions', () => {
  let dir;
  let envPath;
  let heldWrite;
  let pending;

  function track(promise) {
    pending.push(promise);
    return promise;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'portos-env-writers-'));
    envPath = join(dir, '.env');
    __setVaultEnvPathForTests(envPath);
    vi.stubEnv('PRIVACY_VAULT_KEY', undefined);
    pending = [];
  });

  afterEach(async () => {
    heldWrite?.release();
    await Promise.allSettled(pending);
    heldWrite = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __setVaultEnvPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  // Pins the persisted writer/reader contract when accepted whitespace and
  // duplicate declarations would otherwise leave the old first value effective.
  it('updates spaced and repeated assignments without touching other declarations', async () => {
    writeFileSync(envPath, '# LLM_BACKEND=comment\r\nOTHER=first\r\n  LLM_BACKEND \t= "old"\r\nOTHER=last\r\nLLM_BACKEND=stale\r\n');
    await upsertPortosEnvLine('LLM_BACKEND', '"new $& $` $\' value"', envPath);
    expect(readPortosEnvValue('LLM_BACKEND', envPath)).toBe("new $& $` $' value");
    expect(readFileSync(envPath, 'utf8')).toBe('# LLM_BACKEND=comment\r\nOTHER=first\r\nLLM_BACKEND="new $& $` $\' value"\r\nOTHER=last\r\n');
    expect(readPortosEnvValue('OTHER', envPath)).toBe('first');
  });

  it('retains overlapping different-key updates while an independent file proceeds', async () => {
    writeFileSync(envPath, '# Operator comment\nEXISTING=keep');
    heldWrite = holdNextWrite();
    const first = track(upsertPortosEnvLine('LLM_BACKEND', 'ollama', envPath));
    await heldWrite.entered;
    const second = track(upsertPortosEnvLine('EXTRA_ARGS', '$&literal', envPath));
    const otherPath = join(dir, 'other.env');
    await upsertPortosEnvLine('INDEPENDENT', 'saved', otherPath);
    expect(readFileSync(otherPath, 'utf8')).toBe('INDEPENDENT=saved\n');
    heldWrite.release();
    await Promise.all([first, second]);
    expect(readFileSync(envPath, 'utf8')).toBe('# Operator comment\nEXISTING=keep\nLLM_BACKEND=ollama\nEXTRA_ARGS=$&literal\n');
  });

  it('preserves the generated vault key and setting through overlap and a fresh-process key lookup', async () => {
    heldWrite = holdNextWrite();
    const provisioning = track(ensureVaultKey({ envPath }));
    await heldWrite.entered;
    const setting = track(upsertPortosEnvLine('LLM_BACKEND', 'ollama', envPath));
    // Complete an unrelated write while provisioning still holds its snapshot.
    await upsertPortosEnvLine('INDEPENDENT', 'saved', join(dir, 'other.env'));
    heldWrite.release();
    const [result] = await Promise.all([provisioning, setting]);
    expect(result).toEqual({ generated: true });
    const recorded = parseEnvContents(readFileSync(envPath, 'utf8'));
    expect(recorded.get('LLM_BACKEND')).toBe('ollama');
    expect(recorded.get('PRIVACY_VAULT_KEY')).toBe(process.env.PRIVACY_VAULT_KEY);
    const ciphertext = encryptValue('synthetic vault fixture');
    delete process.env.PRIVACY_VAULT_KEY;
    expect(decryptValue(ciphertext)).toBe('synthetic vault fixture');
  });

  it('rechecks the persisted vault key after an earlier queued setting write commits', async () => {
    const syntheticKey = 'b'.repeat(64);
    heldWrite = holdNextWrite();
    const setting = track(upsertPortosEnvLine('PRIVACY_VAULT_KEY', syntheticKey, envPath));
    await heldWrite.entered;
    const provisioning = track(ensureVaultKey({ envPath }));
    await upsertPortosEnvLine('INDEPENDENT', 'saved', join(dir, 'other.env'));
    heldWrite.release();
    const [, result] = await Promise.all([setting, provisioning]);
    expect(result).toEqual({ generated: false });
    expect(process.env.PRIVACY_VAULT_KEY).toBe(syntheticKey);
    expect(readFileSync(envPath, 'utf8')).toBe(`PRIVACY_VAULT_KEY=${syntheticKey}\n`);
  });

  it('rejects a failed write without poisoning the next queued transaction', async () => {
    writeFileSync(envPath, 'EXISTING=keep\n');
    const failure = new Error('Synthetic atomic write failure');
    heldWrite = holdNextWrite(failure);
    const failed = track(upsertPortosEnvLine('FAILED', 'discard', envPath).catch(error => error));
    await heldWrite.entered;
    const next = track(upsertPortosEnvLine('NEXT', 'saved', envPath));
    heldWrite.release();
    expect(await failed).toBe(failure);
    await next;
    expect(readFileSync(envPath, 'utf8')).toBe('EXISTING=keep\nNEXT=saved\n');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves unreadable content and permits a later write after access is restored', async () => {
    const original = 'EXISTING=keep\n';
    writeFileSync(envPath, original);
    chmodSync(envPath, 0o000);
    try {
      await expect(upsertPortosEnvLine('FAILED', 'discard', envPath)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(envPath, 0o600);
    }
    expect(readFileSync(envPath, 'utf8')).toBe(original);
    await upsertPortosEnvLine('NEXT', 'saved', envPath);
    expect(readFileSync(envPath, 'utf8')).toBe(`${original}NEXT=saved\n`);
  });
});
