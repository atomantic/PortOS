import { describe, it, expect } from 'vitest';
import {
  firstWords,
  lastWords,
  firstSentences,
  extractDialogueLines,
  buildIssueDigest,
  renderDigestText,
  __testing,
} from './readerPanelDigest.js';

const words = (n) => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ');

describe('excerpt helpers', () => {
  it('firstWords caps and ellipsizes past the limit', () => {
    expect(firstWords(words(10), 5)).toBe('w1 w2 w3 w4 w5…');
    expect(firstWords(words(3), 5)).toBe('w1 w2 w3');
    expect(firstWords('', 5)).toBe('');
  });

  it('lastWords takes the tail with a leading ellipsis', () => {
    expect(lastWords(words(10), 3)).toBe('…w8 w9 w10');
    expect(lastWords(words(2), 3)).toBe('w1 w2');
  });

  it('firstSentences takes N sentences and strips markdown', () => {
    const text = '## Heading\nOne happened. Two happened! Three? Four.';
    const out = firstSentences(text, 2);
    expect(out).toContain('One happened.');
    expect(out).toContain('Two happened!');
    expect(out).not.toContain('Three');
    expect(out).not.toContain('#');
  });
});

describe('extractDialogueLines', () => {
  it('pulls deduped quoted lines within the length window, capped', () => {
    const text = 'She said "I will not go back there tonight." He replied "I understand." "I will not go back there tonight." said again. "Short" "This is another distinct spoken line of dialogue."';
    const lines = extractDialogueLines(text, 3);
    expect(lines).toContain('I will not go back there tonight.');
    expect(lines).toContain('I understand.');
    // "Short" is below the 8-char floor, so it's excluded
    expect(lines).not.toContain('Short');
    // dedupe: the repeated line appears once
    expect(lines.filter((l) => l === 'I will not go back there tonight.')).toHaveLength(1);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('handles curly quotes and no-dialogue text', () => {
    expect(extractDialogueLines('He walked in silence to the door.')).toEqual([]);
    expect(extractDialogueLines('“A curly-quoted line of dialogue here.”')).toEqual(['A curly-quoted line of dialogue here.']);
  });
});

describe('buildIssueDigest', () => {
  const text = 'The rain fell hard. She ran. "We have to move now," he said, breathless. They vanished into the dark alley and were gone.';

  it('produces the digest shape with summary, opening, closing, dialogue', () => {
    const d = buildIssueDigest({ number: 3, title: 'The Chase', text, scenes: [] });
    expect(d).toMatchObject({ number: 3, title: 'The Chase', sceneCount: 0 });
    expect(typeof d.summary).toBe('string');
    expect(d.summary.length).toBeGreaterThan(0);
    expect(typeof d.opening).toBe('string');
    expect(typeof d.closing).toBe('string');
    expect(Array.isArray(d.dialogue)).toBe(true);
    expect(d.dialogue).toContain('We have to move now,');
  });

  it('prefers scene summaries over the drafted text for the summary', () => {
    const scenes = [{ summary: 'A daring escape through the storm.' }, { summary: 'They regroup in safety.' }];
    const d = buildIssueDigest({ number: 3, title: 'The Chase', text, scenes });
    expect(d.summary).toContain('A daring escape through the storm.');
    expect(d.sceneCount).toBe(2);
  });

  it('falls back to first sentences when no scenes', () => {
    const d = buildIssueDigest({ number: 1, title: 'Open', text, scenes: [] });
    expect(d.summary).toContain('The rain fell hard.');
  });
});

describe('renderDigestText', () => {
  it('renders each issue block with its sections', () => {
    const digest = {
      issues: [
        { number: 1, title: 'A', summary: 'sum', opening: 'open', closing: 'close', dialogue: ['line one here'] },
        { number: 2, title: 'B', summary: 'sum2', opening: '', closing: '', dialogue: [] },
      ],
    };
    const out = renderDigestText(digest);
    expect(out).toContain('### Issue #1: A');
    expect(out).toContain('Summary: sum');
    expect(out).toContain('Opening: open');
    expect(out).toContain('“line one here”');
    expect(out).toContain('### Issue #2: B');
  });
});

describe('digestContentHash', () => {
  it('is stable to ordering and changes with content', () => {
    const a = __testing.digestContentHash([{ number: 1, text: 'x' }, { number: 2, text: 'y' }]);
    const b = __testing.digestContentHash([{ number: 2, text: 'y' }, { number: 1, text: 'x' }]);
    const c = __testing.digestContentHash([{ number: 1, text: 'x' }, { number: 2, text: 'z' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
