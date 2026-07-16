/**
 * SongBook import extractor tests.
 *
 * All fixtures are INVENTED ("Example Song" by "The Placeholders") — never
 * real scraped page content, and no real URLs beyond example.com.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/safeUrlFetch.js', () => ({
  fetchPublicText: vi.fn(),
}));

import { fetchPublicText } from '../lib/safeUrlFetch.js';
import {
  stripUgMarkers,
  extractUltimateGuitarStore,
  extractLargestPre,
  parseTitleArtist,
  buildDraftFromHtml,
  importSongFromUrl,
} from './brainSongbookImport.js';

// Build an invented UG-shaped page: js-store div with entity-encoded JSON.
const encodeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const UG_CONTENT = '[tab][ch]C[/ch]      [ch]G[/ch]\nExample lyric line one[/tab]\n[tab][ch]Am[/ch]     [ch]F[/ch]\nExample lyric line two[/tab]';

const buildUgHtml = (storeJson, title = 'EXAMPLE SONG CHORDS by The Placeholders @ Ultimate-Guitar.Com') =>
  `<html><head><title>${title}</title></head><body>` +
  `<div class="js-store" data-content="${encodeAttr(JSON.stringify(storeJson))}"></div>` +
  '</body></html>';

const UG_STORE = {
  store: {
    page: {
      data: {
        tab: { song_name: 'Example Song', artist_name: 'The Placeholders' },
        tab_view: { wiki_tab: { content: UG_CONTENT } },
      },
    },
  },
};

describe('stripUgMarkers', () => {
  it('strips [ch]/[tab] markers but keeps the sheet text', () => {
    expect(stripUgMarkers('[tab][ch]Am[/ch] hello[/tab]')).toBe('Am hello');
  });
});

describe('extractUltimateGuitarStore', () => {
  it('extracts content + song/artist names from the js-store JSON', () => {
    const result = extractUltimateGuitarStore(buildUgHtml(UG_STORE));
    expect(result).not.toBeNull();
    expect(result.title).toBe('Example Song');
    expect(result.artist).toBe('The Placeholders');
    expect(result.text).toContain('C      G');
    expect(result.text).toContain('Example lyric line one');
    expect(result.text).not.toContain('[ch]');
    expect(result.text).not.toContain('[tab]');
  });

  it('tolerates the shape without the top-level store key', () => {
    const result = extractUltimateGuitarStore(buildUgHtml(UG_STORE.store));
    expect(result?.title).toBe('Example Song');
  });

  it('returns null when there is no js-store div', () => {
    expect(extractUltimateGuitarStore('<html><body><p>nothing</p></body></html>')).toBeNull();
  });

  it('returns null on shape drift (missing wiki_tab)', () => {
    const drifted = { store: { page: { data: { tab: { song_name: 'X' } } } } };
    expect(extractUltimateGuitarStore(buildUgHtml(drifted))).toBeNull();
  });

  it('returns null on malformed JSON in data-content', () => {
    const html = '<div class="js-store" data-content="{not json"></div>';
    expect(extractUltimateGuitarStore(html)).toBeNull();
  });

  it('returns null when content is present but empty', () => {
    const empty = { store: { page: { data: { tab_view: { wiki_tab: { content: '   ' } } } } } };
    expect(extractUltimateGuitarStore(buildUgHtml(empty))).toBeNull();
  });

  it('returns null when content is marker-only and strips to nothing', () => {
    const markerOnly = { store: { page: { data: { tab_view: { wiki_tab: { content: '[tab][/tab]' } } } } } };
    expect(extractUltimateGuitarStore(buildUgHtml(markerOnly))).toBeNull();
  });
});

describe('extractLargestPre', () => {
  it('picks the largest <pre> and decodes entities', () => {
    const html = '<pre>short but long enough tab</pre>' +
      '<pre class="tab">e|--0--2--3--|\nB|--1--1--0--|\nG &amp; D strings</pre>';
    const result = extractLargestPre(html);
    expect(result).toContain('e|--0--2--3--|');
    expect(result).toContain('G & D strings');
  });

  it('decodes named, decimal, and hex entities without double-decoding', () => {
    const html = '<pre>&lt;b&gt; &quot;hi&quot; &#39;x&#39; &#x41; &amp;lt; and padding</pre>';
    expect(extractLargestPre(html)).toBe('<b> "hi" \'x\' A &lt; and padding');
  });

  it('leaves out-of-range numeric entities untouched (never throws)', () => {
    const html = '<pre>&#x110000; still a long enough sheet</pre>';
    expect(extractLargestPre(html)).toBe('&#x110000; still a long enough sheet');
  });

  it('strips inner markup tags', () => {
    const html = '<pre><span class="chord">Am</span> example lyric line here</pre>';
    expect(extractLargestPre(html)).toBe('Am example lyric line here');
  });

  it('returns null when the only <pre> is too small to be a sheet', () => {
    expect(extractLargestPre('<pre>x = 1;</pre>')).toBeNull();
  });

  it('returns null with no <pre> at all', () => {
    expect(extractLargestPre('<p>hello</p>')).toBeNull();
  });
});

describe('parseTitleArtist', () => {
  it('parses "X CHORDS by Y @ site" titles', () => {
    const html = '<title>EXAMPLE SONG CHORDS (ver 2) by The Placeholders @ Ultimate-Guitar.Com</title>';
    expect(parseTitleArtist(html)).toEqual({ title: 'EXAMPLE SONG', artist: 'The Placeholders' });
  });

  it('parses "X - Y" titles', () => {
    expect(parseTitleArtist('<title>Example Song - The Placeholders | TabSite</title>'))
      .toEqual({ title: 'Example Song', artist: 'The Placeholders' });
  });

  it('returns empty fields when there is no title tag', () => {
    expect(parseTitleArtist('<html></html>')).toEqual({ title: '', artist: '' });
  });
});

describe('buildDraftFromHtml', () => {
  const URL = 'https://www.example.com/tab/example-song-1';

  it('prefers the UG extractor and stamps sourceUrl', () => {
    const draft = buildDraftFromHtml(buildUgHtml(UG_STORE), URL);
    expect(draft.title).toBe('Example Song');
    expect(draft.artist).toBe('The Placeholders');
    expect(draft.content.format).toBe('tab');
    expect(draft.content.text).toContain('Example lyric line one');
    expect(draft.sourceUrl).toBe(URL);
  });

  it('falls back to the largest <pre> with title/artist from <title>', () => {
    const html = '<html><head><title>Example Song by The Placeholders</title></head>' +
      '<body><pre>e|--0--2--3--| example tab staff</pre></body></html>';
    const draft = buildDraftFromHtml(html, URL);
    expect(draft.content.format).toBe('tab');
    expect(draft.content.text).toContain('e|--0--2--3--|');
    expect(draft.title).toBe('Example Song');
    expect(draft.artist).toBe('The Placeholders');
  });

  it('falls through UG shape drift to the <pre> extractor', () => {
    const drifted = { store: { page: { data: {} } } };
    const html = buildUgHtml(drifted).replace('</body>', '<pre>Am F C G — example progression sheet</pre></body>');
    const draft = buildDraftFromHtml(html, URL);
    expect(draft.content.format).toBe('tab');
    expect(draft.content.text).toContain('example progression sheet');
  });

  it('falls through marker-only UG content to a real <pre> on the page', () => {
    // The js-store gate must key on the POST-strip text: "[tab][/tab]" strips
    // to nothing, so the cascade continues to the <pre> instead of 422-ing.
    const markerOnly = { store: { page: { data: { tab_view: { wiki_tab: { content: '[tab][/tab]' } } } } } };
    const html = buildUgHtml(markerOnly).replace('</body>', '<pre>e|--0--2--3--| example tab staff</pre></body>');
    const draft = buildDraftFromHtml(html, URL);
    expect(draft.content.format).toBe('tab');
    expect(draft.content.text).toContain('e|--0--2--3--|');
  });

  it('falls back to plain tag-stripped text when nothing else matches', () => {
    const html = '<html><head><title>Example Song - The Placeholders</title><style>.x{}</style></head>' +
      '<body><script>var a = 1;</script><p>Just some lyric text on a plain page</p></body></html>';
    const draft = buildDraftFromHtml(html, URL);
    expect(draft.content.format).toBe('plain');
    expect(draft.content.text).toBe('Just some lyric text on a plain page');
    expect(draft.content.text).not.toContain('var a');
  });
});

describe('importSongFromUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches via safeUrlFetch and returns the draft', async () => {
    fetchPublicText.mockResolvedValue(buildUgHtml(UG_STORE));
    const draft = await importSongFromUrl('https://www.example.com/tab/1');
    expect(fetchPublicText).toHaveBeenCalledWith('https://www.example.com/tab/1', expect.objectContaining({
      timeoutMs: expect.any(Number),
    }));
    expect(draft.title).toBe('Example Song');
    expect(draft.sourceUrl).toBe('https://www.example.com/tab/1');
  });

  it('throws 502 when the fetch fails closed (null)', async () => {
    fetchPublicText.mockResolvedValue(null);
    await expect(importSongFromUrl('https://www.example.com/tab/1'))
      .rejects.toMatchObject({ status: 502, code: 'SONG_IMPORT_FETCH_FAILED' });
  });

  it('throws 422 when the page yields no content at all', async () => {
    fetchPublicText.mockResolvedValue('<html><head><title>Empty</title></head><body></body></html>');
    await expect(importSongFromUrl('https://www.example.com/tab/1'))
      .rejects.toMatchObject({ status: 422, code: 'SONG_IMPORT_EMPTY' });
  });
});
