// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { PORTS, DEFAULT_PEER_PORT } from './ports.js';
import { PORTS as SERVER_PORTS } from '../../../server/lib/ports.js';

const require = createRequire(import.meta.url);
// ecosystem.config.cjs is the source of truth for every PortOS port.
const ecosystem = require('../../../ecosystem.config.cjs');

describe('client/src/lib/ports.js mirror parity', () => {
  it('matches ecosystem.config.cjs for every mirrored port', () => {
    for (const key of Object.keys(PORTS)) {
      expect(ecosystem.PORTS[key], `ecosystem.config.cjs is missing PORTS.${key}`).toBeDefined();
      expect(PORTS[key], `client mirror PORTS.${key} drifted`).toBe(ecosystem.PORTS[key]);
    }
  });

  it('matches the server mirror in server/lib/ports.js for every mirrored port', () => {
    for (const key of Object.keys(PORTS)) {
      expect(PORTS[key], `server mirror PORTS.${key} drifted`).toBe(SERVER_PORTS[key]);
    }
  });

  it('mirrors only the UI-facing subset', () => {
    expect(Object.keys(PORTS).sort()).toEqual(['API', 'API_LOCAL', 'UI']);
  });

  it('defaults a new peer to the API port', () => {
    expect(DEFAULT_PEER_PORT).toBe(ecosystem.PORTS.API);
  });
});
