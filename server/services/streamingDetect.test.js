import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseEcosystemConfig, rewriteEcosystemPorts, rewriteEcosystemPortsByProcess, writeEcosystemPorts, writeEcosystemPortsByProcess, writeEcosystemPortEdits } from './streamingDetect.js';

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

  it('rewrites top-level port constants the parser derives ports from', () => {
    // parseEcosystemConfig reads `const API_PORT = 5555` and resolves env refs
    // to it; a rewrite skipping the constant would let the edit revert.
    const content = `const API_PORT = 5555;
const CDP_PORT = 5549;
module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: API_PORT, CDP_PORT: CDP_PORT } }] };
`;
    const out = rewriteEcosystemPorts(content, [[5555, 6000]]);
    expect(out).toContain('const API_PORT = 6000;');
    expect(out).toContain('const CDP_PORT = 5549;'); // not in remap — untouched
    expect(parseEcosystemConfig(out).processes[0].ports.api).toBe(6000);
  });

  it('rewrites fallback-expression defaults (process.env.PORT || N) the parser derives', () => {
    const content = `module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: process.env.PORT || 4420, RETRIES: 4420 } }] };
`;
    const out = rewriteEcosystemPorts(content, [[4420, 6000]]);
    expect(out).toContain('process.env.PORT || 6000');
    expect(out).toContain('RETRIES: 4420'); // not a port key, and not a `|| N` fallback — untouched
    expect(parseEcosystemConfig(out).processes[0].ports.api).toBe(6000);
  });

  it('does not rewrite a port that appears only in a comment (no false success)', () => {
    // The executable port is 4000; 5173 lives only in a comment. Rewriting
    // 5173 must change nothing — else writeEcosystemPorts would report success
    // while the real config still serves 4000.
    const content = `module.exports = { apps: [{ name: 'x', script: 's.js', env: { /* legacy PORT: 5173 */ PORT: 4000 } }] };
// historical default PORT: 5173
`;
    const out = rewriteEcosystemPorts(content, [[5173, 6000]]);
    expect(out).toBe(content); // unchanged
  });

  it('rewrites the executable port but leaves a same-valued trailing comment alone', () => {
    const content = `module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: 5173 } }] }; // default was 5173\n`;
    const out = rewriteEcosystemPorts(content, [[5173, 6000]]);
    expect(parseEcosystemConfig(out).processes[0].ports.api).toBe(6000);
    expect(out).toContain('// default was 5173'); // comment untouched
  });

  it('does not rewrite a port inside a commented-out PORTS block', () => {
    const content = `/* legacy: const PORTS = { API: 5173 } */
const PORTS = { API: 4000 };
module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: PORTS.API } }] };
`;
    const out = rewriteEcosystemPorts(content, [[5173, 6000]]);
    expect(out).toBe(content); // the only 5173 is in a comment → untouched
  });

  it('is a no-op when remap is empty or only contains identity pairs', () => {
    const content = `module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: 5173 } }] };`;
    expect(rewriteEcosystemPorts(content, [])).toBe(content);
    expect(rewriteEcosystemPorts(content, [[5173, 5173]])).toBe(content);
  });
});

