// #15576: a Music Video frame check can run on any provider that sees an image
// without a host-writing tool, so Claude Code and Grok Build qualify alongside
// Codex and vision API providers. The read posture keeps exactly one read tool.
import { describe, expect, it } from 'vitest';
import { canReviewImages } from './imageReviewProviders.js';
import { canReadImagesOneShot, imageReadOneShotArgs } from './providerVendors.js';
import { GROK_BUILTIN_TOOLS } from './grok.js';

const cli = (id, command, extra = {}) => ({ id, type: 'cli', command, enabled: true, ...extra });

describe('imageReadOneShotArgs', () => {
  it('keeps only the Read tool for Claude Code and drops approval bypasses and MCP servers', () => {
    const { args, imageRead } = imageReadOneShotArgs(cli('claude-code', 'claude'), ['-p', '-', '--dangerously-skip-permissions', '--tools', 'Bash,Read']);
    expect(imageRead).toBe('read-tool');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.filter((arg) => arg === '--tools')).toHaveLength(1);
    expect(args[args.indexOf('--tools') + 1]).toBe('Read');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
  });

  it('keeps only read_file for Grok, in plan mode', () => {
    const { args, imageRead } = imageReadOneShotArgs(cli('grok-cli', 'grok'), ['--permission-mode', 'bypassPermissions', '--prompt-file', '/dev/stdin']);
    expect(imageRead).toBe('read-tool');
    expect(args).not.toContain('bypassPermissions');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    const disallowed = args[args.indexOf('--disallowed-tools') + 1].split(',');
    expect(disallowed).not.toContain('read_file');
    expect(disallowed).toEqual(GROK_BUILTIN_TOOLS.filter((tool) => tool !== 'read_file'));
    expect(args).toContain('/dev/stdin');
  });

  it('holds Codex to its read-only sandbox and passes an API provider through', () => {
    expect(imageReadOneShotArgs(cli('codex', 'codex'), ['exec']).imageRead).toBe('attach');
    expect(imageReadOneShotArgs({ type: 'api' }, []).imageRead).toBe('inline');
  });

  it('has no posture for a CLI that cannot drop its tools, so the caller fails closed', () => {
    expect(imageReadOneShotArgs(cli('agy', 'agy'), [])).toBeNull();
    expect(canReadImagesOneShot(cli('agy', 'agy'))).toBe(false);
    expect(imageReadOneShotArgs({ type: 'tui', command: 'claude' }, [])).toBeNull();
  });
});

describe('canReviewImages', () => {
  it('accepts Claude Code and Grok Build CLIs', () => {
    expect(canReviewImages(cli('claude-code', 'claude'))).toBe(true);
    expect(canReviewImages(cli('grok-cli', '/Users/me/.grok/bin/grok'))).toBe(true);
  });

  it('refuses CLIs that cannot see an image or cannot drop their tools, and TUIs', () => {
    expect(canReviewImages(cli('agy', 'agy'))).toBe(false);
    expect(canReviewImages(cli('kimi', 'kimi'))).toBe(false);
    expect(canReviewImages({ id: 'claude-code-tui', type: 'tui', command: 'claude', enabled: true })).toBe(false);
  });
});
