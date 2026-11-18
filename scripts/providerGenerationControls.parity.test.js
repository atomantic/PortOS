import { describe, expect, it } from 'vitest';
import { generationControlsFor } from '../client/src/utils/providers.js';
import { composeProviderEnv } from '../server/lib/cliChildEnv.js';
import { LOCAL_RUNTIMES } from '../server/lib/localProviderRuntime.js';
import { buildAgentGeneration } from '../server/lib/opencodeConfig.js';
import { PROVIDER_GATEWAYS } from '../server/lib/providerGateways.js';
import { getOpencodeLocalProviderNamespace } from '../server/lib/providerModels.js';

// The CLI forwarding code depends on Node and cannot enter the client import
// graph. Cross-layer tests live here so both production import boundaries hold.
describe('generation controls match CLI forwarding', () => {
  // Use an explicit temperature distinct from Ollama's default and an explicit
  // false to exercise the same thinking override that Claude on Ollama forwards.
  const generation = { temperature: 0.73, topP: 0.91, thinking: false };
  const localBackends = Object.keys(LOCAL_RUNTIMES).map((id) => [id, { [`${id}Backed`]: true }]);
  const gateways = PROVIDER_GATEWAYS.map(({ id }) => [id, { gatewayBacked: id }]);
  const legacyGateways = PROVIDER_GATEWAYS.flatMap(({ id, legacyMarker }) =>
    legacyMarker ? [[`${id} (legacy marker)`, { [legacyMarker]: true }]] : []);

  const controls = (temperature, topP, thinking) =>
    temperature || topP || thinking ? { temperature, topP, thinking } : null;

  it.each([...localBackends, ...gateways, ...legacyGateways])('OpenCode on %s', (_id, markers) => {
    const provider = { type: 'tui', command: 'opencode', ...markers };
    const options = buildAgentGeneration(generation, getOpencodeLocalProviderNamespace(provider));

    expect(generationControlsFor(provider)).toEqual(controls(
      options?.temperature === generation.temperature,
      options?.topP === generation.topP,
      typeof (options?.think ?? options?.chat_template_kwargs?.enable_thinking) === 'boolean',
    ));
  });

  it.each([
    ...localBackends.map(([id, markers]) => [id, { command: 'claude', ...markers }]),
    ['ollama (default Claude command)', { command: '', ollamaBacked: true }],
  ])('Claude on %s', (_id, identity) => {
    const provider = { type: 'tui', ...identity, ...generation };
    const env = composeProviderEnv({ provider });

    expect(generationControlsFor(provider)).toEqual(controls(false, false, env.MAX_THINKING_TOKENS === '0'));
  });
});