describe('rewriteEcosystemPortsByProcess', () => {
  it('splits a shared value (prod UI served by API, uiPort === apiPort) — rewrites only the touched label', () => {
    // Single process: bare PORT 6000 is BOTH the api port and (since no
    // dedicated ui process) the derived ui port. Changing only ui must NOT
    // touch the api — but here there's only one PORT literal and it IS the api,
    // so a ui edit on a process that has no ui-specific literal is unapplied.
    const content = `module.exports = { apps: [
  { name: 'srv', script: 's.js', env: { PORT: 6000 } }
] };
`;
    // Change the api port — the shared literal moves with it.
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'api', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.unapplied).toHaveLength(0);
    expect(parseEcosystemConfig(r.content).processes[0].ports.api).toBe(7000);
  });

  it('disambiguates an explicit ports: { api: N, ui: N } map sharing one value', () => {
    // Both api and ui are literally 6000 in the same block. A value-keyed
    // rewrite can't split them; the label KEY can.
    const content = `module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: { api: 6000, ui: 6000 }, env: { PORT: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.unapplied).toHaveLength(0);
    const ports = parseEcosystemConfig(r.content).processes[0].ports;
    expect(ports.ui).toBe(7000);
    expect(ports.api).toBe(6000); // untouched — the api literal stays
  });

  it('rewrites a port that lives only under processes[] (no top-level field)', () => {
    const content = `module.exports = { apps: [
  { name: 'srv-api', script: 's.js', env: { PORT: 5555 } },
  { name: 'srv-ui', script: 'npx', args: 'vite --host --port 5556', env: { VITE_PORT: 5556 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv-ui', label: 'ui', oldPort: 5556, newPort: 7001 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.content).toContain('--port 7001');
    expect(r.content).toContain('VITE_PORT: 7001');
    expect(r.content).toContain('PORT: 5555'); // sibling api block untouched
  });

  it('targets only the named process when two blocks share a port value', () => {
    const content = `module.exports = { apps: [
  { name: 'a', script: 's.js', env: { PORT: 6000 } },
  { name: 'b', script: 's.js', env: { PORT: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'b', label: 'api', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    const procs = parseEcosystemConfig(r.content).processes;
    expect(procs.find(p => p.name === 'a').ports.api).toBe(6000); // untouched
    expect(procs.find(p => p.name === 'b').ports.api).toBe(7000);
  });

  it('applies multiple labels in the same block (api + ui that shared a value)', () => {
    const content = `module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: { api: 6000, ui: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'api', oldPort: 6000, newPort: 7000 },
      { processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7001 },
    ]);
    expect(r.applied).toHaveLength(2);
    const ports = parseEcosystemConfig(r.content).processes[0].ports;
    expect(ports.api).toBe(7000);
    expect(ports.ui).toBe(7001);
  });

  it('rewrites the devUi (Vite) port via the ui label', () => {
    // With a sibling api process, the parser relabels the Vite port ui → devUi.
    const content = `module.exports = { apps: [
  { name: 'srv', script: 's.js', env: { PORT: 5555 } },
  { name: 'srv-ui', script: 'npx', args: 'vite', env: { VITE_PORT: 5556 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv-ui', label: 'ui', oldPort: 5556, newPort: 7002 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(parseEcosystemConfig(r.content).processes.find(p => p.name === 'srv-ui').ports.devUi).toBe(7002);
  });

  it('does NOT rewrite env PORT as a fallback for a ports: PORTS.x reference block (honest unapplied, no false success)', () => {
    // The block derives api/ui from `ports: PORTS.server` (a reference to a
    // const outside the app block), so the parser ignores env.PORT. A targeted
    // edit can't reach the external const from inside the block — so it must
    // report `unapplied` (→ caller 422s) rather than rewriting env.PORT, which
    // would falsely report success while the displayed/derived port reverts AND
    // silently change the runtime API env port.
    const content = `const PORTS = { server: { api: 6000, ui: 6000 } };
module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: PORTS.server, env: { PORT: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'api', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.unapplied).toHaveLength(1);
    expect(r.content).toBe(content); // env.PORT untouched, nothing falsely rewritten
  });

  it('rewrites only the edited key when an inline ports object has ui and devUi sharing a value', () => {
    // ui and devUi both 6000 in one block. Editing only ui must leave devUi at
    // 6000 — a combined (ui|devUi) pattern would clobber the sibling.
    const content = `module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: { ui: 6000, devUi: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    const ports = parseEcosystemConfig(r.content).processes[0].ports;
    expect(ports.ui).toBe(7000);
    expect(ports.devUi).toBe(6000); // sibling untouched
  });

  it('rewrites only the ports-object key, not a same-named field elsewhere in the block', () => {
    // The block has an inline ports.api AND a same-valued metadata.api. Editing
    // apiPort must touch ONLY ports.api — the label-key pattern is scoped to the
    // ports: { ... } slice, so metadata.api (config the parser never read as the
    // port source) is left alone.
    const content = `module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: { api: 6000, ui: 5556 }, metadata: { api: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'api', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.content).toContain('ports: { api: 7000');
    expect(r.content).toContain('metadata: { api: 6000 }'); // untouched
    expect(parseEcosystemConfig(r.content).processes[0].ports.api).toBe(7000);
  });

  it('rewrites a UI process bare env PORT (its runtime UI port) even alongside an inline ports.ui', () => {
    // A `-ui` process routes bare PORT → ui (parser semantics). With ports.ui
    // AND env.PORT both 6000, editing ui must move BOTH so PM2 restarts on the
    // new port — not just the displayed ports.ui.
    const content = `module.exports = { apps: [
  { name: 'app-ui', script: 's.js', ports: { ui: 6000 }, env: { PORT: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'app-ui', label: 'ui', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.content).toContain('ui: 7000');
    expect(r.content).toContain('PORT: 7000'); // runtime port moves too
  });

  it('an api (non-UI) process bare PORT is the API port — a ui edit leaves it untouched', () => {
    // Bare PORT on a non-UI-named process routes → api. Editing the shared ui
    // label must touch ports.ui only, NOT the bare PORT (which is the api port).
    const content = `module.exports = { apps: [
  { name: 'app-server', script: 's.js', ports: { api: 6000, ui: 6000 }, env: { PORT: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'app-server', label: 'ui', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.content).toContain('ui: 7000');
    expect(r.content).toContain('api: 6000');  // untouched
    expect(r.content).toContain('PORT: 6000'); // bare PORT = api → untouched
  });

  it('also rewrites the matching label-specific runtime env var (UI_PORT) alongside the ports key', () => {
    // ports.ui and a same-valued UI_PORT env var (which PM2 launches with).
    // Editing ui must move BOTH, or the process restarts on the old UI_PORT.
    // The sibling api/API_PORT (same value) must be left alone.
    const content = `module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: { api: 6000, ui: 6000 }, env: { API_PORT: 6000, UI_PORT: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.content).toContain('ui: 7000');
    expect(r.content).toContain('UI_PORT: 7000');
    expect(r.content).toContain('api: 6000');      // sibling untouched
    expect(r.content).toContain('API_PORT: 6000'); // sibling env untouched
  });

  it('does not rewrite a bare lowercase port: field when an inline ports object is the source', () => {
    // parseEcosystemConfig reads ports.api and ignores `metadata.port`; the bare
    // `port:` fallback is last-resort (only when there's no ports object), so it
    // must NOT fire here and corrupt the unrelated same-valued metadata field.
    const content = `module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: { api: 6000, ui: 5556 }, metadata: { port: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'api', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.content).toContain('api: 7000');
    expect(r.content).toContain('metadata: { port: 6000 }'); // untouched
  });

  it('still rewrites a bare legacy port: field when it is the only source (no ports object)', () => {
    const content = `module.exports = { apps: [{ name: 'srv', script: 's.js', port: 6000 }] };`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'api', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.content).toContain('port: 7000');
  });

  it('does NOT match a same-valued lowercase metadata field in a ports-reference block (no false api success)', () => {
    // api is derived from `ports: PORTS.server` (external const). The block also
    // carries a lowercase metadata field that happens to share the value. An
    // unscoped `api:`/`ui:` key pattern would rewrite that metadata and falsely
    // report applied while the real const reverts — so label-key patterns are
    // scoped to inline ports objects only → this edit is unapplied.
    const content = `const PORTS = { server: { api: 6000 } };
module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: PORTS.server, max_restarts: 6000 }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'api', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.unapplied).toHaveLength(1);
    expect(r.content).toBe(content); // metadata field untouched
  });

  it('does NOT report success from an env-only ui rewrite when the ui port comes from a ports reference', () => {
    // ui is derived from `ports: PORTS.client` (external const), but the block
    // ALSO carries a same-valued VITE_PORT. Rewriting only VITE_PORT would be
    // false success — the parser re-derives ui from the unchanged const. So the
    // env/args fallback must be skipped for a reference block → unapplied.
    const content = `const PORTS = { client: { ui: 6000 } };
module.exports = { apps: [
  { name: 'srv-ui', script: 'npx', args: 'vite --host', ports: PORTS.client, env: { VITE_PORT: 6000 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv-ui', label: 'ui', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.unapplied).toHaveLength(1);
    expect(r.content).toBe(content); // VITE_PORT untouched, no false rewrite
  });

  it('still rewrites VITE_PORT/--port for a ui edit when there is no ports reference (inline or sole source)', () => {
    // No ports reference → VITE_PORT is the real source; rewrite it.
    const content = `module.exports = { apps: [
  { name: 'srv', script: 's.js', env: { PORT: 5555 } },
  { name: 'srv-ui', script: 'npx', args: 'vite --host --port 5556', env: { VITE_PORT: 5556 } }
] };
`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv-ui', label: 'ui', oldPort: 5556, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.content).toContain('VITE_PORT: 7000');
    expect(r.content).toContain('--port 7000');
  });

  it('reports an edit as unapplied when the process name is not found', () => {
    const content = `module.exports = { apps: [{ name: 'srv', script: 's.js', env: { PORT: 6000 } }] };`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'ghost', label: 'api', oldPort: 6000, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.unapplied).toHaveLength(1);
    expect(r.content).toBe(content);
  });

  it('reports an edit as unapplied when the label has no literal in the block', () => {
    // api-only process; a ui edit finds nothing to rewrite there.
    const content = `module.exports = { apps: [{ name: 'srv', script: 's.js', ports: { api: 6000 } }] };`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'ui', oldPort: 9999, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.unapplied).toHaveLength(1);
    expect(r.content).toBe(content);
  });

  it('does not rewrite a port that appears only in a comment', () => {
    const content = `module.exports = { apps: [{ name: 'srv', script: 's.js', env: { /* old PORT: 5173 */ PORT: 4000 } }] };`;
    const r = rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'api', oldPort: 5173, newPort: 7000 },
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.unapplied).toHaveLength(1);
    expect(r.content).toBe(content);
  });

  it('is a no-op for empty / identity edits', () => {
    const content = `module.exports = { apps: [{ name: 'srv', script: 's.js', env: { PORT: 6000 } }] };`;
    expect(rewriteEcosystemPortsByProcess(content, []).content).toBe(content);
    expect(rewriteEcosystemPortsByProcess(content, [
      { processName: 'srv', label: 'api', oldPort: 6000, newPort: 6000 },
    ]).content).toBe(content);
  });
});

describe('writeEcosystemPorts', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('rewrites the .js file first (the same one parseEcosystemFromPath reads) when both exist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-write-'));
    const body = (port) => `module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: ${port} } }] };\n`;
    writeFileSync(join(dir, 'ecosystem.config.js'), body(5173));
    writeFileSync(join(dir, 'ecosystem.config.cjs'), body(5173));

    const result = await writeEcosystemPorts(dir, [[5173, 6000]]);
    expect(result).toEqual({ file: 'ecosystem.config.js', changed: true });
    // The reader's file is updated; the .cjs is left as-is (reader never sees it).
    expect(readFileSync(join(dir, 'ecosystem.config.js'), 'utf-8')).toContain('PORT: 6000');
    expect(readFileSync(join(dir, 'ecosystem.config.cjs'), 'utf-8')).toContain('PORT: 5173');
  });

  it('reports changed:false when no port literal matches', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-write-'));
    writeFileSync(join(dir, 'ecosystem.config.cjs'), `module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: 4321 } }] };\n`);
    const result = await writeEcosystemPorts(dir, [[5173, 6000]]);
    expect(result).toEqual({ file: 'ecosystem.config.cjs', changed: false });
  });
});

