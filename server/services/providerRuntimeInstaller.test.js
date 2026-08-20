import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_VENDORS } from '../lib/providerVendors.js';
import {
  buildRuntimeInstallCommand,
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
  });

  it('reports runnable availability as booleans without returning local paths', async () => {
    const findCommand = vi.fn(async (command) => command === 'opencode' ? '/example/opencode' : '/example/npm');
    const probeCommand = vi.fn(async () => true);

    const status = await getProviderRuntimeStatus('opencode', { findCommand, probeCommand });

    expect(status).toEqual({
      id: 'opencode',
      label: 'OpenCode CLI',
      command: 'opencode',
      installed: true,
      method: 'npm',
      installable: true,
      blockedReason: null,
      docsUrl: expect.stringContaining('http'),
    });
    expect(findCommand).toHaveBeenCalledWith('opencode');
    expect(findCommand).toHaveBeenCalledWith('npm');
    // The resolved executable path can carry the host account name.
    expect(JSON.stringify(status)).not.toContain('/example/');
  });

  // A cold agentic CLI can take seconds to answer; commandExists's 5s default
  // clocked these as uninstalled, which here would offer a redundant install.
  it('probes with the longer agentic-CLI timeout', async () => {
    const probeCommand = vi.fn(async () => false);
    await getProviderRuntimeStatus('codex', { findCommand: async () => '/example/codex', probeCommand });

    expect(probeCommand).toHaveBeenCalledWith('/example/codex', ['--version'], { timeoutMs: 15_000 });
  });

  it('reports a PATH-resolved but broken CLI as unavailable', async () => {
    const status = await getProviderRuntimeStatus('codex', {
      findCommand: async () => '/example/codex',
      probeCommand: async () => false,
    });

    expect(status.installed).toBe(false);
    expect(status.installable).toBe(true);
  });

  it('blocks an npm-backed install with a reason when npm is missing', async () => {
    const status = await getProviderRuntimeStatus('claude', {
      findCommand: async (command) => command === 'npm' ? null : '/example/claude',
      probeCommand: async () => true,
    });

    expect(status.installable).toBe(false);
    expect(status.blockedReason).toContain('npm is not available');
  });

  it('gates a script-backed install on curl and the platform', async () => {
    const probeCommand = vi.fn(async () => false);
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
    await expect(getProviderRuntimeStatus('rm-rf', { findCommand: async () => null, probeCommand: async () => false })).resolves.toBeNull();
  });

  it('answers every runtime in one keyed map, resolving each install tool once', async () => {
    const findCommand = vi.fn(async () => null);
    const statuses = await getProviderRuntimeStatuses({ findCommand, probeCommand: async () => false });

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
    const missing = vi.fn(async () => false);
    const present = vi.fn(async () => true);

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

    const statuses = await getProviderRuntimeStatuses({ findCommand: async () => null, probeCommand: async () => false });
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
      await getProviderRuntimeStatus('agy', { findCommand, probeCommand: async () => false });
      findCommand.mockClear();

      const peeked = peekProviderRuntimeStatuses();

      expect(peeked.agy.installed).toBe(false);
      expect(peeked.antigravity).toBe(peeked.agy);
      expect(peeked.codex).toBeUndefined();   // never probed → absent, not false
      expect(findCommand).not.toHaveBeenCalled();
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
