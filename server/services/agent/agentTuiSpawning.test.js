import {
  SUBMIT_ENTER_ATTEMPTS,
  SUBMIT_ENTER_SPACING_MS,
  STALL_NUDGE_IDLE_MS,
  PROMPT_WORK_EVIDENCE_MS,
  UNSUBMITTED_PROMPT_SETTLE_MS,
} from '../../test/fixtures/tuiTiming.js';
import {
  flushMicrotasks,
  sessionCallbacks,
  SESSION_ID,
  defaultProvider,
  defaultTuiConfig,
  runSpawn,
  claudeTuiConfig,
  agyTuiConfig,
  CODEX_COMPOSER,
  pasteCount,
  PASTE_OFF,
  PASTE_ON,
  AGY_COMPOSER_FOOTER,
  SIGNAL_POLL_MS,
  installTuiRuntimeHooks,
} from './agentTuiSpawning.test.fixture.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { execFile } from '../../lib/childProcess.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { buildTuiSpawnConfig, } from './agentTuiSpawning.js';
import {
  PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
  PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
} from '../../lib/agent/agentExecutionProfiles.js';
import { runSpawnerCompletionCleanup } from './agentCompletionCleanup.js';
import { spawnTuiSessionViaRunner } from '../cos/cosRunnerClient.js';
import * as shellService from '../shell.js';
import * as agentLifecycle from './agentFinalization.js';
import { beginOllamaAgentWork, ensureOllamaAgentContext } from '../ollamaAgentContext.js';
import * as cosAgentLifecycle from '../cos/cosAgentLifecycle.js';
import * as gitStatusService from '../git/status.js';
import * as forgeAuthService from '../forgeAuth.js';
import { PASTE_TO_ENTER_FALLBACK_MS, STALL_NUDGE_MAX_ATTEMPTS, UNSUBMITTED_PROMPT_ENTER_MAX_ATTEMPTS } from '../../lib/tuiHandshake.js';

const gitService = { ...gitStatusService, ...forgeAuthService };

