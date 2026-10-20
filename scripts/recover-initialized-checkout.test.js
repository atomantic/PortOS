import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecovery } from './recover-initialized-checkout.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const request = { appId: 'portos-default', transactionId: '12345678-1234-1234-1234-123456789abc', journalDigest: 'a'.repeat(64) };

async function fixture(action = 'review') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'portos-recovery-cli-')));
  roots.push(root);
  for (const relative of ['data/cos/agents', 'data/cos/reports', 'data/cos/scripts', 'data/cos/initialized-checkout-retirements']) {
    await mkdir(join(root, relative), { recursive: true });
  }
  // Persisted registries key apps by ID; getAppById adds the id at read time.
  const apps = { apps: { 'portos-default': { repoPath: root } } };
  await writeFile(join(root, 'data/apps.json'), JSON.stringify(apps));
  await writeFile(join(root, 'data/cos/state.json'), JSON.stringify({ agents: {} }));
  const body = { ...request, ...(['restore', 'finalize', 'resume-quarantine'].includes(action)
    ? { review: { digest: 'b'.repeat(64), ...(action === 'resume-quarantine' ? { acceptSuperseded: true } : {}) } } : {}) };
  const input = join(root, 'request.json');
  const output = join(root, 'result.jsonl');
  await writeFile(input, JSON.stringify(body));
  return { root, apps, input, output, body, args: [action, input, '--install-root', root, '--output', output] };
}

describe('initialized checkout recovery CLI', () => {
  it.each(['review', 'restore', 'review-finalization', 'finalize', 'review-quarantine', 'resume-quarantine'])('pins the existing install, journals intent first, and invokes only guarded %s', async action => {
    const f = await fixture(action);
    const before = process.env.PORTOS_DATA_ROOT;
    const stdout = vi.fn();
    const method = { review: 'reviewMetadataRestore', restore: 'restoreMetadata',
      'review-finalization': 'reviewRestoredFinalization', finalize: 'finalizeRestored',
      'review-quarantine': 'reviewQuarantineResumption', 'resume-quarantine': 'resumeQuarantine' }[action];
    const load = vi.fn(async (deps, root) => {
      expect(root).toBe(f.root);
      expect(process.env.PORTOS_DATA_ROOT).toBe(f.root);
      expect(deps.root()).toBe(join(f.root, 'data/cos/initialized-checkout-retirements'));
      expect(await deps.context(request.appId)).toEqual({ repoPath: f.root, forgeAccount: null });
      const intent = JSON.parse((await readFile(f.output, 'utf8')).trim());
      expect(intent).toMatchObject({ outcome: 'pending-or-uncertain', request: f.body });
      if (process.platform !== 'win32') expect((await stat(f.output)).mode & 0o777).toBe(0o600);
      return { [method]: async input => {
        expect(input).toEqual(f.body);
        return { ok: true, review: { digest: 'c'.repeat(64), privateEvidence: 'never print this' } };
      } };
    });
    expect(await runRecovery(f.args, { load, stdout })).toBe(0);
    expect(load).toHaveBeenCalledOnce();
    expect(process.env.PORTOS_DATA_ROOT).toBe(before);
    const lines = (await readFile(f.output, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ outcome: 'response-recorded', response: { ok: true } });
    expect(stdout.mock.calls[0][0]).not.toContain('never print this');
    expect(JSON.parse(stdout.mock.calls[0][0]).reviewDigest).toBe('c'.repeat(64));
  });

  it('requires a separate exact review for finalization and never falls back to restore', async () => {
    const f = await fixture('finalize');
    await writeFile(f.input, JSON.stringify(request));
    const load = vi.fn();
    expect(await runRecovery(f.args, { load, stdout: () => {} })).toBe(1);
    expect(load).not.toHaveBeenCalled();
    await expect(stat(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing-review', 'nonboolean-supersession', 'caller-proof'])('refuses quarantine %s before loading the service', async change => {
    const f = await fixture('resume-quarantine');
    const body = { ...f.body };
    if (change === 'missing-review') delete body.review;
    if (change === 'nonboolean-supersession') body.review.acceptSuperseded = 'true';
    if (change === 'caller-proof') body.review.quarantineResumption = { digest: 'c'.repeat(64) };
    await writeFile(f.input, JSON.stringify(body));
    const load = vi.fn();
    expect(await runRecovery(f.args, { load, stdout: () => {} })).toBe(1);
    expect(load).not.toHaveBeenCalled();
    await expect(stat(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing-install', 'missing-agents', 'invalid-state', 'wrong-app-root', 'conflicting-app-id', 'inherited-app-id', 'invalid-json', 'extra-request-key', 'missing-review', 'unknown-option', 'existing-output'])(
    'refuses %s before invoking recovery', async change => {
      const f = await fixture('restore');
      if (change === 'missing-install') f.args[3] = join(f.root, 'absent');
      if (change === 'missing-agents') await rm(join(f.root, 'data/cos/agents'), { recursive: true });
      if (change === 'invalid-state') await writeFile(join(f.root, 'data/cos/state.json'), '{"agents":null}');
      if (change === 'wrong-app-root') {
        f.apps.apps['portos-default'].repoPath = join(f.root, 'other');
        await writeFile(join(f.root, 'data/apps.json'), JSON.stringify(f.apps));
      }
      if (change === 'conflicting-app-id') {
        f.apps.apps['portos-default'].id = 'different-app';
        await writeFile(join(f.root, 'data/apps.json'), JSON.stringify(f.apps));
      }
      if (change === 'inherited-app-id') await writeFile(f.input, JSON.stringify({ ...f.body, appId: 'constructor' }));
      if (change === 'invalid-json') await writeFile(f.input, '{');
      if (change === 'extra-request-key') await writeFile(f.input, JSON.stringify({ ...f.body, force: true }));
      if (change === 'missing-review') await writeFile(f.input, JSON.stringify(request));
      if (change === 'unknown-option') f.args.push('--force');
      if (change === 'existing-output') await writeFile(f.output, 'preserved');
      const load = vi.fn();
      expect(await runRecovery(f.args, { load, stdout: () => {} })).toBe(1);
      expect(load).not.toHaveBeenCalled();
      if (change === 'existing-output') expect(await readFile(f.output, 'utf8')).toBe('preserved');
      if (change === 'missing-agents') await expect(stat(join(f.root, 'data/cos/agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it.skipIf(process.platform === 'win32')('refuses a symlinked install component before loading service code', async () => {
    const f = await fixture();
    const target = join(f.root, 'actual-agents');
    await mkdir(target);
    await rm(join(f.root, 'data/cos/agents'), { recursive: true });
    await symlink(target, join(f.root, 'data/cos/agents'));
    const load = vi.fn();
    expect(await runRecovery(f.args, { load, stdout: () => {} })).toBe(1);
    expect(load).not.toHaveBeenCalled();
  });

  it('rechecks app binding and preserves uncertainty on a thrown service operation', async () => {
    const f = await fixture('restore');
    const stdout = vi.fn();
    const load = async deps => ({ restoreMetadata: async () => {
      f.apps.apps['portos-default'].repoPath = '/changed';
      await writeFile(join(f.root, 'data/apps.json'), JSON.stringify(f.apps));
      await deps.context(request.appId);
    } });
    expect(await runRecovery(f.args, { load, stdout })).toBe(1);
    const lines = (await readFile(f.output, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(lines[0].outcome).toBe('pending-or-uncertain');
    expect(lines[1]).toMatchObject({ outcome: 'inspect-before-any-retry', reason: 'recovery-app-install-mismatch' });
  });
});
