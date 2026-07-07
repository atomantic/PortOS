/**
 * proseExport.test.js — pure-helper tests for the prose-series export (#2181):
 * volume grouping/order, manuscript-markdown shape, XHTML/OPF/nav ePub parts,
 * word-wrap, and a full ePub zip round-trip through the parser.
 */

import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'stream';
import { __testing } from './proseExport.js';
import { createZip } from '../../lib/zipWriter.js';
import { parseZip } from '../../lib/zipStream.js';
import {
  buildOpf as buildOpfExport,
  buildNavXhtml as buildNavXhtmlExport,
  buildChapterXhtml as buildChapterXhtmlExport,
} from './proseExport.js';

const {
  groupIntoVolumes,
  buildManuscriptMarkdown,
  proseToXhtmlBody,
  buildChapterXhtml,
  buildOpf,
  buildNavXhtml,
  wrapText,
} = __testing;

const section = (over = {}) => ({
  issueId: 'i1', seasonId: null, number: 1, title: 'One', stageId: 'prose', content: 'Body one.', ...over,
});

describe('groupIntoVolumes', () => {
  it('collapses everything into one untitled volume when the series has no seasons', () => {
    const sections = [section({ number: 1 }), section({ issueId: 'i2', number: 2, title: 'Two' })];
    const volumes = groupIntoVolumes(sections, []);
    expect(volumes).toHaveLength(1);
    expect(volumes[0].title).toBe(''); // single volume → no volume break
    expect(volumes[0].sections.map((s) => s.number)).toEqual([1, 2]);
  });

  it('groups by seasonId and orders volumes by the season list, __none__ last', () => {
    const seasons = [
      { id: 'sB', number: 2, title: 'Book Two' },
      { id: 'sA', number: 1, title: 'Book One' },
    ];
    const sections = [
      section({ issueId: 'i1', number: 1, seasonId: 'sA' }),
      section({ issueId: 'i2', number: 2, seasonId: 'sB' }),
      section({ issueId: 'i3', number: 3, seasonId: null }), // orphan → __none__
    ];
    const volumes = groupIntoVolumes(sections, seasons);
    // Season-list order: sB then sA, then the orphan bucket.
    expect(volumes.map((v) => v.title)).toEqual(['Book Two', 'Book One', 'Volume 3']);
    expect(volumes[0].sections.map((s) => s.number)).toEqual([2]);
    expect(volumes[2].sections.map((s) => s.number)).toEqual([3]);
  });

  it('routes an unknown seasonId into the trailing __none__ bucket (nothing dropped)', () => {
    const seasons = [{ id: 'sA', number: 1, title: 'A' }];
    const sections = [section({ number: 1, seasonId: 'ghost' })];
    const volumes = groupIntoVolumes(sections, seasons);
    expect(volumes).toHaveLength(1);
    expect(volumes[0].sections.map((s) => s.number)).toEqual([1]);
  });
});

