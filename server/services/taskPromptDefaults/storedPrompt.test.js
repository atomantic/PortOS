import { describe, expect, it } from 'vitest';
import { reconcileStoredPrompt, stampPromptWrite } from './storedPrompt.js';
import { DEFAULT_TASK_PROMPTS } from './prompts.js';
import { PROMPT_VERSIONS } from './versions.js';
import { RETIRED_CONSOLE_ERRORS_PROMPT } from './retiredPromptFixtures.js';

const taskType = 'console-errors';
const prompt = DEFAULT_TASK_PROMPTS[taskType];
const promptVersion = PROMPT_VERSIONS[taskType];
const retired = RETIRED_CONSOLE_ERRORS_PROMPT;

describe('stored prompt compatibility cases', () => {
  it.each([
    ['missing prompt installs the default and clears stale provenance',
      { prompt: null, promptSource: 'user' },
      { prompt, promptVersion, promptSource: null, changed: true }],
    ['unversioned current default is stamped without rewriting',
      { prompt }, { prompt, promptVersion, changed: true }],
    ['unversioned retired default resets its version and upgrades',
      { prompt: retired }, { prompt, promptVersion, changed: true }],
    ['unrecognized unversioned body becomes an inferred pin',
      { prompt: 'my instructions' },
      { prompt: 'my instructions', promptVersion, promptCustomized: true, promptSource: 'legacy-inferred', changed: true }],
    ['legacy-inferred retired pin self-heals even with the current version',
      { prompt: retired, promptVersion, promptCustomized: true, promptSource: 'legacy-inferred' },
      { prompt, promptVersion, promptCustomized: false, promptSource: 'legacy-inferred', changed: true }],
    ['absent provenance on a current default self-heals',
      { prompt, promptVersion, promptCustomized: true },
      { prompt, promptVersion, promptCustomized: false, changed: true }],
    ['explicit user pin of a retired default survives a version bump (#5432)',
      { prompt: retired, promptVersion: 1, promptCustomized: true, promptSource: 'user' },
      { prompt: retired, promptVersion: 1, promptCustomized: true, promptSource: 'user', changed: false }],
    ['older uncustomized version upgrades',
      { prompt: retired, promptVersion: 1, promptCustomized: false },
      { prompt, promptVersion, promptCustomized: false, changed: true }],
    ['current default with a current version needs no save',
      { prompt, promptVersion }, { prompt, promptVersion, changed: false }],
    ['unknown task without a shipped default is untouched',
      { prompt: 'custom task', promptVersion: 2 },
      { prompt: 'custom task', promptVersion: 2, changed: false }, 'unknown-task']
  ])('%s', (_name, config, expected, type = taskType) => {
    const original = structuredClone(config);
    expect(reconcileStoredPrompt(config, type)).toEqual(expected);
    expect(config).toEqual(original);
    const { changed: _changed, ...reconciled } = expected;
    expect(reconcileStoredPrompt(reconciled, type)).toEqual({ ...reconciled, changed: false });
  });
});

describe('Settings prompt writes', () => {
  it.each([
    ['empty body resumes defaults', '  \n', null, false],
    ['cleared body resumes defaults', null, null, false],
    ['re-save of current default does not pin', prompt, prompt, false],
    ['retired shipped body is an explicit pin', retired, retired, true],
    ['custom body is an explicit pin', 'my instructions', 'my instructions', true]
  ])('%s', (_name, input, body, pinned) => {
    expect(stampPromptWrite(input, taskType)).toEqual({
      prompt: body, promptCustomized: pinned, promptSource: pinned ? 'user' : null
    });
  });
});
