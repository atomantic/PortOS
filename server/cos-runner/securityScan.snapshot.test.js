import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, lstat, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from '../lib/childProcess.js';
import { createSecurityScanManager } from './securityScan.js';
import { cleanupSecurityScanGroup } from './securityScanRecovery.js';

let root, source;
const managers = [];
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', env: { ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const commit = () => { git('add', '.'); return git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic baseline'); };
const grant = { model: 'example-model', effort: 'medium', auth: 'chatgpt', maxCostUsd: 'unlimited', timeLimitSeconds: 'unlimited' };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scanner-snapshot-test-')));
  source = join(root, 'source');
  await mkdir(source);
  git('init', '--template=');
  await writeFile(join(source, 'boundary.js'), 'committed boundary');
  await writeFile(join(source, 'context.md'), 'committed knowledge');
  commit();
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop('agent-fixture').catch(() => {});
  const owner = await readFile(join(root, 'agents/agent-fixture/security-scan-process.json'), 'utf8').then(JSON.parse).catch(() => null);
  await cleanupSecurityScanGroup(owner);
  await rm(root, { recursive: true, force: true });
});

async function setup(options = {}) {
  const fixture = join(root, 'scanner.cjs');
  // A synthetic process only: captures the received scope, without any network
  // or provider code. The real runner/supervisor/Git ownership path is exercised.
  await writeFile(fixture, `const fs=require('node:fs');
    fs.writeFileSync(${JSON.stringify(join(root, 'launched.json'))},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
    console.log(JSON.stringify({cost:{estimatedUsd:0}}));`);
  const manager = createSecurityScanManager({ agentsDir: join(root, 'agents'), tempRoot: root,
    getAgent: () => ({ workspacePath: source }),
    resolveCli: async () => ({ command: process.execPath, args: [fixture] }), ...options });
  managers.push(manager);
  await manager.register('agent-fixture', grant);
  return manager;
}

