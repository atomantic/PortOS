import { describe, it, expect } from 'vitest';
import { posixPath } from './testHelper.js';

import { buildCliChildEnv, buildPublicReviewCliEnv, composeProviderEnv } from './cliChildEnv.js';
import { PUBLIC_REVIEW_EXECUTION_PROFILE } from './agentExecutionProfiles.js';
import { cliProviderAuthDescriptor } from './processEnv.js';
import { AGENT_GUARD_BIN } from './agentGuard/index.js';
import { collectServerSources, readServerSource } from './testHelper.js';
import { readFileSync } from 'node:fs';
// Read, not `import … with { type: 'json' }` — the repo avoids JSON import
// attributes (see promptSystemStages.js).
const SHIPPED_PROVIDERS = JSON.parse(readFileSync(new URL('../../data.reference/providers.json', import.meta.url), 'utf8'));

// An OpenCode provider that IS ollama-backed — the only shape for which
// buildOpencodeEnvVars returns anything. Everyone else gets `{}`, which is why
// the OpenCode layer is invisible at the other call sites.
const OLLAMA_OPENCODE = {
  command: 'opencode',
  ollamaBacked: true,
  models: ['qwen2.5:7b'],
  defaultModel: 'qwen2.5:7b',
  envVars: { OPENCODE_CONFIG_CONTENT: '{"permission":"deny"}', API_KEY: 'from-provider' },
};

const declaredModels = (env) => Object.keys(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.ollama.models);
const declaredMtplxModels = (env) => Object.keys(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.mtplx.models);

describe('buildCliChildEnv — layering', () => {
  it('layers baseEnv < before < provider.envVars < extra', () => {
    const env = buildCliChildEnv({
      baseEnv: { PATH: '/base/bin', HOME: '/home/example' },
      before: { HOME: '/before', TZ: 'before', XDG_CONFIG_HOME: '/before-config' },
      provider: { envVars: { HOME: '/provider', TZ: 'provider', ANTHROPIC_BASE_URL: 'https://provider.example' } },
      extra: { TZ: 'extra', LANG: 'extra' },
    });
    expect(env.HOME).toBe('/provider');
    expect(env.TZ).toBe('extra');
    expect(env.LANG).toBe('extra');
    // Every layer still contributes its own non-conflicting keys.
    expect(env.PATH).toBe('/base/bin');
    expect(env.XDG_CONFIG_HOME).toBe('/before-config');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://provider.example');
  });

  // The `before` slot exists specifically so agentCliSpawning's forgeTokenEnv
  // can be overridden by an explicit provider credential. Collapsing it into
  // `extra` would silently flip which GH_TOKEN the agent's `gh pr create` uses.
  it('lets provider.envVars beat `before` but lose to `extra`', () => {
    const env = buildCliChildEnv({
      baseEnv: {},
      before: { GH_TOKEN: 'repo-owner-pinned' },
      provider: { envVars: { GH_TOKEN: 'provider-explicit', TERM: 'dumb' } },
      extra: { TERM: 'xterm-256color' },
    });
    expect(env.GH_TOKEN).toBe('provider-explicit');
    expect(env.TERM).toBe('xterm-256color');
  });

  // The OpenCode map is built FROM provider.envVars.OPENCODE_CONFIG_CONTENT, so
  // it must land after it — otherwise the static value the map was derived from
  // wins and `--model ollama/<id>` is rejected again (#2190).
  it('overrides the provider static OPENCODE_CONFIG_CONTENT with the declared-models map', () => {
    const env = buildCliChildEnv({ baseEnv: {}, provider: OLLAMA_OPENCODE, model: 'llama3.1:8b' });
    expect(declaredModels(env).sort()).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
    // Non-conflicting provider vars survive.
    expect(env.API_KEY).toBe('from-provider');
    // The stored base is merged, not clobbered.
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission).toBe('deny');
  });

  it('declares the MTPLX models map for a marked OpenCode provider', () => {
    const env = buildCliChildEnv({
      baseEnv: {},
      provider: { command: 'opencode', mtplxBacked: true, models: ['mtplx'], envVars: {} },
      model: 'mtplx',
    });
    expect(declaredMtplxModels(env)).toEqual(['mtplx']);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.mtplx.options.baseURL).toBe('http://127.0.0.1:8000/v1');
  });

  it('is a no-op OpenCode layer for a non-OpenCode provider', () => {
    const env = buildCliChildEnv({ baseEnv: {}, provider: { command: 'claude', envVars: { A: '1' } }, model: 'opus' });
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.A).toBe('1');
  });

  it('tolerates an absent provider / before / extra', () => {
    expect(buildCliChildEnv({ baseEnv: { PATH: '/usr/bin' }, provider: null, before: null, extra: null })).toEqual({ PATH: '/usr/bin' });
  });

  it('filters unrelated inherited app variables before applying explicit overlays', () => {
    const env = buildCliChildEnv({
      baseEnv: {
        PATH: '/usr/bin',
        GH_TOKEN: 'ambient-owner-token',
        PRIVATE_APP_AUTH_KEYS: 'must-not-forward',
      },
      before: { GH_TOKEN: 'owner-token' },
      provider: { envVars: { PRIVATE_PROVIDER_TOKEN: 'explicit-provider-token' } },
    });
    expect(env.PRIVATE_APP_AUTH_KEYS).toBeUndefined();
    expect(env.GH_TOKEN).toBe('owner-token');
    expect(env.PRIVATE_PROVIDER_TOKEN).toBe('explicit-provider-token');
  });

  it('defaults baseEnv to process.env', () => {
    expect(buildCliChildEnv().PATH).toBe(process.env.PATH);
  });

  it('copies rather than mutating the caller env', () => {
    const baseEnv = { A: '1' };
    const env = buildCliChildEnv({ baseEnv, extra: { B: '2' } });
    expect(baseEnv).toEqual({ A: '1' });
    expect(env).not.toBe(baseEnv);
  });
});

