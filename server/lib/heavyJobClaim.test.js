import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { __cleanupHeldClaims, __findSurvivingTrainer as findSurvivingTrainer, __publishClaim, adoptHeavyLocalJob, beginHeavyJobRecovery, claimHeavyLocalJob, HEAVY_LOCAL_JOB_STALE_MS } from './heavyJobClaim.js';
import { maintenance } from './maintenanceAdmission.js';

const withClaimPath = async (run) => {
  const dir = await mkdtemp(join(tmpdir(), 'portos-heavy-job-'));
  const claimPath = join(dir, 'claim.json');
  try {
    await run(claimPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('claimHeavyLocalJob', () => {
  it('publishes no partial claim while another process writes its candidate', async () => {
    await withClaimPath(async claimPath => {
      const entered = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const first = __publishClaim(claimPath, '{"owner":"first"}', { writeTemp: async (path, data, options) => {
        await writeFile(path, '', options);
        entered.resolve();
        await resume.promise;
        await writeFile(path, data);
      } });
      await entered.promise;
      try {
        expect(existsSync(claimPath)).toBe(false);
        await __publishClaim(claimPath, '{"owner":"second"}');
      } finally { resume.resolve(); }
      await expect(first).rejects.toMatchObject({ code: 'EEXIST' });
      expect(JSON.parse(await readFile(claimPath, 'utf8'))).toEqual({ owner: 'second' });
    });
  });
  it('reports filesystems that cannot publish a complete claim atomically', async () => {
    await withClaimPath(async claimPath => {
      const unsupported = Object.assign(new Error('not supported'), { code: 'EOPNOTSUPP' });
      await expect(__publishClaim(claimPath, '{}', { linkFile: async () => { throw unsupported; } }))
        .rejects.toMatchObject({ code: 'HEAVY_CLAIM_LINK_UNSUPPORTED', cause: unsupported });
      expect(existsSync(claimPath)).toBe(false);
    });
  });
  it.skipIf(process.platform === 'win32')('prevents a second process claiming while an unbound trainer survives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-trainer-'));
    const run = join(root, 'data', 'training-runs', 'run-a');
    const control = join(run, '.detached');
    await mkdir(control, { recursive: true });
    await writeFile(join(root, '.portos-disposable-root'), '');
    const trainer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', 'train_mflux_lora.py', '--output-dir', run], { stdio: 'ignore' });
    const stopped = new Promise(resolve => trainer.once('close', resolve));
    let laterTrainer, laterStopped, racing, go;
    try {
      await new Promise((resolve, reject) => { trainer.once('spawn', resolve); trainer.once('error', reject); });
      await writeFile(join(control, 'pid'), String(trainer.pid));
      const moduleUrl = new URL('./heavyJobClaim.js', import.meta.url).href;
      const admissionUrl = new URL('./maintenanceAdmission.js', import.meta.url).href;
      const data = join(root, 'data');
      const claimPath = join(data, 'heavy-local-job.claim.json');
      const trainerRoot = join(data, 'training-runs');
      await expect(claimHeavyLocalJob({ kind: 'image', id: 'unavailable-inventory', claimPath,
        survivorCheck: options => findSurvivingTrainer({ ...options, root: trainerRoot,
          snapshot: async () => { throw new Error('inventory unavailable'); } }) }))
        .rejects.toThrow('inventory unavailable');
      expect(existsSync(claimPath)).toBe(false);
      const script = `import { claimHeavyLocalJob } from ${JSON.stringify(moduleUrl)};\n`
        + `import { createMaintenanceAdmission } from ${JSON.stringify(admissionUrl)};\n`
        + `import { writeFile } from 'node:fs/promises';\n`
        + `import { existsSync } from 'node:fs'; import { setTimeout as delay } from 'node:timers/promises';\n`
        + `const data = ${JSON.stringify(data)}, claimPath = ${JSON.stringify(claimPath)};\n`
        + `const admission = createMaintenanceAdmission(data, { assertWrite: path => { if (path !== ${JSON.stringify(join(data, 'workflow-maintenance'))}) throw new Error('unexpected path'); } });\n`
        + `const createClaim = async (path, bytes, options) => { if (path !== claimPath) throw new Error('unexpected claim'); if (process.env.CLAIM_TEST_READY) { await writeFile(process.env.CLAIM_TEST_READY, 'ready'); while (!existsSync(process.env.CLAIM_TEST_GO)) await delay(10); } return writeFile(path, bytes, options); };\n`
        + `const claim = await claimHeavyLocalJob({ kind: 'image', id: 'other-process', claimPath, admission, createClaim });\n`
        + `console.log('RESULT:' + JSON.stringify({ ok: claim.ok }));\nif (claim.ok) await claim.release();`;
      const runClaim = async (extra = {}) => {
        const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
          env: { ...process.env, PORTOS_DATA_ROOT: root, CLAIM_TEST_READY: '', CLAIM_TEST_GO: '', ...extra }, timeout: 15000,
        });
        return JSON.parse(stdout.match(/RESULT:(\{[^\n]+\})/)?.[1] ?? '{}');
      };
      expect(await runClaim()).toEqual({ ok: false });
      trainer.kill('SIGTERM');
      await stopped;
      await writeFile(join(control, 'exit'), '0');
      const ready = join(root, 'ready');
      go = join(root, 'go');
      racing = runClaim({ CLAIM_TEST_READY: ready, CLAIM_TEST_GO: go });
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
      laterTrainer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', 'train_mflux_lora.py', '--output-dir', run], { stdio: 'ignore' });
      laterStopped = new Promise(resolve => laterTrainer.once('close', resolve));
      await new Promise((resolve, reject) => { laterTrainer.once('spawn', resolve); laterTrainer.once('error', reject); });
      await writeFile(join(control, 'pid'), String(laterTrainer.pid));
      await writeFile(go, 'go');
      expect(await racing).toEqual({ ok: false });
      laterTrainer.kill('SIGTERM');
      await laterStopped;
      expect(await runClaim()).toEqual({ ok: true });
    } finally {
      if (trainer.exitCode === null && trainer.signalCode === null) { trainer.kill('SIGTERM'); await stopped; }
      if (laterTrainer && laterTrainer.exitCode === null && laterTrainer.signalCode === null) { laterTrainer.kill('SIGTERM'); await laterStopped; }
      if (racing) { await writeFile(go, 'go').catch(() => {}); await racing.catch(() => {}); }
      await rm(root, { recursive: true, force: true });
    }
  });
  it('observes a live trainer despite an exit marker and ignores reused or dead PIDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surviving-trainer-'));
    const run = join(root, 'run-a');
    const control = join(run, '.detached');
    try {
      await mkdir(control, { recursive: true });
      const pidFile = join(control, 'pid');
      await writeFile(pidFile, '12345');
      const at = (await stat(pidFile)).mtimeMs;
      const row = { pid: 12345, state: 'S', startedAt: at - 10000, command: `python train_mflux_lora.py --output-dir ${run}` };
      const inspect = changes => findSurvivingTrainer({ root, alive: () => true, snapshot: async () => [{ ...row, ...changes }] });
      expect(await inspect({})).toMatchObject({ pid: 12345 });
      expect(await inspect({ startedAt: at + 10000, command: 'python unrelated.py' })).toBeNull();
      expect(await inspect({ state: 'Z' })).toBeNull();
      expect(await inspect({ command: 'python unrelated.py' })).toBeNull();
      await writeFile(join(control, 'exit'), '0');
      expect(await inspect({})).toMatchObject({ pid: 12345 });
      expect(await findSurvivingTrainer({ root, snapshot: async () => [] })).toBeNull();
      expect(await findSurvivingTrainer({ root, readControl: async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); },
        snapshot: async () => [] })).toBeNull();
      await expect(findSurvivingTrainer({ root, snapshot: async () => { throw new Error('unavailable'); } })).rejects.toThrow('unavailable');
      expect(await findSurvivingTrainer({ root, readControl: async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); },
        snapshot: async () => [row] })).toMatchObject({ pid: 12345 });
      expect(await findSurvivingTrainer({ root, snapshot: async () => [{ pid: 555, state: 'S',
        command: `mflux-train --config ${run}/mflux-train.json` }] })).toMatchObject({ pid: 555 });
      expect(await findSurvivingTrainer({ root, ignorePid: 12345, snapshot: async () => [row,
        { pid: 555, ppid: 12345, state: 'S', command: `mflux-train --config ${run}/mflux-train.json` }] })).toBeNull();
      expect(await findSurvivingTrainer({ root, ignorePid: 12345, snapshot: async () => [{ ...row, ppid: 9 },
        { pid: 9, state: 'S', command: `sh -c train_mflux_lora.py --output-dir ${run}` }] })).toBeNull();
      expect(await findSurvivingTrainer({ root, snapshot: async () => [{ pid: 556, state: 'S',
        command: `python -m mflux.models.common.cli.train --config ${run}/mflux-train.json` }] })).toMatchObject({ pid: 556 });
      await unlink(pidFile);
      expect(await findSurvivingTrainer({ root, snapshot: async () => [row] })).toMatchObject({ pid: 12345 });
      if (process.platform !== 'win32') {
        execFileSync('mkfifo', [pidFile]);
        expect(await findSurvivingTrainer({ root, snapshot: async () => [] })).toBeNull();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('withdraws a new claim when a survivor appears during creation', async () => {
    await withClaimPath(async claimPath => {
      const check = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ pid: 12345 });
      const result = await claimHeavyLocalJob({ kind: 'image', id: 'image', claimPath, survivorCheck: check });
      expect(result).toMatchObject({ ok: false });
      expect(existsSync(claimPath)).toBe(false);
    });
  });
  it('withdraws a new claim when its post-creation process check fails', async () => {
    await withClaimPath(async claimPath => {
      const check = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('inventory unavailable'));
      await expect(claimHeavyLocalJob({ kind: 'image', id: 'image', claimPath, survivorCheck: check }))
        .rejects.toThrow('inventory unavailable');
      expect(existsSync(claimPath)).toBe(false);
      const next = await claimHeavyLocalJob({ kind: 'image', id: 'next', claimPath, survivorCheck: async () => null });
      expect(next.ok).toBe(true);
      await next.release();
    });
  });
  it('retries transient process-check failures within the requested timeout', async () => {
    await withClaimPath(async claimPath => {
      let clock = 0;
      const check = vi.fn().mockRejectedValueOnce(new Error('inventory unavailable')).mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('inventory unavailable')).mockResolvedValue(null);
      const claim = await claimHeavyLocalJob({ kind: 'image', id: 'image', claimPath, survivorCheck: check,
        timeoutMs: 1000, now: () => clock, wait: async ms => { clock += ms; } });
      expect(claim.ok).toBe(true);
      expect(check).toHaveBeenCalledTimes(5);
      expect(clock).toBe(500);
      await claim.release();
    });
  });
  it('withdraws a local claim that raced a newly observed survivor', async () => {
    await withClaimPath(async claimPath => {
      const entered = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const candidate = claimHeavyLocalJob({ kind: 'image', id: 'image', claimPath, createClaim: async (path, data, options) => {
        entered.resolve();
        await resume.promise;
        await writeFile(path, data, options);
      } });
      await entered.promise;
      const end = beginHeavyJobRecovery('trainer');
      try {
        resume.resolve();
        await expect(candidate).resolves.toMatchObject({ ok: false });
        expect(existsSync(claimPath)).toBe(false);
      } finally { resume.resolve(); end(); }
    });
  });
  it('rechecks local recovery after an in-flight post-creation process scan', async () => {
    await withClaimPath(async claimPath => {
      const entered = Promise.withResolvers();
      const resume = Promise.withResolvers();
      let scans = 0;
      const candidate = claimHeavyLocalJob({ kind: 'image', id: 'image', claimPath, survivorCheck: async () => {
        if (++scans === 2) { entered.resolve(); await resume.promise; }
        return null;
      } });
      await entered.promise;
      const end = beginHeavyJobRecovery('trainer');
      try {
        resume.resolve();
        await expect(candidate).resolves.toMatchObject({ ok: false });
        expect(existsSync(claimPath)).toBe(false);
      } finally { resume.resolve(); end(); }
    });
  });
  it('records a completed unstarted claim if post-check withdrawal repeatedly fails', async () => {
    await withClaimPath(async claimPath => {
      let scans = 0;
      const result = await claimHeavyLocalJob({ kind: 'image', id: 'image', claimPath, survivorCheck: async () => ++scans > 1,
        unlinkClaim: async () => { throw new Error('busy'); }, wait: async () => {} });
      expect(result).toMatchObject({ ok: false });
      const before = JSON.parse(await readFile(claimPath, 'utf8'));
      expect(JSON.parse(await readFile(`${claimPath}.completed.json`, 'utf8'))).toMatchObject({ token: before.token, ownerPid: process.pid });
      const next = await claimHeavyLocalJob({ kind: 'image', id: 'next', claimPath, survivorCheck: async () => false });
      expect(next.ok).toBe(true);
      await next.release();
    });
  });
  it('does not let a local claimant race an in-progress token withdrawal', async () => {
    await withClaimPath(async claimPath => {
      const entered = Promise.withResolvers();
      const resume = Promise.withResolvers();
      let scans = 0;
      const first = claimHeavyLocalJob({ kind: 'image', id: 'first', claimPath, survivorCheck: async () => ++scans > 1,
        unlinkClaim: async path => { entered.resolve(); await resume.promise; await unlink(path); } });
      await entered.promise;
      try {
        expect(await claimHeavyLocalJob({ kind: 'image', id: 'second', claimPath, survivorCheck: async () => false })).toMatchObject({ ok: false });
      } finally { resume.resolve(); }
      await expect(first).resolves.toMatchObject({ ok: false });
      const next = await claimHeavyLocalJob({ kind: 'image', id: 'next', claimPath, survivorCheck: async () => false });
      expect(next.ok).toBe(true);
      await next.release();
    });
  });
  it('serializes claimants that passed their first scan before withdrawal began', async () => {
    await withClaimPath(async claimPath => {
      const firstPreCheck = Promise.withResolvers();
      const firstPostCheck = Promise.withResolvers();
      const releaseFirstPre = Promise.withResolvers();
      const resumeFirst = Promise.withResolvers();
      const secondPreCheck = Promise.withResolvers();
      const thirdPreCheck = Promise.withResolvers();
      const releaseSecond = Promise.withResolvers();
      const releaseThird = Promise.withResolvers();
      let scans = 0;
      const first = claimHeavyLocalJob({ kind: 'image', id: 'first', claimPath, survivorCheck: async () => {
        if (scans++ === 0) { firstPreCheck.resolve(); await releaseFirstPre.promise; return false; }
        firstPostCheck.resolve(); await resumeFirst.promise; return true;
      } });
      const second = claimHeavyLocalJob({ kind: 'image', id: 'second', claimPath, survivorCheck: async () => {
        secondPreCheck.resolve(); await releaseSecond.promise; return false;
      } });
      const third = claimHeavyLocalJob({ kind: 'image', id: 'third', claimPath, survivorCheck: async () => {
        thirdPreCheck.resolve(); await releaseThird.promise; return false;
      } });
      try {
        await Promise.all([firstPreCheck.promise, secondPreCheck.promise, thirdPreCheck.promise]);
        releaseFirstPre.resolve();
        await firstPostCheck.promise;
        releaseSecond.resolve();
        releaseThird.resolve();
        expect(await second).toMatchObject({ ok: false });
        expect(await third).toMatchObject({ ok: false });
        expect(JSON.parse(await readFile(claimPath, 'utf8')).id).toBe('first');
      } finally { releaseFirstPre.resolve(); releaseSecond.resolve(); releaseThird.resolve(); resumeFirst.resolve(); }
      expect(await first).toMatchObject({ ok: false });
      const next = await claimHeavyLocalJob({ kind: 'image', id: 'next', claimPath, survivorCheck: async () => false });
      expect(next.ok).toBe(true);
      expect(JSON.parse(await readFile(claimPath, 'utf8')).id).toBe('next');
      await next.release();
    });
  });
  it('retries an unstarted claim after both unlink and completion-marker writes fail', async () => {
    await withClaimPath(async claimPath => {
      let scans = 0;
      await expect(claimHeavyLocalJob({ kind: 'image', id: 'image', claimPath, survivorCheck: async () => ++scans > 1,
        unlinkClaim: async () => { throw new Error('busy'); }, writeCompletion: async () => { throw new Error('unwritable'); },
        wait: async () => {} })).rejects.toThrow('unwritable');
      await vi.waitFor(() => expect(existsSync(claimPath)).toBe(false), { timeout: 3000 });
      const next = await claimHeavyLocalJob({ kind: 'image', id: 'next', claimPath, survivorCheck: async () => false });
      expect(next.ok).toBe(true);
      await next.release();
    });
  });
  it('retries cleanup when a competing local removal fails after its timer fires', async () => {
    await withClaimPath(async claimPath => {
      let scans = 0;
      await expect(claimHeavyLocalJob({ kind: 'image', id: 'first', claimPath, survivorCheck: async () => ++scans > 1,
        unlinkClaim: async () => { throw new Error('busy'); }, writeCompletion: async () => { throw new Error('unwritable'); },
        wait: async () => {} })).rejects.toThrow('unwritable');
      const entered = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const second = claimHeavyLocalJob({ kind: 'image', id: 'second', claimPath, survivorCheck: async () => false,
        unlinkClaim: async () => { entered.resolve(); await resume.promise; throw new Error('still busy'); } });
      await entered.promise;
      try { await new Promise(resolve => setTimeout(resolve, 1200)); }
      finally { resume.resolve(); }
      await expect(second).rejects.toThrow('still busy');
      await vi.waitFor(() => expect(existsSync(claimPath)).toBe(false), { timeout: 4000 });
    });
  });
  it('refuses another local accelerator job while a survivor is reattaching', async () => {
    await withClaimPath(async claimPath => {
      const end = beginHeavyJobRecovery('surviving-trainer');
      try {
        expect(await claimHeavyLocalJob({ kind: 'image', id: 'new-image', claimPath })).toMatchObject({ ok: false });
        const survivor = await claimHeavyLocalJob({ kind: 'training', id: 'surviving-trainer', claimPath, pid: 12345 });
        expect(survivor).toMatchObject({ ok: true, holder: { pid: 12345 } });
        __cleanupHeldClaims();
        expect(existsSync(claimPath)).toBe(true);
        await survivor.release();
      } finally { end(); }
      const next = await claimHeavyLocalJob({ kind: 'image', id: 'new-image', claimPath });
      expect(next.ok).toBe(true);
      await next.release();
    });
  });
  it('waits for recovery within a caller’s requested timeout', async () => {
    await withClaimPath(async claimPath => {
      const end = beginHeavyJobRecovery('trainer');
      let clock = 0;
      const wait = vi.fn(async ms => { clock += ms; end(); });
      const claim = await claimHeavyLocalJob({ kind: 'assessment', id: 'next', claimPath, timeoutMs: 500, now: () => clock, wait });
      expect(claim.ok).toBe(true);
      expect(wait).toHaveBeenCalledOnce();
      await claim.release();
    });
  });
  it('reuses only an existing parent admission when reattaching a claim', async () => {
    await withClaimPath(async claimPath => {
      await expect(claimHeavyLocalJob({ kind: 'training', id: 'job', claimPath, continuationOwned: true }))
        .rejects.toThrow('Existing work ownership');
      const parent = maintenance.admit('media', 'trainer');
      const claim = await parent.run(() => claimHeavyLocalJob({ kind: 'training', id: 'job', claimPath, continuationOwned: true }));
      expect(maintenance.operations().map(op => op.kind)).toEqual(['media']);
      await claim.release();
      await parent.finish();
      await parent.run(() => expect(claimHeavyLocalJob({ kind: 'training', id: 'late', claimPath, continuationOwned: true }))
        .rejects.toMatchObject({ code: 'MAINTENANCE_HELD' }));
      const uncertain = maintenance.admit('media', 'finished-trainer');
      uncertain.markUnsettled();
      await uncertain.finish();
      await uncertain.run(() => expect(claimHeavyLocalJob({ kind: 'training', id: 'late', claimPath, continuationOwned: true }))
        .rejects.toMatchObject({ code: 'MAINTENANCE_HELD' }));
      const recovery = maintenance.recoverOwned('media', 'finished-trainer');
      const resumed = await recovery.run(() => claimHeavyLocalJob({ kind: 'training', id: 'resumed', claimPath, continuationOwned: true }));
      expect(resumed.ok).toBe(true);
      await resumed.release();
      recovery.completeRecovery();
      await recovery.finish();
    });
  });
  it('does not lose a claim on a failed handoff write and refuses changed ownership', async () => {
    await withClaimPath(async claimPath => {
      const writeClaim = vi.fn().mockRejectedValueOnce(new Error('disk busy'));
      const claim = await claimHeavyLocalJob({ kind: 'video', id: 'job', claimPath, writeClaim });
      await expect(claim.handoffTo(12345)).rejects.toThrow('disk busy');
      expect(JSON.parse(await readFile(claimPath, 'utf8')).pid).toBe(process.pid);
      await writeFile(claimPath, JSON.stringify({ kind: 'video', id: 'other', pid: 1, token: 'other' }));
      await expect(claim.handoffTo(12345)).rejects.toMatchObject({ code: 'HEAVY_CLAIM_CHANGED' });
      await claim.release();
      expect(JSON.parse(await readFile(claimPath, 'utf8')).token).toBe('other');
    });
  });
  it('does not record same-process completion when a child handoff failed', async () => {
    await withClaimPath(async claimPath => {
      const claim = await claimHeavyLocalJob({ kind: 'video', id: 'job', claimPath,
        writeClaim: async () => { throw new Error('handoff failed'); },
        unlinkClaim: async () => { throw new Error('busy'); }, wait: async () => {} });
      await expect(claim.handoffTo(12345)).rejects.toThrow('handoff failed');
      await claim.release();
      const marker = JSON.parse(await readFile(`${claimPath}.completed.json`, 'utf8'));
      expect(marker).toMatchObject({ pid: process.pid, ownerPid: null });
    });
  });
  it('records same-process completion after the handed-off child is known to have closed', async () => {
    await withClaimPath(async claimPath => {
      const claim = await claimHeavyLocalJob({ kind: 'training', id: 'job', claimPath,
        writeClaim: async () => { throw new Error('handoff failed'); },
        unlinkClaim: async () => { throw new Error('busy'); }, wait: async () => {} });
      await expect(claim.handoffTo(12345)).rejects.toThrow('handoff failed');
      await claim.release({ childSettled: true });
      const marker = JSON.parse(await readFile(`${claimPath}.completed.json`, 'utf8'));
      expect(marker).toMatchObject({ pid: process.pid, ownerPid: process.pid });
    });
  });
  it('retries a transient failure removing its finished claim', async () => {
    await withClaimPath(async claimPath => {
      const remove = vi.fn().mockRejectedValueOnce(new Error('busy')).mockImplementation(unlink);
      const claim = await claimHeavyLocalJob({ kind: 'assessment', id: 'model', claimPath, unlinkClaim: remove, wait: async () => {} });
      await claim.release();
      expect(remove).toHaveBeenCalledTimes(2);
      expect(existsSync(claimPath)).toBe(false);
    });
  });

  it('records completed ownership without holding admission when cleanup stays unavailable', async () => {
    await withClaimPath(async claimPath => {
      const claim = await claimHeavyLocalJob({ kind: 'assessment', id: 'model', claimPath,
        unlinkClaim: async () => { throw new Error('busy'); }, wait: async () => {} });
      const before = JSON.parse(await readFile(claimPath, 'utf8'));
      await claim.release();
      expect(JSON.parse(await readFile(`${claimPath}.completed.json`, 'utf8'))).toMatchObject({ token: before.token, pid: before.pid });
      expect(maintenance.operations()).toEqual([]);
      const next = await claimHeavyLocalJob({ kind: 'image', id: 'next', claimPath });
      expect(next.ok).toBe(true);
      await next.release();
    });
  });
  it('shares admission with a waiting update across the claim and release', async () => {
    await withClaimPath(async claimPath => {
      const update = maintenance.deferredUpdate.request();
      const claim = await claimHeavyLocalJob({ kind: 'assessment', id: 'model-example', claimPath });
      expect(maintenance.deferredUpdate.acquire(update.id)).toBe(false);
      await claim.release();
      expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
      await expect(claimHeavyLocalJob({ kind: 'assessment', id: 'after-hold', claimPath })).rejects.toMatchObject({ code: 'MAINTENANCE_HELD' });
      maintenance.deferredUpdate.finish(update.id, false);
    });
  });
  it('holds one cross-process claim until its owner releases it', async () => {
    await withClaimPath(async (claimPath) => {
      const first = await claimHeavyLocalJob({ kind: 'image', id: 'job-a', claimPath });
      expect(first.ok).toBe(true);
      expect(first.holder).toMatchObject({ kind: 'image', id: 'job-a', pid: process.pid });
      expect(first.holder).not.toHaveProperty('token');

      const second = await claimHeavyLocalJob({ kind: 'video', id: 'job-b', claimPath, pidIsAlive: () => true });
      expect(second).toMatchObject({ ok: false, holder: { kind: 'image', id: 'job-a' } });

      await first.handoffTo(12345);
      expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ pid: 12345 });
      await first.release();
      expect(existsSync(claimPath)).toBe(false);
    });
  });

  it('reclaims a lock whose recorded PID is no longer alive', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({ kind: 'training', id: 'old', pid: 42, startedAt: 1, token: 'old' }));
      const claim = await claimHeavyLocalJob({ kind: 'video', id: 'new', claimPath, pidIsAlive: () => false });
      expect(claim).toMatchObject({ ok: true, holder: { kind: 'video', id: 'new' } });
      expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ kind: 'video', id: 'new' });
      await claim.release();
    });
  });

  it('waits only through its bounded timeout for a background caller', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({ kind: 'training', id: 'held', pid: 42, startedAt: 0, token: 'old' }));
      let now = 0;
      const wait = vi.fn(async (ms) => { now += ms; });
      const result = await claimHeavyLocalJob({
        kind: 'video', id: 'waiting', claimPath, timeoutMs: 500, now: () => now, wait, pidIsAlive: () => true,
      });
      expect(result).toMatchObject({ ok: false, holder: { kind: 'training', id: 'held' } });
      expect(wait).toHaveBeenCalled();
    });
  });

  it('reports a live holder that has exceeded the stale-age ceiling without stealing it', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({ kind: 'training', id: 'held', pid: 42, startedAt: 0, token: 'old' }));
      const result = await claimHeavyLocalJob({
        kind: 'video', id: 'next', claimPath, now: () => HEAVY_LOCAL_JOB_STALE_MS + 1, pidIsAlive: () => true,
      });
      expect(result.stale).toBe(true);
      expect(result.message).toContain('older than the safety ceiling');
    });
  });
});

