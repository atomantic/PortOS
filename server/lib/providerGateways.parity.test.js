/**
 * The gateway registry exists in two places by architecture — the vendored
 * `aiToolkit/` may not import out of its own directory, so it carries its own
 * copy. This suite pins the two together so a new gateway added to one is never
 * silently missing from the other (which would show up as a wrapper that spawns
 * fine but can never refresh its models).
 *
 * The browser needs no pin: `client/src/utils/providerGateways.js` re-exports
 * this leaf rather than copying it.
 *
 * The two copies are compared as VALUES — the toolkit module imports cleanly
 * here, so `toEqual` pins every field including `baseURL`.
 */
import { describe, it, expect } from 'vitest';
import { PROVIDER_GATEWAYS as SERVER_GATEWAYS, gatewayForProvider as serverGatewayFor } from './providerGateways.js';
import { PROVIDER_GATEWAYS as TOOLKIT_GATEWAYS, gatewayForProvider as toolkitGatewayFor } from './aiToolkit/internal/gateways.js';

describe('providerGateways ↔ aiToolkit/internal/gateways parity', () => {
  it('declares the same rows, in the same order', () => {
    expect(TOOLKIT_GATEWAYS).toEqual(SERVER_GATEWAYS);
  });

  it('resolves the same provider records', () => {
    const records = [
      { gatewayBacked: 'openrouter' },
      { gatewayBacked: 'orcarouter' },
      { orcarouterBacked: true },
      { ollamaBacked: true },
      { gatewayBacked: 'not-a-gateway' },
      null,
    ];
    for (const record of records) {
      expect(toolkitGatewayFor(record)).toEqual(serverGatewayFor(record));
    }
  });
});
