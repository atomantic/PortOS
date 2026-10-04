// #9008: Ask and AI app detection hand a caller-chosen provider caller text. A
// one-shot argv carrying an approval bypass turns that into remote shell access,
// so these pin the security guard directly: the bypass is gone for every vendor,
// and only a vendor with a real tool-disable switch reports itself tool-free.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCliArgs } from './cliProviderArgs.js';
import { isAuthoringOneShotProvider, isToolFreeOneShotProvider, toolFreeOneShotArgs, toolFreeOneShotRefusal } from './providerVendors.js';

const SHIPPED_PROVIDERS = Object.values(
  JSON.parse(readFileSync(new URL('../../data.reference/providers.json', import.meta.url), 'utf8')).providers,
);

const BYPASS_TOKENS = [
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--yolo', '--auto',
  '--approve', '--force', '--auto-review', '--always-approve', '--yes-always', '--allow-all-tools',
  'bypassPermissions', 'danger-full-access',
];
const expectNoBypass = (args) => {
  for (const token of BYPASS_TOKENS) expect(args).not.toContain(token);
};
const cli = (command) => ({ type: 'cli', command });

describe('toolFreeOneShotArgs', () => {
  it.each([
    ['claude', ['--print', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--tools', 'Bash', 'Edit', '--allowedTools', 'mcp__x', '-p', '-']],
    ['grok', ['--permission-mode', 'bypassPermissions', '--always-approve', '--tools', 'bash', '--prompt-file', '/dev/stdin']],
    ['pi', ['--print', '--approve', '-a']],
  ])('%s keeps no bypass and gets its tool-disable switch', (command, args) => {
    const result = toolFreeOneShotArgs(cli(command), args);
    expect(result.toolFree).toBe(true);
    expectNoBypass(result.args);
    expect(result.args).not.toContain('Bash');
    expect(result.args).not.toContain('mcp__x');
  });

  it('empties claude\'s tool set and walls off project MCP servers and settings', () => {
    const { args } = toolFreeOneShotArgs(cli('claude'), ['--print', '--tools', 'Bash', '--setting-sources', 'user,project', '-p', '-']);
    expect(args).toEqual([
      '--print', '-p', '-',
      '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', 'user',
    ]);
  });

  it('pins grok to plan mode with an empty tool list, keeping its stdin prompt file', () => {
    const { args } = toolFreeOneShotArgs(cli('grok'), ['--output-format', 'plain', '--permission-mode=bypassPermissions', '--prompt-file', '/dev/stdin']);
    expect(args).toEqual(['--output-format', 'plain', '--prompt-file', '/dev/stdin', '--permission-mode', 'plan', '--tools', '']);
  });

  it.each([
    ['agy', ['--dangerously-skip-permissions', '--print']],
    ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'danger-full-access', '-']],
    ['kilo', ['run', '--auto']],
    ['kimi', ['-y', '--yolo']],
    ['opencode', ['run', '--agent', 'build']],
    ['aider', ['--yes-always', '--yolo']],
    ['copilot', ['--allow-all-tools']],
  ])('%s has no tool-disable switch: bypass stripped, reported not tool-free', (command, args) => {
    const result = toolFreeOneShotArgs(cli(command), args);
    expect(result.toolFree).toBe(false);
    expectNoBypass(result.args);
    expect(result.args).not.toContain('-y');
  });

  it('keeps agy\'s --print marker last so the prompt stays its value', () => {
    expect(toolFreeOneShotArgs(cli('agy'), ['--model', 'm', '--dangerously-skip-permissions', '--print']).args)
      .toEqual(['--model', 'm', '--print']);
  });

  it('swaps cursor\'s --force for the trust-only flag so the headless run still starts', () => {
    const result = toolFreeOneShotArgs(cli('cursor-agent'), ['--print', '-f']);
    expect(result).toEqual({ args: ['--print', '--trust'], toolFree: false });
  });

  it('never hands an unknown command claude\'s flags', () => {
    expect(toolFreeOneShotArgs(cli('aider'), ['--model', 'm']).args).toEqual(['--model', 'm']);
  });

  it('leaves an API provider alone and tool-free', () => {
    expect(toolFreeOneShotArgs({ type: 'api' }, ['x'])).toEqual({ args: ['x'], toolFree: true });
  });
});

describe('codex read-only sandbox one-shot', () => {
  it('confines codex to a read-only sandbox without calling it tool-free', () => {
    const result = toolFreeOneShotArgs(cli('codex'), ['exec', '--sandbox', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox', '-']);
    expect(result).toEqual({
      args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-'],
      toolFree: false,
      readOnlySandbox: true,
    });
  });

  it('admits codex for authoring only, not for the host-control guard', () => {
    expect(isAuthoringOneShotProvider(cli('codex'))).toBe(true);
    expect(isToolFreeOneShotProvider(cli('codex'))).toBe(false);
    expect(isAuthoringOneShotProvider(cli('agy'))).toBe(false);
    expect(isAuthoringOneShotProvider({ type: 'tui', command: 'codex' })).toBe(false);
  });
});

describe('isToolFreeOneShotProvider / toolFreeOneShotRefusal', () => {
  it('treats API providers and claude/grok/pi CLIs as tool-free, TUI records and agent CLIs as host control', () => {
    expect(isToolFreeOneShotProvider({ type: 'api' })).toBe(true);
    expect(isToolFreeOneShotProvider(cli('claude'))).toBe(true);
    expect(isToolFreeOneShotProvider(cli('grok'))).toBe(true);
    expect(isToolFreeOneShotProvider(cli('pi'))).toBe(true);
    expect(isToolFreeOneShotProvider(cli('agy'))).toBe(false);
    expect(isToolFreeOneShotProvider(cli('codex'))).toBe(false);
    expect(isToolFreeOneShotProvider({ type: 'tui', command: 'claude' })).toBe(false);
  });

  it('refuses only a non-tool-free provider, and only without host control', () => {
    const agy = { id: 'antigravity-cli', ...cli('agy') };
    expect(toolFreeOneShotRefusal(agy, false)).toMatchObject({ status: 403, code: 'HOST_CONTROL_FORBIDDEN' });
    expect(toolFreeOneShotRefusal(agy, true)).toBeNull();
    expect(toolFreeOneShotRefusal(cli('claude'), false)).toBeNull();
  });
});

// The runner path AI app detection takes: vendor builders re-add their own
// bypass (agy, grok, kilo, cursor, pi), so the guard must hold on the FINAL argv
// of every CLI record PortOS ships.
describe('buildCliArgs(provider, { toolFree: true })', () => {
  const shippedCli = SHIPPED_PROVIDERS.filter((provider) => provider.type === 'cli');

  it.each(shippedCli.map((provider) => [provider.id, provider]))('%s carries no approval bypass', (_id, provider) => {
    expectNoBypass(buildCliArgs(provider, { toolFree: true }));
  });

  it('gives headless grok no bypassPermissions', () => {
    expect(buildCliArgs(cli('grok'), { toolFree: true })).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
  });

  it('leaves the agent path untouched', () => {
    expect(buildCliArgs(cli('grok'))).toContain('bypassPermissions');
  });
});
