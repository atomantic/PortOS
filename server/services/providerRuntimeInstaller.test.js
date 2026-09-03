import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_VENDORS } from '../lib/providerVendors.js';

// The npm-prefix probe shells out; the PATH-adoption contract itself is covered
// by lib/npmGlobalBin.test.js.
const npmGlobalBin = vi.hoisted(() => ({ adoptNpmGlobalBinDir: vi.fn(async () => null) }));
vi.mock('../lib/npmGlobalBin.js', () => npmGlobalBin);

import {
  buildRuntimeActionCommand,
  buildRuntimeInstallCommand,
  buildRuntimeUninstallCommand,
  buildRuntimeUpdateCommand,
  RUNTIME_ACTIONS,
  getProviderRuntime,
  getProviderRuntimeStatus,
  getProviderRuntimeStatuses,
  NPM_GLOBAL_INSTALL_FLAGS,
  PROVIDER_RUNTIMES,
  peekProviderRuntimeStatuses,
  spawnRuntimeInstaller,
  __resetRuntimeStatusCache,
} from './providerRuntimeInstaller.js';

const IS_WIN = process.platform === 'win32';

describe('provider runtime installer', () => {
  beforeEach(() => {
    __resetRuntimeStatusCache();
    npmGlobalBin.adoptNpmGlobalBinDir.mockClear();
  });

  it('reports runnable availability as booleans without returning local paths', async () => {
    const findCommand = vi.fn(async (command) => command === 'opencode' ? '/example/opencode' : '/example/npm');
    // The default probe answers the `--version` banner; a boolean probe is
    // still accepted and simply carries no version.
    const probeCommand = vi.fn(async () => '1.18.27');

    const status = await getProviderRuntimeStatus('opencode', { findCommand, probeCommand });

    expect(status).toEqual({
      id: 'opencode',
      label: 'OpenCode CLI',
      command: 'opencode',
      installed: true,
      version: '1.18.27',
      method: 'npm',
      installable: true,
      blockedReason: null,
      docsUrl: expect.stringContaining('http'),
      updatable: true,
      removable: true,
      listsModels: true,
    });
    expect(findCommand).toHaveBeenCalledWith('opencode');
    expect(findCommand).toHaveBeenCalledWith('npm');
    // The resolved executable path can carry the host account name.
    expect(JSON.stringify(status)).not.toContain('/example/');
  });

  // A cold agentic CLI can take seconds to answer; commandExists's 5s default
  // clocked these as uninstalled, which here would offer a redundant install.
  it('probes with the longer agentic-CLI timeout', async () => {
    const probeCommand = vi.fn(async () => null);
    await getProviderRuntimeStatus('codex', { findCommand: async () => '/example/codex', probeCommand });

    expect(probeCommand).toHaveBeenCalledWith('/example/codex', ['--version'], { timeoutMs: 15_000 });
  });

  // npm installs into ITS OWN global bin directory, which is not necessarily
  // one the host's Node installer put on PATH. Without adopting that directory
  // the probe reports a perfectly installed CLI as missing, and the card offers
  // an install that can never take.
  it('adopts the npm global bin directory before probing', async () => {
    await getProviderRuntimeStatus('codex', { findCommand: async () => null, probeCommand: async () => null });

    expect(npmGlobalBin.adoptNpmGlobalBinDir).toHaveBeenCalled();
  });

  it('reports a PATH-resolved but broken CLI as unavailable', async () => {
    const status = await getProviderRuntimeStatus('codex', {
      findCommand: async () => '/example/codex',
      probeCommand: async () => null,
    });

    expect(status.installed).toBe(false);
    expect(status.installable).toBe(true);
  });

  it('blocks an npm-backed install with a reason when npm is missing', async () => {
    const status = await getProviderRuntimeStatus('claude', {
      findCommand: async (command) => command === 'npm' ? null : '/example/claude',
      probeCommand: async () => '1.2.3',
    });

    expect(status.installable).toBe(false);
    expect(status.blockedReason).toContain('npm is not available');
  });

  it('gates a script-backed install on curl and the platform', async () => {
    const probeCommand = vi.fn(async () => null);
    const withCurl = await getProviderRuntimeStatus('cursor-agent', { findCommand: async () => '/example/curl', probeCommand });
    const withoutCurl = await getProviderRuntimeStatus('cursor-agent', { fresh: true, findCommand: async () => null, probeCommand });

    expect(withCurl.method).toBe('script');
    expect(withCurl.installable).toBe(!IS_WIN);
    expect(withoutCurl.installable).toBe(false);
    expect(withoutCurl.blockedReason).toBeTruthy();
  });

  it('returns nothing for a runtime that is not in the table', async () => {
    expect(getProviderRuntime('rm-rf')).toBeNull();
    expect(getProviderRuntime(undefined)).toBeNull();
    expect(buildRuntimeInstallCommand('rm-rf')).toBeNull();
    expect(spawnRuntimeInstaller('rm-rf', { spawnImpl: () => { throw new Error('must not spawn'); } })).toBeNull();
    await expect(getProviderRuntimeStatus('rm-rf', { findCommand: async () => null, probeCommand: async () => null })).resolves.toBeNull();
  });

  it('answers every runtime in one keyed map, resolving each install tool once', async () => {
    const findCommand = vi.fn(async () => null);
    const statuses = await getProviderRuntimeStatuses({ findCommand, probeCommand: async () => null });

    const published = PROVIDER_RUNTIMES.flatMap((runtime) => [runtime.id, ...runtime.aliases]);
    expect(Object.keys(statuses).sort()).toEqual(published.sort());
    expect(statuses.agy.installed).toBe(false);
    // Five rows install through npm and two through curl — one PATH scan each.
    expect(findCommand.mock.calls.filter(([command]) => command === 'npm')).toHaveLength(1);
    expect(findCommand.mock.calls.filter(([command]) => command === 'curl')).toHaveLength(1);
  });

  // The AI Providers page re-reads this after every provider mutation, and each
  // miss costs a child process per runtime.
  it('serves repeat reads from the TTL cache and re-probes on demand', async () => {
    const findCommand = async () => '/example/bin';
    const missing = vi.fn(async () => null);
    const present = vi.fn(async () => '1.2.3');

    const first = await getProviderRuntimeStatus('codex', { findCommand, probeCommand: missing });
    const second = await getProviderRuntimeStatus('codex', { findCommand, probeCommand: present });
    expect(second).toBe(first);
    expect(present).not.toHaveBeenCalled();

    // `fresh` must bypass it — the install route verifies a just-installed CLI
    // against a cache entry it primed itself seconds earlier.
    const third = await getProviderRuntimeStatus('codex', { fresh: true, findCommand, probeCommand: present });
    expect(third.installed).toBe(true);
    expect(await getProviderRuntimeStatus('codex', { findCommand, probeCommand: missing })).toBe(third);
  });

  // The install surface is exactly the table: no request value ever reaches a
  // package name, a URL, or a shell word.
  it('builds only fixed invocations from the runtime table', () => {
    expect(buildRuntimeInstallCommand('grok')).toEqual({
      command: 'npm',
      args: [...NPM_GLOBAL_INSTALL_FLAGS, '@xai-official/grok@latest'],
    });
    expect(buildRuntimeInstallCommand('agy')).toEqual({
      command: 'bash',
      args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
    });
  });

  it('spawns the global npm package install without a shell', () => {
    const spawnImpl = vi.fn(() => ({ pid: 123 }));

    spawnRuntimeInstaller('opencode', { spawnImpl });

    const [command, args, options] = spawnImpl.mock.calls[0];
    if (IS_WIN) {
      // Windows must launch npm's .cmd shim through cmd.exe because Node
      // rejects direct .cmd spawns when shell:false.
      expect(command).toBe('cmd.exe');
      expect(args.slice(0, 2)).toEqual(['/c', expect.stringMatching(/npm\.cmd$/i)]);
    } else {
      expect(command).toBe('npm');
    }
    expect(options).toEqual(expect.objectContaining({
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !IS_WIN,
    }));
  });

  // A provider may be configured with any command spelling its vendor accepts
  // (`antigravity` as well as `agy`), and the card looks its runtime up by that
  // command — so every alias the vendor matches must resolve the same row.
  it('resolves an aliased command to its canonical runtime', async () => {
    expect(PROVIDER_RUNTIMES.find((runtime) => runtime.id === 'agy').aliases).toContain('antigravity');
    for (const runtime of PROVIDER_RUNTIMES) {
      const vendor = PROVIDER_VENDORS.find((row) => row.inferredCommand === runtime.command);
      for (const alias of runtime.aliases) {
        expect(vendor.matchCommand(alias)).toBe(true);
        expect(getProviderRuntime(alias)).toBe(runtime);
      }
    }

    const statuses = await getProviderRuntimeStatuses({ findCommand: async () => null, probeCommand: async () => null });
    // Same object under both spellings, and its id stays canonical so the
    // install POST names the runtime the table knows.
    expect(statuses.antigravity).toBe(statuses.agy);
    expect(statuses.antigravity.id).toBe('agy');
  });

  // The sync read the fallback router depends on (#4611). It must answer
  // "not probed" — not "not installed" — for anything the async probe has not
  // reached yet, or a cold cache would take every CLI provider out of routing.
  describe('peekProviderRuntimeStatuses', () => {
    it('is empty before anything has been probed', () => {
      expect(peekProviderRuntimeStatuses()).toEqual({});
    });

    it('returns a probed runtime, under its aliases too, without probing again', async () => {
      const findCommand = vi.fn(async () => null);
      await getProviderRuntimeStatus('agy', { findCommand, probeCommand: async () => null });
      findCommand.mockClear();

      const peeked = peekProviderRuntimeStatuses();

      expect(peeked.agy.installed).toBe(false);
      expect(peeked.antigravity).toBe(peeked.agy);
      expect(peeked.codex).toBeUndefined();   // never probed → absent, not false
      expect(findCommand).not.toHaveBeenCalled();
    });

    // A cached "not installed" that has aged out must stop being an answer, or
    // a CLI the user installed from a terminal stays skipped by routing until
    // something else happens to re-probe.
    it('drops a status once its TTL is up, so an expired negative reads as unprobed', async () => {
      await getProviderRuntimeStatus('codex', { findCommand: async () => null, probeCommand: async () => null });
      expect(peekProviderRuntimeStatuses().codex.installed).toBe(false);

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
      expect(peekProviderRuntimeStatuses().codex).toBeUndefined();
      vi.restoreAllMocks();
    });
  });

  // #3618's rule: a vendor is one row. A new coding-agent CLI must not land in
  // the runner allowlist and argv builders while silently having no way to be
  // installed from the Providers page.
  it('offers an install for every live CLI vendor', () => {
    const installable = new Set(PROVIDER_RUNTIMES.map((runtime) => runtime.command));
    for (const vendor of PROVIDER_VENDORS) {
      // The legacy gemini-cli row is deliberately incomplete — Gemini CLI was
      // migrated to Antigravity and ships no installable binary of its own.
      if (vendor.id === 'gemini-legacy') continue;
      expect(installable).toContain(vendor.inferredCommand);
    }
  });
});

