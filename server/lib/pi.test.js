import { describe, it, expect } from 'vitest';
import { buildCliArgs, prepareCliPrompt } from './cliProviderArgs.js';
import { existsSync } from 'node:fs';
import { isPiCommand, ensurePiHeadlessArgs, PI_ENDPOINT_EXTENSION_PATH, PI_ENDPOINT_PROVIDER } from './pi.js';
import portosEndpointExtension from './pi/portosEndpointExtension.js';
import { composeProviderEnv } from './cliChildEnv.js';
import { applyCommandDefaults, PROVIDER_VENDORS, inferTuiCommand, publicReviewRecipe, PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE } from './providerVendors.js';
import { parseHarnessModels } from './harnessOutput.js';
import { reviewerEffortArgs } from './reviewerConfig.js';

describe('Pi provider boundaries', () => {
  it('constructs headless arguments and delivers option-like prompts as text', () => {
    const provider = { id: 'pi-cli', type: 'cli', command: 'pi', args: [], defaultModel: 'example/model', effort: 'high' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(expect.arrayContaining(['--print', '--approve', '--model', 'example/model', '--thinking', 'high']));
    expect(ensurePiHeadlessArgs(args, null, 'high')).toEqual(expect.arrayContaining(['--thinking', 'high']));
    const prepared = prepareCliPrompt('pi', args, '@private --approve');
    expect(prepared.useStdin).toBe(false);
    expect(prepared.args.slice(-2)).toEqual(['--', 'Task:\n@private --approve']);
    expect(reviewerEffortArgs('pi', 'high')).toEqual(['--thinking', 'high']);
  });
  it('preserves explicitly configured flags and identifies exact binary names', () => {
    const args = ['-p', '-na', '--model=example/custom', '--thinking=low'];
    expect(ensurePiHeadlessArgs(args, 'example/other', 'high')).toEqual(args);
    expect(isPiCommand('/opt/bin/pi.exe')).toBe(true);
    expect(isPiCommand('pipeline')).toBe(false);
    expect(inferTuiCommand('pi-tui')).toBe('pi');
    expect(inferTuiCommand('example-api-tui')).toBe('claude');
    expect(PROVIDER_VENDORS.slice(-2).map(v => v.id)).toEqual(['pi', 'claude']);
  });
  it('discards unsafe saved arguments in the no-tool posture and refuses action review', () => {
    const provider = { type: 'cli', command: 'pi', args: ['--approve', '-e', 'untrusted.js', '--tools', 'bash'] };
    const recipe = publicReviewRecipe(provider, PUBLIC_REVIEW_NO_TOOL_POSTURE);
    const { args } = recipe.spawnArgs(provider, {});
    expect(args).toEqual(expect.arrayContaining(['--no-approve', '--no-tools', '--no-extensions', '--no-context-files']));
    expect(args).not.toContain('--approve');
    expect(args).not.toContain('untrusted.js');
    expect(publicReviewRecipe(provider, PUBLIC_REVIEW_ACTIONS_POSTURE)).toBeNull();
  });
  it('parses qualified model IDs without treating login instructions as a model', () => {
    expect(parseHarnessModels('pi', 'provider model context max-out thinking images\nexample model-a 200K 32K yes yes\nexample model-a 200K 32K yes yes\nUse /login to authenticate')).toEqual(['example/model-a']);
  });
});

describe('Pi on a custom OpenAI-compatible endpoint', () => {
  const endpointProvider = {
    id: 'pi-fleet', name: 'Example GPU · Pi', type: 'tui', command: 'pi', args: [],
    endpoint: 'http://192.0.2.10:18022/v1', apiKey: 'example-key', models: ['example-model'], defaultModel: 'example-model',
  };

  it('loads the shipped endpoint extension and selects its provider in TUI and headless argv', () => {
    const tui = applyCommandDefaults('pi', [], endpointProvider);
    expect(tui).toEqual(['--approve', '--extension', PI_ENDPOINT_EXTENSION_PATH, '--provider', PI_ENDPOINT_PROVIDER]);
    const cli = buildCliArgs({ ...endpointProvider, type: 'cli' });
    expect(cli).toEqual(expect.arrayContaining(['--extension', PI_ENDPOINT_EXTENSION_PATH, '--provider', PI_ENDPOINT_PROVIDER, '--model', 'example-model']));
    expect(existsSync(PI_ENDPOINT_EXTENSION_PATH)).toBe(true);
  });

  it('leaves a route on a built-in Pi provider alone', () => {
    const builtin = { ...endpointProvider, args: ['--approve', '--provider', 'nvidia'] };
    expect(applyCommandDefaults('pi', builtin.args, builtin)).toEqual(['--approve', '--provider', 'nvidia']);
    expect(composeProviderEnv({ provider: builtin })).not.toHaveProperty('PORTOS_PI_ENDPOINT_BASE_URL');
  });

  it('passes the endpoint, models and key through the spawn env, and the extension registers them', () => {
    const env = composeProviderEnv({ provider: endpointProvider, model: 'example-run-model' });
    expect(env).toMatchObject({ PORTOS_PI_ENDPOINT_BASE_URL: 'http://192.0.2.10:18022/v1', PORTOS_PI_ENDPOINT_API_KEY: 'example-key' });
    expect(JSON.parse(env.PORTOS_PI_ENDPOINT_MODELS)).toEqual(['example-model', 'example-run-model']);

    const registered = [];
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      portosEndpointExtension({ registerProvider: (name, config) => registered.push({ name, config }) });
    } finally {
      for (const key of Object.keys(env)) if (!(key in saved)) delete process.env[key];
    }
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe(PI_ENDPOINT_PROVIDER);
    expect(registered[0].config).toMatchObject({ baseUrl: 'http://192.0.2.10:18022/v1', apiKey: '$PORTOS_PI_ENDPOINT_API_KEY', api: 'openai-completions' });
    expect(registered[0].config.models.map((m) => m.id)).toEqual(['example-model', 'example-run-model']);
  });
});
