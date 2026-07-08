import { describe, it, expect } from 'vitest';
import {
  resolveHistoryInstant,
  normalizeTransition,
  isSubframeTransition,
  hostnameOf,
  historyVisitToCandidate,
  extractHistoryRecords,
  browserHistoryCandidates,
  summarizeBrowserCandidates,
  parseHistoryJsonText,
} from './browserHistoryImport.js';

// A Google Takeout Chrome `History.json` export.
const historyFile = {
  'Browser History': [
    {
      page_transition: 'LINK',
      title: 'Example Domain',
      url: 'https://example.com/page?q=1',
      client_id: 'abc',
      time_usec: 1614624300000000, // 2021-03-01T18:45:00Z
    },
    {
      page_transition: 'TYPED',
      title: 'News',
      url: 'https://news.example.org/story',
      time_usec: 1614624400000000,
    },
    // A subframe (iframe/ad) load — must be dropped.
    {
      page_transition: 'AUTO_SUBFRAME',
      title: 'Ad frame',
      url: 'https://ads.example.net/frame',
      time_usec: 1614624500000000,
    },
    // No URL — must be dropped.
    { page_transition: 'LINK', title: 'orphan', time_usec: 1614624600000000 },
  ],
  Favicons: [{ url: 'https://example.com/favicon.ico' }], // ignored key
};

describe('resolveHistoryInstant', () => {
  it('converts epoch microseconds to a UTC ISO string', () => {
    expect(resolveHistoryInstant(1614624300000000)).toBe('2021-03-01T18:45:00.000Z');
  });
  it('accepts a numeric string', () => {
    expect(resolveHistoryInstant('1614624300000000')).toBe('2021-03-01T18:45:00.000Z');
  });
  it('returns null for nullish / blank / non-positive values', () => {
    expect(resolveHistoryInstant(null)).toBeNull();
    expect(resolveHistoryInstant(undefined)).toBeNull();
    expect(resolveHistoryInstant('')).toBeNull();
    expect(resolveHistoryInstant(0)).toBeNull();
    expect(resolveHistoryInstant(-5)).toBeNull();
    expect(resolveHistoryInstant('nope')).toBeNull();
  });
});

describe('normalizeTransition / isSubframeTransition', () => {
  it('upper-snakes a transition token', () => {
    expect(normalizeTransition('link')).toBe('LINK');
    expect(normalizeTransition(' auto_subframe ')).toBe('AUTO_SUBFRAME');
    expect(normalizeTransition('')).toBeNull();
    expect(normalizeTransition(null)).toBeNull();
  });
  it('flags subframe transitions only', () => {
    expect(isSubframeTransition('AUTO_SUBFRAME')).toBe(true);
    expect(isSubframeTransition('manual_subframe')).toBe(true);
    expect(isSubframeTransition('LINK')).toBe(false);
    expect(isSubframeTransition(null)).toBe(false);
  });
});

describe('hostnameOf', () => {
  it('extracts the hostname', () => {
    expect(hostnameOf('https://news.example.org/story?x=1')).toBe('news.example.org');
  });
  it('returns null for unparseable / non-http values', () => {
    expect(hostnameOf('not a url')).toBeNull();
    expect(hostnameOf('')).toBeNull();
    expect(hostnameOf(null)).toBeNull();
    // chrome://newtab parses but has no hostname
    expect(hostnameOf('chrome://newtab/')).toBeNull();
  });
});

describe('historyVisitToCandidate', () => {
  it('maps a normal visit to a web.visit candidate', () => {
    const c = historyVisitToCandidate(historyFile['Browser History'][0]);
    expect(c).toMatchObject({
      source: 'browser',
      kind: 'web.visit',
      happenedAt: '2021-03-01T18:45:00.000Z',
      title: 'Example Domain',
      summary: 'example.com',
      url: 'https://example.com/page?q=1',
    });
    expect(c.dedupeKey).toMatch(/^browser:[0-9a-f]{24}$/);
    expect(c.metadata).toMatchObject({ host: 'example.com', transition: 'LINK' });
  });
  it('drops subframe loads', () => {
    expect(historyVisitToCandidate(historyFile['Browser History'][2])).toBeNull();
  });
  it('drops records without a URL', () => {
    expect(historyVisitToCandidate(historyFile['Browser History'][3])).toBeNull();
  });
  it('drops records without a usable timestamp', () => {
    expect(historyVisitToCandidate({ url: 'https://x.com', time_usec: 0 })).toBeNull();
  });
  it('falls back to the hostname when the title is empty', () => {
    const c = historyVisitToCandidate({ url: 'https://only.example/', time_usec: 1614624300000000 });
    expect(c.title).toBe('only.example');
  });
  it('produces a stable dedupe key for the same instant + URL', () => {
    const rec = { url: 'https://a.com/', time_usec: 1614624300000000, page_transition: 'LINK' };
    expect(historyVisitToCandidate(rec).dedupeKey).toBe(historyVisitToCandidate(rec).dedupeKey);
  });
});

describe('extractHistoryRecords', () => {
  it('reads the "Browser History" wrapper', () => {
    expect(extractHistoryRecords(historyFile)).toHaveLength(4);
  });
  it('reads a bare top-level array', () => {
    expect(extractHistoryRecords([{ url: 'x' }])).toHaveLength(1);
  });
  it('returns [] for non-object / missing shapes', () => {
    expect(extractHistoryRecords(null)).toEqual([]);
    expect(extractHistoryRecords({})).toEqual([]);
    expect(extractHistoryRecords(42)).toEqual([]);
  });
});

describe('browserHistoryCandidates + summarizeBrowserCandidates', () => {
  it('maps a file, dropping subframe + url-less records', () => {
    const candidates = browserHistoryCandidates(extractHistoryRecords(historyFile));
    expect(candidates).toHaveLength(2); // LINK + TYPED; subframe & url-less dropped
    expect(candidates.map((c) => c.kind)).toEqual(['web.visit', 'web.visit']);
  });
  it('summarizes counts, unique hosts, range, and top hosts', () => {
    const candidates = browserHistoryCandidates(extractHistoryRecords(historyFile));
    const summary = summarizeBrowserCandidates(candidates);
    expect(summary.visits).toBe(2);
    expect(summary.uniqueHosts).toBe(2);
    expect(summary.from).toBe('2021-03-01T18:45:00.000Z');
    expect(summary.to).toBe('2021-03-01T18:46:40.000Z');
    expect(summary.topHosts).toEqual(
      expect.arrayContaining([{ name: 'example.com', count: 1 }, { name: 'news.example.org', count: 1 }]),
    );
  });
  it('returns an empty summary for no candidates', () => {
    expect(summarizeBrowserCandidates([])).toMatchObject({ visits: 0, uniqueHosts: 0, from: null, to: null });
  });
});

describe('parseHistoryJsonText', () => {
  it('round-trips through JSON', () => {
    expect(parseHistoryJsonText(JSON.stringify(historyFile))['Browser History']).toHaveLength(4);
  });
});
