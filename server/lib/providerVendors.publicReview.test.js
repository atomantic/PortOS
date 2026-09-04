import { describe, expect, it } from 'vitest';
import {
  PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
  PUBLIC_REVIEW_EXECUTION_PROFILE,
  PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
} from './agentExecutionProfiles.js';
import {
  buildVendorSpawnConfig,
  enforcedPublicReviewPosturesForProvider,
  publicReviewPosturesForProvider,
  publicReviewProviderBlock,
  supportsPublicReviewProvider,
  supportsPublicReviewActionsProvider,
  supportsTuiPublicReviewActionsProvider,
  supportsTuiPublicReviewPosture,
} from './providerVendors.js';

const localClaude = {
  id: 'claude-ollama',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  args: ['--dangerously-skip-permissions', '--tools', 'Bash'],
  envVars: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
    ANTHROPIC_AUTH_TOKEN: 'local-only',
  },
};
const codex = { id: 'codex-cli', type: 'cli', command: 'codex', models: ['gpt-5.6'] };
const antigravity = { id: 'antigravity-cli', type: 'cli', command: 'agy', models: ['gemini-3.6-flash-high'] };
const grok = { id: 'grok-cli', type: 'cli', command: 'grok' };
const opencodeOllama = {
  id: 'opencode-ollama-tui',
  type: 'tui',
  command: 'opencode',
  ollamaBacked: true,
  models: ['gemma3:27b'],
};