describe('writeEcosystemPortsByProcess', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('writes the file when every targeted edit applies', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-tgt-'));
    writeFileSync(join(dir, 'ecosystem.config.cjs'),
      `module.exports = { apps: [{ name: 'srv', script: 's.js', ports: { api: 6000, ui: 6000 } }] };\n`);
    const result = await writeEcosystemPortsByProcess(dir, [
      { processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 },
    ]);
    expect(result.changed).toBe(true);
    expect(result.unapplied).toHaveLength(0);
    expect(readFileSync(join(dir, 'ecosystem.config.cjs'), 'utf-8')).toContain('ui: 7000');
  });

  it('does NOT persist a partial batch — leaves the file untouched when any edit is unapplied', async () => {
    // 'srv' has a literal api PORT (rewritable) but the same-valued ui lives in
    // a ports: PORTS.client reference (not reachable in-block). The route 422s
    // such a request, so the applied subset must NOT be written to disk — else
    // config diverges from the un-updated registry for a "failed" request.
    dir = mkdtempSync(join(tmpdir(), 'eco-tgt-'));
    const original = `const PORTS = { client: { ui: 6000 } };
module.exports = { apps: [
  { name: 'srv', script: 's.js', env: { PORT: 6000 } },
  { name: 'srv-ui', script: 'npx', ports: PORTS.client }
] };
`;
    writeFileSync(join(dir, 'ecosystem.config.cjs'), original);
    const result = await writeEcosystemPortsByProcess(dir, [
      { processName: 'srv', label: 'api', oldPort: 6000, newPort: 7000 },      // applies
      { processName: 'srv-ui', label: 'ui', oldPort: 6000, newPort: 7001 },    // unapplied (external const)
    ]);
    expect(result.changed).toBe(false);
    expect(result.applied).toHaveLength(0); // nothing persisted
    expect(result.unapplied.length).toBeGreaterThan(0);
    // File is byte-for-byte unchanged — no partial write.
    expect(readFileSync(join(dir, 'ecosystem.config.cjs'), 'utf-8')).toBe(original);
  });
});

