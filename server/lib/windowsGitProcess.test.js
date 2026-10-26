import { once } from 'node:events';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawn } from './childProcess.js';
import { assertGitWorkSettled, execGit } from './execGit.js';
import { reserveCheckoutRetirement, releaseCheckoutReservation, withCheckoutPublication } from './checkoutRetirementAdmission.js';
import { destroyGitSandbox } from './gitTestRepo.js';

const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
async function waitForFile(path) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('Synthetic helper readiness timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe.skipIf(process.platform !== 'win32')('Windows Git owned process boundary', () => {
  it('cancels a pipe-holding helper after its Git parent exits, preserves a neighbor, and permits teardown only after settlement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portos-git-owned-tree-'));
    await execGit(['init', '-b', 'main'], root);
    const script = join(root, 'helper.cjs');
    const release = join(root, 'release');
    const ready = join(root, 'ready');
    const neighbor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, stdio: 'ignore' });
    const neighborClosed = once(neighbor, 'close');
    await writeFile(script, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [ready, release, mode] = process.argv.slice(2);
if (mode !== 'child') {
  spawn(process.execPath, [__filename, ready, release, 'child'], { detached: true, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();
} else {
  fs.writeFileSync(ready, 'ready');
  const deadline = Date.now() + 10000;
  const timer = setInterval(() => {
    if (fs.existsSync(release) || Date.now() > deadline) clearInterval(timer);
  }, 10);
}
`);
    const args = ['-c', `alias.hold=!${quote(process.execPath)} ${quote(script)} ${quote(ready)} ${quote(release)}`, 'hold'];
    // Prove the original failure at a real Windows boundary, without network:
    // the direct child has exited, but inherited pipes still belong to a helper.
    const direct = spawn('git', args, { cwd: root, shell: false });
    const directClosed = once(direct, 'close');
    let closed = false;
    void directClosed.then(() => { closed = true; });
    try {
      await once(direct, 'exit');
      await waitForFile(ready);
      direct.kill(); // The former timeout path cannot settle an already-exited parent.
      expect(closed).toBe(false);
      await writeFile(release, 'release');
      await directClosed;
      const supervisedReady = join(root, 'supervised-ready');
      const supervisedRelease = join(root, 'supervised-release');
      const supervisedArgs = ['-c', `alias.hold=!${quote(process.execPath)} ${quote(script)} ${quote(supervisedReady)} ${quote(supervisedRelease)}`, 'hold'];
      const outcome = withCheckoutPublication(root, () => execGit(supervisedArgs, root, { timeout: 1500 })).catch(error => error);
      await waitForFile(supervisedReady);
      await expect(destroyGitSandbox(root)).rejects.toMatchObject({ code: 'GIT_SETTLEMENT_HELD' });
      const failure = await outcome;
      expect(failure).toMatchObject({ code: 'GIT_TIMEOUT', settlement: 'settled' });
      expect(neighbor.exitCode).toBe(null);
      expect(() => assertGitWorkSettled(root)).not.toThrow();
      const reservation = await reserveCheckoutRetirement(root, 'confirmed-cancellation');
      await releaseCheckoutReservation(reservation);

      // Overflow shares the same cancellation path but must retain its cause.
      const overflowReady = join(root, 'overflow-ready');
      await writeFile(join(root, 'overflow.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(overflowReady)}, 'ready'); process.stdout.write('x'.repeat(4096)); setInterval(()=>{},1000);`);
      const overflow = await execGit(['-c', `alias.flood=!${quote(process.execPath)} ${quote(join(root, 'overflow.cjs'))}`, 'flood'], root, { maxBuffer: 8 }).catch(error => error);
      expect(overflow).toMatchObject({ code: 'GIT_OUTPUT_LIMIT', settlement: 'settled' });
      expect(neighbor.exitCode).toBe(null);
    } finally {
      await writeFile(release, 'release');
      await writeFile(join(root, 'supervised-release'), 'release');
      await directClosed;
      neighbor.kill();
      await neighborClosed;
      await destroyGitSandbox(root);
    }
  });

  it('preserves ordinary Git commits, opaque output, Unicode arguments and selected environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portos-git-ordinary-'));
    try {
      await execGit(['init', '-b', 'main'], root);
      await writeFile(join(root, 'example.txt'), 'example\n');
      const bytes = Buffer.from([0xff, 0, 10]);
      await writeFile(join(root, 'example.bin'), bytes);
      await execGit(['add', 'example.txt', 'example.bin'], root);
      await execGit(['-c', 'user.name=Example Agent', '-c', 'user.email=agent@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Example 界 "quoted" \\ commit\\'], root);
      const result = await execGit(['log', '-1', '--format=%s'], root, { bufferOutput: true });
      expect(result.stdout.toString().trim()).toBe('Example 界 "quoted" \\ commit\\');
      expect((await execGit(['show', 'HEAD:example.bin'], root, { bufferOutput: true })).stdout).toEqual(bytes);
      const script = join(root, 'env.cjs');
      await writeFile(script, 'process.stdout.write(process.env.EXAMPLE_GIT_ENV);');
      await chmod(script, 0o755);
      const env = { ...process.env, EXAMPLE_GIT_ENV: 'selected 界' };
      expect((await execGit(['-c', `alias.env=!${quote(process.execPath)} ${quote(script)}`, 'env'], root, { env })).stdout).toBe('selected 界');
      expect(await readFile(join(root, 'example.txt'), 'utf8')).toBe('example\n');
    } finally { await destroyGitSandbox(root); }
  });
});
