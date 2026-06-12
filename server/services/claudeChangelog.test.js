import { describe, it, expect } from 'vitest';
import { __testing } from './claudeChangelog.js';

const { parseAtomFeed, stripHtml, extractVersion } = __testing;

// Issue #1167 replaced the sax streaming parser on this path with a focused
// regex extractor. These pin the GitHub releases.atom shapes it must handle.
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/anthropics/claude-code/releases</id>
  <title>Release notes from claude-code</title>
  <entry>
    <id>tag:github.com,2008:Repository/1/v1.2.3</id>
    <updated>2026-06-10T12:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/anthropics/claude-code/releases/tag/v1.2.3"/>
    <title>v1.2.3</title>
    <content type="html">&lt;p&gt;Fixed a bug &amp;amp; added a feature&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/v1.2.2</id>
    <updated>2026-06-09T08:30:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/anthropics/claude-code/releases/tag/v1.2.2"/>
    <title>v1.2.2</title>
    <content type="html"><![CDATA[<h2>What's Changed</h2><p>CDATA content with <b>html</b></p>]]></content>
  </entry>
</feed>`;

describe('claudeChangelog parseAtomFeed (regex extractor, issue #1167)', () => {
  it('extracts every entry with title, href link, updated, and content', () => {
    const entries = parseAtomFeed(SAMPLE);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      title: 'v1.2.3',
      link: 'https://github.com/anthropics/claude-code/releases/tag/v1.2.3',
      updated: '2026-06-10T12:00:00Z',
      // entity-escaped HTML content is decoded (literal &amp;amp; → &amp;)
      content: '<p>Fixed a bug &amp; added a feature</p>',
    });
  });

  it('returns CDATA-wrapped content verbatim (no entity decoding inside CDATA)', () => {
    const entries = parseAtomFeed(SAMPLE);
    expect(entries[1].content).toBe("<h2>What's Changed</h2><p>CDATA content with <b>html</b></p>");
    expect(entries[1].title).toBe('v1.2.2');
  });

  it('returns [] for a feed with no entries', () => {
    expect(parseAtomFeed('<feed></feed>')).toEqual([]);
    expect(parseAtomFeed('')).toEqual([]);
  });

  it('tolerates a missing link / content (empty strings, no throw)', () => {
    const xml = '<feed><entry><title>v9.9.9</title><updated>2026-01-01T00:00:00Z</updated></entry></feed>';
    expect(parseAtomFeed(xml)[0]).toEqual({ title: 'v9.9.9', link: '', updated: '2026-01-01T00:00:00Z', content: '' });
  });

  it('downstream stripHtml + extractVersion still behave on the parsed fields', () => {
    const [first] = parseAtomFeed(SAMPLE);
    expect(extractVersion(first.title)).toBe('1.2.3');
    expect(stripHtml(first.content)).toBe('Fixed a bug & added a feature');
  });
});