describe('agent TUI spawning', () => {
  // `buildTuiSpawnConfig` → `appendModelArgs` → the REAL `resolveInjectedTuiModel`,
  // whose Bedrock arm reads process.env directly (see the vi.mock note above on why
  // stubbing the mapper can't intercept that internal call). Pin the var here so a
  // developer's Bedrock box — or a CI runner that exports it — can't flip these
  // assertions; the tests that WANT Bedrock set it explicitly.
  const bedrockBefore = process.env.CLAUDE_CODE_USE_BEDROCK;
  beforeEach(() => { delete process.env.CLAUDE_CODE_USE_BEDROCK; });
  afterEach(() => {
    if (bedrockBefore === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = bedrockBefore;
  });

  // Regression guard for the drift this path actually shipped: `appendModelArgs`
  // was a second, open-coded copy of the model-injection ladder, so cursor's
  // Bedrock exemption landed only in `buildTuiInvocation` and a cursor CoS agent
  // on a Bedrock box launched with a rewritten, unroutable model id. Both copies
  // now delegate to `resolveInjectedTuiModel`; re-inlining the mapper here would
  // break this test.
  // #6062 — Stage 3 (`sandboxed-actions`) may run attachable. When it does, its
  // argv MUST come from the vendor's maintained recipe, never the generic
  // assembly below: that path forwards `provider.args` and runs
  // `applyCommandDefaults`, either of which can hand a contributor-controlled
  // review a `--dangerously-skip-permissions` session.
  it('builds an actions-posture TUI session from the vendor recipe, not the generic argv', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-tui',
      type: 'tui',
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
    }, 'sonnet', { safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE, effort: 'high' });

    expect(config.command).toBe('claude');
    expect(config.args).toEqual(expect.arrayContaining([
      '--permission-mode', 'acceptEdits', '--settings', '--disallowedTools',
      '--strict-mcp-config', '--disable-slash-commands', '--model', 'sonnet',
    ]));
    // The saved arg is dropped, and the headless output flags are gone so the
    // PTY actually gets an interactive session to attach to.
    expect(config.args).not.toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('--print');
    expect(config.args).not.toContain('--output-format');
    // The command LINE is still rendered by the shared renderer, so it names the
    // binary and carries the recipe. Asserted by CONTENT, not by prefix: the
    // rendering is shell-dialect specific (cmd.exe/PowerShell quote the command
    // token itself), so a `startsWith('claude ')` here passes on POSIX and fails
    // on a Windows runner.
    expect(config.commandLine).toContain('claude');
    expect(config.commandLine).toContain('--permission-mode');
    expect(config.commandLine).toContain('acceptEdits');
  });

  it('fails closed rather than opening an actions-posture PTY with no maintained recipe', () => {
    // Reaching this is a routing bug (`agentLifecycle` asks
    // `supportsTuiPublicReviewActionsProvider` first) — but the fallback tier
    // would emit codex's headless `exec` argv, which in a PTY neither accepts a
    // pasted prompt nor enforces anything.
    expect(() => buildTuiSpawnConfig({ id: 'codex-tui', type: 'tui', command: 'codex' }, 'gpt-5.6', {
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    })).toThrow(/cannot run an attachable sandboxed-actions session/);
    expect(() => buildTuiSpawnConfig({ id: 'claude-tui', type: 'tui', command: 'claude' }, 'sonnet', {
      safetyProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
    })).toThrow(/cannot run an attachable no-tool session/);
  });

  it('leaves the ordinary TUI argv untouched when no posture is requested', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-tui', type: 'tui', command: 'claude', args: ['--dangerously-skip-permissions'],
    }, 'sonnet');
    expect(config.args).toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('--settings');
  });

  // A credential-bootstrap-configured provider wraps the SPAWNED command, not
  // the identity every other consumer of this config keys on (ready-text
  // detection, permission-dialog handling, error messages) — see
  // credentialBootstrap.js. `command`/`args` must stay the harness itself;
  // only `spawnCommand`/`spawnArgs`/`commandLine` reflect the wrap.
  it('wraps spawnCommand/spawnArgs/commandLine for a credential-bootstrap provider, leaving command/args as the harness identity', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-tui',
      type: 'tui',
      command: 'claude',
      args: [],
      credentialBootstrap: { command: 'token-cli', args: ['run'], harnessId: 'claude-code', argsSeparator: '--' },
    }, null);

    expect(config.command).toBe('claude');
    expect(config.args).toEqual([]);
    expect(config.spawnCommand).toBe('token-cli');
    expect(config.spawnArgs).toEqual(['run', 'claude-code']);
    expect(config.commandLine).toContain('token-cli');
    expect(config.commandLine).toContain('claude-code');
  });

  // Public-review postures are enforced recipes and must never be tampered
  // with by a user-configured wrapper — see the module docblock above.
  it('never wraps an actions-posture TUI session even when credentialBootstrap is configured', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-tui',
      type: 'tui',
      command: 'claude',
      credentialBootstrap: { command: 'token-cli', args: ['run'] },
    }, 'sonnet', { safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE, effort: 'high' });

    expect(config.spawnCommand).toBe(config.command);
    expect(config.spawnArgs).toEqual(config.args);
  });

  it('does not Bedrock-map a cursor TUI model id that merely contains "claude"', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const config = buildTuiSpawnConfig({
      id: 'cursor-tui',
      type: 'tui',
      command: 'cursor-agent',
      args: ['--force'],
    }, 'claude-opus-5-thinking-high');
    expect(config.args).toEqual(['--force', '--model', 'claude-opus-5-thinking-high']);
    expect(config.args.join(' ')).not.toContain('anthropic.');
  });

  it('still Bedrock-maps a claude TUI model id on a Bedrock box', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const config = buildTuiSpawnConfig({
      id: 'claude-code-tui',
      type: 'tui',
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
    }, 'claude-opus-4-8');
    expect(config.args).toContain('global.anthropic.claude-opus-4-8');
  });

  // A user-baked --model pin used to be honored only for opencode here, so a
  // pinned claude/codex/cursor TUI spawned `--model <pin> --model <ui-choice>`
  // and last-flag-wins silently discarded the pin.
  it('honors a user-baked --model pin instead of appending a second flag', () => {
    const config = buildTuiSpawnConfig({
      id: 'cursor-tui',
      type: 'tui',
      command: 'cursor-agent',
      args: ['--force', '--model', 'composer-2.5'],
    }, 'auto');
    expect(config.args.filter((a) => a === '--model')).toHaveLength(1);
    expect(config.args).toContain('composer-2.5');
    expect(config.args).not.toContain('auto');
  });

  it('builds a codex TUI command without a model flag for the configured-default sentinel', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      name: 'Codex TUI',
      type: 'tui',
      command: 'codex',
      args: []
    }, 'codex-configured-default', { shell: '/bin/zsh' });

    expect(config.command).toBe('codex');
    expect(config.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false']);
    expect(config.commandLine).toBe('codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false');
  });

  it('injects --dangerously-bypass-approvals-and-sandbox for codex TUI when not already set', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      command: 'codex',
      type: 'tui',
      args: ['--cd', '/tmp/work']
    }, null);
    expect(config.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false', '--cd', '/tmp/work']);
  });

  it('skips the bypass flag but still disables the update check when the provider config pins an approval policy', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      command: 'codex',
      type: 'tui',
      args: ['--ask-for-approval', 'on-failure']
    }, null);
    expect(config.args).toEqual(['-c', 'check_for_update_on_startup=false', '--ask-for-approval', 'on-failure']);
  });

  it('does not inject the bypass flag for non-codex TUI commands', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-code-tui',
      command: 'claude',
      type: 'tui',
      args: ['--dangerously-skip-permissions']
    }, null);
    expect(config.args).toEqual(['--dangerously-skip-permissions']);
  });

  it('quotes TUI arguments and carries prompt timing config without a runtime limit', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-code-tui',
      name: 'Claude TUI',
      type: 'tui',
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--add-dir', '/tmp/with space'],
      tuiPromptDelayMs: 1000,
      tuiMaxRuntimeMs: 7200000
    }, 'claude-sonnet', { shell: '/bin/zsh' });

    expect(config.args).toEqual([
      '--dangerously-skip-permissions',
      '--add-dir',
      '/tmp/with space',
      '--model',
      'claude-sonnet'
    ]);
    expect(config.commandLine).toBe("claude --dangerously-skip-permissions --add-dir '/tmp/with space' --model claude-sonnet");
    expect(config.promptDelayMs).toBe(1000);
    expect(config).not.toHaveProperty('maxRuntimeMs');
    expect(config).not.toHaveProperty('idleTimeoutMs');
  });

  it('quotes the command position for PowerShell and cmd.exe while preserving POSIX output', () => {
    const provider = {
      id: 'claude-code-tui',
      name: 'Claude TUI',
      type: 'tui',
      command: 'C:\\Program Files\\Claude\\claude.cmd',
      args: ['--append-system-prompt-file', "I:\\input folder\\it's.md"],
    };

    expect(buildTuiSpawnConfig(provider, null, { shell: '/bin/zsh' }).commandLine)
      .toBe("'C:\\Program Files\\Claude\\claude.cmd' --append-system-prompt-file 'I:\\input folder\\it'\\''s.md'");
    expect(buildTuiSpawnConfig(provider, null, { shell: 'pwsh.exe' }).commandLine)
      .toBe("& 'C:\\Program Files\\Claude\\claude.cmd' '--append-system-prompt-file' 'I:\\input folder\\it''s.md'");
    expect(buildTuiSpawnConfig(provider, null, { shell: 'cmd.exe' }).commandLine)
      .toBe('"C:\\Program Files\\Claude\\claude.cmd" "--append-system-prompt-file" "I:\\input folder\\it\'s.md"');
  });

  it('namespaces the Ollama model under ollama/ for an OpenCode TUI', () => {
    const config = buildTuiSpawnConfig({
      id: 'opencode-ollama-tui', type: 'tui', command: 'opencode', args: [], ollamaBacked: true,
    }, 'qwen2.5:7b');
    expect(config.command).toBe('opencode');
    // `--agent build` is the TUI arm's role pin (#7405) — see applyCommandDefaults.
    expect(config.args).toEqual(['--agent', 'build', '--model', 'ollama/qwen2.5:7b']);
  });

  it('respects a user-baked --model pin on an OpenCode TUI and does not duplicate it', () => {
    const config = buildTuiSpawnConfig({
      id: 'opencode-ollama-tui', type: 'tui', command: 'opencode',
      args: ['--model', 'ollama/custom'], ollamaBacked: true,
    }, 'qwen2.5:7b');
    expect(config.args).toEqual(['--model', 'ollama/custom', '--agent', 'build']);
  });

  it('falls back to the default command via id heuristic when command is omitted', () => {
    const codexConfig = buildTuiSpawnConfig({ id: 'my-codex-instance', type: 'tui' }, null);
    expect(codexConfig.command).toBe('codex');

    const claudeConfig = buildTuiSpawnConfig({ id: 'whatever', type: 'tui' }, null);
    expect(claudeConfig.command).toBe('claude');
  });

  it('applies the default prompt delay and omits a runtime limit', () => {
    const config = buildTuiSpawnConfig({ id: 'codex-tui', command: 'codex', type: 'tui' }, null);
    expect(config.promptDelayMs).toBe(2500);
    expect(config).not.toHaveProperty('maxRuntimeMs');
    expect(config).not.toHaveProperty('idleTimeoutMs');
  });

  it('does not configure an idle timeout for any TUI provider', () => {
    for (const provider of [
      { id: 'claude-ollama-tui', type: 'tui', command: 'claude', ollamaBacked: true },
      { id: 'opencode-mtplx-tui', type: 'tui', command: 'opencode', mtplxBacked: true },
      { id: 'codex-tui', type: 'tui', command: 'codex' },
    ]) {
      expect(buildTuiSpawnConfig(provider, 'example-model')).not.toHaveProperty('idleTimeoutMs');
    }
  });

  it('omits the --model flag when model is null/empty', () => {
    const config = buildTuiSpawnConfig(
      { id: 'codex-tui', command: 'codex', type: 'tui', args: [] },
      null,
      { shell: '/bin/zsh' },
    );
    expect(config.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false']);
    expect(config.commandLine).toBe('codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false');
  });

  it('adds --effort for a claude TUI and a -c model_reasoning_effort pair for a codex TUI', () => {
    const claude = buildTuiSpawnConfig(
      { id: 'claude-code-tui', command: 'claude', type: 'tui', args: [] },
      'claude-opus-4-8',
      { effort: 'xhigh' },
    );
    expect(claude.args[claude.args.indexOf('--effort') + 1]).toBe('xhigh');

    const codex = buildTuiSpawnConfig(
      { id: 'codex-tui', command: 'codex', type: 'tui', args: [] },
      null,
      { effort: 'max' },
    );
    expect(codex.args).toContain('model_reasoning_effort=max');
    expect(codex.args).not.toContain('--effort');
  });

  it('passes Ultra through when a Codex TUI runs Sol', () => {
    const codex = buildTuiSpawnConfig(
      { id: 'codex-tui', command: 'codex', type: 'tui', args: [] },
      'gpt-5.6-sol',
      { effort: 'ultra' },
    );
    expect(codex.args).toContain('model_reasoning_effort=ultra');
  });

  it('gives a cloud Codex swarm enough threads for its root plus every worker', () => {
    const config = buildTuiSpawnConfig(
      { id: 'codex-tui', command: 'codex', type: 'tui', args: [] },
      null,
      { maxConcurrentThreads: 7 },
    );

    expect(config.args).toContain('agents.max_concurrent_threads_per_session=7');
  });

  it('omits effort args when unset or when the TUI has no effort control', () => {
    const noEffort = buildTuiSpawnConfig({ id: 'claude-code-tui', command: 'claude', type: 'tui', args: [] }, null);
    expect(noEffort.args).not.toContain('--effort');

    // kimi's TUI takes no effort flag at all, so a pinned level emits nothing.
    const kimi = buildTuiSpawnConfig({ id: 'kimi-tui', command: 'kimi', type: 'tui', args: [] }, null, { effort: 'high' });
    expect(kimi.args.join(' ')).not.toContain('effort');
  });

  it('injects grok’s effort into the TUI — its --reasoning-effort/--effort is a root flag', () => {
    const grok = buildTuiSpawnConfig({ id: 'grok-tui', command: 'grok', type: 'tui', args: [] }, null, { effort: 'high' });
    expect(grok.args).toEqual(expect.arrayContaining(['--effort', 'high']));
    // Outside grok's ladder — clamped down rather than passed through as-is,
    // because grok rejects an unknown level outright.
    const clamped = buildTuiSpawnConfig({ id: 'grok-tui', command: 'grok', type: 'tui', args: [] }, null, { effort: 'max' });
    expect(clamped.args).toEqual(expect.arrayContaining(['--effort', 'xhigh']));
  });

  it('passes --effort through to the Antigravity TUI, clamped to its supported ladder', () => {
    const agy = buildTuiSpawnConfig({ id: 'antigravity-tui', command: 'agy', type: 'tui', args: [] }, null, { effort: 'high' });
    expect(agy.args).toEqual(['--dangerously-skip-permissions', '--effort', 'high']);

    const clamped = buildTuiSpawnConfig({ id: 'antigravity-tui', command: 'agy', type: 'tui', args: [] }, null, { effort: 'max' });
    expect(clamped.args).toEqual(['--dangerously-skip-permissions', '--effort', 'high']);
  });

  it('preserves a saved Hydrogen xhigh selection when spawning the Antigravity TUI', () => {
    const agy = buildTuiSpawnConfig({
      id: 'antigravity-tui', command: 'agy', type: 'tui', args: [],
      models: ['low', 'medium', 'high', 'xhigh'].map(level => `gemini-4-hydrogen-${level}`),
    }, 'gemini-4-hydrogen-xhigh');
    expect(agy.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-4-hydrogen', '--effort', 'xhigh']);
  });

  it('passes the per-task model through to the Antigravity TUI', () => {
    const agy = buildTuiSpawnConfig(
      { id: 'antigravity-tui', command: 'agy', type: 'tui', args: [] },
      'gemini-3.1-pro-high',
      { effort: 'low' },
    );
    // An explicitly selected effort wins over the tier baked into the model id,
    // and the id is passed as its base so agy sees exactly one effort source.
    expect(agy.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-3.1-pro', '--effort', 'low']);
  });

  it('adds lean-mode flags and the system-prompt file for an Ollama-backed claude TUI', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-ollama-tui', type: 'tui', command: 'claude', ollamaBacked: true,
      args: ['--dangerously-skip-permissions'],
    }, 'qwen3.6:35b', { systemPromptFile: '/data/cos/agents/agent-1/system-prompt.md' });
    expect(config.args).toEqual([
      '--dangerously-skip-permissions',
      '--model', 'qwen3.6:35b',
      '--bare', '--strict-mcp-config',
      '--append-system-prompt-file', '/data/cos/agents/agent-1/system-prompt.md',
    ]);
  });

  it('does NOT add lean flags to the standard claude TUI, and skips the system-prompt flag for non-claude commands', () => {
    const standard = buildTuiSpawnConfig({
      id: 'claude-code-tui', type: 'tui', command: 'claude', args: ['--dangerously-skip-permissions'],
    }, 'claude-opus-4-8', { systemPromptFile: '/tmp/sys.md' });
    expect(standard.args).not.toContain('--bare');
    // Claude command still honors an explicitly provided system-prompt file.
    expect(standard.args).toContain('--append-system-prompt-file');

    const opencode = buildTuiSpawnConfig({
      id: 'opencode-ollama-tui', type: 'tui', command: 'opencode', args: [], ollamaBacked: true,
    }, 'qwen3.6:35b', { systemPromptFile: '/tmp/sys.md' });
    expect(opencode.args).not.toContain('--append-system-prompt-file');
    expect(opencode.args).not.toContain('--bare');
  });
});

