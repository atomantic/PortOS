import { describe, it, expect } from 'vitest';
import { parseEcosystemConfig, rewriteEcosystemPorts } from './streamingDetect.js';

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

  it('captures *_PORT keys when surrounding code uses backtick template literals', () => {
    // PM2 configs commonly use template literals (script paths, CLI args). The
    // brace-counter must treat backticks as string delimiters so `${...}` braces
    // don't perturb depth and miscount the env block close.
    const content = `
      module.exports = {
        apps: [
          {
            name: 'tmpl-app',
            script: \`\${__dirname}/server.js\`,
            args: \`--port \${5602} --extra \${{x: 1}}\`,
            env: {
              PORT: 5602,
              IPC_PORT: 5603,
            },
          },
        ],
      };
    `;

    const { processes } = parseEcosystemConfig(content);
    const proc = processes.find(p => p.name === 'tmpl-app');
    expect(proc.ports.api).toBe(5602);
    expect(proc.ports.ipc).toBe(5603);
  });

  it('captures *_PORT keys when written with quoted key syntax', () => {
    // JSON-style ecosystem configs quote env keys.
    const content = `
      module.exports = {
        apps: [
          {
            name: 'json-style',
            env: {
              'PORT': 5610,
              "COINBASE_IPC_PORT": 5611,
            },
          },
        ],
      };
    `;

    const { processes } = parseEcosystemConfig(content);
    const proc = processes.find(p => p.name === 'json-style');
    expect(proc.ports.api).toBe(5610);
    expect(proc.ports.coinbaseIpc).toBe(5611);
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

  it('correctly handles even-length backslash runs before a closing quote', () => {
    // Content has a string ending in `\\\\` (4 literal backslashes) then `"`.
    // A naive `prevChar === '\\'` check would flag the closing `"` as escaped,
    // leave inString true, and run the brace-counter past the env-block close —
    // dropping every port that follows. isEscaped() counts the backslash run
    // (even = not escaped) and exits the string correctly.
    const content = `
      module.exports = {
        apps: [
          {
            name: 'escape-app',
            env: {
              NOTE: "ends-with-backslashes\\\\\\\\",
              PORT: 5640,
            },
          },
        ],
      };
    `;

    const { processes } = parseEcosystemConfig(content);
    const proc = processes.find(p => p.name === 'escape-app');
    expect(proc.ports.api).toBe(5640);
  });

  it('env_production overrides env when the same *_PORT key appears in both blocks', () => {
    // PM2 picks the env block based on `--env`. For port reservation/display,
    // env_production wins so the value PortOS surfaces matches the production
    // deploy that runs against this config.
    const content = `
      module.exports = {
        apps: [
          {
            name: 'multi-env',
            env: {
              PORT: 5620,
              IPC_PORT: 5621,
            },
            env_production: {
              PORT: 5630,
              IPC_PORT: 5631,
            },
          },
        ],
      };
    `;

    const { processes } = parseEcosystemConfig(content);
    const proc = processes.find(p => p.name === 'multi-env');
    expect(proc.ports.api).toBe(5630);
    expect(proc.ports.ipc).toBe(5631);
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

describe('rewriteEcosystemPorts', () => {
  it('rewrites inline env PORT/VITE_PORT and --port args (the standardizer-generated shape)', () => {
    const content = `module.exports = {
  apps: [
    { name: 'app-server', script: 'server.js', env: { NODE_ENV: 'development', PORT: 5173 } },
    { name: 'app-client', script: 'npx', args: 'vite --host --port 5174', env: { VITE_PORT: 5174 } }
  ]
};
`;
    const out = rewriteEcosystemPorts(content, [[5173, 6000], [5174, 6001]]);
    expect(out).toContain('PORT: 6000');
    expect(out).toContain('--port 6001');
    expect(out).toContain('VITE_PORT: 6001');
    expect(out).not.toContain('5173');
    expect(out).not.toContain('5174');
    // Re-parsing the rewritten file yields the new ports.
    const { processes } = parseEcosystemConfig(out);
    expect(processes.find(p => p.name === 'app-server').ports.api).toBe(6000);
  });

  it('rewrites a per-app ports: {...} object — the parser\'s PRIMARY derivation source', () => {
    // parseEcosystemConfig reads the literal `ports:` object before env, so a
    // rewrite that skipped it would let the edit revert on the next refresh.
    const content = `module.exports = { apps: [
  { name: 'app-server', script: 's.js', ports: { api: 5555, ui: 5173 }, env: { PORT: 5555 } }
] };
`;
    const out = rewriteEcosystemPorts(content, [[5555, 6000], [5173, 6001]]);
    const { processes } = parseEcosystemConfig(out);
    expect(processes[0].ports.api).toBe(6000);
    expect(processes[0].ports.ui).toBe(6001);
    expect(out).not.toContain('5555');
    expect(out).not.toContain('5173');
  });

  it('rewrites values inside a const PORTS = {...} block regardless of key name', () => {
    const content = `const PORTS = { API: 5555, UI: 5173 };
module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: PORTS.API, VITE_PORT: PORTS.UI } }] };
`;
    const out = rewriteEcosystemPorts(content, [[5173, 6000]]);
    expect(out).toContain('UI: 6000');
    expect(out).toContain('API: 5555'); // untouched
  });

  it('does not touch unrelated numbers that merely equal an old port', () => {
    const content = `module.exports = {
  apps: [{ name: 'x', script: 's.js', watch_delay: 1000, env: { PORT: 1000 } }]
};
`;
    const out = rewriteEcosystemPorts(content, [[1000, 6000]]);
    expect(out).toContain('watch_delay: 1000'); // not a port key — preserved
    expect(out).toContain('PORT: 6000');
  });

  it('does not chain when a new port equals another old port', () => {
    const content = `module.exports = { apps: [
  { name: 'a', script: 's.js', env: { PORT: 6000 } },
  { name: 'b', script: 's.js', env: { PORT: 6001 } }
] };
`;
    const out = rewriteEcosystemPorts(content, [[6000, 6001], [6001, 6002]]);
    const { processes } = parseEcosystemConfig(out);
    expect(processes.find(p => p.name === 'a').ports.api).toBe(6001);
    expect(processes.find(p => p.name === 'b').ports.api).toBe(6002);
  });

  it('resolves 11+ remap pairs without placeholder prefix collision (index 1 vs 10)', () => {
    const pairs = Array.from({ length: 11 }, (_, k) => [7000 + k, 8000 + k]);
    const content = pairs.map(([o]) => `PORT: ${o}`).join('\n');
    const out = rewriteEcosystemPorts(content, pairs);
    for (const [, newP] of pairs) expect(out).toContain(`PORT: ${newP}`);
    expect(out).not.toMatch(/PORT_REMAP/);
    for (const [oldP] of pairs) expect(out).not.toContain(`PORT: ${oldP}`);
  });

  it('is a no-op when remap is empty or only contains identity pairs', () => {
    const content = `module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: 5173 } }] };`;
    expect(rewriteEcosystemPorts(content, [])).toBe(content);
    expect(rewriteEcosystemPorts(content, [[5173, 5173]])).toBe(content);
  });
});
