import { describe, it, expect } from 'vitest';
import { greyboxContractInstructions, greyboxPrompt, greyboxPlaceBlock, greyboxCurrentBlock, parseGreyboxAnswer } from './greyboxPrompt.js';

const scene = { parts: [{ id: 'floor', type: 'box', size: [10, 0.1, 10] }], shots: [{ id: 'wide', label: 'Wide', position: [0, 3, 10], target: [0, 0, 0] }] };

describe('parseGreyboxAnswer', () => {
  it('reads a fenced answer wrapped in prose', () => {
    expect(parseGreyboxAnswer(`Here you go:\n\`\`\`json\n${JSON.stringify(scene)}\n\`\`\`\nEnjoy`).parts[0].id).toBe('floor');
  });
  it('names the first problem for an invalid scene and for non-JSON', () => {
    expect(() => parseGreyboxAnswer(JSON.stringify({ parts: [] }))).toThrow(/at least one part/);
    expect(() => parseGreyboxAnswer('no scene')).toThrow(/JSON/);
  });
});

describe('greyboxPrompt', () => {
  it('sends the user request verbatim after the visible blocks, with the current scene only for an edit', () => {
    const instructions = greyboxContractInstructions();
    const placeBlock = greyboxPlaceBlock({ name: 'Rink', description: 'Roller rink' });
    const create = greyboxPrompt({ instructions, placeBlock, currentBlock: '', request: 'Add a DJ booth' });
    expect(create.endsWith('Request:\nAdd a DJ booth')).toBe(true);
    expect(create).not.toMatch(/Current greybox/);
    const edit = greyboxPrompt({ instructions, placeBlock, currentBlock: greyboxCurrentBlock(scene), request: 'Add a DJ booth' });
    expect(edit).toMatch(/Current greybox \(JSON\)/);
    expect(edit.endsWith('Requested change:\nAdd a DJ booth')).toBe(true);
  });
});
