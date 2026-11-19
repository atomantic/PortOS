import { describe, expect, it } from 'vitest';
import { parseLLMJSON } from './llmText.js';

describe('parseLLMJSON', () => {
  it.each([
    ['```json\n{"ok":true}\n```\n', { ok: true }],
    ['null', null],
    ['Here is the response:\n```json\n{"ok":true}\n```\nDone.', { ok: true }],
    ['Here is the list:\n[{"message":"A bracket: ]"}]\nDone.', [{ message: 'A bracket: ]' }]],
  ])('parses %j', (reply, expected) => {
    expect(parseLLMJSON(reply)).toEqual(expected);
  });

  it.each([
    'Reply: {"broken": [1}',
    'Reply: {"ok": true}\nMore: {"ok": false}',
  ])('rejects malformed or multiple JSON payloads in %j', reply => {
    expect(() => parseLLMJSON(reply)).toThrow('Invalid JSON from AI:');
  });
});
