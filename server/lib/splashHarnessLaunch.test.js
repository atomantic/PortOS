import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCliChildEnv, composeProviderEnv } from './cliChildEnv.js';
import { resolveSplashHarnessContext } from './splashHarnessLaunch.js';
import { SPLASH_ORIGIN } from './splashRuntime.js';

const MODEL = 'inkling2-mini';
const CONTEXT = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS';
const claude = {
  type: 'cli', command: 'claude', splashBacked: true, defaultModel: MODEL,
  envVars: { ANTHROPIC_BASE_URL: SPLASH_ORIGIN, [CONTEXT]: '65536' },
};
const opencode = {
  type: 'tui', command: 'opencode', splashBacked: true, defaultModel: `splash/${MODEL}`,
  envVars: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { splash: { options: { baseURL: `${SPLASH_ORIGIN}/v1` } } } }) },
};
const composeRuntimeProviderEnv = async ({ provider }) => composeProviderEnv({ provider: await resolveSplashHarnessContext(provider) });
const listing = (tokens) => Response.json({ data: [{ id: MODEL, owned_by: 'splash', max_model_len: tokens }] });

afterEach(() => vi.unstubAllGlobals());

describe('Splash launch context', () => {
  it('resolves live again for the next launch without persisting or copying a pin', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(listing(262144)).mockResolvedValueOnce(listing(1000000));
    vi.stubGlobal('fetch', fetch);
    expect((await composeRuntimeProviderEnv({ provider: claude }))[CONTEXT]).toBe('262144');
    expect((buildCliChildEnv({ provider: await resolveSplashHarnessContext(claude), baseEnv: {} }))[CONTEXT]).toBe('1000000');
    expect(claude.envVars[CONTEXT]).toBe('65536');
    expect(fetch).toHaveBeenCalledWith(`${SPLASH_ORIGIN}/v1/models`, expect.objectContaining({ redirect: 'error' }));
  });

  it('hands the observed size to OpenCode without dropping its output allowance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(524288)));
    const env = await composeRuntimeProviderEnv({ provider: opencode });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.splash.models[MODEL].limit)
      .toMatchObject({ context: 524288, output: 8192 });
  });

  it('preserves explicit and older custom pins and never probes an edited endpoint', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await composeRuntimeProviderEnv({ provider: { ...claude, harnessContext: { tokens: 32768 } } }))[CONTEXT]).toBe('32768');
    const custom = { ...claude, envVars: { ...claude.envVars, [CONTEXT]: '131072' } };
    expect((await composeRuntimeProviderEnv({ provider: custom }))[CONTEXT]).toBe('131072');
    const remote = { ...claude, envVars: { ...claude.envVars, ANTHROPIC_BASE_URL: 'http://example.invalid:8001' } };
    expect((await composeRuntimeProviderEnv({ provider: remote }))[CONTEXT]).toBe('65536');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the fallback instead of an old custom pin if follow is selected and Splash cannot report a limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const provider = { ...claude, harnessContext: { followRuntime: true }, envVars: { ...claude.envVars, [CONTEXT]: '131072' } };
    expect((await composeRuntimeProviderEnv({ provider }))[CONTEXT]).toBe('65536');
  });
});