describe('writeEcosystemPortEdits (combined value-keyed + targeted, atomic)', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('persists a distinct (value-keyed) and a shared (targeted) edit in one write', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-edits-'));
    writeFileSync(join(dir, 'ecosystem.config.cjs'), `module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: { api: 6000, ui: 6000 } },
  { name: 'srv-ui', script: 'npx', args: 'vite --host --port 5556', env: { VITE_PORT: 5556 } }
] };
`);
    const result = await writeEcosystemPortEdits(
      dir,
      [[5556, 7001]],
      [{ processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 }]
    );
    expect(result.changed).toBe(true);
    expect(result.remapApplied).toBe(true);
    expect(result.unapplied).toHaveLength(0);
    const out = readFileSync(join(dir, 'ecosystem.config.cjs'), 'utf-8');
    expect(out).toContain('ui: 7000');     // targeted
    expect(out).toContain('VITE_PORT: 7001'); // value-keyed
    expect(out).toContain('api: 6000');    // sibling untouched
  });

  it('persists NOTHING (not even the value-keyed pass) when a targeted edit is unapplied', async () => {
    // The atomicity bug: the value-keyed remap (devUiPort 5556→7001) is
    // rewritable, but the shared uiPort lives in an external PORTS.server const
    // the targeted pass can't reach → unapplied → the route 422s. The
    // value-keyed change must NOT have already hit disk.
    dir = mkdtempSync(join(tmpdir(), 'eco-edits-'));
    const original = `const PORTS = { server: { api: 6000, ui: 6000 } };
module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: PORTS.server, env: { PORT: 6000 } },
  { name: 'srv-ui', script: 'npx', args: 'vite --host --port 5556', env: { VITE_PORT: 5556 } }
] };
`;
    writeFileSync(join(dir, 'ecosystem.config.cjs'), original);
    const result = await writeEcosystemPortEdits(
      dir,
      [[5556, 7001]],                                                          // distinct, rewritable
      [{ processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 }]      // shared, in external const → unapplied
    );
    expect(result.changed).toBe(false);
    expect(result.remapApplied).toBe(false); // reported as not-persisted
    expect(result.unapplied.length).toBeGreaterThan(0);
    // Critical: the file is byte-for-byte unchanged — the value-keyed devUiPort
    // edit did NOT land on disk despite being individually rewritable.
    expect(readFileSync(join(dir, 'ecosystem.config.cjs'), 'utf-8')).toBe(original);
  });

  it('persists NOTHING when the value-keyed remap matches no literal but a targeted edit would apply', async () => {
    // Symmetric twin of the unapplied-targeted case: the distinct devUiPort
    // remap (9999→7001) matches nothing in the config, but the shared uiPort
    // targeted edit DOES apply. The route 422s on the failed remap, so the
    // targeted rewrite must NOT have been written to disk.
    dir = mkdtempSync(join(tmpdir(), 'eco-edits-'));
    const original = `module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: { api: 6000, ui: 6000 } }
] };
`;
    writeFileSync(join(dir, 'ecosystem.config.cjs'), original);
    const result = await writeEcosystemPortEdits(
      dir,
      [[9999, 7001]],                                                          // remap matches nothing
      [{ processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 }]      // targeted would apply
    );
    expect(result.changed).toBe(false);
    expect(result.remapApplied).toBe(false);
    // File unchanged — the applicable targeted edit was NOT written because the
    // remap failed and the whole request will be rejected.
    expect(readFileSync(join(dir, 'ecosystem.config.cjs'), 'utf-8')).toBe(original);
  });

  it('does not chain when a value-keyed NEW value equals a targeted OLD value (forward collision)', async () => {
    // One process: ports {api:6000, ui:6000, devUi:5556} + VITE_PORT:5556.
    // Save devUiPort 5556→6000 (value-keyed) AND uiPort 6000→7000 (targeted,
    // shared with api). Naive value-keyed-first would rewrite devUi 5556→6000,
    // then the targeted ui pass would see that fresh 6000 and chain it to 7000,
    // corrupting devUi. Running targeted FIRST avoids it: ui→7000 lands, then
    // devUi 5556→6000 — and api stays 6000.
    dir = mkdtempSync(join(tmpdir(), 'eco-edits-'));
    writeFileSync(join(dir, 'ecosystem.config.cjs'), `module.exports = { apps: [
  { name: 'srv', script: 's.js', ports: { api: 6000, ui: 6000, devUi: 5556 } }
] };
`);
    const result = await writeEcosystemPortEdits(
      dir,
      [[5556, 6000]],                                                          // devUiPort distinct → value-keyed
      [{ processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 }]      // uiPort shared → targeted
    );
    expect(result.changed).toBe(true);
    const ports = parseEcosystemConfig(readFileSync(join(dir, 'ecosystem.config.cjs'), 'utf-8')).processes[0].ports;
    expect(ports.ui).toBe(7000);    // edited
    expect(ports.devUi).toBe(6000); // remapped, NOT chained to 7000
    expect(ports.api).toBe(6000);   // untouched
  });

  it('is a no-op when both remap and edits are empty', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-edits-'));
    const original = `module.exports = { apps: [{ name: 'x', script: 's.js', env: { PORT: 6000 } }] };\n`;
    writeFileSync(join(dir, 'ecosystem.config.cjs'), original);
    const result = await writeEcosystemPortEdits(dir, [], []);
    expect(result.changed).toBe(false);
    expect(readFileSync(join(dir, 'ecosystem.config.cjs'), 'utf-8')).toBe(original);
  });
});
