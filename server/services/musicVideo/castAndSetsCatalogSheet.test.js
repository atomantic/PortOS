import { describe, it, expect } from 'vitest';
import { catalogSheetImageFiles, renderCatalogCastAndSetsSheet } from './castAndSetsCatalogSheet.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const item = (subjectId, kind, name, extra = {}) => ({ subjectId, kind, name, description: `${name} text`, images: [`${subjectId}.png`], formLabel: null, ...extra });
const places = [item('s-harbor', 'place', 'Harbor'), item('s-roof', 'place', 'Roof')];

describe('catalog guide song map', () => {
  // Uniquely catches section-based or invented times: only real shot spans, the cold open excluded, unclaimed shots kept visible.
  it('places each timed shot on the set conditioning would use', () => {
    const project = { concept: { subjects: places.map((p) => ({ id: p.subjectId, kind: 'place', name: p.name })) }, scenes: [
      { sceneId: 'late', startSec: 30, endSec: 40, setReference: { subjectId: 's-harbor' } },
      { sceneId: 'first', startSec: 0, endSec: 10, setReference: { subjectId: 's-harbor' } },
      { sceneId: 'joined', startSec: 10, endSec: 15, setReference: { subjectId: 's-harbor' } },
      { sceneId: 'named', startSec: 15, endSec: 20, shotSheet: { location: 'The Roof at night' } },
      { sceneId: 'none', startSec: 20, endSec: 25, description: 'Text card' },
      { sceneId: 'cold', startSec: 0, endSec: 5, setReference: { subjectId: 's-roof' }, preMusic: { durationSec: 5 } },
      { sceneId: 'untimed', setReference: { subjectId: 's-roof' } },
    ] };
    const html = renderCatalogCastAndSetsSheet({ title: 'Example Song', project, checkin: { items: places }, durationSec: 60 });
    const map = html.slice(html.indexOf('<small>Song map</small>'));
    const row = (name) => map.slice(map.indexOf('<table>')).split('<tr>').find((r) => r.includes(name));
    expect(row('Harbor')).toContain('3 shots');
    expect(row('Harbor')).toContain('0:25');
    expect(row('Harbor')).toContain('0:00–0:15, 0:30–0:40');
    expect(row('Roof')).toContain('1 shot<');
    expect(row('Roof')).toContain('0:15–0:20');
    expect(row('No set identified')).toContain('0:20–0:25');
    expect(html.slice(html.indexOf('<small>Sets</small>'), html.indexOf('<small>Song map</small>'))).toContain('3 shots · 0:00–0:15, 0:30–0:40');
    const bar = map.slice(map.indexOf('class="bar"'), map.indexOf('class="ticks"'));
    expect([...bar.matchAll(/title="([^"]+)"/g)].map((m) => m[1])).toEqual(['Harbor 0:00–0:15', 'Roof 0:15–0:20', 'No set identified 0:20–0:25', 'No shot 0:25–0:30', 'Harbor 0:30–0:40', 'No shot 0:40–1:00']);
  });
});

describe('catalog guide sheet', () => {
  const subjects = [
    { id: 's-lead', kind: 'character', role: 'protagonist', name: 'Lead' },
    { id: 's-k1', kind: 'character', role: 'protagonist', name: 'K' },
    { id: 's-k2', kind: 'character', role: 'protagonist', name: 'K', active: true },
    { id: 's-friend', kind: 'character', role: 'supporting', name: 'Friend' },
    { id: 's-band', kind: 'character', role: 'band', name: 'Drummer' },
    { id: 's-lamp', kind: 'object', name: 'Lamp' },
  ];
  const items = [
    item('s-lead', 'character', 'Lead', { images: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'], formLabel: 'Age 40' }),
    item('s-k1', 'character', 'K One'), item('s-k2', 'character', 'K Two'),
    item('s-friend', 'character', 'Friend'), item('s-band', 'character', 'Drummer'),
    item('s-lamp', 'object', 'Lamp'), ...places,
  ];
  const render = (over = {}) => renderCatalogCastAndSetsSheet({ title: 'Example Song', project: { concept: { prompt: 'A vigil', subjects }, scenes: [] }, checkin: { items, approved: false }, images: {}, ...over });

  // Uniquely catches every lead after the first reading as supporting cast, or an alternate reading as a second person.
  it('groups cast by role and marks which alternate is selected', () => {
    const html = render();
    const section = (name) => html.slice(html.indexOf(`<small>${name}</small>`), html.indexOf('</section>', html.indexOf(`<small>${name}</small>`)));
    const leads = section('Protagonists');
    expect(leads).toContain('2 protagonists · 1 alternate not selected');
    expect(leads).toContain('Lead · Age 40');
    expect(leads).toMatch(/K One.*Alternate for K · Not selected/s);
    expect(leads).toMatch(/K Two.*Alternate for K · Selected/s);
    expect(leads).not.toContain('Friend');
    expect(section('Supporting cast')).toContain('Friend');
    expect(section('Band')).toContain('Drummer');
    expect(section('Objects')).toContain('Lamp text');
    expect(section('Sets')).toContain('Not in a timed shot yet');
    expect(html).toContain('No timed shots yet');
    expect(html).toContain('2 more images in the catalog');
  });

  // Uniquely catches catalog text injecting markup, or an image source reaching the network from the saved page.
  it('escapes catalog text and embeds only image data', () => {
    const hostile = item('s-lead', 'character', '<script>alert(1)</script>', { description: '"><img src=x onerror=alert(1)>', images: ['bad.png'] });
    const html = render({ title: '<b>Song</b>', checkin: { items: [hostile] }, images: { 'bad.png': 'https://example.com/x.png' } });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('example.com');
    expect(html).toContain('&lt;b&gt;Song&lt;/b&gt;');
    expect(render({ images: { 'a.png': PNG } })).toContain(`<img src="${PNG}"`);
  });

  // Uniquely catches a saved file asserting an approval that a later catalog change or approval would contradict.
  it('states no approval in the saved page', () => {
    expect(render({ checkin: { items, approved: true } })).not.toMatch(/approved|approval/i);
    expect(render({ checkin: { items, approved: false } })).not.toMatch(/approved|approval/i);
  });

  // Uniquely catches a code-only guide promising a raster image the media policy forbids, which would also fail its upload scan.
  it('keeps a code-only guide free of embedded images', () => {
    const html = render({ project: { mediaMode: 'code-only', concept: { subjects }, scenes: [] }, checkin: { items: items.map((i) => ({ ...i, images: [] })) } });
    expect(html).toContain('No raster image: drawn in code');
    expect(html).not.toMatch(/data\s*:\s*image\/|<(?:img|image)\b/i);
  });

  // Uniquely catches the service embedding every catalog image (the 54 MB sheet) or missing one the page shows.
  it('embeds only the lead images it shows', () => {
    expect(catalogSheetImageFiles(items.slice(0, 1))).toEqual(['a.png', 'b.png', 'c.png']);
  });
});
