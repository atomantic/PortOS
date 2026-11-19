/**
 * scripts/setup.js is the one install pipeline behind `npm run setup`,
 * setup.sh and setup.ps1 (#16820). These tests pin the ordered steps, the
 * fail-soft versus fail-fast split, and that no wrapper regrows its own copy of
 * the install chain, the ffmpeg installer or the slash-do install.
 *
 * Nothing here installs anything: the in-process tests inject the command
 * runner, and the CLI tests run a copy of setup.js in a disposable root whose
 * npm, git and step scripts are stubs that append to a call log.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildSetupSteps, runSetup } from './setup.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(REPO_ROOT, relativePath), 'utf8');

const STEP_SCRIPTS = [
  'checkNodeVersion.js', 'checkNpmVersion.js', 'checkGitVersion.js',
  'setup-data.js', 'setup-db.js', 'setup-llm.js', 'setup-browser.js', 'setup-cert.js',
  'ensure-ffmpeg.js', 'install-slashdo.js', 'setup-guide.js'
];
const WORKSPACE_LABELS = ['root', 'client', 'server', 'autofixer'];

/** The full ordered call log of a successful run, shared by the in-process and CLI tests. */
const EXPECTED_ORDER = [
  'checkNodeVersion.js --security',
  'checkNpmVersion.js',
  'checkGitVersion.js',
  'git submodule update --init --recursive',
  ...WORKSPACE_LABELS.map((label) => `install ${label}`),
  'setup-data.js',
  'setup-db.js',
  'setup-llm.js',
  'setup-browser.js',
  'setup-cert.js',
  'ensure-ffmpeg.js --non-interactive',
  'install-slashdo.js',
  'setup-guide.js'
];

