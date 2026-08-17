import { describe, expect, it } from 'vitest';
import { transcriptTeaser } from './MemoryTab.jsx';

describe('transcriptTeaser', () => {
  it('returns empty for non-strings', () => {
    expect(transcriptTeaser(null)).toBe('');
    expect(transcriptTeaser(undefined)).toBe('');
    expect(transcriptTeaser(42)).toBe('');
  });

  it('strips markdown images and link targets, keeps labels', () => {
    const out = transcriptTeaser('Hello ![img](http://x/y.png) and [docs](http://example.com/a).');
    expect(out).toBe('Hello and docs.');
    expect(out).not.toMatch(/http/);
  });

  it('collapses whitespace and truncates with an ellipsis', () => {
    const long = `${'word '.repeat(80)}end`;
    const out = transcriptTeaser(long, 40);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
  });

  it('leaves short plain text unchanged', () => {
    expect(transcriptTeaser('Short note.')).toBe('Short note.');
  });
});
// @vitest-environment node
