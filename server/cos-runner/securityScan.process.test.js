import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFileSync, spawn } from '../lib/childProcess.js';
import { createSecurityScanManager } from './securityScan.js';
import { cleanupSecurityScanGroup } from './securityScanRecovery.js';

let root;
const owners = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'scanner-process-test-')); await mkdir(join(root, 'repo'));
  execFileSync('git', ['init', '--template='], { cwd: join(root, 'repo') });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic baseline'], { cwd: join(root, 'repo') });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await cleanupSecurityScanGroup(owner);
  await rm(root, { recursive: true, force: true });
});
// Where PID 1 does not reap orphans (some containers), a killed orphan stays a
// zombie that still answers signal 0; on Linux its /proc state says it exited.
const zombie = pid => { try { return /^[ZX]$/.test(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0]); } catch { return false; } };
const gone = pid => { try { process.kill(pid, 0); return process.platform === 'linux' && zombie(pid); } catch (err) { return err.code === 'ESRCH'; } };

it.skipIf(process.platform === 'win32')('reaps a real inherited worker after the scanner exits without waiting for its pipes', async () => {
  // This fixture is a local Node process only. It has no provider/network code.
  const fixture = join(root, 'fixture.cjs');
  await writeFile(fixture, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const out=process.argv[process.argv.indexOf('--output-dir')+1];
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    fs.writeFileSync(out+'/worker.pid',String(child.pid)); child.unref(); process.exit(0);`);
  const manager = createSecurityScanManager({ agentsDir: join(root, 'agents'), tempRoot: root,
    getAgent: () => ({ workspacePath: join(root, 'repo') }),
    resolveCli: async () => ({ command: process.execPath, args: [fixture] }),
  });
  await manager.register('agent-example', { model: 'example-model', effort: 'medium', auth: 'chatgpt', maxCostUsd: 'unlimited', timeLimitSeconds: 'unlimited' });
  const result = await manager.start('agent-example', { prompt: 'Synthetic lifecycle fixture', paths: ['.'] });
  owners.push(JSON.parse(await readFile(join(root, 'agents/agent-example/security-scan-process.json'), 'utf8')));
  const workerPid = Number(await readFile(join(result.artifactDirectory, 'results/worker.pid'), 'utf8'));
  expect(result.evidence).toMatchObject({ status: 'completed', exitCode: 0, cleanup: 'confirmed' });
  await vi.waitFor(() => expect(gone(workerPid)).toBe(true));
});

it.skipIf(process.platform === 'win32')('waits for the durable-receipt handshake and kills its group on runner IPC loss', async () => {
  const marker = randomUUID();
  const supervisor = fileURLToPath(new URL('./securityScanChild.js', import.meta.url));
  const child = spawn(process.execPath, [supervisor, root], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, PORTOS_SECURITY_SCAN_OWNER: marker } });
  const owner = { pid: child.pid, startedAt: Date.now(), marker, outputDir: root };
  owners.push(owner);
  const exit = new Promise(resolve => child.once('exit', resolve));
  const markerFile = join(root, 'launched');
  expect(await readFile(markerFile).catch(() => null)).toBeNull();
  child.send({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(markerFile)},String(process.pid));setInterval(()=>{},1000)`] });
  let workerPid;
  await vi.waitFor(async () => { workerPid = Number(await readFile(markerFile, 'utf8')); expect(workerPid).toBeGreaterThan(1); });
  child.disconnect();
  await exit;
  await vi.waitFor(() => expect(gone(workerPid)).toBe(true));
  expect(await cleanupSecurityScanGroup(owner)).toBe(true);
});
