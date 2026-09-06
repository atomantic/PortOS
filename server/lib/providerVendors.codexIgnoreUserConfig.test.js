/**
 * The `ignoreUserConfig` pin at the Codex spawn boundary (#6304).
 *
 * The regression this uniquely catches: a toggle the AI Providers page offers
 * that never reaches argv (so PortOS keeps routing through the user's config
 * while reporting its own account), and the inverse — the flag appearing on a
 * provider that never asked for it, which would silently change every existing
 * install's Codex behavior. The public-review recipes are asserted unchanged
 * because they already pass the flag unconditionally and must keep doing so.
 */
import { describe, expect, it } from 'vitest';
import { PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE } from './agentExecutionProfiles.js';
import { applyCommandDefaults, buildVendorCliArgs, buildVendorSpawnConfig } from './providerVendors.js';

const codexCli = { id: 'codex', type: 'cli', command: 'codex' };
const codexTui = { id: 'codex-tui', type: 'tui', command: 'codex' };
const pinned = (provider) => ({ ...provider, ignoreUserConfig: true });

describe('codex --ignore-user-config pin', () => {
  it('is absent by default on both spawn paths', () => {
    expect(buildVendorCliArgs(codexCli, [], {})).not.toContain('--ignore-user-config');
    expect(buildVendorSpawnConfig(codexCli, {}).args).not.toContain('--ignore-user-config');
    expect(applyCommandDefaults('codex', [], codexTui)).not.toContain('--ignore-user-config');
  });

  it('appends the flag on every spawn path once the provider opts in', () => {
    expect(buildVendorCliArgs(pinned(codexCli), [], {})).toContain('--ignore-user-config');
    expect(buildVendorSpawnConfig(pinned(codexCli), {}).args).toContain('--ignore-user-config');
    expect(applyCommandDefaults('codex', [], pinned(codexTui))).toContain('--ignore-user-config');
  });

  it('does not duplicate a flag the user already pinned in provider args', () => {
    const args = buildVendorCliArgs(pinned(codexCli), ['--ignore-user-config'], {});
    expect(args.filter((arg) => arg === '--ignore-user-config')).toHaveLength(1);
    const tuiArgs = applyCommandDefaults('codex', ['--ignore-user-config'], pinned(codexTui));
    expect(tuiArgs.filter((arg) => arg === '--ignore-user-config')).toHaveLength(1);
  });

  it('leaves the public-review recipe passing the flag regardless of the toggle', () => {
    for (const provider of [codexCli, pinned(codexCli)]) {
      const config = buildVendorSpawnConfig(provider, { safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE });
      expect(config.args.filter((arg) => arg === '--ignore-user-config')).toHaveLength(1);
    }
  });

  it('never reaches a non-codex vendor', () => {
    const claude = { id: 'claude-code', type: 'cli', command: 'claude', ignoreUserConfig: true };
    expect(buildVendorSpawnConfig(claude, {}).args).not.toContain('--ignore-user-config');
  });
});
