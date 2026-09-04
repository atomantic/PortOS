import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

import { TRUSTED_REBUILDS, discoverWorkspaces, workspaceDir, rebuildTrusted, runCli } from './trusted-rebuilds.js';
import { prepareCliSpawn } from '../server/lib/bufferedSpawn.js';

// Discovered, not hand-listed: a hardcoded roster here would silently miss a
// workspace added later, leaving it with no `ignore-scripts` guard while this
// suite stayed green — the same drift the shared allowlist exists to prevent.
const WORKSPACES = discoverWorkspaces();

const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall'];

/**
 * Packages a workspace declares an install hook for, read from the committed
 * lockfile. This is the CI-safe path: `scripts/**` is globbed only by the SERVER
 * vitest runner, and the server CI job installs only server deps — so for
 * client/autofixer/browser there is no node_modules and a node_modules-only scan
 * silently skipped, meaning the accounting assertion below never ran for them in
 * CI. A dependency there gaining a postinstall (a Dependabot bump, or a
 * compromised release) would have sailed through green. The lockfile is committed,
 * so this works with zero installs.
 */
function lockfileInstallScriptPackages(label) {
  const lock = join(workspaceDir(label), 'package-lock.json');
  if (!existsSync(lock)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(lock, 'utf8'));
  } catch {
    return null;
  }
  return new Set(
    Object.entries(parsed?.packages ?? {})
      .filter(([, meta]) => meta?.hasInstallScript === true)
      .map(([path]) => path.replace(/.*node_modules\//, ''))
  );
}

/**
 * Packages in a workspace's installed tree that declare a lifecycle install hook.
 * Returns null when the workspace has no node_modules (e.g. the client tree in
 * the server CI job), which is a skip rather than a pass.
 *
 * Only two levels are ever walked — top-level `node_modules/*` and one level into
 * `node_modules/@scope/*` — because npm scopes do not nest.
 */
function packagesWithInstallHooks(label) {
  const modulesDir = join(workspaceDir(label), 'node_modules');
  if (!existsSync(modulesDir)) return null;

  const dirNames = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };

  const packageDirs = dirNames(modulesDir).flatMap((name) => (
    name.startsWith('@')
      ? dirNames(join(modulesDir, name)).map((scoped) => join(modulesDir, name, scoped))
      : [join(modulesDir, name)]
  ));

  const found = new Set();
  for (const packageDir of packageDirs) {
    const manifest = join(packageDir, 'package.json');
    if (!existsSync(manifest)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    // A `binding.gyp` counts even with no explicit hook: npm runs node-gyp
    // implicitly for such a package, and `ignore-scripts=true` blocks that too —
    // so a gyp-only native dependency would otherwise be left unbuilt AND
    // unflagged, which is the exact silent-failure this guard exists to prevent.
    const hasImplicitGypBuild = existsSync(join(packageDir, 'binding.gyp'));
    if (hasImplicitGypBuild || LIFECYCLE_HOOKS.some((hook) => pkg?.scripts?.[hook])) found.add(pkg.name);
  }
  return found;
}

/** A workspace's .npmrc settings, comments and blank lines stripped. */
function npmrcSettings(label) {
  const npmrc = join(workspaceDir(label), '.npmrc');
  expect(existsSync(npmrc), `${label}/.npmrc is missing — npm does not inherit the root .npmrc for this workspace's install path`).toBe(true);
  return readFileSync(npmrc, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

describe('workspace .npmrc guards', () => {
  it('discovers every installable workspace', () => {
    // Sanity-check the discovery itself: if it silently returned only the root,
    // every per-workspace assertion below would vacuously pass.
    expect(WORKSPACES).toContain('root');
    expect(WORKSPACES).toContain('client');
    expect(WORKSPACES).toContain('server');
    expect(WORKSPACES.length).toBeGreaterThanOrEqual(4);
  });

  // npm resolves the project .npmrc from the *local prefix* and never walks up the
  // tree, so the repo-root file does NOT cover `cd client && npm install` or
  // `npm ci --prefix client` (what CI runs). A workspace missing this file silently
  // re-grants every dependency in it an install-time code-execution slot — the
  // vector the Aug 2026 keyv/cacheable worm used via a preinstall hook.
  it.each(WORKSPACES)('%s/.npmrc pins ignore-scripts=true', (label) => {
    expect(npmrcSettings(label), `${label}/.npmrc must set ignore-scripts=true`).toContain('ignore-scripts=true');
  });

  // `npm install` performs an advisory lookup AFTER it has finished writing
  // node_modules, and BLOCKS on it: a stalled request costs fetch-timeout (300s)
  // times fetch-retries (2) before npm moves on. On 2026-09-03 that endpoint began
  // accepting the TLS handshake and never answering, which cost a measured 153s per
  // workspace — four workspaces per managed install path — for a summary that goes
  // to a log file. Same local-prefix rule as above: the root file does not cover
  // `cd client && npm install`, so a workspace missing this line silently reopens
  // the stall for every install path at once.
  it.each(WORKSPACES)('%s/.npmrc pins audit=false', (label) => {
    expect(npmrcSettings(label), `${label}/.npmrc must set audit=false`).toContain('audit=false');
  });
});

describe('trusted rebuild allowlist', () => {
  it('declares only known workspaces, each with a valid shape', () => {
    for (const [label, groups] of Object.entries(TRUSTED_REBUILDS)) {
      expect(WORKSPACES).toContain(label);
      expect(Array.isArray(groups)).toBe(true);
      for (const group of groups) {
        expect(Array.isArray(group.pkgs)).toBe(true);
        expect(group.pkgs.length).toBeGreaterThan(0);
        expect(typeof group.fatal).toBe('boolean');
      }
    }
  });

  it('groups packages by distinct failure semantics, not one group per package', () => {
    // Each group is another npm spawn, so a group only earns its cost by carrying
    // a different `fatal` value than its neighbours.
    for (const [label, groups] of Object.entries(TRUSTED_REBUILDS)) {
      const fatalValues = groups.map((group) => group.fatal);
      expect(new Set(fatalValues).size, `${label}: two groups share the same \`fatal\` value — merge them into one npm rebuild call`).toBe(groups.length);
    }
  });

  // ignore-scripts=true blocks EVERY install hook, so any package that legitimately
  // needs one must be named explicitly. If a new dependency arrives with a
  // postinstall and nobody decides about it, it is silently left unbuilt — which
  // surfaces much later as a confusing runtime crash on a missing native binding.
  // Fail here instead, when the dependency lands, and force the decision.
  // `fsevents` carries `hasInstallScript: true` in the lockfiles, but that is stale
  // registry metadata: the installed 2.3.3 ships `fsevents.node` prebuilt and
  // declares no hook and no binding.gyp (verified in all three trees that have it).
  // It is also darwin-only and optional, so it is absent entirely on CI. Nothing to
  // rebuild — recorded here so the lockfile-derived check stays honest rather than
  // being loosened.
  const FSEVENTS_STALE_FLAG = ['fsevents'];
  // Scalar's Vue 3 renderer brings in vue-demi. Its postinstall only rewrites
  // the shipped compatibility files when the host uses Vue 2; PortOS uses Vue
  // 3 and the package already ships in Vue 3 mode. Keep the hook blocked rather
  // than expanding the lifecycle-script allowlist for a no-op.
  const VUE_DEMI_VUE3_NOOP = ['vue-demi'];
  const DELIBERATELY_UNBUILT = {
    root: FSEVENTS_STALE_FLAG,
    client: [...FSEVENTS_STALE_FLAG, ...VUE_DEMI_VUE3_NOOP],
    server: FSEVENTS_STALE_FLAG
  };

  it('detects install hooks at all, so the accounting assertion is not vacuous', () => {
    // `unaccounted === []` also passes when the scan finds nothing, so a scan that
    // silently broke (wrong path, changed npm layout, a `readdirSync` throw swallowed
    // by the catch) would look exactly like a clean tree. Pin the known-hooked server
    // packages so a broken scan fails loudly instead of reporting success.
    //
    // Deciding "absent" from the directory directly rather than from a `null` return
    // is what makes this non-vacuous: the helper also returns `null` when it looks at
    // the WRONG path, so trusting its own `null` would let exactly the broken-scan
    // case skip the assertion it exists to make.
    if (!existsSync(join(workspaceDir('server'), 'node_modules'))) return;
    const hooked = packagesWithInstallHooks('server');
    expect(hooked, 'scan returned null even though server/node_modules exists — it is looking at the wrong path').not.toBeNull();
    expect(hooked.has('node-pty'), 'scan did not find node-pty — it declares install+postinstall').toBe(true);
    expect(hooked.size).toBeGreaterThanOrEqual(3);
  });

  // The lockfile-driven twin of the test below. This one runs in EVERY CI job for
  // EVERY workspace, installed or not, which is what closes the silent-skip hole.
  it.each(WORKSPACES)('%s: every lockfile-declared install hook is accounted for', (label) => {
    // Decide "no lockfile" from the file itself, not from the helper's `null` — the
    // helper also returns `null` when the lockfile is unreadable or unparseable, so
    // trusting its `null` would silently skip exactly the broken cases. This is the
    // same vacuity trap called out for the node_modules twin below; do not collapse
    // it back into `if (declared === null) return`.
    if (!existsSync(join(workspaceDir(label), 'package-lock.json'))) return; // browser/ has no deps
    const declared = lockfileInstallScriptPackages(label);
    expect(declared, `${label}/package-lock.json exists but could not be parsed`).not.toBeNull();
    const allowed = new Set([
      ...(TRUSTED_REBUILDS[label] ?? []).flatMap((group) => group.pkgs),
      ...(DELIBERATELY_UNBUILT[label] ?? [])
    ]);
    const unaccounted = [...declared].filter((name) => !allowed.has(name));
    expect(
      unaccounted,
      `${label}: package-lock.json marks these with hasInstallScript, but they are not in the allowlist in scripts/trusted-rebuilds.js. ignore-scripts=true blocks their build, so either add them (if the build is needed) or list them under DELIBERATELY_UNBUILT with the reason: ${unaccounted.join(', ')}`
    ).toEqual([]);
  });

  it('reads install-script flags from the lockfile, so the check is not vacuous', () => {
    // Same vacuity trap as below: an empty result passes. The server lock is known
    // to flag node-pty, so a broken read fails loudly instead of looking clean.
    const declared = lockfileInstallScriptPackages('server');
    expect(declared).not.toBeNull();
    expect(declared.has('node-pty'), 'server lockfile should mark node-pty hasInstallScript').toBe(true);
  });

  it.each(WORKSPACES)('%s: every installed package with an install hook is accounted for', (label) => {
    const hooked = packagesWithInstallHooks(label);
    if (hooked === null) return; // node_modules absent in this job
    const allowed = new Set([
      ...(TRUSTED_REBUILDS[label] ?? []).flatMap((group) => group.pkgs),
      ...(DELIBERATELY_UNBUILT[label] ?? [])
    ]);
    const unaccounted = [...hooked].filter((name) => !allowed.has(name));
    expect(
      unaccounted,
      `${label}: these packages declare an install hook that ignore-scripts=true blocks, but are not in the allowlist in scripts/trusted-rebuilds.js. Either add them (if the build is needed) or list them under DELIBERATELY_UNBUILT: ${unaccounted.join(', ')}`
    ).toEqual([]);
  });
});

// The fatal/non-fatal decision is the module's entire purpose: if it inverts or is
// dropped, a failed node-pty build exits 0, `npm run setup` and the CI rebuild step
// both report success, and the missing binding resurfaces much later as a confusing
// MODULE_NOT_FOUND at smoke-boot. Assert the decision directly with an injected
// spawner rather than only asserting the shape of TRUSTED_REBUILDS.
describe('rebuildTrusted failure semantics', () => {
  const failFor = (needle) => (_bin, args) => {
    if (args.some((arg) => arg === needle)) throw new Error(`boom: ${needle}`);
  };

  it('spawns one npm rebuild per group, with the group\'s packages', () => {
    const calls = [];
    rebuildTrusted('/tmp', 'server', { spawn: (bin, args) => calls.push([bin, args]) });
    // Compared against prepareCliSpawn rather than a hardcoded `npm` + args pair:
    // the launchable form is platform-dependent (on Windows npm is a `.cmd` shim
    // that has to be wrapped), so pinning the POSIX shape would fail the suite on
    // a Windows checkout.
    expect(calls).toEqual(TRUSTED_REBUILDS.server.map((group) => {
      const { command, args } = prepareCliSpawn('npm', ['rebuild', ...group.pkgs]);
      return [command, args];
    }));
  });

  it('fails when a fatal group fails', () => {
    expect(rebuildTrusted('/tmp', 'server', { spawn: failFor('node-pty') })).toBe(false);
  });

  it('still succeeds when only a non-fatal group fails', () => {
    expect(rebuildTrusted('/tmp', 'server', { spawn: failFor('onnxruntime-node') })).toBe(true);
  });

  it('attempts every group even after one fails', () => {
    const calls = [];
    rebuildTrusted('/tmp', 'server', {
      spawn: (_bin, args) => { calls.push(args); if (args.includes('node-pty')) throw new Error('boom'); }
    });
    expect(calls.length).toBe(TRUSTED_REBUILDS.server.length);
  });

  it('is a no-op for a workspace with no trusted rebuilds', () => {
    const calls = [];
    expect(rebuildTrusted('/tmp', 'client', { spawn: (...a) => calls.push(a) })).toBe(true);
    expect(calls).toEqual([]);
  });
});

// Node ≥18.20.2 REFUSES to spawn a `.cmd`/`.bat` target under `shell:false` and
// throws `spawnSync npm.cmd EINVAL`. Because the node-pty group is fatal, that
// throw made `trusted-rebuilds.js server` exit 1, which made `update.ps1` exit
// before the client build and the pm2 restart — so every Windows update left the
// UI reporting "the served client build is older than the UI source", with no
// way to clear it by updating again. bufferedSpawn owns the wrap; this asserts
// the end-to-end property that regressed, on whatever platform CI runs.
describe('npm spawn shape', () => {
  it('never hands a bare .cmd/.bat to a shell-less spawn', () => {
    const { command } = prepareCliSpawn('npm', ['rebuild', 'node-pty']);
    expect(command, 'a .cmd target under shell:false throws EINVAL').not.toMatch(/\.(cmd|bat)$/i);
  });

  it('actually runs npm on this platform', () => {
    const { command, args } = prepareCliSpawn('npm', ['--version']);
    const out = execFileSync(command, args, { encoding: 'utf8', windowsHide: true });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('runCli exit codes', () => {
  const noop = () => {};

  it('exits 1 with usage when no label is given', () => {
    expect(runCli([], { spawn: noop })).toBe(1);
  });

  it('exits 1 on an unknown label instead of reporting a green no-op', () => {
    // The regression this guards: `sever` previously printed "✅ no trusted rebuilds
    // needed" and exited 0, leaving node-pty unbuilt behind a passing CI step.
    expect(runCli(['sever'], { spawn: noop })).toBe(1);
  });

  it('exits 0 for a real workspace that needs no rebuilds', () => {
    expect(runCli(['browser'], { spawn: noop })).toBe(0);
  });

  it('exits 0 when every rebuild succeeds and 1 when a fatal one fails', () => {
    expect(runCli(['server', '/tmp'], { spawn: noop })).toBe(0);
    expect(runCli(['server', '/tmp'], {
      spawn: (_bin, args) => { if (args.includes('node-pty')) throw new Error('boom'); }
    })).toBe(1);
  });
});
