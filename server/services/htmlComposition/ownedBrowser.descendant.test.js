import { it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = vi.hoisted(() => ({ control: '', profile: '', child: null }));
vi.mock('../browserService.js', () => ({ loadConfig: async () => ({ chromePath: '/synthetic/chrome' }) }));
vi.mock('../../lib/childProcess.js', async original => ({
  ...await original(),
  spawn: (_command, args, options) => {
    fixture.profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const helper = `
      const fs = require('node:fs');
      const [profile, control] = process.argv.slice(1);
      const limit = setTimeout(() => process.exit(0), 5000);
      let terms = 0;
      process.on('SIGTERM', () => {
        if (++terms === 1) return;
        fs.writeFileSync(control + '/stopped', 'stopped');
        process.exit(0);
      });
      setInterval(() => {
        if (!fs.existsSync(control + '/write')) return;
        fs.mkdirSync(profile, { recursive: true });
        fs.writeFileSync(profile + '/late-write', 'synthetic');
        fs.writeFileSync(control + '/done', 'done');
        clearTimeout(limit);
        process.exit(0);
      }, 10);
      process.send('ready');
    `;
    const parent = `
      const { spawn } = require('node:child_process');
      const [helper, profile, control] = process.argv.slice(1);
      const child = spawn(process.execPath, ['-e', helper, profile, control], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      child.once('message', () => process.stderr.write('DevTools listening on ws://127.0.0.1:12345/devtools/browser/synthetic\\n'));
      process.on('SIGTERM', () => process.exit(0));
    `;
    fixture.child = spawn(process.execPath, ['-e', parent, helper, fixture.profile, fixture.control], options);
    return fixture.child;
  },
}));

const { launchCompositionBrowser } = await import('./ownedBrowser.js');

it.skipIf(process.platform === 'win32')('does not let an owned descendant recreate the profile after browser close', async () => {
  fixture.control = await mkdtemp(join(tmpdir(), 'owned-descendant-control-'));
  let owner;
  try {
    owner = await launchCompositionBrowser();
    await owner.close();
    expect(fixture.child.exitCode).toBe(0);
    expect(existsSync(fixture.profile)).toBe(false);
    expect(existsSync(join(fixture.control, 'stopped'))).toBe(true);
    await writeFile(join(fixture.control, 'write'), 'write');
    expect(existsSync(join(fixture.control, 'done'))).toBe(false);
    expect(existsSync(fixture.profile)).toBe(false);
  } finally {
    await owner?.close().catch(() => {});
    if (fixture.profile) await rm(fixture.profile, { recursive: true, force: true });
    await rm(fixture.control, { recursive: true, force: true });
  }
});
