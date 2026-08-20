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
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getProviderPrerequisiteMap', () => {
  it('keys the verdict by provider id, from one runtime probe for the batch', async () => {
    getProviderRuntimeStatuses.mockResolvedValue({ codex: CODEX_ABSENT });

    const map = await getProviderPrerequisiteMap([
      codex(),
      { id: 'openai', type: 'api', endpoint: 'https://api.example.com/v1' },
      { id: 'lmstudio', type: 'api', endpoint: 'http://localhost:1234/v1' },
    ]);

    expect(getProviderRuntimeStatuses).toHaveBeenCalledTimes(1);
    expect(map.codex).toEqual({ met: false, missing: [{ code: 'runtime', label: 'Codex CLI is not installed' }] });
    expect(map.openai.met).toBe(false);
    expect(map.lmstudio.met).toBe(true);
  });

  it('probes nothing for an empty collection', async () => {
    expect(await getProviderPrerequisiteMap([])).toEqual({});
    expect(await getProviderPrerequisiteMap(null)).toEqual({});
    expect(getProviderRuntimeStatuses).not.toHaveBeenCalled();
  });

  it('reads the inherited OrcaRouter key off the sibling in the same collection', async () => {
    getProviderRuntimeStatuses.mockResolvedValue({});
    const wrapper = { id: 'opencode-orcarouter', type: 'cli', command: 'opencode', orcarouterBacked: true };

    const keyless = await getProviderPrerequisiteMap([wrapper, { id: 'orcarouter', type: 'api', hasApiKey: false, endpoint: 'https://api.example.com' }]);
    expect(keyless[wrapper.id].missing.map((m) => m.code)).toContain('inheritedApiKey');

    const keyed = await getProviderPrerequisiteMap([wrapper, { id: 'orcarouter', type: 'api', hasApiKey: true, endpoint: 'https://api.example.com' }]);
    expect(keyed[wrapper.id].met).toBe(true);
  });
});

describe('prerequisitesMetForRouting', () => {
  it('rejects a provider whose CLI the probe has already found absent', () => {
    peekProviderRuntimeStatuses.mockReturnValue({ codex: CODEX_ABSENT });

    expect(prerequisitesMetForRouting(codex(), {})).toBe(false);
  });

  it('accepts a provider whose CLI is installed', () => {
    peekProviderRuntimeStatuses.mockReturnValue({ codex: CODEX_PRESENT });

    expect(prerequisitesMetForRouting(codex(), {})).toBe(true);
    expect(getProviderRuntimeStatuses).not.toHaveBeenCalled();
  });

  it('accepts an UN-PROBED CLI and kicks a background refresh so the next pick is accurate', () => {
    peekProviderRuntimeStatuses.mockReturnValue({});
    getProviderRuntimeStatuses.mockResolvedValue({});

    expect(prerequisitesMetForRouting(codex(), {})).toBe(true);
    expect(getProviderRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  it('coalesces the background refresh while one is already in flight', () => {
    peekProviderRuntimeStatuses.mockReturnValue({});
    getProviderRuntimeStatuses.mockReturnValue(new Promise(() => {})); // never settles

    prerequisitesMetForRouting(codex(), {});
    prerequisitesMetForRouting(codex(), {});
    prerequisitesMetForRouting(codex(), {});

    expect(getProviderRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  it('never probes for a provider that spawns no command', () => {
    peekProviderRuntimeStatuses.mockReturnValue({});

    expect(prerequisitesMetForRouting({ id: 'lmstudio', type: 'api', endpoint: 'http://localhost:1234/v1' }, {})).toBe(true);
    expect(getProviderRuntimeStatuses).not.toHaveBeenCalled();
  });

  // Routing acts ONLY on the missing binary. A keyless-looking provider may
  // still authenticate through a secret env var (Bedrock, an Ollama auth token)
  // — the card says NEEDS SETUP, but skipping it here would take a working
  // provider out of the chain. See ROUTING_BLOCKING_CODES / issue #4612.
  it('does NOT reject a keyless API provider, however its card is painted', () => {
    peekProviderRuntimeStatuses.mockReturnValue({});

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

  it('never probes for a command outside the runtime table', () => {
    peekProviderRuntimeStatuses.mockReturnValue({});

    expect(prerequisitesMetForRouting({ id: 'custom', type: 'cli', command: 'my-own-cli' }, {})).toBe(true);
    expect(getProviderRuntimeStatuses).not.toHaveBeenCalled();
  });

  it('logs one line naming what is missing when it skips a provider', () => {
    peekProviderRuntimeStatuses.mockReturnValue({ codex: CODEX_ABSENT });

    prerequisitesMetForRouting(codex(), {});

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Codex CLI is not installed'));
  });
});