describe('spawnTuiAgent runtime', () => {
  installTuiRuntimeHooks();

  // The TUI spawn path delegates the central completion sequence
  // (completeAgent + completeAgentRun + updateTask + processAgentCompletion +
  // provider markers) to `finalizeAgent` so those concerns stay shared with
  // the runner-mode and direct-CLI paths. The tests below assert the
  // arguments handed to `finalizeAgent`, not the downstream individual
  // calls — those are covered by agentLifecycle.test.js.

  // ── GH_TOKEN pinning: the agent's own `gh pr create` must auth as the repo owner ─
  it('uses a runner-owned PTY and registers it as an attachable shell session', async () => {
    runSpawn({ useDurableRunner: true });
    await flushMicrotasks();

    expect(spawnTuiSessionViaRunner).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      taskId: 'task-1',
      command: 'codex',
      workspacePath: '/tmp/ws',
      // Per-agent sentinel: `/tmp/ws` is a SHARED workspace (its basename is not
      // the agent id), so the run watches only its own `.agent-done-agent-1`.
      doneSentinelPath: join('/tmp/ws', '.agent-done-agent-1'),
    }));
    expect(shellService.createShellSession).not.toHaveBeenCalled();
    expect(shellService.registerExternalSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ pid: 4321 }),
      expect.objectContaining({ agentId: 'agent-1', kind: 'agent-tui' }),
    );

    await sessionCallbacks.onExit({ exitCode: 1, signal: 15 });

    // The runner proxy accepts writes after its PTY died, so only removing the
    // record makes a later paste report the session gone (#11861) — and it has
    // to happen before the run is finalized, which is where a nudge is decided.
    expect(shellService.unregisterExternalSession).toHaveBeenCalledWith(SESSION_ID, { exitCode: 1 });
    expect(vi.mocked(shellService.unregisterExternalSession).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(agentLifecycle.finalizeAgent).mock.invocationCallOrder[0]);
  });

  it('passes the repo-owner-pinned GH_TOKEN into the TUI session env (buildSafeEnv would otherwise strip it)', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });
    vi.mocked(gitService.resolveForgeTokenEnv).mockResolvedValueOnce({ GH_TOKEN: 'ghp_pinned_owner_token' });

    runSpawn({ workspacePath: '/tmp/ws' });
    await flushMicrotasks();

    // Resolved against the agent's workspace and folded into the session env.
    expect(gitService.resolveForgeTokenEnv).toHaveBeenCalledWith('/tmp/ws');
    expect(shellService.createShellSession).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: 'ghp_pinned_owner_token' }) }),
    );

    // Drive the shell-exit path so the completion chain settles and no timer leaks.
    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await completeDone;
  });

  // Same reason as GH_TOKEN above, different credential: `buildSafeEnv`
  // allowlists the inherited env, so the loopback PortOS session token only
  // reaches the agent by riding this explicit delta. Without it every canned
  // `curl` in the agent's own prompt is a 401 on a password-protected install.
  it('passes the loopback PortOS API token into the TUI session env', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });
    const { resolveAgentApiEnv } = await import('./agentApiAuth.js');
    vi.mocked(resolveAgentApiEnv).mockResolvedValueOnce({ PORTOS_API_TOKEN: 'portos-session-token' });

    runSpawn({ workspacePath: '/tmp/ws' });
    await flushMicrotasks();

    expect(shellService.createShellSession).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ env: expect.objectContaining({ PORTOS_API_TOKEN: 'portos-session-token' }) }),
    );

    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await completeDone;
  });

  // #6062 — the attachable Stage 3. The PTY child must get the SAME allowlisted
  // environment its headless sibling would; a TUI Stage 3 running with the
  // server's own inherited environment would be a real regression, not a
  // cosmetic one — the whole posture assumes no forge credential is reachable.
  //
  // #6159 closed the residual that allowlist could not: the stage no longer runs
  // inside a login shell at all, so the operator's rc file never executes between
  // the allowlist and the provider.
  it('spawns an actions-posture stage as its own PTY with the allowlisted env, never inside a login shell', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });
    process.env.PORTOS_TEST_6062_SECRET = 'must-not-reach-the-review';

    runSpawn({
      provider: { id: 'claude-tui', name: 'Local Claude TUI', type: 'tui', command: 'claude', envVars: {} },
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
      tuiConfig: { command: 'claude', args: ['--permission-mode', 'plan'], spawnCommand: 'claude', spawnArgs: ['--permission-mode', 'plan'], commandLine: 'claude --permission-mode plan', promptDelayMs: 100 },
    });
    await flushMicrotasks();

    // No login shell is created at all — that is what makes an rc-file export
    // unreachable, and no env assertion on its own can prove it.
    expect(shellService.createShellSession).not.toHaveBeenCalled();
    const [command, args, opts] = vi.mocked(shellService.spawnCommandSession).mock.calls[0];
    // The PTY's process is the provider binary from the vendor recipe.
    expect(command).toBe('claude');
    expect(args).toEqual(['--permission-mode', 'plan']);
    expect(opts.env.PORTOS_TEST_6062_SECRET).toBeUndefined();
    expect(opts.env.GH_TOKEN).toBeUndefined();
    // …while the variables the stage legitimately needs survive.
    expect(opts.env.PATH).toBeTruthy();
    expect(opts.env.HOME).toBeTruthy();
    // The forge credential is never even read out of the keychain for this stage.
    expect(gitService.resolveForgeTokenEnv).not.toHaveBeenCalled();

    delete process.env.PORTOS_TEST_6062_SECRET;
    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await completeDone;
  });

  it('keeps the ordinary TUI session on the shell service\u2019s own base env', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();
    await flushMicrotasks();

    // The operator's rc file is a FEATURE for an ordinary coding agent — it is
    // where their toolchain (nvm, pyenv, PATH edits) comes from. #6159 removes
    // the hosting shell only for the restricted posture, and `env` stays a
    // DELTA that createShellSession unions onto its own base: the regression
    // this guards is flipping every agent session onto the public-review
    // allowlist, which would strip the toolchain vars a coding agent needs.
    expect(shellService.spawnCommandSession).not.toHaveBeenCalled();
    const opts = vi.mocked(shellService.createShellSession).mock.calls[0][1];
    expect(opts.initialCommand).toBe('codex');
    expect(opts.waitForPromptReady).toBe(true);

    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await completeDone;
  });

  // #6159 — the direct PTY loses both affordances the login shell supplied:
  // shell.js's readiness probe (which fired onInitialCommandSent, opening the
  // paste gate) and the shell's bracketed-paste OFF that the input-ready tracker
  // waited for. It also invalidates the "does this pid have a live child?" guard,
  // because the pid IS the CLI. If any of those were left wired for the shell
  // shape, the prompt would never be delivered — silently, on a live stage.
  it('still delivers the prompt for a direct actions-posture PTY, with no shell probe or paste-mode OFF', async () => {
    // Truthy pid AND a probe that reports no child of it — exactly the state
    // that trips `tui-exited-early` on the login-shell path.
    vi.mocked(shellService.getSessionProcess).mockReturnValue({ pid: 4242 });
    vi.mocked(execFile).mockImplementation((_file, _args, _opts, cb) => cb(null, '1\n1\n999\n'));

    runSpawn({
      provider: { id: 'claude-tui', name: 'Local Claude TUI', type: 'tui', command: 'claude', envVars: {} },
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
      tuiConfig: { command: 'claude', args: [], spawnCommand: 'claude', spawnArgs: [], commandLine: 'claude', promptDelayMs: 100 },
    });
    await flushMicrotasks();

    // The TUI owns the PTY from byte zero: its composer turns bracketed-paste ON
    // with no preceding shell OFF.
    await sessionCallbacks.onData(Buffer.from('\x1b[?2004hClaude Code v2.1.186\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    const pasteWrites = vi.mocked(shellService.writeToSession).mock.calls
      .filter(([, data]) => typeof data === 'string' && data.includes('\x1b[200~'));
    expect(pasteWrites).toHaveLength(1);

    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
  });

  it('refuses to route a public-content stage through the shared CoS runner', async () => {
    // The runner builds its own child env from ITS ambient environment
    // (`/spawn-tui` → `buildCliChildEnv` with no profile), so a restricted stage
    // routed through it would silently lose the allowlist. `agentLifecycle`
    // forces every such stage direct-only; this keeps that true by construction.
    const spawned = runSpawn({
      provider: { id: 'claude-tui', name: 'Local Claude TUI', type: 'tui', command: 'claude', envVars: {} },
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
      useDurableRunner: true,
    });
    await flushMicrotasks();

    expect(spawnTuiSessionViaRunner).not.toHaveBeenCalled();
    expect(shellService.createShellSession).not.toHaveBeenCalled();
    expect(shellService.spawnCommandSession).not.toHaveBeenCalled();
    await expect(spawned).resolves.toBeNull();
  });

  it('makes the login shell exit with the TUI command instead of lingering after it exits', async () => {
    runSpawn();
    await flushMicrotasks();

    // The raw command plus the flag — the run-then-exit wrapper is rendered by
    // shell.js, which is the only place that knows the session's shell dialect.
    // Its rendering is covered by shell.test.js and lib/shellExit.test.js.
    expect(shellService.createShellSession).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ initialCommand: 'codex', exitWithCommand: true }),
    );
  });

  it('skips the owner-token probe when the provider supplies its own GITHUB_TOKEN so the explicit credential wins', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ provider: { id: 'codex-tui', name: 'Codex TUI', type: 'tui', envVars: { GITHUB_TOKEN: 'ghp_provider_bot' } } });
    await flushMicrotasks();

    // gh prefers GH_TOKEN over GITHUB_TOKEN, so injecting an owner GH_TOKEN would
    // shadow the provider's bot credential — the probe must be skipped entirely.
    expect(gitService.resolveForgeTokenEnv).not.toHaveBeenCalled();
    const env = vi.mocked(shellService.createShellSession).mock.calls[0][1].env;
    expect(env.GITHUB_TOKEN).toBe('ghp_provider_bot');
    expect(env.GH_TOKEN).toBeUndefined();

    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await completeDone;
  });

  it('hands a slashdo-free TUI to the dispatch as owning its PR with nothing verified (#3733)', async () => {
    const task = {
      id: 'task-1',
      description: 'do the thing',
      metadata: { openPR: true, prCompletion: 'review-then-merge', reviewers: ['codex'] },
    };
    const spawnPromise = runSpawn({
      provider: { id: 'codex-tui', name: 'Codex TUI', type: 'tui', command: 'codex', envVars: {} },
      task,
    });
    await flushMicrotasks();

    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await spawnPromise;

    // The codex TUI drives its own push → PR → review → merge but cannot type
    // `/do:pr`, so finalize verified no claim — the dispatch maps that to a
    // forge-checked `if-missing` backstop (pinned in agentCompletionCleanup.test.js).
    expect(runSpawnerCompletionCleanup).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      task,
      success: true,
      prOwnership: { taskOpenPR: true, prOpenedBy: 'agent-inline', agentOpensOwnPr: true, prClaimExpected: false },
      prClaimVerified: false,
    }));
    // …and finalize was told not to verify a claim this session cannot make —
    // failing it there would pre-empt the backstop cleanup is about to run.
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({ prExpected: false }));
  });

  it('a lean --bare TUI still hands its PR to PortOS outright', async () => {
    const spawnPromise = runSpawn({
      provider: { id: 'claude-ollama-tui', name: 'Lean Claude TUI', type: 'tui', command: 'claude', ollamaBacked: true, envVars: {} },
      leanMode: true,
      task: {
        id: 'task-1',
        description: 'do the thing',
        metadata: { openPR: true, prCompletion: 'review-then-merge' },
      },
    });
    await flushMicrotasks();

    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await spawnPromise;

    // Neither predicate holds for a `--bare` session, so the dispatch opens the
    // PR itself (`always`) and may auto-merge the branch.
    expect(runSpawnerCompletionCleanup).toHaveBeenCalledWith(expect.objectContaining({
      prOwnership: { taskOpenPR: true, prOpenedBy: 'portos', agentOpensOwnPr: false, prClaimExpected: false },
    }));
  });

  it('prepares the Ollama context window only for Ollama-backed providers', async () => {
    const spawnPromise = runSpawn({
      provider: { id: 'claude-ollama-tui', name: 'Lean Claude TUI', type: 'tui', command: 'claude', ollamaBacked: true, envVars: {} },
    });
    await flushMicrotasks();
    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await spawnPromise;
    expect(ensureOllamaAgentContext).toHaveBeenCalledTimes(1);

    vi.mocked(ensureOllamaAgentContext).mockClear();
    const cloudSpawn = runSpawn();
    await flushMicrotasks();
    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await cloudSpawn;
    expect(ensureOllamaAgentContext).not.toHaveBeenCalled();
  });

  // #17341: the run holds an in-flight registration for as long as its harness
  // can talk to the daemon, so a later spawn's context reload defers instead of
  // restarting Ollama under it.
  describe('in-flight Ollama registration', () => {
    const ollamaProvider = { id: 'claude-ollama-tui', name: 'Claude Ollama TUI', type: 'tui', command: 'claude', ollamaBacked: true, envVars: {} };

    it('registers after the context is prepared and releases once the session exits', async () => {
      const release = vi.fn();
      vi.mocked(beginOllamaAgentWork).mockResolvedValueOnce(release);
      const spawnPromise = runSpawn({ provider: ollamaProvider });
      await flushMicrotasks();

      expect(beginOllamaAgentWork).toHaveBeenCalledWith(ollamaProvider);
      expect(vi.mocked(ensureOllamaAgentContext).mock.invocationCallOrder.at(-1))
        .toBeLessThan(vi.mocked(beginOllamaAgentWork).mock.invocationCallOrder.at(-1));
      expect(release).not.toHaveBeenCalled();

      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await spawnPromise;
      expect(release).toHaveBeenCalled();
    });

    it('releases when the session fails to start', async () => {
      const release = vi.fn();
      vi.mocked(beginOllamaAgentWork).mockResolvedValueOnce(release);
      vi.mocked(shellService.createShellSession).mockImplementationOnce(() => {
        throw new Error('posix_spawnp failed');
      });

      await expect(runSpawn({ provider: ollamaProvider })).resolves.toBeNull();
      expect(release).toHaveBeenCalled();
    });

    it('finalizes a failed registration as a failed start', async () => {
      vi.mocked(beginOllamaAgentWork).mockRejectedValueOnce(new Error('registry unavailable'));
      await expect(runSpawn({ provider: ollamaProvider })).resolves.toBeNull();
      expect(shellService.createShellSession).not.toHaveBeenCalled();
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        completionReason: 'spawn-error',
        error: 'Failed to start TUI session: registry unavailable',
      }));
    });

    it('does not register a cloud-provider run', async () => {
      const spawnPromise = runSpawn();
      await flushMicrotasks();
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await spawnPromise;
      expect(beginOllamaAgentWork).not.toHaveBeenCalled();
    });
  });

  it('does not double-fire a PR owned by a slashdo-capable Claude TUI', async () => {
    // finalize asked the forge and got an answer for a real branch — the only
    // shape that lets cleanup skip its own query (see `prClaimWasVerified`).
    vi.mocked(agentLifecycle.finalizeAgent).mockResolvedValueOnce({
      success: true,
      prClaimVerified: true,
      branchProvenEmpty: false,
      cleanupEvidence: { ok: true, branch: 'cos/task-1/agent-1' },
    });
    const spawnPromise = runSpawn({
      provider: { id: 'claude-code-tui', name: 'Claude TUI', type: 'tui', command: 'claude', envVars: {} },
      task: {
        id: 'task-1',
        description: 'do the thing',
        metadata: { openPR: true, prCompletion: 'review-then-merge' },
      },
    });
    await flushMicrotasks();

    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await spawnPromise;

    // finalize ran `verifyPrClaim` for a slashdo-capable session and the verdict
    // reaches the dispatch as verified, so it never queries the forge again.
    expect(runSpawnerCompletionCleanup).toHaveBeenCalledWith(expect.objectContaining({
      prOwnership: { taskOpenPR: true, prOpenedBy: 'agent-slashdo', agentOpensOwnPr: true, prClaimExpected: true },
      prClaimVerified: true,
    }));
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({ prExpected: true }));
  });

  // The dispatch releases the retry hold with this verdict (#3368 — its ordering
  // after worktree cleanup is pinned in agentCompletionCleanup.test.js). What
  // this pins is that finish() hands it the REAL verdict: a hardcoded value
  // would stamp resume pointers on every completed run, or on none.
  it('hands the dispatch the run verdict — failure on a non-zero exit, success on a clean one', async () => {
    const task = { id: 'task-1', description: 'do the thing', metadata: {} };
    const failed = runSpawn({ task });
    await flushMicrotasks();
    await sessionCallbacks.onExit({ exitCode: 1, killed: false });
    await failed;
    expect(runSpawnerCompletionCleanup).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1', task, success: false }));

    vi.mocked(runSpawnerCompletionCleanup).mockClear();
    const clean = runSpawn();
    await flushMicrotasks();
    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await clean;
    expect(runSpawnerCompletionCleanup).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('keeps the reservation after physical exit until completion cleanup finishes', async () => {
    const cleanupStarted = Promise.withResolvers();
    const cleanup = Promise.withResolvers();
    vi.mocked(runSpawnerCompletionCleanup).mockImplementationOnce(() => {
      cleanupStarted.resolve();
      return cleanup.promise;
    });
    const spawnPromise = runSpawn();
    await flushMicrotasks();

    const exited = sessionCallbacks.onExit({ exitCode: 0, killed: false });
    try {
      await cleanupStarted.promise;
      expect(maintenance.finishResource).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      await exited;
      await spawnPromise;
    }
    expect(maintenance.finishResource).toHaveBeenCalledExactlyOnceWith('agent', 'agent-1');
  });

  it('keeps the reservation after synthetic exit cleanup until the PTY physically exits', async () => {
    const spawnPromise = runSpawn({ useDurableRunner: true });
    await flushMicrotasks();
    const { ptyProcess } = await vi.mocked(spawnTuiSessionViaRunner).mock.results[0].value;
    const [[physicalExit]] = vi.mocked(ptyProcess.onExit).mock.calls;

    await sessionCallbacks.onExit({ exitCode: 0, killed: true });
    await spawnPromise;
    expect(runSpawnerCompletionCleanup).toHaveBeenCalledOnce();
    expect(maintenance.finishResource).not.toHaveBeenCalled();

    physicalExit();
    expect(maintenance.finishResource).toHaveBeenCalledExactlyOnceWith('agent', 'agent-1');
  });

  // ── CoS agents stay alive while provider output is silent ────────────────────
  it('does not finalize a CoS TUI merely because provider output goes silent', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    const spawnPromise = runSpawn();
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from('Codex booting...\\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('do the thing\\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    // The agent has submitted its prompt. No output follows for substantially
    // longer than the old idle window, but the run must remain attached.
    await vi.advanceTimersByTimeAsync(60000);
    await flushMicrotasks();
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await spawnPromise;
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: true,
        completionReason: 'shell-exit',
      })
    );
  });

  // ── No wall-clock stop ─────────────────────────────────────────────────────
  // A provider can legitimately spend more than a day on one task. Advancing
  // well past the old three-hour ceiling must not send a wrap-up prompt or
  // finalize the agent; completion remains sentinel-, exit-, or failure-driven.
  it('keeps a submitted OpenCode agent attached beyond 24 hours', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    const spawnPromise = runSpawn({
      provider: { ...defaultProvider, id: 'opencode-tui', name: 'OpenCode TUI' },
      tuiConfig: { ...defaultTuiConfig, command: 'opencode', spawnCommand: 'opencode', commandLine: 'opencode' },
    });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('\x1b[?2004l\x1b[?2004hAsk anything…\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();
    // It works for a while before going quiet: a run that never started is
    // failed instead (#12769), and this one is about the lack of a ceiling.
    await vi.advanceTimersByTimeAsync(PROMPT_WORK_EVIDENCE_MS);
    await sessionCallbacks.onData(Buffer.from('Reading the repository…\n'));
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await flushMicrotasks();

    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
    expect(shellService.pasteToSession).not.toHaveBeenCalledWith(
      SESSION_ID,
      expect.anything(),
      { label: '[cosAgents] max-runtime wrap-up' },
    );

    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await spawnPromise;
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: true,
        completionReason: 'shell-exit',
      })
    );
  });

  // ── 1b. Command exited before the prompt → don't paste into the bare shell ───
  // The TUI command (claude/codex/…) runs as a CHILD of the persistent PTY
  // shell, so if it exits at startup the PTY stays open and onExit never fires.
  // The ready-gate would then paste the bracketed-paste prompt into the returned
  // shell prompt — the wedged `^[[200~ …` session. The liveness probe must catch
  // "shell has no live child", skip the paste, and finalize failure with the
  // command's captured output.
  it('tui-exited-early: skips the paste and finalizes failure when the command exited before the prompt', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    // Truthy pid so the probe runs; ps reports NO process whose ppid is 4242.
    vi.mocked(shellService.getSessionProcess).mockReturnValue({ pid: 4242 });
    vi.mocked(execFile).mockImplementation((_file, _args, _opts, cb) => cb(null, '1\n1\n999\n'));
    // raw.txt tail surfaced in the error.
    vi.mocked(readFile).mockResolvedValue('Error: claude exited at startup\n');

    const _spawnPromise = runSpawn();
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from('booting...\n' + CODEX_COMPOSER));
    await flushMicrotasks();

    // Open the ready-gate (promptDelay floor + idle threshold) so sendPrompt fires.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    vi.useRealTimers();
    await completeDone;

    // The bracketed-paste prompt must NOT have been written.
    const pasteWrites = vi.mocked(shellService.writeToSession).mock.calls
      .filter(([, data]) => typeof data === 'string' && data.includes('\x1b[200~'));
    expect(pasteWrites).toHaveLength(0);

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        completionReason: 'tui-exited-early',
      })
    );
  });

  it('claude input-ready: does NOT paste on the startup banner, only once paste mode is re-enabled', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();

    // Startup banner (and the shell turning paste mode OFF to run the command).
    await sessionCallbacks.onData(Buffer.from(`${PASTE_OFF}Claude Code v2.1.186\nOpus 4.8 (1M context) with high effort\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0); // banner / paste-mode-off is not "input ready"

    // claude re-enables bracketed-paste mode → input box live, safe to paste.
    await sessionCallbacks.onData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('claude input-ready: holds the paste while paste mode is OFF (so the paste ESC cannot cancel the input)', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();

    // Command launched, paste mode OFF — pasting now would send a bare ESC that
    // cancels claude's input. Gate must NOT paste.
    await sessionCallbacks.onData(Buffer.from(PASTE_OFF));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0);

    await sessionCallbacks.onData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  // Regression (#3202 durable runner): the runner pty.spawns claude DIRECTLY —
  // no launch shell — so the shell's paste-mode OFF never appears in the
  // stream. The tracker must treat claude's own first ON as ready; before the
  // fix every runner-tui claude agent died `tui-not-ready` at the 45s deadline
  // with a live input box on screen (agent-ade9a664 / agent-29ca86ef).
  it('claude input-ready (runner mode): pastes on claude\'s own paste-mode ON with no shell OFF ever seen', async () => {
    // Runner mode must also SKIP the shell-child liveness probe: the TUI is the
    // PTY process itself (no launch shell), so a ps listing where the pid has no
    // children does not mean the TUI exited. Make ps return no child of pid 4321
    // to prove the probe can't veto the paste.
    vi.mocked(execFile).mockImplementation((_file, _args, _opts, cb) => cb(null, '1\n1\n999\n'));
    runSpawn({ tuiConfig: claudeTuiConfig, useDurableRunner: true });
    await flushMicrotasks();

    // Startup banner only — no bracketed-paste OFF precedes it in runner mode.
    await sessionCallbacks.onData(Buffer.from('Claude Code v2.1.220\nOpus 5 with high effort\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0); // banner alone is still not "input ready"

    await sessionCallbacks.onData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('claude trust gate: auto-confirms the folder-trust prompt with Enter, then pastes once ready', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from(`${PASTE_OFF}Is this a project you trust?\n  1. Yes, I trust this folder\n  2. No, exit\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();

    // A bare Enter was sent to confirm the default ("Yes, I trust").
    const enters = vi.mocked(shellService.writeToSession).mock.calls.filter(([, d]) => d === '\r');
    expect(enters.length).toBeGreaterThanOrEqual(1);

    // After trust is accepted claude's input box comes up (paste mode ON) → paste.
    await sessionCallbacks.onData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('Cursor workspace trust: selects the keyed choice before delivering the task', async () => {
    runSpawn({ tuiConfig: { command: 'cursor-agent', args: ['--force'], spawnCommand: 'cursor-agent', spawnArgs: ['--force'], commandLine: 'cursor-agent --force', promptDelayMs: 100 } });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from(`${PASTE_OFF}Do you trust the contents of this directory?\n/workspace/example\n▶ [a] Trust this workspace\n[q] Quit\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();
    expect(vi.mocked(shellService.writeToSession).mock.calls.map(([, data]) => data)).toContain('a\r');
    expect(pasteCount()).toBe(0);
    await sessionCallbacks.onData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('claude trust gate: moves from a highlighted No choice before confirming', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig, useDurableRunner: true });
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from(
      'Quick safety check: Is this a project you created or one you trust?\n'
      + '❯ No, exit\n'
      + '  Yes, I trust this folder\n'
      + 'Enter to confirm · Esc to cancel\n',
    ));
    const writes = () => vi.mocked(shellService.writeToSession).mock.calls.map(([, data]) => data);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();
    // The arrow goes out alone once the dialog settles; Enter waits for proof it landed.
    expect(writes()).toEqual(['\x1b[B']);

    // Replay of agent-8a2fe161's transcript: the move paints, then Claude's
    // selector resets to "No, exit". Enter here would exit claude, so PortOS
    // re-navigates instead of submitting.
    await sessionCallbacks.onData(Buffer.from('  No, exit\n❯ Yes, I trust this folder\n'));
    await sessionCallbacks.onData(Buffer.from('❯ No, exit\n  Yes, I trust this folder\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();
    expect(writes()).toEqual(['\x1b[B', '\x1b[B']);

    await sessionCallbacks.onData(Buffer.from('  No, exit\n❯ Yes, I trust this folder\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();
    expect(writes()).toEqual(['\x1b[B', '\x1b[B', '\r']);
    expect(pasteCount()).toBe(0);

    // The composer comes up only after trust is accepted → now the paste lands.
    await sessionCallbacks.onData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  // Claude Code v2.1.233's auto-mode offer. The trust gate above paints BEFORE
  // the composer; this one paints after, with paste mode already on — so the old
  // gate said "ready" and the prompt went into a modal that ignored it. All four
  // claude-code-tui agents on 2026-08-14 died `paste-not-rendered` this way.
  it('claude auto-mode offer: declines it and pastes only after it is cleared', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();

    // Composer comes up live — under the old gate this alone would paste.
    await sessionCallbacks.onData(Buffer.from(`${PASTE_OFF}${PASTE_ON}`));
    await flushMicrotasks();

    // ...then the modal paints over it, before the prompt delay elapses.
    await sessionCallbacks.onData(Buffer.from(
      'Make auto mode your default permission mode?\n'
      + '   ❯ 1. Yes, set auto mode as my default permission mode\n'
      + "     2. No, keep don't ask\n"
    ));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();

    // Down+Enter selects option 2. A BARE Enter would accept the highlighted
    // option 1 and rewrite the user's global permission default — assert we did
    // not do that.
    const writes = vi.mocked(shellService.writeToSession).mock.calls.map(([, d]) => d);
    expect(writes).toContain('\x1b[B\r');
    expect(writes).not.toContain('\r');

    // Only once the dialog is answered does the prompt go out — and exactly once.
    await vi.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('claude external-imports offer: disables parent imports before pasting the prompt', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from(
      `${PASTE_OFF}This project's CLAUDE` + '.md imports files outside the current working directory.\n'
      + 'Never allow this for third-party repositories.\n'
      + 'External imports:\n'
      + '  /workspace-parent/AGENTS.md\n'
      + '❯ 1. Yes, allow external imports\n'
      + '2. No, disable external imports\n',
    ));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();

    // Down+Enter takes the conservative option 2. A bare Enter would import
    // instructions from PortOS's parent workspace into the managed app.
    const writes = vi.mocked(shellService.writeToSession).mock.calls.map(([, data]) => data);
    expect(writes).toContain('\x1b[B\r');
    expect(writes).not.toContain('\r');
    expect(pasteCount()).toBe(0);

    await sessionCallbacks.onData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('waits through OpenCode terminal negotiation and skips its update modal before submitting once', async () => {
    const spawnPromise = runSpawn({
      provider: { ...defaultProvider, id: 'opencode-tui', name: 'OpenCode TUI' },
      tuiConfig: { ...defaultTuiConfig, command: '/opt/bin/opencode', spawnCommand: 'opencode', commandLine: 'opencode' },
    });
    await flushMicrotasks();
    // A quiet terminal-capability query used to trigger the idle paste, then
    // exhaust every retry before the composer and update offer even appeared.
    await sessionCallbacks.onData(Buffer.from('\x1bP+q4d73\x1b\\'));
    await vi.advanceTimersByTimeAsync(15000);
    expect(pasteCount()).toBe(0);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

    await sessionCallbacks.onData(Buffer.from('\x1b[?2004l\x1b[?2004hAsk anything…\n'));
    await vi.advanceTimersByTimeAsync(600);
    expect(pasteCount()).toBe(0);
    await sessionCallbacks.onData(Buffer.from('Update\x1b[8;29H Available esc\nA new release v9.9.9 is avail'));
    // The composer border is painted between the two wrapped message rows.
    await sessionCallbacks.onData(Buffer.from('able. Would you like to\x1b[12;4H┃\n'));
    await sessionCallbacks.onData(Buffer.from('        update now?\n┃ Ask\n┃ Buil     Skip Confirm\n'));
    await vi.advanceTimersByTimeAsync(400);
    expect(vi.mocked(shellService.writeToSession).mock.calls.map(([, data]) => data)).toEqual(['\x1b']);
    expect(pasteCount()).toBe(0);
    // Even beyond the old blind-paste deadline, require fresh output after Esc.
    await vi.advanceTimersByTimeAsync(2000);
    expect(pasteCount()).toBe(0);
    await sessionCallbacks.onData(Buffer.from('Ask anything…\n'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(pasteCount()).toBe(1);
    await sessionCallbacks.onData(Buffer.from('[Pasted ~42 lines]'));
    await vi.advanceTimersByTimeAsync(8000);
    expect(vi.mocked(shellService.writeToSession).mock.calls.map(([, data]) => data)).toContain('\r');
    expect(pasteCount()).toBe(1);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await spawnPromise;
  });

  it('fails OpenCode startup on a rejected model without pasting into its replacement composer', async () => {
    const spawnPromise = runSpawn({
      provider: { ...defaultProvider, id: 'opencode-tui', name: 'OpenCode TUI' },
      tuiConfig: { ...defaultTuiConfig, command: '/opt/bin/opencode', spawnCommand: 'opencode', commandLine: 'opencode' },
    });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('\x1b[?2004l\x1b[?2004hModel example-provider/exam'));
    await sessionCallbacks.onData(Buffer.from('ple-model\n┃ is not valid\nreplacement-provider/replacement-model\nAsk anything…\n'));
    await vi.advanceTimersByTimeAsync(8000);
    expect(pasteCount()).toBe(0);
    await spawnPromise;
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      completionReason: 'opencode-model-rejected',
      errorAnalysis: expect.objectContaining({ category: 'model-not-found', affectedModel: 'example-provider/example-model' }),
    }));
  });

  it('codex hook-review offer: continues without trusting hooks before pasting the prompt', async () => {
    runSpawn();
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from(
      'Hooks need review\n'
      + '1 hook is new or changed.\n'
      + '› 1. Review hooks\n'
      + '2. Trust all and continue\n'
      + "3. Continue without trusting (hooks won't run)\n",
    ));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();

    // Two down-arrows select option 3, preserving the sandbox boundary.
    expect(vi.mocked(shellService.writeToSession).mock.calls.map(([, data]) => data))
      .toContain('\x1b[B\x1b[B\r');
    expect(pasteCount()).toBe(0);

    // The selector clears and Codex repaints its composer; only then can the
    // ordinary Codex readiness path paste the task.
    await sessionCallbacks.onData(Buffer.from(CODEX_COMPOSER));
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  // Regression (agent-671af38f, 2026-08-21): codex takes the idle/deadline path,
  // and its first-run directory-trust dialog paints and then goes SILENT — which
  // that path read as "ready". The task went into the menu, all three paste
  // retries with it, and the run died `paste-not-rendered`. Creative-director
  // tasks run in a fresh per-agent temp cwd, so codex asked on every single run.
  it('codex folder-trust gate: confirms it before the idle heuristic can paste', async () => {
    runSpawn();
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from(
      'You are in /tmp/portos-cd-cwd/agent-1\n'
      + 'Do you trust the contents of this directory? Working with untrusted contents comes with'
      + ' higher risk of prompt injection.\n'
      + '› 1. Yes, continue\n'
      + '2. No, quit\n'
      + 'Press enter to continue\n',
    ));
    await flushMicrotasks();
    // Past the 1200ms idle threshold — the window in which the prompt used to go
    // into the dialog.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // A bare Enter takes the highlighted "1. Yes, continue" — sent ONCE, not on
    // every poll tick — and nothing pasted.
    expect(vi.mocked(shellService.writeToSession).mock.calls.filter(([, d]) => d === '\r').length).toBe(1);
    expect(pasteCount()).toBe(0);

    // Trust accepted → codex paints its composer → the ordinary idle path pastes.
    await sessionCallbacks.onData(Buffer.from(CODEX_COMPOSER));
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('codex folder access: waits for a split Trust and continue choice before answering once', async () => {
    runSpawn();
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from(
      `${PASTE_OFF}Folder access\n/workspace/example\nTrustthisfolder?\n`
      + 'Codexcanread,edit,andrunfileshere,subjecttoyourpermissionsettings.\n'
      + '› 1. Trust and cont',
    ));
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(vi.mocked(shellService.writeToSession).mock.calls.some(([, data]) => data === '\r')).toBe(false);
    expect(pasteCount()).toBe(0);

    await sessionCallbacks.onData(Buffer.from('inue\n2.Quit\nenter continue · esc quit\n'));
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(vi.mocked(shellService.writeToSession).mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1);
    expect(pasteCount()).toBe(0);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

    await sessionCallbacks.onData(Buffer.from(CODEX_COMPOSER));
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('tui-not-ready: claude that never shows an input prompt finalizes failure without pasting', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('some startup noise but no input box ever appears\n'));
    await flushMicrotasks();

    // Advance past TUI_INPUT_READY_DEADLINE_MS (45s).
    await vi.advanceTimersByTimeAsync(46000);
    vi.useRealTimers();
    await completeDone;

    expect(pasteCount()).toBe(0);
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'tui-not-ready' })
    );
  });

  it('agy input-ready: does NOT paste until the composer footer follows paste-mode-on', async () => {
    runSpawn({ tuiConfig: agyTuiConfig });
    await flushMicrotasks();

    // Startup banner (and the shell turning paste mode OFF to run the command).
    await sessionCallbacks.onData(Buffer.from(`${PASTE_OFF}Antigravity CLI 1.1.3\nGemini 3.5 Flash (Medium)\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0); // banner / paste-mode-off is not "input ready"

    // agy enables bracketed paste when it enters the alt screen — still signing
    // in, no composer yet. Paste mode ALONE must not be treated as ready.
    await sessionCallbacks.onData(Buffer.from(`${PASTE_ON}Welcome to the Antigravity CLI.\n Signing in...\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0);

    // Composer renders → input box live, safe to paste.
    await sessionCallbacks.onData(Buffer.from(`>\n${AGY_COMPOSER_FOOTER}Gemini 3.5 Flash · medium`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  // Regression: the real `paste-not-rendered` failure. agy turned bracketed paste
  // ON at alt-screen entry (~200ms in) and then spent longer than promptDelayMs
  // signing in, so the old paste-mode-only gate fired while the folder-trust menu
  // was still pending — `needsTrust` was still false, the trust auto-confirm never
  // ran, and the menu swallowed the prompt plus all three paste retries.
  it('agy trust gate: paste mode turns on BEFORE the trust menu — waits for trust confirm, then the composer', async () => {
    runSpawn({ tuiConfig: agyTuiConfig });
    await flushMicrotasks();

    // Alt-screen entry enables paste mode while agy is still signing in.
    await sessionCallbacks.onData(Buffer.from(`${PASTE_OFF}${PASTE_ON}Welcome to the Antigravity CLI. You are currently not signed in.\n Signing in...\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0); // would have pasted into the void before the fix

    // Trust gate finally paints (after the sign-in round trip).
    await sessionCallbacks.onData(Buffer.from('Do you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here.\n> Yes, I trust this folder\n  No, exit\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();

    // Auto-confirmed with a bare Enter, and still no paste.
    expect(vi.mocked(shellService.writeToSession).mock.calls.filter(([, d]) => d === '\r').length)
      .toBeGreaterThanOrEqual(1);
    expect(pasteCount()).toBe(0);

    // Composer comes up only after trust is accepted → now the paste lands.
    await sessionCallbacks.onData(Buffer.from(`>\n${AGY_COMPOSER_FOOTER}Gemini 3.5 Flash · medium`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('agy tui-not-ready: an agy TUI that never signals input-ready fails fast instead of blind-pasting', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: agyTuiConfig });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('some agy startup noise but no input box ever appears\n'));
    await flushMicrotasks();

    // Advance past TUI_INPUT_READY_DEADLINE_MS (45s).
    await vi.advanceTimersByTimeAsync(46000);
    vi.useRealTimers();
    await completeDone;

    expect(pasteCount()).toBe(0);
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'tui-not-ready' })
    );
  });

  // ── Unsubmitted prompt: the paste chip rendered, every submit Enter was lost ──
  // #12769: claim runs sat at `❯ [Pasted text #1 +N lines]` indefinitely. As
  // possible claim owners they held every claim checkout in their repository.
  const driveToUnsubmittedChip = async () => {
    runSpawn({ prompt: 'claim the issue and ship a PR' });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('>_ OpenAI Codex\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
    await sessionCallbacks.onData(Buffer.from('> [Pasted Content 29448 chars]\n'));
    await flushMicrotasks();
    // The paste confirms and every submit Enter goes out; the TUI ignores them.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
  };

  const enterCount = () => vi.mocked(shellService.writeToSession).mock.calls
    .filter(([id, data]) => id === SESSION_ID && data === '\r').length;

  it('presses Enter again on a prompt left unsubmitted in the composer, without re-pasting', async () => {
    await driveToUnsubmittedChip();
    const submitted = enterCount();
    expect(submitted).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(UNSUBMITTED_PROMPT_SETTLE_MS - 5000);
    await flushMicrotasks();
    expect(enterCount()).toBe(submitted);

    await vi.advanceTimersByTimeAsync(5000 + SIGNAL_POLL_MS);
    await flushMicrotasks();
    expect(enterCount()).toBe(submitted + 1);
    expect(pasteCount()).toBe(1);
    expect(shellService.pasteToSession).not.toHaveBeenCalled();

    // That Enter started the turn: a working session is left alone.
    for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += 1000) {
      await sessionCallbacks.onData(Buffer.from('• Working (12s • esc to interrupt)\n'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await flushMicrotasks();
    expect(enterCount()).toBe(submitted + 1);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  it('fails a run that never started after the full nudge budget, so the task retries', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });
    await driveToUnsubmittedChip();
    const submitted = enterCount();

    await vi.advanceTimersByTimeAsync(STALL_NUDGE_IDLE_MS * (STALL_NUDGE_MAX_ATTEMPTS + 2));
    await flushMicrotasks();
    // A bounded number of bare Enters, then the stall nudges, then the verdict.
    expect(enterCount()).toBe(submitted + UNSUBMITTED_PROMPT_ENTER_MAX_ATTEMPTS);
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(STALL_NUDGE_MAX_ATTEMPTS);
    vi.useRealTimers();
    await completeDone;
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'prompt-not-submitted' }),
    );
    expect(cosAgentLifecycle.updateAgent).not.toHaveBeenCalledWith('agent-1', { metadata: { phase: 'stalled' } });
  });

  // ── 1b. Submit-Enter retries ─────────────────────────────────────────────────
  // A single `\r` after a large bracketed paste can be swallowed mid-paste-
  // commit, stranding the prompt unsent (the "I had to hit Enter myself" bug,
  // which was then falsely marked success by the old fallback). The submit path must
  // fire the Enter SUBMIT_ENTER_ATTEMPTS times, spaced apart, so one lands after
  // the paste settles. Asserts the bracketed paste is written once and `\r` is
  // written exactly SUBMIT_ENTER_ATTEMPTS times.
  it('submit-enter: writes the bracketed paste once and retries the submit Enter SUBMIT_ENTER_ATTEMPTS times', async () => {

    runSpawn({ prompt: 'paste me into the box' });
    await flushMicrotasks();

    // Banner output so firstOutputAt is set, then advance past the prompt-delay
    // floor + readiness idle threshold so the ready poll fires the paste.
    await sessionCallbacks.onData(Buffer.from('Codex booting...\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    const writes = () => vi.mocked(shellService.writeToSession).mock.calls
      .filter(([id]) => id === SESSION_ID);
    const pasteWrites = () => writes().filter(([, data]) => data.startsWith('\x1b[200~'));
    const enterWrites = () => writes().filter(([, data]) => data === '\r');

    // Paste is written exactly once; no Enter has been sent yet (we never
    // emit the [Pasted text] marker, so the 3500ms fallback drives submit).
    expect(pasteWrites()).toHaveLength(1);
    expect(enterWrites()).toHaveLength(0);

    // Emit the prompt echo so paste verification passes (issue #2192).
    // In a real TUI, the paste is echoed in the input buffer.
    await sessionCallbacks.onData(Buffer.from('ste me into the box\n'));
    await flushMicrotasks();

    // Advance past the fallback window AND the full spread of retry spacing
    // intervals. Once the budget is exhausted the interval stops re-sending
    // (Enter into an empty box would be a no-op anyway).
    await vi.advanceTimersByTimeAsync(
      PASTE_TO_ENTER_FALLBACK_MS + SUBMIT_ENTER_SPACING_MS * (SUBMIT_ENTER_ATTEMPTS + 3)
    );
    await flushMicrotasks();

    // Exactly SUBMIT_ENTER_ATTEMPTS Enters, and the paste was never re-sent.
    expect(enterWrites()).toHaveLength(SUBMIT_ENTER_ATTEMPTS);
    expect(pasteWrites()).toHaveLength(1);
  });

  it('Grok collapsed paste: submits its size chip once without retrying the hidden prompt', async () => {
    // agent-5ffe35b5 rendered this chip, but its truncated preview could not
    // satisfy prefix verification. Retrying expanded/duplicated the input.
    runSpawn({
      provider: { id: 'grok-tui', name: 'Grok TUI', type: 'tui', envVars: {} },
      tuiConfig: { ...defaultTuiConfig, command: 'grok', spawnCommand: 'grok', commandLine: 'grok' },
      prompt: 'A long UX audit prompt whose full prefix is hidden by the collapsed preview.',
    });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('Grok Build 1.0.25 [stable]'));
    await vi.advanceTimersByTimeAsync(2000);
    const writes = () => vi.mocked(shellService.writeToSession).mock.calls
      .filter(([id]) => id === SESSION_ID);
    expect(pasteCount()).toBe(1);
    expect(writes().filter(([, data]) => data === '\r')).toHaveLength(0);

    // ANSI styling and PTY chunk boundaries match the real size chip.
    await sessionCallbacks.onData(Buffer.from('\x1b[38;2;65;65;65m[\x1b[38;2;200;200;200mPasted: 31'));
    await sessionCallbacks.onData(Buffer.from(' KB\x1b[38;2;65;65;65m] Enter:send'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes().some(([, data]) => data === '\r')).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(pasteCount()).toBe(1);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  // ── 1c2. The readiness probe's own echo must not seed the startup-idle clock ──
  // shell.js's waitForPromptReady round-trips a shell-level probe (posix printf /
  // PowerShell Write-Output) BEFORE injecting the real CLI command, and fires
  // onInitialCommandSent only once that command is actually typed in. If PTY
  // output that arrives before onInitialCommandSent counted toward
  // lastOutputAt/firstOutputAt, a quiet gap after the probe's own echo — e.g.
  // PowerShell's heavier startup, which is slower than bash — would satisfy the
  // idle-based "ready" check and paste the prompt into a still-loading CLI (codex
  // review [P1] on the dialect-aware probe, #4638).
  it('idle-detection: pre-injection PTY output does not satisfy startup-idle readiness', async () => {
    let sendInitialCommand = null;
    vi.mocked(shellService.createShellSession).mockImplementation((_socket, opts) => {
      sessionCallbacks.onData = opts.onData;
      sessionCallbacks.onExit = opts.onExit;
      // Do NOT fire onInitialCommandSent yet — mirrors the real shell.js
      // waitForPromptReady gap between the probe round-trip and command
      // injection, unlike the suite's default mock (which fires it immediately).
      sendInitialCommand = () => opts.onInitialCommandSent?.();
      return SESSION_ID;
    });

    runSpawn({ prompt: 'evaluate our animation prompts and generate drafts' });
    await flushMicrotasks();

    // Shell-level probe echo/noise arrives BEFORE the real command is injected.
    await sessionCallbacks.onData(Buffer.from("bash-5.2$ printf '%s\\n' 'PORTOSRDY''abc123'\nPORTOSRDYabc123\n"));
    await flushMicrotasks();

    // Advance well past promptDelayMs + the idle threshold. Pre-fix, this probe
    // echo would have seeded firstOutputAt/lastOutputAt and the idle poll would
    // have fired the paste here — before the CLI command was ever typed in.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    const pasteWrites = () => vi.mocked(shellService.writeToSession).mock.calls
      .filter(([id, data]) => id === SESSION_ID && data.startsWith('\x1b[200~'));
    expect(pasteWrites()).toHaveLength(0);

    // Now the real command is injected and the CLI produces its own output —
    // the idle clock should start from here and the paste should proceed.
    sendInitialCommand();
    await sessionCallbacks.onData(Buffer.from('Codex booting...\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    expect(pasteWrites()).toHaveLength(1);
  });

  // Regression (2026-09-20, agent-d4c7c237 and five siblings): codex QUEUES a
  // bracketed paste written before its composer finished initializing and
  // commits it once the composer is live — on a cold Windows start that was
  // ~11s for a paste sent at 3.7s. The old 3.5s marker wait + 2s verify window
  // expired first and the retry ladder wrote a SECOND full prompt on top of the
  // queued one; codex committed NEITHER, and the agent was killed
  // `paste-not-rendered` in ~24s with a healthy composer on screen. The paste
  // must be left alone long enough for that late commit, and submitted when it
  // arrives — never re-pasted over.
  // Regression (2026-09-20, six codex-tui agents dead in ~24s): on a cold
  // Windows start codex paints its header and then goes SILENT for seconds
  // while the native binary boots. Output-idle alone read that lull as "ready"
  // and pasted into a composer that did not exist yet, which swallowed the
  // paste. The idle path must wait for codex's composer placeholder; the
  // PASTE_DEADLINE_MS fallback still delivers if it never paints.
  it('codex composer gate: idle silence before the composer paints does not paste', async () => {
    runSpawn();
    await flushMicrotasks();

    // Header only — no composer. Then well past the 1200ms idle threshold.
    await sessionCallbacks.onData(Buffer.from('>_ OpenAI Codex (v0.155.1)\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0);

    // Composer paints → the ordinary idle path delivers.
    await sessionCallbacks.onData(Buffer.from(CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  // The gate can only DELAY a paste: a codex whose composer wording we no
  // longer recognize still gets the prompt at the blind-paste deadline.
  it('codex composer gate: still blind-pastes at PASTE_DEADLINE_MS if the composer is never recognized', async () => {
    const { PASTE_DEADLINE_MS } = await vi.importActual('../../lib/tuiHandshake.js');

    runSpawn();
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('>_ OpenAI Codex (v9.9.9)\n  some future composer wording\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(PASTE_DEADLINE_MS + 1000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('codex late paste commit: waits for the chip past the old window instead of re-pasting', async () => {
    const pasteFailSpy = vi.fn();
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async (args) => {
      if (args?.completionReason === 'paste-not-rendered') pasteFailSpy(args);
    });

    runSpawn({ prompt: 'review the provider install detection on this machine' });
    await flushMicrotasks();
    // Ordinary banner — deliberately NOT an MCP-boot signal, so the extended
    // boot budget is not what rescues this run.
    await sessionCallbacks.onData(Buffer.from('>_ OpenAI Codex (v0.155.1)\n  directory: loading\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);

    // Well past the old 5.5s marker+verify budget, codex is still initializing
    // and has echoed nothing. Nothing may be re-pasted, and nothing may fail.
    await vi.advanceTimersByTimeAsync(10000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
    expect(pasteFailSpy).not.toHaveBeenCalled();

    // Composer goes live and commits the queued paste.
    await sessionCallbacks.onData(Buffer.from('[Pasted Content 29448 chars]\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();

    const enterWrites = vi.mocked(shellService.writeToSession).mock.calls
      .filter(([id, data]) => id === SESSION_ID && data === '\r');
    expect(enterWrites.length).toBeGreaterThan(0);
    expect(pasteCount()).toBe(1);
    expect(pasteFailSpy).not.toHaveBeenCalled();
  });

  // The patient window is for a paste codex QUEUED. During an MCP boot codex
  // renders its box early and SWALLOWS pastes outright, so there is nothing to
  // wait for and patience would only delay the 5s re-paste cadence that IS the
  // recovery. The boot banner can latch AFTER the paste went out, so the wait
  // has to be read live rather than fixed when the attempt started.
  it('codex MCP boot: drops the patient window when the boot banner latches after the paste', async () => {
    const { PASTE_COMMIT_PATIENCE_MS } = await vi.importActual('../../lib/tuiHandshake.js');

    runSpawn({ prompt: 'evaluate our animation prompts and generate drafts' });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('>_ OpenAI Codex (v0.155.1)\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);

    // Boot banner arrives only now — after the paste. The attempt must abandon
    // the patient window and fall back to the short swallow-recovery ladder.
    await sessionCallbacks.onData(Buffer.from('Starting MCP servers (1/2): codex_apps (0s • esc to interrupt)\n' + CODEX_COMPOSER));
    await flushMicrotasks();

    // Well inside the patient window, so a captured 45s wait would still be
    // sitting on attempt 1 with nothing re-pasted.
    await vi.advanceTimersByTimeAsync(20000);
    await flushMicrotasks();
    expect(PASTE_COMMIT_PATIENCE_MS).toBeGreaterThan(20000);
    expect(pasteCount()).toBeGreaterThan(1);
  });

  // ── 1d. Codex MCP-server boot patience (incident 2026-07-10, agent-c5a26b40) ──
  // Codex boots the user's globally-configured MCP servers (playwright via npx,
  // a node_repl with startup_timeout_sec=120) on every headless spawn. During
  // that boot codex swallows pastes and renders no `[Pasted Content N chars]`
  // marker, and its input viewport shows only the paste TAIL (never the verified
  // prefix), so the paste-verify retry can't confirm. With the fixed 3-attempt
  // budget the agent was killed `paste-not-rendered` at ~19s — long before a
  // legitimately-slow boot finishes. Once the MCP-boot banner is seen, the retry
  // budget must extend to MCP_BOOT_PASTE_DEADLINE_MS so a slow boot completes and
  // the paste finally lands.
  it('codex MCP boot: extends the paste-retry budget past the fixed 3-attempt cap while booting', async () => {
    const { MCP_BOOT_PASTE_DEADLINE_MS } = await vi.importActual('../../lib/tuiHandshake.js');
    const pasteFailSpy = vi.fn();
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async (args) => {
      if (args?.completionReason === 'paste-not-rendered') pasteFailSpy(args);
    });

    runSpawn({ prompt: 'evaluate our animation prompts and generate drafts' });
    await flushMicrotasks();

    // Codex prints its MCP-boot banner during a whole-screen repaint. The
    // composer/footer after the status line exceeds the tracker's 256-char
    // cross-chunk tail in real transcripts; the tracker must search the full
    // new repaint before truncating that tail, or it misses the banner and
    // kills the run at the ordinary three-attempt cap.
    const footer = `\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · ${'workspace footer '.repeat(24)}`;
    await sessionCallbacks.onData(Buffer.from(`>_ OpenAI Codex (v0.148.0)\nStarting MCP servers (1/2): codex_apps (0s • esc to interrupt)${footer}`));
    await flushMicrotasks();
    // Fire the paste (past prompt-delay floor + readiness idle threshold).
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // No marker and no echo ever arrive — every attempt is swallowed. Advance
    // well past the point where the fixed 3-attempt budget would be exhausted,
    // but under the MCP-boot deadline.
    await vi.advanceTimersByTimeAsync(MCP_BOOT_PASTE_DEADLINE_MS - 5000);
    await flushMicrotasks();

    // Boot-aware budget kept retrying instead of failing paste-not-rendered…
    expect(pasteFailSpy).not.toHaveBeenCalled();
    // …and re-pasted more times than the 3-attempt cap would ever allow.
    expect(pasteCount()).toBeGreaterThan(3);
  });

  it('codex MCP boot: submits a paste whose marker arrives during retry backoff', async () => {
    const {
      MCP_BOOT_PASTE_RETRY_DELAY_MS,
      PASTE_TO_ENTER_FALLBACK_MS,
      PASTE_VERIFY_WINDOW_MS,
      PASTE_VERIFY_POLL_MS,
      PASTE_TO_ENTER_MIN_DELAY_MS,
    } = await vi.importActual('../../lib/tuiHandshake.js');

    runSpawn({ prompt: 'evaluate our animation prompts and generate drafts' });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('Starting MCP servers (1/2): codex_apps (0s • esc to interrupt)\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    expect(pasteCount()).toBe(1);

    // Deliver the chip well past the old marker + verification windows. The
    // production incident delivered it in exactly this gap, after output from a
    // busy Codex repaint was delayed; the old controller discarded it and
    // stacked another full prompt on top.
    await vi.advanceTimersByTimeAsync(
      PASTE_TO_ENTER_FALLBACK_MS + PASTE_VERIFY_WINDOW_MS + PASTE_VERIFY_POLL_MS,
    );
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from('[Pasted Content 12345 chars]\n'));
    await flushMicrotasks();

    const enterWrites = () => vi.mocked(shellService.writeToSession).mock.calls
      .filter(([id, data]) => id === SESSION_ID && data === '\r');
    // The chip cancels re-paste immediately, but Enter waits for its output to
    // settle even when confirmation arrives during retry backoff.
    expect(enterWrites()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(PASTE_TO_ENTER_MIN_DELAY_MS - 1);
    expect(enterWrites()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(enterWrites()).toHaveLength(1);

    // The late authoritative marker cancels the pending duplicate paste.
    await vi.advanceTimersByTimeAsync(MCP_BOOT_PASTE_RETRY_DELAY_MS + 100);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('codex MCP boot: fails paste-not-rendered only after the extended deadline if boot never completes', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('Booting MCP server: node_repl(0s • esc to interrupt)\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Never becomes ready. Advance past MCP_BOOT_PASTE_DEADLINE_MS (150s).
    await vi.advanceTimersByTimeAsync(155000);
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'paste-not-rendered' })
    );
  });

  it('paste-not-rendered: without an MCP-boot banner, still fails after the fixed 3 attempts', async () => {
    const { PASTE_COMMIT_PATIENCE_MS } = await vi.importActual('../../lib/tuiHandshake.js');
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();
    await flushMicrotasks();
    // Ordinary banner chrome — NOT an MCP-boot signal, so the budget stays fixed.
    await sessionCallbacks.onData(Buffer.from('Codex booting...\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // No marker/echo. Advance past attempt 1's patient commit window plus the
    // two short retries behind it, but well under the 150s MCP-boot deadline —
    // proving the non-boot path still fails at 3 attempts.
    await vi.advanceTimersByTimeAsync(PASTE_COMMIT_PATIENCE_MS + 25000);
    vi.useRealTimers();
    await completeDone;

    expect(pasteCount()).toBe(3);
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'paste-not-rendered' })
    );
  });

  it('MCP-boot budget is codex-only: a non-codex TUI emitting the same banner fails at the 60s retry window, not 150s', async () => {
    // Regression for codex review [P2]: the boot tracker must not latch for a
    // non-codex provider, or an unrelated TUI whose startup text contains
    // "starting mcp servers" would inherit codex's 150s budget and its
    // codex-specific failure guidance, breaking "non-codex TUIs are unchanged."
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: { command: 'gemini', args: [], spawnCommand: 'gemini', spawnArgs: [], commandLine: 'gemini', promptDelayMs: 100 } });
    await flushMicrotasks();
    // Same banner text codex prints — but this is a gemini session.
    await sessionCallbacks.onData(Buffer.from('Starting MCP servers (0/3): a, b, c\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Fails when the PASTE_RETRY_MIN_WINDOW_MS window closes (~60s), NOT the 150s boot budget.
    await vi.advanceTimersByTimeAsync(75000);
    vi.useRealTimers();
    await completeDone;

    expect(pasteCount()).toBeGreaterThan(3);
    expect(pasteCount()).toBeLessThan(15);
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'paste-not-rendered' })
    );
  });
});