describe('buildCliChildEnv — public-review profile', () => {
  it('keeps runtime essentials but strips forge, cloud, SSH, and provider credentials', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/example',
      LC_ALL: 'C',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
      ANTHROPIC_AUTH_TOKEN: 'local-only',
      GH_TOKEN: 'forge-secret',
      GITHUB_TOKEN: 'forge-secret-2',
      AWS_SECRET_ACCESS_KEY: 'cloud-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      OPENAI_API_KEY: 'provider-secret',
      OPENCODE_CONFIG_CONTENT: '{"mcp":"unexpected"}',
      PRIVATE_APP_SETTING: 'must-not-forward',
    };

    const env = buildPublicReviewCliEnv(source);
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/example',
      LC_ALL: 'C',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('OPENCODE_CONFIG_CONTENT');
    expect(env).not.toHaveProperty('PRIVATE_APP_SETTING');
  });

  it('applies the same allowlist after all provider and inherited layers are composed', () => {
    const env = buildCliChildEnv({
      baseEnv: { PATH: '/usr/bin', GH_TOKEN: 'ambient' },
      before: { GH_TOKEN: 'forge', AWS_PROFILE: 'cloud-profile' },
      provider: {
        envVars: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
          ANTHROPIC_AUTH_TOKEN: 'local-only',
          GH_TOKEN: 'provider-forge',
          OPENAI_API_KEY: 'provider-secret',
        },
      },
      cwd: '/tmp/public-review',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    });

    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(env.PWD).toBe('/tmp/public-review');
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('AWS_PROFILE');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CLAUDECODE');
  });
});

describe('buildCliChildEnv — PWD pin and CLAUDECODE strip', () => {
  it('pins PWD to the spawn cwd, overriding a stale inherited value (#3193)', () => {
    const env = buildCliChildEnv({ baseEnv: { PWD: '/repos/PortOS' }, cwd: '/repos/my-app' });
    expect(posixPath(env.PWD)).toBe('/repos/my-app');
  });

  it('leaves the inherited PWD alone when no cwd is passed', () => {
    expect(posixPath(buildCliChildEnv({ baseEnv: { PWD: '/repos/PortOS' } }).PWD)).toBe('/repos/PortOS');
  });

  // The pin runs LAST, over the composed object — so a provider that sets its
  // own PWD cannot re-point the child at the wrong repo.
  it('pins PWD over a provider-supplied PWD', () => {
    const env = buildCliChildEnv({
      baseEnv: {}, provider: { envVars: { PWD: '/somewhere/else' } }, cwd: '/repos/my-app',
    });
    expect(posixPath(env.PWD)).toBe('/repos/my-app');
  });

  it('strips CLAUDECODE from every layer that could supply it', () => {
    const env = buildCliChildEnv({
      baseEnv: { CLAUDECODE: '1' },
      before: { CLAUDECODE: '1' },
      provider: { envVars: { CLAUDECODE: '1' } },
      extra: { CLAUDECODE: '1' },
    });
    expect(env.CLAUDECODE).toBeUndefined();
  });
});

