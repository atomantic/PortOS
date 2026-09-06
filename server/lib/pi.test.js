import { describe, it, expect } from 'vitest';
import { buildCliArgs, prepareCliPrompt } from './cliProviderArgs.js';
import { isPiCommand, ensurePiHeadlessArgs } from './pi.js';
import { PROVIDER_VENDORS, publicReviewRecipe, PUBLIC_REVIEW_NO_TOOL_POSTURE, PUBLIC_REVIEW_ACTIONS_POSTURE } from './providerVendors.js';
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
