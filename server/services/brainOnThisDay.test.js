import { describe, it, expect } from 'vitest';
import { collectOnThisDay, snippetOf } from './brainOnThisDay.js';

const TZ = 'America/Los_Angeles';
const TODAY = '2026-09-01';

describe('snippetOf', () => {
  it('flattens markdown chrome and collapses whitespace', () => {
    expect(snippetOf('# Heading\n\n- did a [thing](https://example.com)\n> quote')).toBe('Heading did a thing quote');
    expect(snippetOf('**Big day** — shipped `it` with ![pic](img.png)')).toBe('Big day — shipped it with pic');
  });

  it('drops fenced code blocks and truncates with an ellipsis', () => {
    const long = `intro ${'word '.repeat(60)}`;
    expect(snippetOf('```js\nsecret()\n```\nafter')).toBe('after');
    const out = snippetOf(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty for non-strings and whitespace-only bodies', () => {
    expect(snippetOf(null)).toBe('');
    expect(snippetOf('   \n  ')).toBe('');
  });
});

describe('collectOnThisDay', () => {
  it('matches journals by month-day in prior years only', () => {
    const items = collectOnThisDay({
      today: TODAY,
      timezone: TZ,
      journals: [
        { date: '2024-09-01', content: 'two years back' },
        { date: '2025-09-01', content: 'one year back' },
        { date: '2026-09-01', content: 'today itself' },
        { date: '2025-08-31', content: 'wrong day' },
        { date: '2025-09-01', content: '   ' },
      ],
    });
    expect(items.map((i) => [i.type, i.date, i.yearsAgo])).toEqual([
      ['journal', '2025-09-01', 1],
      ['journal', '2024-09-01', 2],
    ]);
  });

  it('converts memory/idea timestamps through the user timezone', () => {
    // 2025-09-02T04:30Z is still Sep 1 in Los Angeles — it must match.
    // 2025-09-01T04:30Z is Aug 31 local — it must not.
    const items = collectOnThisDay({
      today: TODAY,
      timezone: TZ,
      memories: [
        { id: 'm1', title: 'Late night', content: 'body', createdAt: '2025-09-02T04:30:00.000Z' },
        { id: 'm2', title: 'Wrong local day', content: 'body', createdAt: '2025-09-01T04:30:00.000Z' },
      ],
      ideas: [
        { id: 'i1', title: 'Spark', oneLiner: 'the pitch', createdAt: '2024-09-01T18:00:00.000Z' },
      ],
    });
    expect(items.map((i) => [i.type, i.id, i.yearsAgo])).toEqual([
      ['memory', 'm1', 1],
      ['idea', 'i1', 2],
    ]);
    expect(items[0].date).toBe('2025-09-01');
  });

  it('prefers sourceCreatedAt for imported memories and skips unparseable stamps', () => {
    const items = collectOnThisDay({
      today: TODAY,
      timezone: TZ,
      memories: [
        // createdAt is the import time (today); sourceCreatedAt is the real capture.
        { id: 'm1', title: 'Imported', sourceCreatedAt: '2023-09-01T20:00:00.000Z', createdAt: '2026-08-30T00:00:00.000Z' },
        { id: 'm2', title: 'Broken stamp', createdAt: 'not-a-date' },
        { id: 'm3', createdAt: '2023-09-01T20:00:00.000Z' },
      ],
    });
    expect(items).toEqual([
      { type: 'memory', id: 'm1', date: '2023-09-01', yearsAgo: 3, title: 'Imported', snippet: '' },
    ]);
  });

  it('sorts most recent year first, journal before memory before idea within a year', () => {
    const items = collectOnThisDay({
      today: TODAY,
      timezone: TZ,
      journals: [{ date: '2025-09-01', content: 'journal' }],
      ideas: [{ id: 'i1', title: 'Idea', oneLiner: 'x', createdAt: '2025-09-01T18:00:00.000Z' }],
      memories: [{ id: 'm1', title: 'Memory', createdAt: '2025-09-01T18:00:00.000Z' }],
    });
    expect(items.map((i) => i.type)).toEqual(['journal', 'memory', 'idea']);
  });
});
