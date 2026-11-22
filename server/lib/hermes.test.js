import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCliArgs, prepareCliPrompt } from './cliProviderArgs.js';
import { buildVendorSpawnConfig, applyCommandDefaults, toolFreeOneShotArgs, toolFreeOneShotRefusal } from './provider/providerVendors.js';
import { effortLevelsForProvider } from './provider/providerModels.js';
import { harnessForProvider } from './provider/providerHarnesses.js';
import { buildSafeCliBaseEnv } from './processEnv.js';
import { HERMES_COMMAND, ensureHermesHeadlessArgs, ensureHermesTuiArgs, isHermesCommand, prepareHermesPrompt } from './hermes.js';

const SHIPPED = JSON.parse(readFileSync(new URL('../../data.reference/providers.json', import.meta.url), 'utf8')).providers;
const cli = (extra = {}) => ({ id: 'hermes-cli', type: 'cli', command: 'hermes', args: SHIPPED['hermes-cli'].args, ...extra });

describe('hermes.js', () => {
  it('recognizes the binary by basename, including a path and a Windows .exe', () => {
    expect(isHermesCommand(HERMES_COMMAND)).toBe(true);
    expect(isHermesCommand('/opt/bin/hermes')).toBe(true);
    expect(isHermesCommand('C:\\tools\\Hermes.exe')).toBe(true);
    expect(isHermesCommand('hermes-agent')).toBe(false);
    expect(isHermesCommand(null)).toBe(false);
  });

  it('builds the headless argv with the model, and leaves a baked model pin alone', () => {
    expect(ensureHermesHeadlessArgs([], 'anthropic/claude-sonnet-4.6'))
      .toEqual(['chat', '--oneshot', '--quiet', '--yolo', '--model', 'anthropic/claude-sonnet-4.6']);
    expect(ensureHermesHeadlessArgs(['chat', '-m', 'pinned'], 'other')).toEqual(['chat', '-m', 'pinned', '--oneshot', '--quiet', '--yolo']);
    expect(ensureHermesHeadlessArgs(SHIPPED['hermes-cli'].args)).toEqual(SHIPPED['hermes-cli'].args);
  });

  it('delivers the prompt over stdin so a large prompt never rides argv', () => {
    const prompt = 'x'.repeat(500000);
    const prepared = prepareHermesPrompt(['chat', '--oneshot', '--query-file', 'stale.txt', '--model', 'm']);
    expect(prepared).toMatchObject({ args: ['chat', '--oneshot', '--model', 'm', '--query-file', '-'], useStdin: true });
    expect(prepared.args.join(' ')).not.toContain(prompt.slice(0, 20));
    expect(prepareCliPrompt('hermes', ['chat'], prompt)).toMatchObject({ args: ['chat', '--query-file', '-'], useStdin: true });
  });

  it('builds the TUI argv idempotently and respects a pinned posture', () => {
    expect(ensureHermesTuiArgs([])).toEqual(['--tui', '--yolo']);
    expect(ensureHermesTuiArgs(['--tui', '--yolo'])).toEqual(['--tui', '--yolo']);
    expect(ensureHermesTuiArgs(['--cli'])).toEqual(['--cli', '--yolo']);
    expect(applyCommandDefaults('hermes', [])).toEqual(['--tui', '--yolo']);
  });
});

describe('hermes through the provider builders', () => {
  it('buildCliArgs resolves a concrete model and omits it when none is configured (Hermes uses its own default)', () => {
    expect(buildCliArgs(cli({ defaultModel: 'openai/gpt-5.5' }))).toEqual([...SHIPPED['hermes-cli'].args, '--model', 'openai/gpt-5.5']);
    expect(buildCliArgs(cli({ defaultModel: null }))).toEqual(SHIPPED['hermes-cli'].args);
  });

  it('passes no effort flag: Hermes has no per-run reasoning flag', () => {
    expect(effortLevelsForProvider(cli())).toBeNull();
    const args = buildCliArgs(cli({ defaultModel: 'm', effort: 'high' }));
    expect(args).not.toContain('--effort');
    expect(args).not.toContain('--reasoning');
    expect(args).not.toContain('--thinking');
  });

  it('spawns the headless run with stdin prompt delivery', () => {
    const config = buildVendorSpawnConfig(cli(), { effectiveModel: 'm', effort: null });
    expect(config).toMatchObject({ command: 'hermes', stdinMode: 'prompt' });
    expect(config.args).toEqual([...SHIPPED['hermes-cli'].args, '--model', 'm']);
  });

  it('is never tool-free: the bypass is stripped and a caller without host control is refused', () => {
    const { args, toolFree } = toolFreeOneShotArgs(cli(), ['chat', '--yolo', '--oneshot']);
    expect(toolFree).toBe(false);
    expect(args).toEqual(['chat', '--oneshot']);
    expect(buildCliArgs(cli(), { toolFree: true })).not.toContain('--yolo');
    expect(toolFreeOneShotRefusal(cli(), false)).toMatchObject({ status: 403, code: 'HOST_CONTROL_FORBIDDEN' });
    expect(toolFreeOneShotRefusal(cli(), true)).toBeNull();
  });

  it('classifies both shipped records as the hermes harness and forwards only HERMES_HOME ambiently', () => {
    expect(harnessForProvider(SHIPPED['hermes-cli'])?.id).toBe('hermes');
    expect(harnessForProvider(SHIPPED['hermes-tui'])?.id).toBe('hermes');
    const env = buildSafeCliBaseEnv({ HERMES_HOME: '/h', OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k', PATH: '/bin' }, cli());
    expect(env).toEqual({ HERMES_HOME: '/h', PATH: '/bin' });
  });
});
