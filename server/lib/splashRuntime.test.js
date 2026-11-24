import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildCliChildEnv } from './cliChildEnv.js';
import { localRuntimeForProvider } from './localProviderRuntime.js';
import { providerConnectionProfile } from './provider/providerConnections.js';
import { prefixOpencodeModel } from './provider/providerModels.js';
import { materializeRoute, routeDescribesService } from './provider/providerRouteRecipes.js';
import { SPLASH_CONTEXT, SPLASH_MODEL, SPLASH_ORIGIN } from './splashRuntime.js';

const reference = JSON.parse(readFileSync(new URL('../../data.reference/providers.json', import.meta.url), 'utf8')).providers;
const instance = {
  definitionId: 'splash',
  transports: { openai: { baseUrl: `${SPLASH_ORIGIN}/v1` }, anthropic: { baseUrl: SPLASH_ORIGIN } },
  credentials: { apiKey: 'local-only' },
};

it('materializes both coding harnesses against their own protocol on the same Splash service', () => {
  for (const harness of ['opencode', 'claude']) {
    const route = materializeRoute({ harness, method: 'cli', serviceInstance: instance, selection: { model: SPLASH_MODEL } });
    expect(route.splashBacked).toBe(true);
    expect(routeDescribesService(providerConnectionProfile(route), instance)).toBe(true);
    expect(localRuntimeForProvider(route)).toMatchObject({
      kind: 'splash', endpoint: `${SPLASH_ORIGIN}/v1`, manageUrl: '/models/llms-runtimes/splash',
    });
  }
});

it('declares the exact OpenCode request and side model locally and keeps reasoning_content in tool-loop history', () => {
  const provider = reference['opencode-splash'];
  const env = buildCliChildEnv({ provider, model: SPLASH_MODEL, baseEnv: { OPENAI_API_KEY: 'ambient-test' } });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  expect(prefixOpencodeModel(provider, SPLASH_MODEL)).toBe(`splash/${SPLASH_MODEL}`);
  expect(config.small_model).toBe(`splash/${SPLASH_MODEL}`);
  expect(config.provider.splash.options).toEqual({ baseURL: `${SPLASH_ORIGIN}/v1` });
  expect(config.provider.splash.models[SPLASH_MODEL]).toMatchObject({
    reasoning: true, interleaved: { field: 'reasoning_content' }, tool_call: true,
    limit: { context: SPLASH_CONTEXT, output: 8192 },
  });
  expect(env.OPENAI_API_KEY).toBeUndefined();
});

it('uses the Anthropic protocol root without forwarding ambient cloud credentials', () => {
  const env = buildCliChildEnv({
    provider: reference['claude-splash'], model: SPLASH_MODEL,
    baseEnv: { ANTHROPIC_BASE_URL: 'https://example.com', ANTHROPIC_API_KEY: 'ambient-test', CLAUDE_CODE_USE_BEDROCK: '1' },
  });
  expect(env.ANTHROPIC_BASE_URL).toBe(SPLASH_ORIGIN);
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('splash');
  expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe(SPLASH_MODEL);
  expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(String(SPLASH_CONTEXT));
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
});