describe('buildCliChildEnv — pm2 guard', () => {
  it('leaves PATH untouched without `guard` (Run Prompt / fire-and-collect paths)', () => {
    const env = buildCliChildEnv({ baseEnv: { PATH: '/usr/bin' } });
    expect(posixPath(env.PATH)).toBe('/usr/bin');
    expect(env.PORTOS_REAL_PM2).toBeUndefined();
  });

  // Load-bearing: the shim must sit on the FINAL PATH. Prepending it before the
  // provider's override would let a `--dangerously-skip-permissions` agent reach
  // the real pm2 and `pm2 kill` the shared daemon.
  it('prepends the guard shim onto the PATH a provider override produced', () => {
    const env = buildCliChildEnv({
      baseEnv: { PATH: '/usr/bin' },
      provider: { envVars: { PATH: '/provider/bin' } },
      guard: true,
    });
    expect(env.PATH.startsWith(`${AGENT_GUARD_BIN}`)).toBe(true);
    expect(posixPath(env.PATH)).toContain('/provider/bin');
    expect(posixPath(env.PATH)).not.toContain('/usr/bin');
  });
});

// composeProviderEnv is the same layering WITHOUT a base env, PWD pin, or strip
// — for the two sites that build a DELTA someone else bases and spawns. Those
// are exactly the sites an earlier draft of the guard could not see, and where
// the OpenCode sweep was missed once before.
describe('composeProviderEnv — delta for sites that do not spawn directly', () => {
  it('widens Claude Code output for Ollama harnesses while preserving explicit provider overrides', () => {
    const localClaude = { command: '/usr/local/bin/claude', ollamaBacked: true, envVars: {} };
    expect(composeProviderEnv({ provider: localClaude }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('65536');
    expect(composeProviderEnv({
      provider: { ...localClaude, envVars: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '48000' } },
    }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('48000');

    expect(composeProviderEnv({
      provider: { command: 'claude', ollamaBacked: false, envVars: {} },
    }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(composeProviderEnv({
      provider: { command: 'opencode', ollamaBacked: true, envVars: {} },
    }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it('disables Claude/Ollama thinking when the provider requests it', () => {
    const localClaude = { command: 'claude', ollamaBacked: true, thinking: false, envVars: {} };
    expect(composeProviderEnv({ provider: localClaude }).MAX_THINKING_TOKENS).toBe('0');
    expect(composeProviderEnv({ provider: { ...localClaude, thinking: true } }).MAX_THINKING_TOKENS).toBeUndefined();
  });

  it('emits only the provider layers, with no base env, PWD, or strip', () => {
    const delta = composeProviderEnv({
      before: { GH_TOKEN: 'forge' },
      provider: { envVars: { GH_TOKEN: 'provider', CLAUDECODE: '1' } },
    });
    // No process.env keys leak in — the consumer supplies the base.
    expect(delta).toEqual({ GH_TOKEN: 'provider', CLAUDECODE: '1' });
    // And no PWD is invented for a caller that has no cwd to pin.
    expect(delta.PWD).toBeUndefined();
  });

  it('keeps the same layer order buildCliChildEnv uses', () => {
    expect(composeProviderEnv({
      before: { K: 'before' },
      provider: { envVars: { K: 'provider' } },
      extra: { K: 'extra' },
    }).K).toBe('extra');
  });

  it('declares the OpenCode models map for the runner payload (#2243/#2190)', () => {
    // agentLifecycle hands this to the cos-runner over HTTP, which has no
    // provider record of its own — so the map has to be baked in HERE or the
    // runner-spawned agent rejects its own --model.
    const delta = composeProviderEnv({ provider: OLLAMA_OPENCODE, model: 'llama3.1:8b' });
    expect(declaredModels(delta).sort()).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
  });

  it('hands the shipped Claude SGLang TUI its Anthropic wiring, and no OpenCode config', () => {
    // Acceptance path for the seeded pair: a CoS task assigned this provider
    // spawns `claude --dangerously-skip-permissions` with exactly this env.
    const provider = SHIPPED_PROVIDERS.providers['claude-sglang-tui'];
    expect(provider.command).toBe('claude');
    expect(provider.args).toEqual(['--dangerously-skip-permissions']);

    const env = composeProviderEnv({ provider, model: 'qwen3.8-27b' });

    // Without this, Claude Code's per-request attribution hash is the first
    // token to differ between turns and SGLang re-prefills the whole prompt.
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    // Server ROOT: the Anthropic SDK appends /v1/messages itself.
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:18021');
    expect(env.ANTHROPIC_BASE_URL).not.toMatch(/\/v\d+\/?$/);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sglang');

    // `sglangBacked` also marks the OpenCode wrappers, but the OpenCode config
    // is gated on the COMMAND — a `claude` harness must not receive one.
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();

    // The 32K-output wedge is a property of "local thinking model behind the
    // claude binary", not of Ollama — a run that reasons past the default ceiling
    // hangs forever at an empty composer, and thinking cannot be turned off here.
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('65536');
  });

  it('widens the Claude output ceiling for any LOCAL backend, never a hosted one', () => {
    const forClaude = (extra) => composeProviderEnv({ provider: { command: 'claude', envVars: {}, ...extra } });

    for (const marker of ['ollamaBacked', 'sglangBacked', 'llamaBacked', 'mtplxBacked', 'vllmBacked']) {
      expect(forClaude({ [marker]: true }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, marker).toBe('65536');
    }
    // OrcaRouter is a hosted gateway whose upstream models own their own output
    // budgets — the same carve-out localRuntimeKind makes.
    expect(forClaude({ orcarouterBacked: true }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    // And a cloud Claude provider is untouched.
    expect(forClaude({}).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    // The marker alone isn't enough: an OpenCode wrapper is not a Claude harness.
    expect(composeProviderEnv({ provider: { command: 'opencode', sglangBacked: true, envVars: {} } })
      .CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it('emits MAX_THINKING_TOKENS only where an omitted thinking field means OFF', () => {
    // Ollama's Anthropic endpoint maps an omitted `thinking` field to its
    // non-thinking mode, so the var is a real off switch there. SGLang falls
    // through to Qwen3.8's chat-template default (thinking ON), so emitting it
    // would look like an off switch while changing nothing.
    const off = (extra) => composeProviderEnv({ provider: { command: 'claude', thinking: false, envVars: {}, ...extra } });
    expect(off({ ollamaBacked: true }).MAX_THINKING_TOKENS).toBe('0');
    expect(off({ sglangBacked: true }).MAX_THINKING_TOKENS).toBeUndefined();
  });

  it('is what buildCliChildEnv layers over its base env', () => {
    const layers = { before: { A: '1' }, provider: { envVars: { B: '2' } }, extra: { C: '3' } };
    expect(buildCliChildEnv({ baseEnv: {}, ...layers })).toEqual(composeProviderEnv(layers));
  });
});

// One case per real call site, asserting the precedence THAT site depends on.
// The sites do not all layer the same way, so a single "extra wins" rule would
// have silently changed two of them — these pin the actual contracts.
describe('buildCliChildEnv — per-call-site composition', () => {
  it('runner.js / cliProviderRun.js: provider.envVars over baseEnv, guarded only for the runner', () => {
    const args = { baseEnv: { PATH: '/usr/bin' }, provider: { envVars: { A: 'provider' } }, cwd: '/w' };
    expect(buildCliChildEnv({ ...args, guard: true }).A).toBe('provider');
    expect(buildCliChildEnv({ ...args, guard: true }).PATH).toContain(AGENT_GUARD_BIN);
    // The fire-and-collect path is not an agent — it must stay unguarded.
    expect(posixPath(buildCliChildEnv(args).PATH)).toBe('/usr/bin');
  });

  it('cliProviderRun.js: honors a sanitized baseEnv instead of process.env', () => {
    // The autofixer passes an allowlist so host credentials never reach the CLI —
    // so the builder must not smuggle process.env back in under it.
    const env = buildCliChildEnv({ baseEnv: { PATH: '/usr/bin' }, provider: { envVars: {} }, cwd: '/w' });
    expect(Object.keys(env).sort()).toEqual(['PATH', 'PWD']);
  });

  it('agentCliSpawning.js: forgeToken/claudeSettings sit UNDER provider.envVars', () => {
    const env = buildCliChildEnv({
      baseEnv: { PATH: '/usr/bin' },
      before: { GH_TOKEN: 'forge', AWS_PROFILE: 'from-settings' },
      provider: { envVars: { GH_TOKEN: 'provider' } },
      model: 'opus',
      cwd: '/w',
      guard: true,
    });
    expect(env.GH_TOKEN).toBe('provider');       // explicit provider credential wins
    expect(env.AWS_PROFILE).toBe('from-settings'); // non-conflicting settings survive
    expect(env.PWD).toBe('/w');
    expect(env.PATH).toContain(AGENT_GUARD_BIN);
  });

  it('tuiPromptRunner.js / tuiUsageScrape.js: TERM/COLORTERM beat provider.envVars', () => {
    const env = buildCliChildEnv({
      baseEnv: { TERM: 'dumb' },
      provider: { envVars: { TERM: 'vt100', COLORTERM: '' } },
      cwd: '/sandbox',
      extra: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.PWD).toBe('/sandbox');
    // A PTY prompt run is not an agent — no shim.
    expect(env.PORTOS_REAL_PM2).toBeUndefined();
  });

  it('cos-runner/index.js: request envVars over process.env, no OpenCode layer, unguarded', () => {
    // Mirrors the real call exactly — `before: envVars`, no provider record. The
    // runner receives an ALREADY-composed delta over HTTP (agentLifecycle built it
    // with composeProviderEnv), so this side must add only the base, the pin, and
    // the strip; inventing an OpenCode config here would clobber the baked-in one.
    const env = buildCliChildEnv({
      baseEnv: { A: 'base', PATH: '/usr/bin', CLAUDECODE: '1' },
      before: { A: 'request', OPENCODE_CONFIG_CONTENT: '{"baked":"upstream"}' },
      cwd: '/workspace',
    });
    expect(env).toEqual({
      A: 'request',
      OPENCODE_CONFIG_CONTENT: '{"baked":"upstream"}',
      PATH: '/usr/bin',
      PWD: '/workspace',
    });
  });

  it('retains ambient auth for the selected provider when the runner supplies its descriptor', () => {
    const provider = { id: 'codex', command: 'codex', envVars: { OPENAI_API_KEY: 'not serialized' } };
    const env = buildCliChildEnv({
      baseEnv: { PATH: '/usr/bin', OPENAI_API_KEY: 'ambient-key' },
      provider: cliProviderAuthDescriptor(provider),
      cwd: '/workspace',
    });

    expect(env.OPENAI_API_KEY).toBe('ambient-key');
  });

  it('askService.js: no cwd means no PWD is invented', () => {
    const env = buildCliChildEnv({ baseEnv: { PATH: '/usr/bin' }, provider: { envVars: {} }, model: 'opus' });
    expect(env.PWD).toBeUndefined();
  });

  it('visionCli.js: the image dir is pinned as PWD so the CLI can find the file', () => {
    const env = buildCliChildEnv({
      baseEnv: { PWD: '/repos/PortOS' }, provider: OLLAMA_OPENCODE, model: 'llava:7b', cwd: '/tmp/portos-vision-x',
    });
    expect(posixPath(env.PWD)).toBe('/tmp/portos-vision-x');
    // And the vision model is declared, so `--model ollama/llava:7b` is accepted.
    expect(declaredModels(env)).toContain('llava:7b');
  });
});

// Source invariant. The whole point of this module is that the next env-level
// concern is a ONE-file change — which only holds if no spawn site quietly
// rebuilds the tuple by hand again. Three separate fixes (the OpenCode models
// map, the CLAUDECODE strip, the PWD pin) each had to sweep every site because
// nothing failed when one was missed.
//
// Deliberately DISCOVERS the offenders rather than listing the known call sites:
// an allowlist of "these files must call the builder" passes the day someone
// adds a ninth spawn site, which is exactly when the guard needs to fire.
describe('no spawn site rebuilds the CLI child env by hand', () => {
  // Files allowed to compose the tuple themselves, each with the reason.
  const EXEMPT = new Map([
    ['lib/cliChildEnv.js', 'this module IS the shared composer'],
    // Worth stating both halves: the import constraint is why it cannot call the
    // composer, and the dormancy is why its missing CLAUDECODE strip / OpenCode
    // map is not a live PortOS gap someone needs to chase.
    ['lib/aiToolkit/runner.js', 'vendored toolkit — must not import out to other PortOS modules, and its spawn is dormant under PortOS\'s setCliRunner override'],
  ]);

  // Two independent markers, because either one alone has a blind spot: a new
  // site could strip CLAUDECODE without spreading provider.envVars, or spread
  // provider.envVars while forgetting the strip (which is itself the bug).
  //
  // Marker A — the CLAUDECODE strip. Crisp: every path that runs a coding CLI
  // strips it, and nothing else in the tree does.
  const STRIPS_CLAUDECODE = /delete\s+[A-Za-z_$][\w$]*\.CLAUDECODE\b/;

  // Marker B — a `provider.envVars` spread that reaches a child process.
  //
  // Keyed on the spread + the handoff, NOT on a `...process.env` base. An
  // earlier draft anchored on the base env and had to be widened once already
  // (for cliProviderRun's `baseEnv` parameter name) — and it still could not see
  // the two sites that compose a DELTA someone else bases: agentLifecycle's
  // runner payload and agentTuiSpawning's shell overlay, which is exactly where
  // the OpenCode sweep was missed once before. Requiring only the spread and a
  // nearby handoff catches both shapes.
  //
  // The handoff requirement is what separates a real child env from the two
  // shapes that merge the same objects for a different purpose and correctly
  // need none of this: a model-id LOOKUP env (`resolveBedrockCliModel({ env })`,
  // `resolveWindowsExecutable(…, searchEnv)`) and a capability PROBE
  // (`agy models`, `--version`) — neither runs a model, writes files, nor has a
  // workspace to be misrouted into.
  //
  // A window rather than a parser, sized from the real tree: the widest real gap
  // is ~1400 chars (agentTuiSpawning's `env:` overlay sits that far below its
  // `createShellSession(`, behind a long comment block), so the back-window is
  // 1500. Verified empirically — at 1500 the only files flagged across all of
  // `server/` are the two EXEMPT ones, and every pre-refactor hand-rolled site
  // is caught. Over-matching costs one EXEMPT line; under-matching silently
  // reopens the N-file sweep, so the bias is deliberate.
  //
  // The optional `(` in the spread pattern matters: `...(provider.envVars || {})`
  // is the shape two sites use, and a pattern without it reads them as clean.
  const HANDS_OFF_TO_CHILD = /\b(?:spawn|ptySpawn|spawnImpl|pty\.spawn|createShellSession|spawnAgentViaRunner)\s*\(|\benvVars:/;
  const SPREADS_PROVIDER_ENV_INTO_SPAWN = (src) => {
    for (const m of src.matchAll(/\.\.\.\s*\(?\s*[A-Za-z_$][\w$]*\??\.envVars\b/g)) {
      if (HANDS_OFF_TO_CHILD.test(src.slice(Math.max(0, m.index - 1500), m.index + 900))) return true;
    }
    return false;
  };

  const isOffender = (src) => STRIPS_CLAUDECODE.test(src) || SPREADS_PROVIDER_ENV_INTO_SPAWN(src);
  const offenders = () => collectServerSources()
    .filter((rel) => !EXEMPT.has(rel) && isOffender(readServerSource(rel)));

  it('finds the exempt files (guard is not vacuous)', () => {
    // If the markers stop matching even the composer itself, the scan broke and
    // the assertion below would pass for the wrong reason.
    for (const rel of EXEMPT.keys()) {
      expect(
        isOffender(readServerSource(rel)),
        `${rel} no longer matches either marker — the scan broke`,
      ).toBe(true);
    }
  });

  it('every AI-CLI spawn composes its child env through buildCliChildEnv', () => {
    expect(
      offenders(),
      'These files build an AI-CLI child environment by hand instead of calling '
      + 'buildCliChildEnv (server/lib/cliChildEnv.js). That is what made the OpenCode '
      + 'models map (#2190), the CLAUDECODE strip, and the PWD pin (#3193) each cost an '
      + 'N-file sweep, with a missed site failing silently. Route the spawn through the '
      + 'shared builder, or add the file to EXEMPT above with the reason it must not.',
    ).toEqual([]);
  });
});
