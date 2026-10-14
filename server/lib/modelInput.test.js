import { describe, expect, it } from 'vitest';
import { agentInstructionsAddition, promptAddition, promptAdditionsSchema, sentPromptRecord } from './modelInput.js';

describe('promptAdditionsSchema', () => {
  // A multipart image request (an uploaded reference) carries the list as one JSON string.
  it('accepts the list as an array or as a multipart JSON string', () => {
    const list = [{ id: 'style', label: 'Universe style', text: 'muted earth tones' }];
    expect(promptAdditionsSchema.parse(list)).toEqual(list);
    expect(promptAdditionsSchema.parse(JSON.stringify(list))).toEqual(list);
    expect(promptAdditionsSchema.parse(undefined)).toBeUndefined();
  });

  it('refuses a malformed string rather than dropping it', () => {
    expect(() => promptAdditionsSchema.parse('not json')).toThrow();
    expect(() => promptAdditionsSchema.parse([{ id: 'x', label: 'X', text: '' }])).toThrow();
  });
});

describe('promptAddition', () => {
  // #11317: a chip used to stop at 20,000 characters, so a long bible showed cut off.
  it('keeps a long block whole and round-trips it through the request schema', () => {
    const text = 'b'.repeat(50000);
    const addition = promptAddition('bible', 'Production bible', text);
    expect(addition.text).toHaveLength(50000);
    expect(promptAdditionsSchema.parse([addition])[0].text).toHaveLength(50000);
  });
});

describe('sentPromptRecord', () => {
  it('keeps carried additions ahead of the backend ones and drops empty ones', () => {
    const carried = [{ id: 'style', label: 'Style preset', text: 'film grain' }];
    const record = sentPromptRecord({
      sentPrompt: 'a fox, film grain',
      sentNegativePrompt: '  ',
      carried,
      added: [null, { id: 'lora-triggers', label: 'LoRA trigger words', text: 'fxstyle' }],
    });
    expect(record).toEqual({
      sentPrompt: 'a fox, film grain',
      promptAdditions: [carried[0], { id: 'lora-triggers', label: 'LoRA trigger words', text: 'fxstyle' }],
    });
  });
});

describe('agentInstructionsAddition', () => {
  // Review on #11326: replacing the prompt text by search garbled the chip when a
  // short prompt ("image") also appeared inside the wrapper ("$imagegen").
  it('marks only the spot the builder puts the prompt, even when the wrapper repeats its words', () => {
    const buildWith = (text) => `$imagegen ${text} of a cat. Aspect ratio 16:9`;
    expect(agentInstructionsAddition('Codex image tool instructions', buildWith).text)
      .toBe('$imagegen [prompt] of a cat. Aspect ratio 16:9');
  });
});
