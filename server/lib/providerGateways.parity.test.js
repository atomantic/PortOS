/**
 * The gateway registry exists in three places by architecture — the vendored
 * `aiToolkit/` may not import out of its own directory, and the browser cannot
 * import server code at all. This suite pins the two SERVER copies together so
 * a new gateway added to one is never silently missing from the other (which
 * would show up as a wrapper that spawns fine but can never refresh its models,
 * or vice versa).
 *
 * The client copy (`client/src/utils/providers.js`) is deliberately NOT imported
 * here: a server suite that imports a client module drags the client's deps into
 * the server CI job. It carries a "keep in lockstep" comment naming both server
 * copies instead.
 */
import { describe, it, expect } from 'vitest';
import { PROVIDER_GATEWAYS as SERVER_GATEWAYS } from './providerGateways.js';
import { PROVIDER_GATEWAYS as TOOLKIT_GATEWAYS, gatewayForProvider as toolkitGatewayFor } from './aiToolkit/internal/gateways.js';
import { gatewayForProvider as serverGatewayFor } from './providerGateways.js';

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
