import { describe, it, expect } from 'vitest';
import {
  TASK_PROMPT_KEY,
  TASK_CONTEXT_KEY,
  isPromptPayload,
  getTaskPrompt,
  getTaskContextNote,
  taskContextBlock,
  splitTaskPromptFields,
} from './cosTaskPrompt.js';

const AGENT_BODY = 'Ship the thing\n\n## Phase 1\nRead the repo.';

describe('isPromptPayload', () => {
  it('classifies a multi-line value as a prompt', () => {
    expect(isPromptPayload(AGENT_BODY)).toBe(true);
  });

  it('classifies a one-line note as NOT a prompt', () => {
    expect(isPromptPayload('Manually triggered autonomous job: nightly')).toBe(false);
  });

  it('treats an intentionally-cleared note as a note, not a prompt', () => {
    // Absent vs present-but-empty: '' is a cleared NOTE and must stay one.
    expect(isPromptPayload('')).toBe(false);
    expect(isPromptPayload(undefined)).toBe(false);
    expect(isPromptPayload(null)).toBe(false);
  });
});

describe('getTaskPrompt', () => {
  it('prefers metadata.prompt', () => {
    const task = { metadata: { [TASK_PROMPT_KEY]: AGENT_BODY, [TASK_CONTEXT_KEY]: 'a note' } };
    expect(getTaskPrompt(task)).toBe(AGENT_BODY);
  });

  it('falls back to a legacy metadata.context payload', () => {
    expect(getTaskPrompt({ metadata: { [TASK_CONTEXT_KEY]: AGENT_BODY } })).toBe(AGENT_BODY);
  });

  it('distinguishes an absent field from a present-but-empty one', () => {
    expect(getTaskPrompt({ metadata: {} })).toBeNull();
    expect(getTaskPrompt({})).toBeNull();
    expect(getTaskPrompt(null)).toBeNull();
    expect(getTaskPrompt({ metadata: { [TASK_PROMPT_KEY]: '' } })).toBe('');
  });
});

describe('getTaskContextNote', () => {
  it('returns the note only once the task is split', () => {
    const task = { metadata: { [TASK_PROMPT_KEY]: AGENT_BODY, [TASK_CONTEXT_KEY]: 'a note' } };
    expect(getTaskContextNote(task)).toBe('a note');
  });

  it('returns null on a legacy task so the payload is not rendered twice', () => {
    expect(getTaskContextNote({ metadata: { [TASK_CONTEXT_KEY]: AGENT_BODY } })).toBeNull();
  });
});

describe('taskContextBlock', () => {
  it('renders prompt then note', () => {
    const task = { metadata: { [TASK_PROMPT_KEY]: AGENT_BODY, [TASK_CONTEXT_KEY]: 'a note' } };
    expect(taskContextBlock(task)).toBe(`${AGENT_BODY}\n\na note`);
  });

  it('renders a legacy context-as-prompt unchanged', () => {
    expect(taskContextBlock({ metadata: { [TASK_CONTEXT_KEY]: AGENT_BODY } })).toBe(AGENT_BODY);
  });

  it('does not repeat a queue prompt already folded into description', () => {
    const task = {
      description: AGENT_BODY,
      metadata: { [TASK_PROMPT_KEY]: AGENT_BODY, [TASK_CONTEXT_KEY]: 'a note' },
    };
    expect(taskContextBlock(task)).toBe('a note');
  });

  it('does not repeat the prompt when description is the prompt plus an appended slashdo section', () => {
    const task = {
      description: `${AGENT_BODY}\n\n## Slashdo section`,
      metadata: { [TASK_PROMPT_KEY]: AGENT_BODY },
    };
    expect(taskContextBlock(task)).toBeNull();
  });

  it('renders both when the description is unrelated to the prompt', () => {
    const task = { description: 'Something else', metadata: { [TASK_PROMPT_KEY]: AGENT_BODY } };
    expect(taskContextBlock(task)).toBe(AGENT_BODY);
  });

  it('returns null when the task carries neither', () => {
    expect(taskContextBlock({ metadata: {} })).toBeNull();
    expect(taskContextBlock({ metadata: { [TASK_PROMPT_KEY]: '   ' } })).toBeNull();
  });
});

describe('splitTaskPromptFields', () => {
  it('moves a multi-line context to prompt', () => {
    const out = splitTaskPromptFields({ [TASK_CONTEXT_KEY]: AGENT_BODY, app: 'a1' });
    expect(out).toEqual({ [TASK_PROMPT_KEY]: AGENT_BODY, app: 'a1' });
  });

  it('leaves a one-line note alone', () => {
    const metadata = { [TASK_CONTEXT_KEY]: 'short note' };
    expect(splitTaskPromptFields(metadata)).toBe(metadata);
  });

  it('never overwrites an explicit prompt', () => {
    const metadata = { [TASK_PROMPT_KEY]: 'explicit', [TASK_CONTEXT_KEY]: AGENT_BODY };
    expect(splitTaskPromptFields(metadata)).toBe(metadata);
  });

  it('does not mutate the caller metadata', () => {
    const metadata = { [TASK_CONTEXT_KEY]: AGENT_BODY };
    splitTaskPromptFields(metadata);
    expect(metadata[TASK_CONTEXT_KEY]).toBe(AGENT_BODY);
    expect(metadata[TASK_PROMPT_KEY]).toBeUndefined();
  });

  it('passes through a non-object', () => {
    expect(splitTaskPromptFields(null)).toBeNull();
    expect(splitTaskPromptFields([1])).toEqual([1]);
  });
});