describe.skipIf(process.platform === 'win32')('scanner committed snapshot boundary', () => {
  it('pins all inputs to independent objects and preserves the baseline through live edits and commits', async () => {
    const initialCommit = git('rev-parse', 'HEAD');
    const initialTree = git('rev-parse', 'HEAD^{tree}');
    await writeFile(join(source, 'boundary.js'), 'dirty content excluded');
    await writeFile(join(source, 'untracked.txt'), 'untracked content excluded');
    const manager = await setup({ emitEvidence: async (_id, evidence) => {
      if (evidence.status === 'running' && evidence.baseline) {
        await writeFile(join(source, 'boundary.js'), 'later repair');
        commit();
      }
    } });
    const result = await manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['boundary.js'], knowledgeBase: ['context.md'] });
    expect(result.evidence).toMatchObject({ status: 'completed', exitCode: 0, cleanup: 'confirmed', baseline: {
      commit: initialCommit, tree: initialTree, kind: 'git-commit', uncommitted: 'excluded', submodules: 'excluded', symlinks: 'link-text',
    } });
    const launch = JSON.parse(await readFile(join(root, 'launched.json'), 'utf8'));
    expect(launch.cwd).not.toBe(source);
    expect(launch.args[1]).toBe(launch.cwd);
    expect(launch.args[launch.args.indexOf('--path') + 1]).toBe(join(launch.cwd, 'boundary.js'));
    expect(launch.args[launch.args.indexOf('--knowledge-base') + 1]).toBe(join(launch.cwd, 'context.md'));
    expect(await readFile(join(launch.cwd, 'boundary.js'), 'utf8')).toBe('committed boundary');
    expect(await lstat(join(launch.cwd, 'untracked.txt')).catch(() => null)).toBeNull();
    expect(git('rev-parse', 'HEAD')).not.toBe(initialCommit);
    expect(await readFile(join(launch.cwd, '.git/objects/info/alternates')).catch(() => null)).toBeNull();
    expect(await readFile(join(launch.cwd, '.git/config'), 'utf8')).not.toContain('[remote');
    expect(await manager.start('agent-fixture', { prompt: 'Again', paths: ['.'] })).toEqual(result);
  });

  it('does not execute source filters/hooks or follow symlinks and reports submodule exclusions', async () => {
    await symlink(join(root, 'outside'), join(source, 'link'));
    await writeFile(join(source, '.gitattributes'), 'boundary.js filter=fixture\n');
    commit();
    git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},vendor`);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic gitlink');
    await mkdir(join(source, 'vendor'));
    const marker = join(root, 'hook-ran');
    git('config', 'filter.fixture.smudge', `touch ${marker}`);
    git('config', 'uploadpack.packObjectsHook', `touch ${marker}`);
    const hooks = join(root, 'hooks'); await mkdir(hooks);
    await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`); await chmod(join(hooks, 'post-checkout'), 0o700);
    git('config', 'core.hooksPath', hooks);
    const manager = await setup();
    const result = await manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['.'] });
    expect(result.evidence.status).toBe('completed');
    const launch = JSON.parse(await readFile(join(root, 'launched.json'), 'utf8'));
    expect((await lstat(join(launch.cwd, 'link'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(launch.cwd, 'link'), 'utf8')).toBe(join(root, 'outside'));
    expect(await readFile(join(launch.cwd, 'boundary.js'), 'utf8')).toBe('committed boundary');
    expect(await lstat(marker).catch(() => null)).toBeNull();
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: launch.cwd, encoding: 'utf8' }).trim()).toBe('');
  });

  it.each(['uncommitted', 'submodule', 'git-metadata'])('rejects %s selected context before provider launch and permits an explicit correction after cleanup', async kind => {
    const path = kind === 'uncommitted' ? 'draft.md' : kind === 'submodule' ? 'vendor' : '.git/config';
    if (kind === 'uncommitted') await writeFile(join(source, path), 'not in commit');
    else if (kind === 'submodule') {
      git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},vendor`);
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic gitlink');
      await mkdir(join(source, path));
    }
    const manager = await setup();
    const result = await manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['.'], knowledgeBase: [path] });
    expect(result.evidence).toMatchObject({ status: 'invalid-input', cleanup: 'confirmed', preflight: { lastError: {
      field: 'knowledgeBase', code: kind === 'submodule' ? 'submodule-excluded' : 'not-in-commit',
    } } });
    expect(await lstat(join(root, 'launched.json')).catch(() => null)).toBeNull();
    const corrected = await manager.start('agent-fixture', { prompt: 'Corrected input', paths: ['.'] });
    expect(corrected.evidence).toMatchObject({ status: 'completed', preflight: result.evidence.preflight });
    expect(await manager.start('agent-fixture', { prompt: 'Again', paths: ['.'] })).toEqual(corrected);
  });

  it('stops owned Git preparation and never launches the scanner after Stop', async () => {
    const bin = join(root, 'bin'); await mkdir(bin);
    const marker = join(root, 'git-worker');
    await writeFile(join(bin, 'git'), `#!/bin/sh\necho $$ > '${marker}'\nexec sleep 300\n`);
    await chmod(join(bin, 'git'), 0o700);
    const manager = await setup({ environment: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, graceMs: 100 });
    const run = manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['.'] });
    await vi.waitFor(async () => expect(Number(await readFile(marker, 'utf8'))).toBeGreaterThan(1));
    const pid = Number(await readFile(marker, 'utf8'));
    expect((await manager.stop('agent-fixture')).status).toBe('interrupted');
    expect((await run).evidence.cleanup).toBe('confirmed');
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await lstat(join(root, 'launched.json')).catch(() => null)).toBeNull();
  });

  it('fails closed if committed baseline evidence cannot be persisted before launch', async () => {
    const manager = await setup({ emitEvidence: async (_id, evidence) => {
      if (evidence.baseline) throw new Error('Synthetic persistence failure');
    } });
    const run = manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['.'] });
    await expect(run).rejects.toThrow('Synthetic persistence failure');
    expect(manager.start('agent-fixture', { prompt: 'Again', paths: ['.'] })).toBe(run);
    expect(await lstat(join(root, 'launched.json')).catch(() => null)).toBeNull();
  });
});
