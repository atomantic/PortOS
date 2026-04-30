import { describe, it, expect } from 'vitest';
import { parseEcosystemConfig } from './streamingDetect.js';

describe('parseEcosystemConfig', () => {
  it('captures arbitrary *_PORT env vars and labels them by camelCased stem', () => {
    // Mirror the critical-mass shape: a server process that fans out IPC ports
    // to per-exchange engine processes.
    const content = `
      const PORTS = {
        API: 5563,
        UI: 5564,
        COINBASE_IPC: 5565,
        GEMINI_IPC: 5566,
        CRYPTOCOM_IPC: 5567,
      };

      module.exports = {
        apps: [
          {
            name: 'critical-mass',
            script: 'server.js',
            env: {
              PORT: PORTS.API,
              COINBASE_IPC_PORT: PORTS.COINBASE_IPC,
              GEMINI_IPC_PORT: PORTS.GEMINI_IPC,
              CRYPTOCOM_IPC_PORT: PORTS.CRYPTOCOM_IPC,
            },
          },
          {
            name: 'critical-mass-coinbase',
            script: 'engines/coinbase-engine.js',
            env: {
              EXCHANGE_IPC_PORT: PORTS.COINBASE_IPC,
            },
          },
          {
            name: 'critical-mass-gemini',
            script: 'engines/gemini-engine.js',
            env: {
              GEMINI_IPC_PORT: PORTS.GEMINI_IPC,
            },
          },
        ],
      };
    `;

    const { processes } = parseEcosystemConfig(content);

    const main = processes.find(p => p.name === 'critical-mass');
    expect(main.ports).toEqual({
      api: 5563,
      coinbaseIpc: 5565,
      geminiIpc: 5566,
      cryptocomIpc: 5567,
    });

    const coinbase = processes.find(p => p.name === 'critical-mass-coinbase');
    expect(coinbase.ports).toEqual({ exchangeIpc: 5565 });

    const gemini = processes.find(p => p.name === 'critical-mass-gemini');
    expect(gemini.ports).toEqual({ geminiIpc: 5566 });
  });

  it('preserves smart-labeling for PORT/VITE_PORT/CDP_PORT alongside generic *_PORT capture', () => {
    const content = `
      module.exports = {
        apps: [
          {
            name: 'my-app-server',
            env: {
              PORT: 5570,
              ADMIN_PORT: 5571,
            },
          },
          {
            name: 'my-app-ui',
            env: {
              VITE_PORT: 5572,
            },
          },
          {
            name: 'my-app-browser',
            env: {
              CDP_PORT: 5573,
              PORT: 5574,
            },
          },
        ],
      };
    `;

    const { processes } = parseEcosystemConfig(content);

    const server = processes.find(p => p.name === 'my-app-server');
    expect(server.ports.api).toBe(5570);
    expect(server.ports.admin).toBe(5571);

    const ui = processes.find(p => p.name === 'my-app-ui');
    // Post-processing relabels Vite ports from `ui` → `devUi` whenever a sibling
    // api process exists (the prod UI is served by the API server in that shape).
    expect(ui.ports.devUi).toBe(5572);
    expect(ui.ports.ui).toBeUndefined();

    const browser = processes.find(p => p.name === 'my-app-browser');
    expect(browser.ports.cdp).toBe(5573);
    // Browser process with CDP_PORT routes PORT → health (not api)
    expect(browser.ports.health).toBe(5574);
    expect(browser.ports.api).toBeUndefined();
  });

  it('does not treat identifiers ending in PORT (e.g., REPORT) as ports', () => {
    const content = `
      module.exports = {
        apps: [
          {
            name: 'reporter',
            env: {
              PORT: 5580,
              REPORT_LEVEL: 3,
              MY_REPORT: 'verbose',
            },
          },
        ],
      };
    `;

    const { processes } = parseEcosystemConfig(content);
    const proc = processes.find(p => p.name === 'reporter');
    expect(proc.ports).toEqual({ api: 5580 });
  });

  it('captures *_PORT keys after a nested brace inside the env block', () => {
    // Env values can contain object spreads/ternaries that introduce nested `}`.
    // A naive `\\{[^}]*\\}` env-block regex would truncate at the inner `}` and
    // miss any *_PORT key that follows. Brace-counting handles this correctly.
    const content = `
      module.exports = {
        apps: [
          {
            name: 'nested-env-app',
            env: {
              ...(process.env.FEATURE_FLAG ? { ENABLED: 'true' } : { ENABLED: 'false' }),
              PORT: 5600,
              IPC_PORT: 5601,
            },
          },
        ],
      };
    `;

    const { processes } = parseEcosystemConfig(content);
    const proc = processes.find(p => p.name === 'nested-env-app');
    expect(proc.ports.api).toBe(5600);
    expect(proc.ports.ipc).toBe(5601);
  });

  it('still honors explicit ports: { ... } literal map (does not double-extract from env)', () => {
    const content = `
      module.exports = {
        apps: [
          {
            name: 'explicit-app',
            ports: { api: 5590, ui: 5591 },
            env: {
              PORT: 9999, // should be ignored — explicit ports map wins
              IPC_PORT: 8888,
            },
          },
        ],
      };
    `;

    const { processes } = parseEcosystemConfig(content);
    const proc = processes.find(p => p.name === 'explicit-app');
    expect(proc.ports).toEqual({ api: 5590, ui: 5591 });
  });
});
