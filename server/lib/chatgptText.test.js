import { describe, expect, it } from 'vitest';
import { stripChatgptCitations } from './chatgptText.js';

describe('ChatGPT citation cleanup', () => {
  it('removes complete single and multi-source tokens without changing surrounding Markdown', () => {
    const input = 'A citeturn1search0 and B.citeturn2search3turn2search4\n\n[Source](https://example.com)\n![Image](/data/brain-imports/example.png)';
    const expected = 'A  and B.\n\n[Source](https://example.com)\n![Image](/data/brain-imports/example.png)';
    expect(stripChatgptCitations(input)).toBe(expected);
    expect(stripChatgptCitations(expected)).toBe(expected);
  });

  it('removes unterminated reference IDs at line boundaries without consuming the following prose', () => {
    expect(stripChatgptCitations('Answer.citeturn1search0turn2view1\n\nKeep this.\nciteturn3search2')).toBe('Answer.\n\nKeep this.\n');
  });

  it('removes a token cut by the legacy import preview limit', () => {
    const footer = '\n\n…(transcript truncated — open the full conversation to see everything)';
    expect(stripChatgptCitations(`Answer.citeturn1sea${footer}`)).toBe(`Answer.${footer}`);
  });

  it('preserves unrelated private-use markup and incomplete tokens rather than eating prose', () => {
    const text = 'imageexample citeunfinished\nKeep this. citeturn1search0';
    expect(stripChatgptCitations(text)).toBe('imageexample citeunfinished\nKeep this. ');
  });
});
