import { describe, it, expect } from 'vitest';
import {
  PROVIDER_GATEWAYS,
  PROVIDER_GATEWAY_IDS,
  gatewayById,
  gatewayForProvider,
  gatewayIdForProvider,
  isGatewayNamespace,
} from './providerGateways.js';
import { getOpencodeLocalProviderNamespace, prefixOpencodeModel } from './providerModels.js';

describe('providerGateways', () => {
  it('ships both gateways with a complete row', () => {
    expect(PROVIDER_GATEWAY_IDS).toEqual(['orcarouter', 'openrouter']);
    for (const gateway of PROVIDER_GATEWAYS) {
      expect(gateway.label).toBeTruthy();
      expect(gateway.baseURL).toMatch(/^https:\/\//);
      expect(gateway.apiKeyEnv).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it('resolves the generic gatewayBacked marker', () => {
    expect(gatewayIdForProvider({ gatewayBacked: 'openrouter' })).toBe('openrouter');
    expect(gatewayIdForProvider({ gatewayBacked: 'orcarouter' })).toBe('orcarouter');
  });

  // Records written before the registry existed carry the per-gateway boolean.
  // Installs upgrade on their own schedule and nothing rewrites stored records,
  // so this must keep resolving forever.
  it('still resolves the legacy orcarouterBacked boolean', () => {
    expect(gatewayIdForProvider({ orcarouterBacked: true })).toBe('orcarouter');
    expect(getOpencodeLocalProviderNamespace({ orcarouterBacked: true })).toBe('orcarouter');
  });

  it('returns null for a non-gateway provider', () => {
    expect(gatewayForProvider({ ollamaBacked: true })).toBeNull();
    expect(gatewayForProvider({ gatewayBacked: 'not-a-gateway' })).toBeNull();
    expect(gatewayForProvider(null)).toBeNull();
    expect(gatewayForProvider('opencode')).toBeNull();
    expect(gatewayById('nope')).toBeNull();
  });

  // A malformed record carrying both a local marker and a gateway marker keeps
  // its legacy LOCAL outcome — the pre-registry if-chain checked local first.
  it('prefers a local runtime marker over a gateway marker', () => {
    expect(getOpencodeLocalProviderNamespace({ ollamaBacked: true, gatewayBacked: 'openrouter' })).toBe('ollama');
  });

  it('classifies namespaces', () => {
    expect(isGatewayNamespace('openrouter')).toBe(true);
    expect(isGatewayNamespace('orcarouter')).toBe(true);
    expect(isGatewayNamespace('ollama')).toBe(false);
    expect(isGatewayNamespace(null)).toBe(false);
  });
});

describe('prefixOpencodeModel — gateway namespacing', () => {
  const openrouter = { command: 'opencode', gatewayBacked: 'openrouter' };
  const orcarouter = { command: 'opencode', orcarouterBacked: true };

  // OpenRouter ids are ALREADY `vendor/model`, and OpenCode splits
  // provider/model on the first slash only, so the namespaced form is doubled.
  it('namespaces a vendor-qualified OpenRouter id', () => {
    expect(prefixOpencodeModel(openrouter, 'anthropic/claude-sonnet-4'))
      .toBe('openrouter/anthropic/claude-sonnet-4');
  });

  // The trap a single-prefix guard falls into: `openrouter/auto` is OpenRouter's
  // own auto-router MODEL id, not an already-namespaced id. Emitting it
  // unchanged would resolve to the model `auto`, which does not exist.
  it('namespaces OpenRouter\'s own auto-router id rather than treating it as prefixed', () => {
    expect(prefixOpencodeModel(openrouter, 'openrouter/auto')).toBe('openrouter/openrouter/auto');
  });

  it('is idempotent on an already-doubled id', () => {
    expect(prefixOpencodeModel(openrouter, 'openrouter/openrouter/auto')).toBe('openrouter/openrouter/auto');
    expect(prefixOpencodeModel(orcarouter, 'orcarouter/orcarouter/auto')).toBe('orcarouter/orcarouter/auto');
  });

  it('preserves the OrcaRouter behavior it generalized', () => {
    expect(prefixOpencodeModel(orcarouter, 'orcarouter/auto')).toBe('orcarouter/orcarouter/auto');
  });

  // A local runtime keeps the single-prefix rule — its stored ids are bare.
  it('leaves local-runtime namespacing single-prefixed', () => {
    const ollama = { command: 'opencode', ollamaBacked: true };
    expect(prefixOpencodeModel(ollama, 'qwen3:8b')).toBe('ollama/qwen3:8b');
    expect(prefixOpencodeModel(ollama, 'ollama/qwen3:8b')).toBe('ollama/qwen3:8b');
  });
});
