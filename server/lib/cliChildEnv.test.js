import { describe, it, expect } from 'vitest';
import { buildCliChildEnv, composeProviderEnv } from './cliChildEnv.js';
import { AGENT_GUARD_BIN } from './agentGuard/index.js';
import { collectServerSources, readServerSource } from './testHelper.js';

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

describe('buildCliChildEnv — layering', () => {
  it('layers baseEnv < before < provider.envVars < extra', () => {
    const env = buildCliChildEnv({
      baseEnv: { WHO: 'base', FROM_BASE: '1' },
      before: { WHO: 'before', FROM_BEFORE: '1' },
      provider: { envVars: { WHO: 'provider', FROM_PROVIDER: '1' } },
      extra: { WHO: 'extra', FROM_EXTRA: '1' },
    });
    expect(env.WHO).toBe('extra');
    // Every layer still contributes its own non-conflicting keys.
    expect(env).toMatchObject({ FROM_BASE: '1', FROM_BEFORE: '1', FROM_PROVIDER: '1', FROM_EXTRA: '1' });
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

  it('is a no-op OpenCode layer for a non-OpenCode provider', () => {
    const env = buildCliChildEnv({ baseEnv: {}, provider: { command: 'claude', envVars: { A: '1' } }, model: 'opus' });
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.A).toBe('1');
  });

  it('tolerates an absent provider / before / extra', () => {
    expect(buildCliChildEnv({ baseEnv: { A: '1' }, provider: null, before: null, extra: null })).toEqual({ A: '1' });
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

describe('buildCliChildEnv — PWD pin and CLAUDECODE strip', () => {
  it('pins PWD to the spawn cwd, overriding a stale inherited value (#3193)', () => {
    const env = buildCliChildEnv({ baseEnv: { PWD: '/repos/PortOS' }, cwd: '/repos/my-app' });
    expect(env.PWD).toBe('/repos/my-app');
  });

  it('leaves the inherited PWD alone when no cwd is passed', () => {
    expect(buildCliChildEnv({ baseEnv: { PWD: '/repos/PortOS' } }).PWD).toBe('/repos/PortOS');
  });

  // The pin runs LAST, over the composed object — so a provider that sets its
  // own PWD cannot re-point the child at the wrong repo.
  it('pins PWD over a provider-supplied PWD', () => {
    const env = buildCliChildEnv({
      baseEnv: {}, provider: { envVars: { PWD: '/somewhere/else' } }, cwd: '/repos/my-app',
    });
    expect(env.PWD).toBe('/repos/my-app');
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
    expect(env.PATH).toBe('/usr/bin');
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
    expect(env.PATH).toContain('/provider/bin');
    expect(env.PATH).not.toContain('/usr/bin');
  });
});

// composeProviderEnv is the same layering WITHOUT a base env, PWD pin, or strip
// — for the two sites that build a DELTA someone else bases and spawns. Those
// are exactly the sites an earlier draft of the guard could not see, and where
// the OpenCode sweep was missed once before.
describe('composeProviderEnv — delta for sites that do not spawn directly', () => {
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
    const args = { baseEnv: { A: 'base', PATH: '/usr/bin' }, provider: { envVars: { A: 'provider' } }, cwd: '/w' };
    expect(buildCliChildEnv({ ...args, guard: true }).A).toBe('provider');
    expect(buildCliChildEnv({ ...args, guard: true }).PATH).toContain(AGENT_GUARD_BIN);
    // The fire-and-collect path is not an agent — it must stay unguarded.
    expect(buildCliChildEnv(args).PATH).toBe('/usr/bin');
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
    // The runner receives loose envVars over HTTP with no `command` to classify.
    const env = buildCliChildEnv({
      baseEnv: { A: 'base', PATH: '/usr/bin', CLAUDECODE: '1' },
      provider: { envVars: { A: 'request' } },
      cwd: '/workspace',
    });
    expect(env).toEqual({ A: 'request', PATH: '/usr/bin', PWD: '/workspace' });
  });

  it('askService.js: no cwd means no PWD is invented', () => {
    const env = buildCliChildEnv({ baseEnv: { PATH: '/usr/bin' }, provider: { envVars: {} }, model: 'opus' });
    expect(env.PWD).toBeUndefined();
  });

  it('visionCli.js: the image dir is pinned as PWD so the CLI can find the file', () => {
    const env = buildCliChildEnv({
      baseEnv: { PWD: '/repos/PortOS' }, provider: OLLAMA_OPENCODE, model: 'llava:7b', cwd: '/tmp/portos-vision-x',
    });
    expect(env.PWD).toBe('/tmp/portos-vision-x');
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
