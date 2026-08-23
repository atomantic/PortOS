import { describe, it, expect, beforeEach, vi } from 'vitest';

// Only the probe is stubbed — `getProviderRuntime` stays real so the "is this
// command even in the runtime table?" branch is exercised against the shipped
// table rather than a fixture that could drift from it.
vi.mock('./providerRuntimeInstaller.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProviderRuntimeStatuses: vi.fn(),
  peekProviderRuntimeStatuses: vi.fn(),
}));

const { getProviderRuntimeStatuses, peekProviderRuntimeStatuses } = await import('./providerRuntimeInstaller.js');
const { getProviderPrerequisiteMap, prerequisitesMetForRouting, __resetPrerequisiteRefresh } =
  await import('./providerPrerequisites.js');

const CODEX_ABSENT = { id: 'codex', label: 'Codex CLI', installed: false };
const CODEX_PRESENT = { id: 'codex', label: 'Codex CLI', installed: true };

const codex = (over = {}) => ({ id: 'codex', type: 'cli', command: 'codex', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrerequisiteRefresh();
  peekProviderRuntimeStatuses.mockReturnValue({});
  getProviderRuntimeStatuses.mockResolvedValue({});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getProviderPrerequisiteMap', () => {
  it('keys the verdict by provider id, from the cached runtime statuses', () => {
    peekProviderRuntimeStatuses.mockReturnValue({ codex: CODEX_ABSENT });

    const map = getProviderPrerequisiteMap([
      codex(),
      { id: 'openai', type: 'api', endpoint: 'https://api.example.com/v1' },
      { id: 'lmstudio', type: 'api', endpoint: 'http://localhost:1234/v1' },
    ]);

    expect(map.codex).toEqual({ met: false, missing: [{ code: 'runtime', label: 'Codex CLI is not installed' }] });
    expect(map.openai.met).toBe(false);
    expect(map.lmstudio.met).toBe(true);
  });

  // Fetched by half the app — a cold cache must not put a multi-second sweep of
  // every CLI on that request.
  it('never awaits the probe; a cold cache publishes no runtime finding and refreshes behind the request', () => {
    const map = getProviderPrerequisiteMap([codex()]);

    expect(map.codex).toEqual({ met: true, missing: [] });
    expect(getProviderRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  it('probes nothing for an empty collection', () => {
    expect(getProviderPrerequisiteMap([])).toEqual({});
    expect(getProviderPrerequisiteMap(null)).toEqual({});
    expect(getProviderRuntimeStatuses).not.toHaveBeenCalled();
  });

  it('reads the inherited OrcaRouter key off the sibling in the same collection', () => {
    const wrapper = { id: 'opencode-orcarouter', type: 'cli', command: 'opencode', orcarouterBacked: true };
    const sibling = (hasApiKey) => ({ id: 'orcarouter', type: 'api', hasApiKey, endpoint: 'https://api.example.com' });

    expect(getProviderPrerequisiteMap([wrapper, sibling(false)])[wrapper.id].missing.map((m) => m.code))
      .toContain('inheritedApiKey');
    expect(getProviderPrerequisiteMap([wrapper, sibling(true)])[wrapper.id].met).toBe(true);
  });

  // Each gateway wrapper is judged against ITS OWN sibling: a key on one gateway
  // must never satisfy another, or the card would report a wrapper as ready
  // while the spawn has no credential for the host it actually calls.
  it('keeps each gateway wrapper on its own sibling key', () => {
    const orcaWrapper = { id: 'opencode-orcarouter', type: 'cli', command: 'opencode', orcarouterBacked: true };
    const openWrapper = { id: 'opencode-openrouter', type: 'cli', command: 'opencode', gatewayBacked: 'openrouter' };
    const api = (id, hasApiKey) => ({ id, type: 'api', hasApiKey, endpoint: 'https://api.example.com' });

    const map = getProviderPrerequisiteMap([orcaWrapper, openWrapper, api('orcarouter', true), api('openrouter', false)]);
    expect(map[orcaWrapper.id].met).toBe(true);
    expect(map[openWrapper.id].missing).toEqual([
      { code: 'inheritedApiKey', label: 'OpenRouter API provider has no API key' },
    ]);
  });
});

describe('prerequisitesMetForRouting', () => {
  it('rejects a provider whose CLI the probe has already found absent', () => {
    peekProviderRuntimeStatuses.mockReturnValue({ codex: CODEX_ABSENT });

    expect(prerequisitesMetForRouting(codex(), {})).toBe(false);
  });

  it('accepts a provider whose CLI is installed, without re-probing', () => {
    peekProviderRuntimeStatuses.mockReturnValue({ codex: CODEX_PRESENT });

    expect(prerequisitesMetForRouting(codex(), {})).toBe(true);
    expect(getProviderRuntimeStatuses).not.toHaveBeenCalled();
  });

  it('accepts an UN-PROBED CLI and kicks a background refresh so the next pick is accurate', () => {
    expect(prerequisitesMetForRouting(codex(), {})).toBe(true);
    expect(getProviderRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  // `peekProviderRuntimeStatuses` drops a status once its TTL is up, so an
  // expired "not installed" arrives here as an absent entry. That must route
  // normally — otherwise a CLI installed by hand stays skipped until something
  // else happens to re-probe.
  it('accepts a provider whose cached negative has aged out of the snapshot', () => {
    peekProviderRuntimeStatuses.mockReturnValue({});   // codex probed, then expired

    expect(prerequisitesMetForRouting(codex(), {})).toBe(true);
    expect(getProviderRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  it('coalesces the background refresh while one is already in flight', () => {
    getProviderRuntimeStatuses.mockReturnValue(new Promise(() => {})); // never settles

    prerequisitesMetForRouting(codex(), {});
    prerequisitesMetForRouting(codex(), {});
    prerequisitesMetForRouting(codex(), {});

    expect(getProviderRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  it('logs and clears a FAILED refresh so the next call can try again', async () => {
    getProviderRuntimeStatuses.mockRejectedValueOnce(new Error('PATH scan exploded'));

    expect(prerequisitesMetForRouting(codex(), {})).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('PATH scan exploded'));
    prerequisitesMetForRouting(codex(), {});
    expect(getProviderRuntimeStatuses).toHaveBeenCalledTimes(2);
  });

  it('never probes for a provider that spawns no command', () => {
    expect(prerequisitesMetForRouting({ id: 'lmstudio', type: 'api', endpoint: 'http://localhost:1234/v1' }, {})).toBe(true);
    expect(getProviderRuntimeStatuses).not.toHaveBeenCalled();
  });

  it('never probes for a command outside the runtime table', () => {
    expect(prerequisitesMetForRouting({ id: 'custom', type: 'cli', command: 'my-own-cli' }, {})).toBe(true);
    expect(getProviderRuntimeStatuses).not.toHaveBeenCalled();
  });

  // The runtime table answers "does the bare binary resolve on PortOS's PATH?".
  // A provider pinned to an explicit path is a different question — the runner
  // spawns that path against the provider's own env — so borrowing the bare
  // binary's answer would drop a perfectly working CLI from the chain.
  it('does not borrow a bare binary\'s verdict for a provider pinned to an explicit path', () => {
    peekProviderRuntimeStatuses.mockReturnValue({ codex: CODEX_ABSENT });

    expect(prerequisitesMetForRouting(codex({ command: '/opt/example/bin/codex' }), {})).toBe(true);
    expect(getProviderRuntimeStatuses).not.toHaveBeenCalled();
  });

  // Routing acts ONLY on the missing binary. A keyless-looking provider may
  // still authenticate through a secret env var (Bedrock, an Ollama auth token)
  // — the card says NEEDS SETUP, but skipping it here would take a working
  // provider out of the chain. See ROUTING_BLOCKING_CODES / issue #4612.
  it('does NOT reject a keyless API provider, however its card is painted', () => {
    expect(prerequisitesMetForRouting({ id: 'openai', type: 'api', endpoint: 'https://api.example.com/v1' }, {})).toBe(true);
    expect(prerequisitesMetForRouting({ id: 'peer', type: 'api', endpoint: 'http://desk.ts.net:11434' }, {})).toBe(true);
  });

  it('does NOT reject an OrcaRouter wrapper over its sibling key alone', () => {
    peekProviderRuntimeStatuses.mockReturnValue({ opencode: { id: 'opencode', label: 'OpenCode CLI', installed: true } });
    const wrapper = { id: 'opencode-orcarouter', type: 'cli', command: 'opencode', orcarouterBacked: true };

    expect(prerequisitesMetForRouting(wrapper, { orcarouter: { id: 'orcarouter' } })).toBe(true);
    // …but the missing BINARY still takes it out of the chain.
    peekProviderRuntimeStatuses.mockReturnValue({ opencode: { id: 'opencode', label: 'OpenCode CLI', installed: false } });
    expect(prerequisitesMetForRouting(wrapper, { orcarouter: { id: 'orcarouter' } })).toBe(false);
  });

  it('logs one line naming what is missing when it skips a provider', () => {
    peekProviderRuntimeStatuses.mockReturnValue({ codex: CODEX_ABSENT });

    prerequisitesMetForRouting(codex(), {});

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Codex CLI is not installed'));
  });
});
