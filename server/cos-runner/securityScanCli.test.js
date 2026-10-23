import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises';
import { delimiter, dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { resolveInstalledSecurityScanner } from './securityScanCli.js';

let root;
let options;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scanner-cli-test-')));
  options = { home: join(root, 'home'), root: join(root, 'repo'), environment: { PATH: join(root, 'bin') } };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function install(directory, { name = '@openai/codex-security', bin = './bin/codex-security.mjs' } = {}) {
  await mkdir(join(directory, 'bin'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '0.2.0', bin: { 'codex-security': bin } }));
  const entry = join(directory, 'bin/codex-security.mjs');
  await writeFile(entry, 'throw new Error("Discovery must never execute a scanner");');
  const declaredEntry = resolve(directory, bin);
  if (declaredEntry !== entry) {
    await mkdir(dirname(declaredEntry), { recursive: true });
    await writeFile(declaredEntry, 'throw new Error("Discovery must never execute a different entry");');
  }
  return entry;
}

async function globalInstall(metadata) {
  const directory = join(root, 'global/lib/node_modules/@openai/codex-security');
  const entry = await install(directory, metadata);
  await mkdir(options.environment.PATH, { recursive: true });
  await symlink(entry, join(options.environment.PATH, 'codex-security'));
  return entry;
}

describe.skipIf(process.platform === 'win32')('installed security scanner discovery', () => {
  it('finds a global npm executable on PATH without invoking npm or the scanner', async () => {
    const entry = await globalInstall();
    options.environment.PATH = `${join(root, 'missing')}${delimiter}${options.environment.PATH}`;
    expect(await resolveInstalledSecurityScanner(options)).toEqual({ command: process.execPath, args: [entry], version: '0.2.0' });
  });

  it('prefers the local install, then PATH, while retaining the cached-install fallback', async () => {
    const local = join(options.root, 'node_modules/@openai/codex-security');
    const cached = join(options.home, '.npm/_npx/abcd/node_modules/@openai/codex-security');
    const localEntry = await install(local);
    const cachedEntry = await install(cached);
    const globalEntry = await globalInstall();
    expect((await resolveInstalledSecurityScanner(options)).args).toEqual([localEntry]);
    await rm(local, { recursive: true });
    expect((await resolveInstalledSecurityScanner(options)).args).toEqual([globalEntry]);
    options.environment.PATH = '';
    expect((await resolveInstalledSecurityScanner(options)).args).toEqual([cachedEntry]);
  });

  it.each([
    { name: 'unrelated-package' },
    { bin: '../../outside.mjs' },
    { bin: './bin/other-entry.mjs' },
  ])('rejects a PATH executable that does not match the official package bin: %j', async metadata => {
    await globalInstall(metadata);
    expect(await resolveInstalledSecurityScanner(options)).toBeNull();
  });

  it('reports a missing installation without using ambient PATH or installing anything', async () => {
    expect(await resolveInstalledSecurityScanner(options)).toBeNull();
  });
});