describe('adoptHeavyLocalJob', () => {
  // #1332 boot re-attach: a restarted server re-attaches to a detached trainer
  // that survived the crash. That trainer's PID already holds the machine-wide
  // claim (handed off to it pre-restart) — the new process must recognize and
  // adopt that claim rather than contending for a fresh one, which would see
  // its own survivor as a competing job and refuse it.
  it('adopts an on-disk claim already recorded for this exact kind/id/pid', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({
        kind: 'LoRA training', id: 'run-a', pid: 4242, startedAt: 0, token: 'tok-a',
      }));
      const adopted = await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-a', pid: 4242, claimPath });
      expect(adopted).toMatchObject({ ok: true, holder: { kind: 'LoRA training', id: 'run-a', pid: 4242 } });

      await adopted.release();
      expect(existsSync(claimPath)).toBe(false);
    });
  });

  it('returns null (does not steal) when no claim exists, or the on-disk claim names a different job', async () => {
    await withClaimPath(async (claimPath) => {
      expect(await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-a', pid: 4242, claimPath })).toBeNull();

      await writeFile(claimPath, JSON.stringify({
        kind: 'LoRA training', id: 'run-a', pid: 4242, startedAt: 0, token: 'tok-a',
      }));
      // Wrong id, wrong pid, and wrong kind all fail to match — and the claim
      // file is left untouched (still readable, still holding the same token).
      expect(await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-b', pid: 4242, claimPath })).toBeNull();
      expect(await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-a', pid: 9999, claimPath })).toBeNull();
      expect(await adoptHeavyLocalJob({ kind: 'video', id: 'run-a', pid: 4242, claimPath })).toBeNull();
      expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ token: 'tok-a' });
    });
  });

  it('release() only removes the claim file if its token still matches', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({
        kind: 'LoRA training', id: 'run-a', pid: 4242, startedAt: 0, token: 'tok-a',
      }));
      const adopted = await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-a', pid: 4242, claimPath });

      // Someone else already claimed the path under a different token by the
      // time release() runs — it must not remove that unrelated claim.
      await writeFile(claimPath, JSON.stringify({
        kind: 'video', id: 'run-c', pid: 1, startedAt: 0, token: 'tok-c',
      }));
      await adopted.release();
      expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ token: 'tok-c' });
    });
  });
});
