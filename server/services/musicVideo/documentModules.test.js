import { describe, it, expect } from 'vitest';
import { PREVIEW_DOCUMENT_BASE, inlineDocumentModule, previewDocumentPath } from './documentModules.js';

const decode = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8');
const graph = (entries) => new Map(Object.entries(entries).map(([k, v]) => [k, { data: Buffer.from(v) }]));

describe('inlineDocumentModule', () => {
  it('gives each inlined module a stand-in import.meta.url at its own document path', async () => {
    // Vite's default form for a JS-referenced asset under base './'
    const files = graph({ 'assets/index.js': 'const a = new URL(`photo-abc.jpg`, import.meta.url).href; const b = import.meta["url"]; export { a, b };' });
    const out = decode(await inlineDocumentModule('assets/index.js', files));
    const base = JSON.stringify(`${PREVIEW_DOCUMENT_BASE}assets/index.js`);
    expect(out).toBe(`const a = new URL(\`photo-abc.jpg\`, ${base}).href; const b = ${base}; export { a, b };`);
    // and that base resolves the asset to a URL the preview bootstrap maps back to the document file
    expect(new URL('photo-abc.jpg', JSON.parse(base)).href).toBe(`${PREVIEW_DOCUMENT_BASE}assets/photo-abc.jpg`);
  });

  it('rewrites import.meta.url in imported modules too, and leaves other import.meta fields alone', async () => {
    const files = graph({
      'main.js': "import { u } from './lib/u.js'; console.log(u, import.meta.env);",
      'lib/u.js': 'export const u = new URL("../media/clip.mp4", import.meta.url).href;',
    });
    const main = decode(await inlineDocumentModule('main.js', files));
    expect(main).toContain('import.meta.env');
    const lib = decode(main.match(/"data:text\/javascript;base64,([^"]+)"/)[0].slice(1, -1));
    expect(lib).toContain(JSON.stringify(`${PREVIEW_DOCUMENT_BASE}lib/u.js`));
    expect(lib).not.toContain('import.meta');
  });
});

describe('previewDocumentPath', () => {
  const base = PREVIEW_DOCUMENT_BASE;
  it('maps stand-in-base URLs to document paths, from strings and URL objects alike', () => {
    expect(previewDocumentPath(`${base}assets/photo-abc.jpg`, base)).toBe('assets/photo-abc.jpg');
    expect(previewDocumentPath(new URL('photo-abc.jpg', `${base}assets/index.js`), base)).toBe('assets/photo-abc.jpg');
  });

  it('drops the query and hash, then decodes the path like the server keys its files', () => {
    expect(previewDocumentPath(new URL('My Clip ü.jpg?v=2#t', `${base}media/x.js`).href, base)).toBe('media/My Clip ü.jpg');
    expect(previewDocumentPath(`${base}media/a%3Fb.jpg`, base)).toBe('media/a?b.jpg');
    expect(previewDocumentPath(`${base}media/bad%E0.jpg`, base)).toBe('media/bad%E0.jpg');
  });

  it('leaves everything else untouched', () => {
    expect(previewDocumentPath('assets/photo.jpg', base)).toBe('assets/photo.jpg');
    expect(previewDocumentPath('blob:null/1234', base)).toBe('blob:null/1234');
    expect(previewDocumentPath('https://example.com/x.jpg', base)).toBe('https://example.com/x.jpg');
    expect(previewDocumentPath(null, base)).toBe(null);
  });

  it('is self-contained, so the preview bootstrap can inline it', () => {
    const inlined = new Function(`return (${previewDocumentPath.toString()})`)();
    expect(inlined(`${base}assets/photo-abc.jpg`, base)).toBe('assets/photo-abc.jpg');
  });
});