describe('buildManuscriptMarkdown', () => {
  const settings = {
    trimSize: 'us-trade', interiorFont: 'times',
    titlePageTitle: 'My Book', titlePageSubtitle: 'A Tale', titlePageAuthor: 'Ada',
    copyright: '', dedication: 'For no one.',
  };

  it('emits YAML front matter, no volume break for a single volume, and chapter headings', () => {
    const volumes = groupIntoVolumes([section({ number: 1, title: 'Beginnings' })], []);
    const md = buildManuscriptMarkdown({ series: { name: 'My Book' }, volumes }, settings);
    expect(md).toMatch(/^---\ntitle: My Book\n/);
    expect(md).toContain('author: Ada');
    expect(md).toContain('> For no one.');
    expect(md).not.toMatch(/^# /m); // no volume-level heading for one volume
    expect(md).toContain('## Chapter 1 — Beginnings');
    expect(md).toContain('Body one.');
  });

  it('emits a # volume break for multi-volume series', () => {
    const seasons = [{ id: 'sA', number: 1, title: 'Book One' }, { id: 'sB', number: 2, title: 'Book Two' }];
    const sections = [
      section({ issueId: 'i1', number: 1, seasonId: 'sA' }),
      section({ issueId: 'i2', number: 2, seasonId: 'sB', title: 'Two' }),
    ];
    const volumes = groupIntoVolumes(sections, seasons);
    const md = buildManuscriptMarkdown({ series: { name: 'X' }, volumes }, settings);
    expect(md).toContain('# Book One');
    expect(md).toContain('# Book Two');
  });
});

describe('proseToXhtmlBody', () => {
  it('splits blank-line blocks into <p> and single newlines into <br/>', () => {
    const body = proseToXhtmlBody('First para.\nStill first.\n\nSecond para.');
    expect(body).toBe('<p>First para.<br/>Still first.</p>\n<p>Second para.</p>');
  });
  it('escapes XML special characters', () => {
    expect(proseToXhtmlBody('A & B < C > "D"')).toContain('A &amp; B &lt; C &gt; &quot;D&quot;');
  });
  it('returns an empty paragraph for empty content', () => {
    expect(proseToXhtmlBody('')).toBe('<p></p>');
  });
});

describe('buildChapterXhtml / buildNavXhtml / buildOpf', () => {
  const vol = { id: 'sA', number: 1, title: 'Book One', sections: [section({ number: 3, title: 'Three', content: 'Prose.' })] };

  it('renders a valid-looking XHTML chapter with a chapter heading', () => {
    const xhtml = buildChapterXhtml(vol, { multiVolume: true });
    expect(xhtml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xhtml).toContain('<h1 class="volume-title">Book One</h1>');
    expect(xhtml).toContain('<h2 class="chapter-title">Chapter 3 — Three</h2>');
    expect(xhtml).toContain('<p>Prose.</p>');
  });

  it('omits the volume header for a single-volume book', () => {
    const xhtml = buildChapterXhtml(vol, { multiVolume: false });
    expect(xhtml).not.toContain('volume-title');
  });

  it('builds an OPF manifest + spine covering every volume and marks the cover', () => {
    const opf = buildOpf({
      series: { id: 's1' },
      settings: { titlePageTitle: 'T', titlePageAuthor: 'A', titlePageSubtitle: '' },
      volumes: [vol, { ...vol, id: 'sB' }],
      coverImage: { name: 'cover.png', mediaType: 'image/png' },
      bookId: 'urn:portos:series:s1',
    });
    expect(opf).toContain('<dc:title>T</dc:title>');
    expect(opf).toContain('<dc:creator>A</dc:creator>');
    expect(opf).toContain('<dc:identifier id="book-id">urn:portos:series:s1</dc:identifier>');
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
    expect((opf.match(/<itemref /g) || []).length).toBe(2);
  });

  it('nav doc lists each volume title for a multi-volume book', () => {
    const nav = buildNavXhtml({ settings: { titlePageTitle: 'T' }, volumes: [vol, { ...vol, id: 'sB', title: 'Book Two' }] });
    expect(nav).toContain('Book One');
    expect(nav).toContain('Book Two');
    expect(nav).toContain('<nav epub:type="toc"');
  });

  // The exported (non-__testing) builders are the same functions.
  it('exports the builders at the module top level too', () => {
    expect(buildOpfExport).toBe(buildOpf);
    expect(buildNavXhtmlExport).toBe(buildNavXhtml);
    expect(buildChapterXhtmlExport).toBe(buildChapterXhtml);
  });
});

describe('wrapText', () => {
  // Stub font: each char is 10 units wide.
  const font = { widthOfTextAtSize: (t) => t.length * 10 };
  it('wraps words to fit maxWidth', () => {
    const lines = wrapText('aa bb cc dd', font, 1, 55); // 55 units → 5 chars/line
    expect(lines).toEqual(['aa bb', 'cc dd']);
  });
  it('never drops a word longer than the line (keeps it on its own line)', () => {
    const lines = wrapText('supercalifragilistic ok', font, 1, 50);
    expect(lines[0]).toBe('supercalifragilistic');
    expect(lines[1]).toBe('ok');
  });
  it('returns [] for empty text', () => {
    expect(wrapText('', font, 1, 100)).toEqual([]);
  });
});

// Round-trip: assemble an ePub-shaped zip and parse it back through the
// production parser, asserting order + content; the OCF "mimetype stored" rule
// is checked against the raw local-header bytes (the parser doesn't surface the
// compression method).
function collectEntries(zipBuf) {
  return new Promise((resolve, reject) => {
    const results = [];
    const promises = [];
    const parser = parseZip();
    parser.on('entry', (entry) => {
      promises.push(new Promise((res) => {
        const chunks = [];
        const sink = new Writable({ write(chunk, _, cb) { chunks.push(chunk); cb(); } });
        sink.on('finish', () => { results.push({ path: entry.path, data: Buffer.concat(chunks) }); res(); });
        entry.pipe(sink);
      }));
    });
    parser.on('close', () => Promise.all(promises).then(() => resolve(results), reject));
    parser.on('error', reject);
    Readable.from([zipBuf]).pipe(parser);
  });
}

describe('ePub OCF zip round-trip', () => {
  it('keeps mimetype first + stored and includes the container + OPF', async () => {
    const buf = createZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      { name: 'META-INF/container.xml', data: '<container/>' },
      { name: 'OEBPS/content.opf', data: '<package/>' },
      { name: 'OEBPS/vol1.xhtml', data: buildChapterXhtml({ number: 1, title: '', sections: [section()] }, { multiVolume: false }) },
    ], { compress: true });

    // OCF invariant: the first local file header is `mimetype`, method 0 (stored).
    // Local header layout: sig(4) ver(2) flags(2) method(2 @ offset 8) …
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt16LE(8)).toBe(0); // compression method 0 = stored
    const firstNameLen = buf.readUInt16LE(26);
    expect(buf.slice(30, 30 + firstNameLen).toString('utf8')).toBe('mimetype');

    const entries = await collectEntries(buf);
    expect(entries[0].path).toBe('mimetype');
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.data.toString('utf8')]));
    expect(byPath.mimetype).toBe('application/epub+zip');
    expect(byPath['META-INF/container.xml']).toBe('<container/>');
    expect(byPath['OEBPS/content.opf']).toBe('<package/>');
    expect(byPath['OEBPS/vol1.xhtml']).toContain('<p>Body one.</p>');
  });
});