describe('public-review provider postures', () => {
  // The whole point of the posture table: eligibility is DECLARED per vendor,
  // so an install that has only one of these can still configure every stage.
  it('derives each provider’s eligible postures from its vendor row', () => {
    expect(publicReviewPosturesForProvider(codex)).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(publicReviewPosturesForProvider(antigravity)).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(publicReviewPosturesForProvider(grok)).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(publicReviewPosturesForProvider(localClaude)).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
  });

  // The actions stage is open to every enabled binary provider; the ENFORCED
  // list is the subset with a vendor sandbox recipe, which is what the schedule
  // UI reports beside the picker.
  it('distinguishes a vendor-sandboxed actions stage from a worktree-only one', () => {
    const opencode = { id: 'opencode', type: 'cli', command: 'opencode' };
    expect(publicReviewPosturesForProvider(opencode)).toEqual([PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(enforcedPublicReviewPosturesForProvider(opencode)).toEqual([]);
    expect(enforcedPublicReviewPosturesForProvider(codex)).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(enforcedPublicReviewPosturesForProvider(localClaude)).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(enforcedPublicReviewPosturesForProvider({ ...codex, type: 'api' })).toEqual([]);
  });

  // Regression (#5830): the spawn gate passes the posture a STAGE requires,
  // which is `null` for every ordinary agent task. Answering "unsupported" for
  // a task that requested no posture blocked all normal work — scheduled tasks
  // included — with "has no enforced null public-content review mode".
  it('does not block a task that requested no posture', () => {
    expect(publicReviewProviderBlock(codex, null)).toBeNull();
    expect(publicReviewProviderBlock(codex, undefined)).toBeNull();
    // The transport is irrelevant when nothing is being enforced: a TUI session
    // and an api provider run ordinary tasks all day.
    expect(publicReviewProviderBlock({ ...codex, type: 'tui' }, null)).toBeNull();
    expect(publicReviewProviderBlock({ ...codex, type: 'api' }, null)).toBeNull();
  });

  it('blocks a requested posture the provider has no recipe for, naming that posture', () => {
    expect(publicReviewProviderBlock(codex, PUBLIC_REVIEW_NO_TOOL_POSTURE)).toBeNull();
    expect(publicReviewProviderBlock(codex, PUBLIC_REVIEW_ACTIONS_POSTURE)).toBeNull();

    // claude has permission modes but no sandbox flag — tool-free only.
    expect(publicReviewProviderBlock(localClaude, PUBLIC_REVIEW_NO_TOOL_POSTURE)).toBeNull();
    expect(publicReviewProviderBlock({ ...localClaude, type: 'api' }, PUBLIC_REVIEW_ACTIONS_POSTURE)).toEqual({
      reason: "Provider 'claude-ollama' has no enforced sandboxed-actions public-content review mode",
      category: 'public-review-actions-provider-unsupported',
    });

    // A TUI record of a recipe-bearing vendor is spawned headless through
    // that recipe, so it is as eligible as its CLI sibling. An api provider
    // has no binary to spawn and no recipe.
    expect(publicReviewProviderBlock({ ...codex, id: 'codex-tui', type: 'tui' }, PUBLIC_REVIEW_NO_TOOL_POSTURE)).toBeNull();
    expect(publicReviewProviderBlock({ ...codex, id: 'codex-tui', type: 'tui' }, PUBLIC_REVIEW_ACTIONS_POSTURE)).toBeNull();
    expect(publicReviewProviderBlock({ id: 'grok', type: 'api', command: undefined }, PUBLIC_REVIEW_ACTIONS_POSTURE)).toEqual({
      reason: "Provider 'grok' has no enforced sandboxed-actions public-content review mode",
      category: 'public-review-actions-provider-unsupported',
    });
  });

  // The user's enabled providers are commonly the TUI records (the CLI
  // siblings switched off), and a stage runs the same binary headless either
  // way — so a TUI record carries its vendor's postures.
  it('derives the same postures for a TUI record of a recipe-bearing vendor', () => {
    expect(publicReviewPosturesForProvider({ ...codex, id: 'codex-tui', type: 'tui' })).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(publicReviewPosturesForProvider({ ...grok, id: 'grok-tui', type: 'tui' })).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(publicReviewPosturesForProvider({ ...localClaude, id: 'claude-ollama-tui', type: 'tui' })).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
    // The headless recipe, not the TUI argv, is what the stage spawns.
    const config = buildVendorSpawnConfig({ ...codex, id: 'codex-tui', type: 'tui', args: ['--full-auto'] }, {
      effectiveModel: 'gpt-5.6',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });
    expect(config.args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'workspace-write']));
    expect(config.args).not.toContain('--full-auto');
  });

  // OpenCode is how a user actually drives a local Ollama model, so the gate
  // has to be configurable on it — otherwise the only local option is a Claude
  // binary pointed at an Anthropic-compatible shim.
  it('offers the no-tool gate on a local-backed OpenCode wrapper', () => {
    expect(publicReviewPosturesForProvider(opencodeOllama))
      .toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE]);
    // Enforced for the gate (config recipe), worktree-only for the actions
    // stage — OpenCode ships no OS sandbox of its own.
    expect(enforcedPublicReviewPosturesForProvider(opencodeOllama)).toEqual([PUBLIC_REVIEW_NO_TOOL_POSTURE]);
  });

  // The gate's enforcement rides in OPENCODE_CONFIG_CONTENT, which the
  // public-review env allowlist keeps only for a config declaring on-box
  // endpoints — so a wrapper fronting a hosted gateway must not be offered a
  // stage it cannot authenticate.
  it('withholds the gate from an OpenCode wrapper with no local backend', () => {
    const gateway = { id: 'opencode-openrouter-tui', type: 'tui', command: 'opencode', gatewayBacked: 'openrouter' };
    expect(publicReviewPosturesForProvider(gateway)).toEqual([PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(supportsPublicReviewProvider(gateway)).toBe(false);
  });

  // The marker alone is not enough, and this is the security case, not a tidy-up:
  // `cliChildEnv.js` strips a config whose endpoint is off-box, and a stripped
  // config does not harden the child — OpenCode falls back to reading the user's
  // own ~/.config/opencode with its tools, plugins and MCP servers intact, while
  // the stage still reports an enforced tool-free gate. Eligibility must use the
  // same locality rule the allowlist does.
  it('withholds the gate from an ollama-marked wrapper pointed off-box', () => {
    const relocated = {
      ...opencodeOllama,
      envVars: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { ollama: { options: { baseURL: 'http://192.0.2.10:11434/v1' } } },
        }),
      },
    };
    expect(supportsPublicReviewProvider(relocated)).toBe(false);
    // A config that keeps the daemon on this machine is still eligible.
    expect(supportsPublicReviewProvider({
      ...opencodeOllama,
      envVars: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { ollama: { options: { baseURL: 'http://127.0.0.1:11434/v1' } } },
        }),
      },
    })).toBe(true);
  });

  // Every other local runtime is rejected at spawn time by
  // `validatePublicReviewModel` (`public-review-runtime-unsupported` — only an
  // Ollama catalog can be probed for the authoritative no-tools answer), so
  // offering them would put a permanently blocking choice in the picker.
  it('withholds the gate from local runtimes the model check cannot validate', () => {
    for (const marker of ['llamaBacked', 'vllmBacked', 'sglangBacked', 'mtplxBacked']) {
      const provider = { id: `opencode-${marker}`, type: 'tui', command: 'opencode', [marker]: true };
      expect(supportsPublicReviewProvider(provider), marker).toBe(false);
      expect(publicReviewPosturesForProvider(provider), marker).toEqual([PUBLIC_REVIEW_ACTIONS_POSTURE]);
    }
  });

  it('builds the OpenCode gate on its read-only agent with a namespaced model and no provider args', () => {
    const config = buildVendorSpawnConfig({ ...opencodeOllama, args: ['--agent', 'build'] }, {
      effectiveModel: 'gemma3:27b',
      effort: 'low',
      safetyProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
    });
    expect(config).toEqual({
      command: 'opencode',
      args: ['run', '--agent', 'plan', '-m', 'ollama/gemma3:27b'],
      stdinMode: 'prompt',
    });
    // A saved `--agent build` would select the tool-enabled agent; `--effort` is
    // not an `opencode run` flag at all.
    expect(config.args).not.toContain('build');
    expect(config.args).not.toContain('--effort');
  });

  it('fails closed for the no-tool gate on transports and vendors with no maintained recipe', () => {
    // An HTTP api provider has no binary to spawn and no enforced argv.
    expect(publicReviewPosturesForProvider({ ...codex, type: 'api' })).toEqual([]);
    // A namespace-less opencode record, and kimi/cursor, have no maintained
    // no-tool recipe, so they can run only the actions stage. An unknown command
    // must never inherit claude's always-true fallback row for the gate either.
    expect(publicReviewPosturesForProvider({ id: 'opencode-tui', type: 'tui', command: 'opencode' })).toEqual([PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(publicReviewPosturesForProvider({ id: 'custom', type: 'cli', command: 'custom-agent' })).toEqual([PUBLIC_REVIEW_ACTIONS_POSTURE]);
    expect(supportsPublicReviewProvider({ id: 'kimi', type: 'cli', command: 'kimi' })).toBe(false);
    expect(supportsPublicReviewActionsProvider(localClaude)).toBe(true);
    expect(supportsPublicReviewActionsProvider({ ...localClaude, type: 'api' })).toBe(false);
  });

  it('builds the final reviewer with the bounded Codex sandbox and no provider args', () => {
    const config = buildVendorSpawnConfig({
      ...codex,
      command: '/opt/example/bin/codex',
      args: ['--dangerously-bypass-approvals-and-sandbox', '--mcp-config', 'unsafe.json'],
    }, {
      effectiveModel: 'gpt-5.6',
      effort: 'high',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });

    expect(config.args).toEqual(expect.arrayContaining([
      'exec', '--sandbox', 'workspace-write', '--approve-for-me', '--ephemeral', '--ignore-user-config',
      '--model', 'gpt-5.6',
    ]));
    expect(config.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(config.args).not.toContain('--mcp-config');
    expect(config.args).not.toContain('unsafe.json');
  });

  it('builds the Codex gate stage read-only rather than workspace-write', () => {
    const config = buildVendorSpawnConfig(codex, {
      effectiveModel: 'gpt-5.6',
      safetyProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
    });
    expect(config.args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only']));
    expect(config.args).not.toContain('workspace-write');
    expect(config.args).not.toContain('--approve-for-me');
  });

  it('builds the final reviewer with the bounded Antigravity sandbox and selected effort', () => {
    const config = buildVendorSpawnConfig({
      ...antigravity,
      command: '/opt/example/bin/agy',
      args: ['--dangerously-skip-permissions', '--model', 'unsafe-model'],
      models: ['gemini-3.6-flash-low', 'gemini-3.6-flash-high'],
    }, {
      effectiveModel: 'gemini-3.6-flash',
      effort: 'high',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });

    expect(config.args).toEqual(expect.arrayContaining([
      '--sandbox', '--mode', 'accept-edits', '--disable-slash-commands',
      '--model', 'gemini-3.6-flash', '--effort', 'high',
    ]));
    expect(config.args).not.toContain('plan');
    expect(config.args).not.toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('unsafe-model');
  });

  it('builds the Antigravity gate stage in plan mode, which cannot edit', () => {
    const config = buildVendorSpawnConfig(antigravity, { safetyProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE });
    expect(config.args).toEqual(expect.arrayContaining(['--sandbox', '--mode', 'plan', '--disable-slash-commands']));
    expect(config.args).not.toContain('accept-edits');
  });

  it('builds grok’s two postures from its own permission-mode and sandbox flags', () => {
    const gate = buildVendorSpawnConfig({ ...grok, args: ['--always-approve'] }, {
      effectiveModel: 'grok-4',
      safetyProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
    });
    expect(gate.args).toEqual(expect.arrayContaining([
      '--permission-mode', 'plan', '--tools', '', '--no-subagents', '--disable-web-search',
      '--model', 'grok-4',
    ]));
    // A saved auto-approval posture must not survive into the screened run.
    expect(gate.args).not.toContain('--always-approve');
    expect(gate.args).not.toContain('bypassPermissions');
    expect(gate.args).not.toContain('--sandbox');

    const actions = buildVendorSpawnConfig(grok, { safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE });
    expect(actions.args).toEqual(expect.arrayContaining([
      '--sandbox', 'workspace', '--permission-mode', 'acceptEdits',
    ]));
    expect(actions.args).not.toContain('plan');
  });

  it('builds the Claude actions stage inside its OS sandbox, not under skip-permissions', () => {
    const config = buildVendorSpawnConfig({ ...localClaude, args: ['--dangerously-skip-permissions'] }, {
      effectiveModel: 'qwen3.8:27b',
      effort: 'high',
      systemPromptFile: '/tmp/example-system.md',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });
    expect(config.command).toBe('claude');
    expect(config.streamFormat).toBe('stream-json');
    expect(config.args).toEqual(expect.arrayContaining([
      '--permission-mode', 'acceptEdits', '--settings', '--strict-mcp-config', '--print',
      '--append-system-prompt-file', '/tmp/example-system.md', '--model', 'qwen3.8:27b', '--effort', 'high',
    ]));
    const settings = JSON.parse(config.args[config.args.indexOf('--settings') + 1]);
    expect(settings.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, network: { allowedDomains: [] } });
    expect(config.args[config.args.indexOf('--disallowedTools') + 1]).toBe('WebFetch,WebSearch');
    expect(config.args).not.toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('--restricted');
    expect(config.args).not.toContain('plan');
    expect(config.args).toContain('--bare');
    const cloud = buildVendorSpawnConfig({ id: 'claude-code', type: 'cli', command: 'claude' }, {
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });
    expect(cloud.args).not.toContain('--bare');
    const cloudGate = buildVendorSpawnConfig({ id: 'claude-code', type: 'cli', command: 'claude' }, {
      safetyProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
    });
    expect(cloudGate.args).not.toContain('--bare');
    expect(cloudGate.args).toContain('--restricted');
  });

  // #6062 — Stage 3 may run as an ATTACHABLE session so an operator can watch
  // and steer the longest, least predictable stage in the pipeline. `tui: true`
  // is a per-recipe opt-in, and it drops ONLY the flags that require `--print`.
  it('keeps every Claude actions enforcement flag when the recipe is built for a TUI session', () => {
    const claudeTui = { id: 'claude-tui', type: 'tui', command: 'claude', args: ['--dangerously-skip-permissions'] };
    const headless = buildVendorSpawnConfig(claudeTui, {
      effectiveModel: 'sonnet',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });
    const tui = buildVendorSpawnConfig(claudeTui, {
      effectiveModel: 'sonnet',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
      tui: true,
    });

    expect(tui.command).toBe('claude');
    // The whole sandbox recipe survives — this is what makes attaching safe.
    expect(tui.args).toEqual(expect.arrayContaining([
      '--permission-mode', 'acceptEdits',
      '--settings', headless.args[headless.args.indexOf('--settings') + 1],
      '--disallowedTools', 'WebFetch,WebSearch',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--no-chrome', '--disable-slash-commands',
      '--model', 'sonnet',
    ]));
    // Nothing inside the session can lift the sandbox: the only lever is
    // `sandbox.filesystem.disabled`, and the recipe never emits it.
    expect(JSON.parse(tui.args[tui.args.indexOf('--settings') + 1]).sandbox)
      .not.toHaveProperty('filesystem');
    // A saved skip-permissions arg is still ignored — provider.args is never
    // forwarded on this path, headless or attachable.
    expect(tui.args).not.toContain('--dangerously-skip-permissions');
    // …and ONLY the flags that require `--print` are gone. `--no-session-persistence`
    // is in the SHARED posture set rather than the headless output block, and
    // leaving it on the attachable argv made the CLI exit(1) at parse time
    // ("can only be used with --print mode") — three seconds in, before the
    // prompt was pasted, on every retry of a Stage 3 pr-reviewer run.
    const printOnly = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence'];
    expect(headless.args).toEqual(expect.arrayContaining(printOnly));
    for (const flag of printOnly) {
      expect(tui.args).not.toContain(flag);
    }
    expect(headless.args.filter((a) => !printOnly.includes(a))).toEqual(tui.args);
  });

  it('declares attachability per recipe, and never for the tool-free postures', () => {
    const claudeTui = { id: 'claude-tui', type: 'tui', command: 'claude' };
    expect(supportsTuiPublicReviewActionsProvider(claudeTui)).toBe(true);
    // An interactive session for a reasoner with no tools buys nothing and
    // widens the boundary for free — no row declares it.
    expect(supportsTuiPublicReviewPosture(claudeTui, PUBLIC_REVIEW_NO_TOOL_POSTURE)).toBe(false);
    // Vendors whose actions recipe has not been reviewed for a PTY stay headless.
    expect(supportsTuiPublicReviewActionsProvider({ id: 'codex-tui', type: 'tui', command: 'codex' })).toBe(false);
    expect(supportsTuiPublicReviewActionsProvider({ id: 'grok-tui', type: 'tui', command: 'grok' })).toBe(false);
    expect(supportsTuiPublicReviewActionsProvider(antigravity)).toBe(false);
    // …as do vendors with no actions recipe at all, and non-binary records.
    expect(supportsTuiPublicReviewActionsProvider({ id: 'opencode-tui', type: 'tui', command: 'opencode' })).toBe(false);
    expect(supportsTuiPublicReviewActionsProvider({ id: 'claude-api', type: 'api', command: 'claude' })).toBe(false);
  });

  it('refuses to build an attachable argv for a vendor with no attachable recipe', () => {
    // Failing closed matters more here than anywhere else on this path: the
    // headless fallback tier emits `--print`/`exec`/`run` argv, which in a PTY
    // neither accepts a pasted prompt nor enforces anything.
    for (const provider of [
      { id: 'codex-tui', type: 'tui', command: 'codex' },
      { id: 'grok-tui', type: 'tui', command: 'grok' },
      { id: 'opencode-tui', type: 'tui', command: 'opencode' },
      { id: 'antigravity-tui', type: 'tui', command: 'agy' },
    ]) {
      expect(() => buildVendorSpawnConfig(provider, {
        safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
        tui: true,
      })).toThrow(/no attachable sandboxed-actions public-review recipe/);
    }
    expect(() => buildVendorSpawnConfig({ id: 'claude-tui', type: 'tui', command: 'claude' }, {
      safetyProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
      tui: true,
    })).toThrow(/no attachable no-tool public-review recipe/);
  });

  it('runs a vendor with no sandbox recipe through its ordinary headless recipe for the actions stage only', () => {
    const opencode = { id: 'opencode-tui', type: 'tui', command: 'opencode', args: ['--agent', 'build'] };
    const config = buildVendorSpawnConfig(opencode, {
      effectiveModel: 'x',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });
    expect(config.command).toBe('opencode');
    expect(config.args[0]).toBe('run');
    expect(() => buildVendorSpawnConfig(opencode, {
      effectiveModel: 'x',
      safetyProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
    })).toThrow(/no enforced no-tool public-review posture/);
    expect(() => buildVendorSpawnConfig({ ...opencode, type: 'api' }, {
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    })).toThrow(/no enforced sandboxed-actions public-review posture/);
  });

  it('builds a fresh no-tool argv and ignores dangerous saved provider args', () => {
    const config = buildVendorSpawnConfig(localClaude, {
      effectiveModel: 'qwen3.8:27b',
      effort: 'max',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    });

    expect(config.command).toBe('claude');
    expect(config.stdinMode).toBe('prompt');
    expect(config.args).toContain('--permission-mode');
    expect(config.args).toContain('plan');
    expect(config.args).toContain('--restricted');
    expect(config.args).toContain('--tools');
    expect(config.args[config.args.indexOf('--tools') + 1]).toBe('');
    expect(config.args).toContain('--strict-mcp-config');
    expect(config.args).toContain('--bare');
    expect(config.args).toContain('--model');
    expect(config.args).toContain('qwen3.8:27b');
    expect(config.args).toContain('--effort');
    expect(config.args).not.toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('Bash');
    expect(config.args).not.toContain('--disallowedTools');
  });

  it('fails closed instead of assigning a posture to an unknown command', () => {
    expect(() => buildVendorSpawnConfig({
      id: 'custom-agent',
      type: 'cli',
      command: 'custom-agent',
    }, {
      effectiveModel: 'model',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    })).toThrow(/no enforced no-tool public-review posture/);
  });

  it('holds a cloud Claude to the same enforced no-tool argv as the local wrapper', () => {
    // Public PR content is public, so the posture — not the model's location —
    // is the control. The argv is what denies tools either way.
    const config = buildVendorSpawnConfig({
      id: 'claude-code',
      type: 'cli',
      command: 'claude',
      envVars: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    }, {
      effectiveModel: 'claude-sonnet-5',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    });
    expect(config.args).toEqual(expect.arrayContaining(['--restricted', '--tools', '', '--permission-mode', 'plan']));
    expect(config.args).toContain('claude-sonnet-5');
  });
});
