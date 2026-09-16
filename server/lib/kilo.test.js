import { describe, it, expect } from 'vitest';
import { buildCliArgs, prepareCliPrompt } from './cliProviderArgs.js';
import { isKiloCommand, ensureKiloHeadlessArgs, ensureKiloTuiArgs } from './kilo.js';
import { applyCommandDefaults, inferTuiCommand } from './providerVendors.js';
import { harnessForProvider, harnessSupportsMode } from './providerHarnesses.js';
import { parseHarnessModels } from './harnessOutput.js';
import { isAllowedCommand } from '../cos-runner/allowedCommands.js';

describe('Kilo provider boundaries', () => {
  it('builds the headless run argv with an approval posture and a namespaced model', () => {
    const provider = { id: 'kilo-cli', type: 'cli', command: 'kilo', args: [], defaultModel: 'anthropic/claude-opus-5' };
    expect(buildCliArgs(provider)).toEqual(['run', '--auto', '--model', 'anthropic/claude-opus-5']);
    // The prompt rides stdin, like OpenCode's `run` that Kilo forks.
    const prepared = prepareCliPrompt('kilo', buildCliArgs(provider), 'review this');
    expect(prepared.useStdin).toBe(true);
    expect(prepared.args).toEqual(buildCliArgs(provider));
  });

  it('never duplicates a pinned subcommand, approval posture or model flag', () => {
    expect(ensureKiloHeadlessArgs(['run', '--no-auto', '-m', 'openai/gpt-5.6-sol'], 'anthropic/other'))
      .toEqual(['run', '--no-auto', '-m', 'openai/gpt-5.6-sol']);
    expect(ensureKiloTuiArgs(['--auto'])).toEqual(['--auto']);
    expect(ensureKiloTuiArgs([])).toEqual(['--auto']);
    // Both TUI spawn paths go through `applyCommandDefaults`, so the posture a
    // headless run gets is the one an attached session gets.
    expect(applyCommandDefaults('kilo', [])).toEqual(['--auto']);
  });

  it('identifies both shipped bin names and nothing that merely starts with them', () => {
    expect(isKiloCommand('kilo')).toBe(true);
    expect(isKiloCommand('/opt/bin/kilocode.exe')).toBe(true);
    expect(isKiloCommand('kilobyte')).toBe(false);
    expect(isKiloCommand('opencode')).toBe(false);
    expect(inferTuiCommand('kilo-tui')).toBe('kilo');
    // A vendor row is what makes the binary spawnable by the CoS runner.
    expect(isAllowedCommand('kilo')).toBe(true);
  });

  it('classifies as a CLI/TUI harness that cannot be minted from a connection', () => {
    const harness = harnessForProvider({ id: 'kilo-tui', type: 'tui', command: 'kilo' });
    expect(harness.id).toBe('kilo');
    expect(harnessSupportsMode('kilo', 'tui')).toBe(true);
    // No config surface PortOS writes, so no route recipe — see providerHarnesses.js.
    expect(harness.recipe ?? null).toBeNull();
  });

  it('parses `kilo models` output in the same `provider/model` shape as OpenCode', () => {
    expect(parseHarnessModels('kilo', 'anthropic/claude-opus-5\nopenai/gpt-5.6-sol\nFetching models...'))
      .toEqual(['anthropic/claude-opus-5', 'openai/gpt-5.6-sol']);
  });
});
