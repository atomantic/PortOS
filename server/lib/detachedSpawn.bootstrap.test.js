// Lifecycle-specific suite; durable admission has its own subprocess contract.
vi.mock('./databaseWriterRegistry.js', () => ({ reserveDatabaseWriter: () => ({
  assertLaunchAllowed() {}, launched() {}, completed() {},
}) }));

import { EventEmitter } from 'events';
import { spawn as nativeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from './childProcess.js';
import { pinPlatform } from './testHelper.js';
import { spawnDetached, __detachedSpawnTesting } from './detachedSpawn.js';

vi.mock('./childProcess.js', async (original) => ({
  ...(await original()),
  spawn: vi.fn(),
}));

let controlDir;
let restorePlatform;
const realWindows = process.platform === 'win32';
beforeEach(async () => {
  controlDir = await mkdtemp(join(tmpdir(), 'bootstrap-test-'));
  restorePlatform = pinPlatform('win32');
});
afterEach(async () => {
  restorePlatform();
  vi.restoreAllMocks();
  await rm(controlDir, { recursive: true, force: true });
});

function launcher(run) {
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.unref = vi.fn();
    setImmediate(() => run(child));
    return child;
  });
}
const failure = (handle) => new Promise((resolve) => handle.once('error', resolve));

describe('Windows detached bootstrap failure contract', () => {
  it.skipIf(!realWindows)('keeps a started ticketed child alive if PID publication fails', async () => {
    const marker = join(controlDir, 'child-completed');
    const original = '[System.IO.File]::WriteAllText((Join-Path $dir \'pid\'), "$($p.Id)")';
    const supervisor = __detachedSpawnTesting.WINDOWS_SUPERVISOR.replace(original, 'throw "synthetic PID write failure"');
    expect(supervisor).not.toBe(__detachedSpawnTesting.WINDOWS_SUPERVISOR);
    await writeFile(join(controlDir, 'supervisor.ps1'), supervisor);
    await writeFile(join(controlDir, 'job.json'), JSON.stringify({ bin: process.execPath,
      arguments: '-e "setTimeout(()=>require(\'fs\').writeFileSync(process.env.PORTOS_TEST_MARKER,\'ok\'),500)"',
      cwd: controlDir, preserveStartedOnBootstrapError: true }));
    const proc = nativeSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(controlDir, 'supervisor.ps1'), '-bootstrapStartedAt', String(Date.now())],
    { env: { ...process.env, PORTOS_TEST_MARKER: marker }, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('ok'), { timeout: 10000, interval: 50 });
    await expect(readFile(join(controlDir, 'exit'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15000);
  it('does not cancel a supervisor that claimed its update before PID publication', async () => {
    launcher(child => { child.emit('spawn'); child.emit('exit', 0); });
    const handle = await spawnDetached('example-job', [], { controlDir, pollMs: 1, pidTimeoutMs: 20,
      onLaunchTimeout: () => ({ state: 'claimed', ownerPid: 1234 }) });
    const error = await failure(handle);
    expect(handle.launchTimeoutResult).toEqual({ state: 'claimed', ownerPid: 1234 });
    expect(error.message).toContain('cancellation=not-requested');
    await expect(readFile(join(controlDir, 'launch-cancelled'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(controlDir, 'job.json'), 'utf8')).preserveStartedOnBootstrapError).toBe(true);
    expect(await readFile(join(controlDir, 'supervisor.ps1'), 'utf8')).toContain('if ($started -and !$preserveStarted -and !$p.HasExited)');
  });
  it('retains cancellation and bounded diagnostics when supervisor shutdown is unconfirmed', async () => {
    launcher(async (child) => {
      await writeFile(join(controlDir, 'launcher-bootstrap.log'), 'supervisor-started hresult=0');
      await writeFile(join(controlDir, 'supervisor-bootstrap.log'), [
        'reading-job hresult=0 elapsed-ms=820',
        'starting-job hresult=0 elapsed-ms=900',
        'failed hresult=-2147024894 elapsed-ms=9401',
        '',
      ].join('\n'));
      await writeFile(join(controlDir, 'exit'), '1');
      child.emit('exit', 0);
    });
    const handle = await spawnDetached('example-job', [], { controlDir, pollMs: 1, cleanup: true });
    const error = await failure(handle);
    expect(handle.pid).toBeNull();
    expect(error.message).toContain('launcher=0');
    expect(error.message).toContain('supervisor-stage=failed hresult=-2147024894');
    expect(error.message).toContain('elapsed-ms=9401; timeline=reading-job@820ms>starting-job@900ms>failed@9401ms');
    expect(error.message).toContain('cancellation=written; cleanup=unconfirmed');
    expect(await readFile(join(controlDir, 'launch-cancelled'), 'utf8')).toBe('1');
    expect(await __detachedSpawnTesting.readBootstrapDiagnostic(controlDir, 'supervisor-bootstrap.log'))
      .toContain('failed hresult=-2147024894 elapsed-ms=9401');
  });

  it('projects successful handoff timings without exporting absolute timestamps or job data', async () => {
    const rows = [
      'reading-job hresult=0 elapsed-ms=700',
      'starting-job hresult=0 elapsed-ms=750',
      'job-started hresult=0 elapsed-ms=1400',
      'handle-acquired hresult=0 elapsed-ms=1401',
      'pid-written hresult=0 elapsed-ms=1403',
    ];
    await writeFile(join(controlDir, 'supervisor-bootstrap.log'), rows.join('\r\n') + '\r\n');
    expect(await __detachedSpawnTesting.readBootstrapDiagnostic(controlDir, 'supervisor-bootstrap.log'))
      .toBe('pid-written hresult=0 elapsed-ms=1403; timeline=reading-job@700ms>starting-job@750ms>job-started@1400ms>handle-acquired@1401ms>pid-written@1403ms');
    // Retained control directories from older launches still have one row.
    await writeFile(join(controlDir, 'supervisor-bootstrap.log'), 'pid-written hresult=0');
    expect(await __detachedSpawnTesting.readBootstrapDiagnostic(controlDir, 'supervisor-bootstrap.log'))
      .toBe('pid-written hresult=0');
  });

  it.each([
    ['private trailing text', 'pid-written hresult=0 elapsed-ms=10\nsecret-value'],
    ['oversized valid prefix', 'pid-written hresult=0 elapsed-ms=10\n'.repeat(40) + 'secret-value'],
    ['excess stage count', 'pid-written hresult=0 elapsed-ms=10\n'.repeat(7)],
    ['unbounded timing', 'pid-written hresult=0 elapsed-ms=12345678901234'],
    ['unknown stage', 'secret-value hresult=0 elapsed-ms=10'],
  ])('rejects %s before successful-launch diagnostics can be logged', async (_name, value) => {
    await writeFile(join(controlDir, 'supervisor-bootstrap.log'), value);
    expect(await __detachedSpawnTesting.readBootstrapDiagnostic(controlDir, 'supervisor-bootstrap.log'))
      .toBe('invalid');
  });

  it('reports a launcher spawn error without copying paths or environment data', async () => {
    launcher((child) => child.emit('error', Object.assign(
      new Error('secret-value C:\\Users\\example-user\\private'), { code: 'ENOENT' }
    )));
    const handle = await spawnDetached('example-job', [], { controlDir, pollMs: 1 });
    const error = await failure(handle);
    expect(error.message).toContain('launcher=ENOENT');
    expect(error.message).not.toMatch(/secret-value|example-user/);
    expect(await readFile(join(controlDir, 'launcher-result.log'), 'utf8')).toBe('ENOENT');
    expect(await readFile(join(controlDir, 'launch-cancelled'), 'utf8')).toBe('1');
  });

  it('keeps a missing PID an error and rejects arbitrary bootstrap text', async () => {
    launcher(async (child) => {
      await writeFile(join(controlDir, 'supervisor-bootstrap.log'), 'secret-value '.repeat(1000));
      child.emit('exit', 1);
    });
    const handle = await spawnDetached('example-job', [], { controlDir, pollMs: 1, pidTimeoutMs: 50 });
    const error = await failure(handle);
    expect(error.message).toContain('within 50ms');
    expect(error.message).toContain('launcher=1');
    expect(error.message).toContain('supervisor-stage=invalid');
    expect(error.message).not.toContain('secret-value');
    expect(error.message.length).toBeLessThan(300);
    expect(await readFile(join(controlDir, 'launch-cancelled'), 'utf8')).toBe('1');
  });
});