describe('runSetup step order', () => {
  // A root of its own: the real checkout may be a worktree with linked node_modules, which setup refuses.
  const cleanRoot = mkdtempSync(join(tmpdir(), 'portos-setup-order-'));
  afterAll(() => rmSync(cleanRoot, { recursive: true, force: true }));

  function run({ interactive = false, failing = [], root = cleanRoot } = {}) {
    const calls = [];
    const exec = (command, args) => {
      const label = command === process.execPath ? [basename(args[0]), ...args.slice(1)].join(' ') : [command, ...args].join(' ');
      calls.push(label);
      return failing.some((name) => label.startsWith(name)) ? 3 : 0;
    };
    const install = (dir, label) => {
      calls.push(`install ${label}`);
      return !failing.includes(`install ${label}`);
    };
    const logs = [];
    const code = runSetup({ root, interactive, exec, install, log: (line) => logs.push(line) });
    return { code, calls, logs };
  }

  it('runs every step once, in the documented order', () => {
    const { code, calls } = run();
    expect(code).toBe(0);
    expect(calls).toEqual(EXPECTED_ORDER);
  });

  it('lets ffmpeg prompt for sudo only when stdin is a TTY', () => {
    expect(run({ interactive: true }).calls).toContain('ensure-ffmpeg.js');
    expect(run({ interactive: true }).calls).not.toContain('ensure-ffmpeg.js --non-interactive');
  });

  it('keeps going when ffmpeg or slash-do fail', () => {
    const { code, calls } = run({ failing: ['ensure-ffmpeg.js', 'install-slashdo.js'] });
    expect(code).toBe(0);
    expect(calls).toEqual(EXPECTED_ORDER);
  });

  it.each(['setup-db.js', 'git submodule', 'install server', 'checkNodeVersion.js'])('stops at a failed %s and runs nothing after it', (failing) => {
    const { code, calls, logs } = run({ failing: [failing] });
    expect(code).not.toBe(0);
    const failedAt = EXPECTED_ORDER.findIndex((entry) => entry.startsWith(failing));
    expect(calls).toEqual(EXPECTED_ORDER.slice(0, failedAt + 1));
    expect(logs.join('\n')).toMatch(/Setup step ".+" failed/);
  });

  it('lists the same step ids the wrappers rely on', () => {
    expect(buildSetupSteps({ root: cleanRoot, interactive: false }).map(({ id }) => id)).toEqual([
      'versions', 'submodules', 'dependencies', 'data', 'database', 'llm', 'browser', 'cert', 'ffmpeg', 'slash-do', 'guide'
    ]);
  });

  // A CoS worktree's node_modules are symlinks into the primary checkout; a
  // setup run there would empty the primary's dependencies.
  it('refuses to install through linked node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-setup-linked-'));
    try {
      const shared = join(root, 'shared-deps');
      mkdirSync(shared);
      mkdirSync(join(root, 'client'));
      symlinkSync(shared, join(root, 'client', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const { code, calls, logs } = run({ root });
      expect(code).not.toBe(0);
      expect(calls.some((entry) => entry.startsWith('install '))).toBe(false);
      expect(logs.join('\n')).toMatch(/Refusing to install: client\/node_modules is linked/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The pipeline end to end through the real file, with a stubbed npm, git and
// step scripts. `git` is a PATH-resolved shell stub, which Node cannot resolve
// on Windows without a .cmd shim, so Windows runs the in-process tests above.
describe.skipIf(process.platform === 'win32')('node scripts/setup.js', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'portos-setup-cli-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(root, 'server', 'lib'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    for (const label of ['client', 'autofixer']) mkdirSync(join(root, label));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    for (const file of ['setup.js', 'ensure-deps.js', 'lib/directInvocation.js', 'lib/workspaceDependencies.js']) {
      copyFileSync(join(REPO_ROOT, 'scripts', file), join(root, 'scripts', file));
    }
    writeFileSync(join(root, 'scripts', 'trusted-rebuilds.js'), `
      import { appendFileSync } from 'fs';
      export const rebuildTrusted = (dir, label) => { appendFileSync(process.env.SETUP_CALLS, 'rebuild ' + label + '\\n'); return true; };
    `);
    writeFileSync(join(root, 'server', 'lib', 'bufferedSpawn.js'), `
      import { fileURLToPath } from 'url';
      export const prepareCliSpawn = (command, args) => ({
        command: process.execPath,
        args: [fileURLToPath(new URL('../../fake-npm.js', import.meta.url)), ...args]
      });
    `);
    writeFileSync(join(root, 'fake-npm.js'), `
      import { appendFileSync } from 'fs';
      import { dirname, relative } from 'path';
      import { fileURLToPath } from 'url';
      const label = relative(dirname(fileURLToPath(import.meta.url)), process.cwd()) || 'root';
      appendFileSync(process.env.SETUP_CALLS, 'npm ' + label + ' ' + process.argv.slice(2).join(' ') + '\\n');
    `);
    for (const name of STEP_SCRIPTS) {
      writeFileSync(join(root, 'scripts', name), `
        import { appendFileSync } from 'fs';
        appendFileSync(process.env.SETUP_CALLS, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
        if ((process.env.SETUP_FAIL ?? '').split(',').includes(${JSON.stringify(name)})) process.exit(7);
      `);
    }
    writeFileSync(join(root, 'bin', 'git'), '#!/bin/sh\necho "git $*" >> "$SETUP_CALLS"\n');
    chmodSync(join(root, 'bin', 'git'), 0o755);
    const calls = join(root, 'calls.log');
    writeFileSync(calls, '');
    const run = (env = {}) => {
      try {
        execFileSync(process.execPath, [join(root, 'scripts', 'setup.js')], {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, SETUP_CALLS: calls, ...env }
        });
        return 0;
      } catch (error) {
        return error.status;
      }
    };
    const logged = () => readFileSync(calls, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    return { root, run, logged };
  }

  it('installs each workspace by cwd with --no-save (never --prefix) and runs the steps in order', () => {
    const f = fixture();
    try {
      expect(f.run()).toBe(0);
      const installs = WORKSPACE_LABELS.flatMap((label) => [`npm ${label} install --no-save`, `rebuild ${label}`]);
      expect(f.logged()).toEqual([
        'checkNodeVersion.js --security',
        'checkNpmVersion.js',
        'checkGitVersion.js',
        'git submodule update --init --recursive',
        ...installs,
        'setup-data.js', 'setup-db.js', 'setup-llm.js', 'setup-browser.js', 'setup-cert.js',
        'ensure-ffmpeg.js --non-interactive',
        'install-slashdo.js',
        'setup-guide.js'
      ]);
      expect(f.logged().join('\n')).not.toContain('--prefix');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('exits 0 when the ffmpeg and slash-do helpers fail, and non-zero with no later steps when setup-db fails', () => {
    const f = fixture();
    try {
      expect(f.run({ SETUP_FAIL: 'ensure-ffmpeg.js,install-slashdo.js' })).toBe(0);
      expect(f.logged().at(-1)).toBe('setup-guide.js');
      writeFileSync(join(f.root, 'calls.log'), '');
      expect(f.run({ SETUP_FAIL: 'setup-db.js' })).toBe(7);
      expect(f.logged().at(-1)).toBe('setup-db.js');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

// The point of the pipeline is that nothing else keeps a copy. These read the
// wrappers' source because the wrappers cannot be run on every platform here.
describe('the wrappers do not regrow their own pipeline', () => {
  const WRAPPERS = ['setup.sh', 'setup.ps1', 'update.sh', 'update.ps1'];
  const INSTALLER = /(brew|apt-get|dnf|pacman|winget)[^\n]*(install|-S)[^\n]*ffmpeg/;

  // Each detector decides whether its scan means anything, so it is verified.
  it('the detectors flag the copies they exist to catch', () => {
    expect(INSTALLER.test('brew install ffmpeg')).toBe(true);
    expect(INSTALLER.test('$maybe_sudo apt-get install -y ffmpeg')).toBe(true);
    expect(INSTALLER.test('node scripts/ensure-ffmpeg.js')).toBe(false);
  });

  it('npm run setup is scripts/setup.js and install:all stays an alias', () => {
    const { scripts } = JSON.parse(read('package.json'));
    expect(scripts.setup).toBe('node scripts/setup.js');
    expect(scripts['install:all']).toBe('npm run setup');
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, `package.json script ${name}`).not.toMatch(/\bnpm install\b[^&]*--prefix/);
    }
  });

  it('setup.sh and setup.ps1 hand the whole chain to scripts/setup.js', () => {
    expect(read('setup.sh')).toContain('node scripts/setup.js');
    expect(read('setup.ps1')).toContain('node scripts/setup.js');
  });

  it('setup.ps1 runs no install, rebuild or setup step of its own', () => {
    const source = read('setup.ps1');
    expect(source).not.toMatch(/\bnpm\b\s+(install|ci)/);
    expect(source).not.toContain('trusted-rebuilds');
    expect(source).not.toMatch(/Push-Location/);
    // The interactive Ghostty prompt is the one setup script the wrapper still owns.
    const setupScripts = [...source.matchAll(/scripts[\\/](setup-[\w-]+\.js)/g)].map(([, name]) => name);
    expect(setupScripts.filter((name) => name !== 'setup-ghostty.js')).toEqual([]);
  });

  it('setup.sh keeps deferring the setup guide until after its start prompt', () => {
    const source = read('setup.sh');
    expect(source).toMatch(/PORTOS_DEFER_SETUP_GUIDE=1 node scripts\/setup\.js/);
    expect(source.indexOf('node scripts/setup-guide.js')).toBeGreaterThan(source.indexOf('Start PortOS now'));
    expect(read('scripts/setup-guide.js')).toContain("process.env.PORTOS_DEFER_SETUP_GUIDE === '1'");
  });

  it.each(WRAPPERS)('%s holds no ffmpeg installer', (file) => {
    expect(read(file)).not.toMatch(INSTALLER);
  });

  it('only the helper contains the slash-do install', () => {
    expect(read('scripts/install-slashdo.js')).toContain('slash-do@');
    for (const file of [...WRAPPERS, 'scripts/setup.js']) {
      expect(read(file), file).not.toMatch(/slash-do@|(Get-Content|<)[^\n]*SLASHDO_VERSION/);
    }
  });
});