describe('harness lifecycle actions', () => {
  // The vendor's own updater is the ONLY path that refreshes the copy actually
  // on PATH. A Homebrew- or script-installed OpenCode is invisible to npm, so
  // re-running `npm install --global` writes a second copy that may not win the
  // PATH race and leaves the stale binary running — the exact failure the
  // Harnesses page exists to fix.
  it('prefers a vendor self-updater over re-running the npm install', () => {
    expect(buildRuntimeUpdateCommand('opencode')).toEqual({ command: 'opencode', args: ['upgrade'] });
    expect(buildRuntimeUpdateCommand('agy')).toEqual({ command: 'agy', args: ['update'] });
  });

  it('exposes update and uninstall through the shared action builder', () => {
    expect(buildRuntimeActionCommand('opencode', 'install')).toEqual(buildRuntimeInstallCommand('opencode'));
    expect(buildRuntimeActionCommand('opencode', 'update')).toEqual(buildRuntimeUpdateCommand('opencode'));
    expect(buildRuntimeActionCommand('opencode', 'uninstall')).toEqual(buildRuntimeUninstallCommand('opencode'));
  });

  it('removes only what a package manager installed', () => {
    expect(buildRuntimeUninstallCommand('opencode')).toEqual({
      command: 'npm',
      args: ['uninstall', '--global', '--no-progress', 'opencode-ai'],
    });
    // Script-installed vendors publish no uninstall PortOS can run; guessing at
    // `rm` paths would delete whatever happens to sit at a path, not the binary.
    expect(buildRuntimeUninstallCommand('agy')).toBeNull();
    expect(buildRuntimeUninstallCommand('cursor-agent')).toBeNull();
  });

  it('refuses an unknown action and an unknown runtime rather than falling back', () => {
    // A silent fallback to `install` would turn a typo'd action into a global
    // package write.
    expect(buildRuntimeActionCommand('opencode', 'purge')).toBeNull();
    expect(buildRuntimeActionCommand('not-a-harness', 'install')).toBeNull();
    expect(spawnRuntimeInstaller('opencode', { action: 'purge', spawnImpl: () => 'spawned' })).toBeNull();
  });

  // Three places name this action set: the argv builders here, the SSE runner's
  // copy table, and the route's zod enum. They cannot import each other freely
  // (lib must not import services), so this is what keeps them from drifting —
  // a fourth action added to one alone would reach `HARNESS_ACTION_COPY[action]`
  // as `undefined` and crash mid-stream, or be refused at the boundary.
  it('publishes exactly the actions the routes accept', async () => {
    expect([...RUNTIME_ACTIONS].sort()).toEqual(['install', 'uninstall', 'update']);

    const { HARNESS_ACTION_COPY } = await import('./harnessActionStream.js');
    expect(Object.keys(HARNESS_ACTION_COPY).sort()).toEqual([...RUNTIME_ACTIONS].sort());

    const { harnessActionSchema } = await import('../lib/validation.js');
    expect([...harnessActionSchema.shape.action.unwrap().unwrap().options].sort())
      .toEqual([...RUNTIME_ACTIONS].sort());
  });

  it('strips the @latest install tag from the package identity', () => {
    // `npm view <pkg>@latest version` and `npm uninstall -g <pkg>@latest` both
    // want the bare name; the tag belongs only to the install invocation.
    for (const runtime of PROVIDER_RUNTIMES) {
      if (runtime.install.kind !== 'npm') { expect(runtime.npmPackage).toBeNull(); continue; }
      expect(runtime.npmPackage).not.toMatch(/@latest$/);
      expect(runtime.install.package).toBe(`${runtime.npmPackage}@latest`);
    }
  });

  // The parser table in lib/harnessOutput.js and the `modelsArgs` here are two
  // halves of one capability: a row claiming it can list models with no parser
  // would report an empty catalog and refuse forever.
  it('declares modelsArgs for exactly the harnesses harnessOutput can parse', async () => {
    const { HARNESS_MODEL_PARSER_IDS } = await import('../lib/harnessOutput.js');
    const declared = PROVIDER_RUNTIMES.filter((runtime) => runtime.modelsArgs).map((runtime) => runtime.id);
    expect(declared.sort()).toEqual([...HARNESS_MODEL_PARSER_IDS].sort());
  });
});
