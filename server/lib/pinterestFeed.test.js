/**
 * Pure tests for the Pinterest board RSS helpers — URL normalization rules and
 * per-pin extraction (image slot probing + size upgrade). No network.
 */

import { describe, it, expect } from 'vitest';
import { normalizePinterestFeedUrl, parsePinterestRss } from './pinterestFeed.js';

describe('normalizePinterestFeedUrl', () => {
  it('appends .rss to a board URL and keeps the human board URL', () => {
    expect(normalizePinterestFeedUrl('https://www.pinterest.com/jane/cyberpunk/')).toEqual({
      feedUrl: 'https://www.pinterest.com/jane/cyberpunk.rss',
      boardUrl: 'https://www.pinterest.com/jane/cyberpunk/',
      isSection: false,
    });
  });

  it('passes a .rss feed URL through (derives the board URL back)', () => {
    expect(normalizePinterestFeedUrl('https://www.pinterest.com/jane/cyberpunk.rss')).toEqual({
      feedUrl: 'https://www.pinterest.com/jane/cyberpunk.rss',
      boardUrl: 'https://www.pinterest.com/jane/cyberpunk/',
      isSection: false,
    });
  });

  it('collapses a board-section URL to the parent board feed (Pinterest has no section RSS)', () => {
    // A section path (3+ segments) has no RSS; appending .rss returns HTML → 0 pins.
    expect(normalizePinterestFeedUrl('https://www.pinterest.com/jane/cyberpunk/neon-alleys/')).toEqual({
      feedUrl: 'https://www.pinterest.com/jane/cyberpunk.rss',
      boardUrl: 'https://www.pinterest.com/jane/cyberpunk/neon-alleys/',
      isSection: true,
    });
  });

  it('collapses a section .rss URL to the parent board feed too', () => {
    expect(normalizePinterestFeedUrl('https://www.pinterest.com/jane/cyberpunk/neon-alleys.rss')).toEqual({
      feedUrl: 'https://www.pinterest.com/jane/cyberpunk.rss',
      boardUrl: 'https://www.pinterest.com/jane/cyberpunk/neon-alleys/',
      isSection: true,
    });
  });

  it('forces https and tolerates a trailing slash', () => {
    expect(normalizePinterestFeedUrl('http://pinterest.com/jane/board').feedUrl)
      .toBe('https://pinterest.com/jane/board.rss');
  });

  it('accepts a country subdomain of pinterest.com', () => {
    expect(normalizePinterestFeedUrl('https://br.pinterest.com/jane/board/').feedUrl)
      .toBe('https://br.pinterest.com/jane/board.rss');
  });

  it('accepts a two-part-TLD Pinterest domain (pinterest.co.uk)', () => {
    expect(normalizePinterestFeedUrl('https://pinterest.co.uk/jane/board/').feedUrl)
      .toBe('https://pinterest.co.uk/jane/board.rss');
  });

  it.each([
    ['empty', ''],
    ['not a url', 'not a url'],
    ['non-pinterest host', 'https://example.com/jane/board'],
    ['pinterest look-alike (suffix)', 'https://pinterest.com.evil.com/jane/board'],
    ['pinterest as attacker subdomain label', 'https://pinterest.evil.com/jane/board'],
    ['pinterest as attacker subdomain under ccTLD', 'https://pinterest.evil.co.uk/jane/board'],
    ['attacker-registered pinterest.<tld> (not a real Pinterest domain)', 'https://pinterest.zip/jane/board'],
    ['embedded brand name', 'https://evilpinterest.com/jane/board'],
    ['ftp scheme', 'ftp://pinterest.com/jane/board'],
    ['root path only', 'https://www.pinterest.com/'],
  ])('rejects %s with a 400', (_label, input) => {
    expect(() => normalizePinterestFeedUrl(input)).toThrow();
    try { normalizePinterestFeedUrl(input); } catch (e) {
      expect(e.status).toBe(400);
      expect(e.code).toBe('INVALID_PINTEREST_URL');
    }
  });
});

describe('parsePinterestRss', () => {
  const item = (inner) => `<item>${inner}</item>`;
  const wrap = (items) => `<rss><channel><title>Board</title>${items.join('')}</channel></rss>`;

  it('extracts the img from the description HTML and upgrades 236x → 736x', () => {
    const xml = wrap([item(`
      <title>Neon alley</title>
      <link>https://www.pinterest.com/pin/111/</link>
      <description><![CDATA[<a href="/pin/111/"><img src="https://i.pinimg.com/236x/aa/bb/cc.jpg"></a> a moody alley]]></description>
      <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
    `)]);
    const pins = parsePinterestRss(xml);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      pinUrl: 'https://www.pinterest.com/pin/111/',
      imageUrl: 'https://i.pinimg.com/736x/aa/bb/cc.jpg',
      imageUrlOriginal: 'https://i.pinimg.com/236x/aa/bb/cc.jpg',
      title: 'Neon alley',
      description: 'a moody alley',
    });
  });

  it('extracts the img from an entity-escaped description (live feed shape, no CDATA)', () => {
    // Pinterest escapes the description HTML with entities instead of CDATA.
    const xml = wrap([item(`
      <title>点击查看大图</title>
      <link>https://www.pinterest.com/pin/201465783329049465/</link>
      <description>&lt;a href=&quot;https://www.pinterest.com/pin/201465783329049465/&quot;&gt;&lt;img src=&quot;https://i.pinimg.com/236x/a2/6a/00/a26a00dc0156784e3ab7188b95301bcd.jpg&quot;&gt;&lt;/a&gt;</description>
    `)]);
    const pins = parsePinterestRss(xml);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      pinUrl: 'https://www.pinterest.com/pin/201465783329049465/',
      imageUrl: 'https://i.pinimg.com/736x/a2/6a/00/a26a00dc0156784e3ab7188b95301bcd.jpg',
      imageUrlOriginal: 'https://i.pinimg.com/236x/a2/6a/00/a26a00dc0156784e3ab7188b95301bcd.jpg',
    });
  });

  it('prefers <media:content> over an <img>, and decodes &amp; in URLs', () => {
    const xml = wrap([item(`
      <link>https://www.pinterest.com/pin/222/</link>
      <media:content url="https://i.pinimg.com/736x/x.jpg?a=1&amp;b=2" />
      <description><![CDATA[<img src="https://i.pinimg.com/236x/ignored.jpg">]]></description>
    `)]);
    const pins = parsePinterestRss(xml);
    expect(pins[0].imageUrl).toBe('https://i.pinimg.com/736x/x.jpg?a=1&b=2');
  });

  it('falls back to <enclosure> when there is no media:content or img', () => {
    const xml = wrap([item(`
      <link>https://www.pinterest.com/pin/333/</link>
      <enclosure url="https://i.pinimg.com/474x/e.jpg" type="image/jpeg" length="1" />
      <description><![CDATA[no img here]]></description>
    `)]);
    expect(parsePinterestRss(xml)[0].imageUrl).toBe('https://i.pinimg.com/736x/e.jpg');
  });

  it('skips items with no image or no permalink', () => {
    const xml = wrap([
      item(`<link>https://www.pinterest.com/pin/444/</link><description>no image</description>`),
      item(`<description><![CDATA[<img src="https://i.pinimg.com/236x/z.jpg">]]></description>`),
    ]);
    expect(parsePinterestRss(xml)).toEqual([]);
  });

  it('returns [] for non-string / empty input', () => {
    expect(parsePinterestRss('')).toEqual([]);
    expect(parsePinterestRss(null)).toEqual([]);
  });
});
