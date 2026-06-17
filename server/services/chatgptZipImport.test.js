import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Minimal ZIP fixture builder (mirrors lib/zipStream.test.js) -----------
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;

function buildEntry(name, payload) {
  const nameBuf = Buffer.from(name, 'utf-8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_SIG, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);            // stored (no compression)
  header.writeUInt32LE(payload.length, 18);
  header.writeUInt32LE(payload.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuf, payload]);
}
function buildEocd() {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(CENTRAL_SIG, 0);
  return buf;
}
const buildZip = (entries) =>
  Buffer.concat([...entries.map(([n, p]) => buildEntry(n, Buffer.isBuffer(p) ? p : Buffer.from(p))), buildEocd()]);

// Magic-byte payloads for asset extension sniffing.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(8).fill(0)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(8).fill(0)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(4)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(8)]);

let TMP;
let extractChatgptZip, makeAssetResolver, importChatgptZip, sniffExtension, datAssetId;

describe('chatgptZipImport service', () => {
  beforeEach(async () => {
    TMP = await mkdtemp(join(tmpdir(), 'portos-cgptzip-'));
    const mod = await import('./chatgptZipImport.js');
    extractChatgptZip = mod.extractChatgptZip;
    makeAssetResolver = mod.makeAssetResolver;
    importChatgptZip = mod.importChatgptZip;
    sniffExtension = mod.__test.sniffExtension;
    datAssetId = mod.__test.datAssetId;
  });
  afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

  const writeZip = async (entries) => {
    const p = join(TMP, 'export.zip');
    await writeFile(p, buildZip(entries));
    return p;
  };

  describe('sniffExtension', () => {
    it('detects png/jpeg/wav/pdf from magic bytes', () => {
      expect(sniffExtension(PNG)).toBe('.png');
      expect(sniffExtension(JPEG)).toBe('.jpg');
      expect(sniffExtension(WAV)).toBe('.wav');
      expect(sniffExtension(PDF)).toBe('.pdf');
    });
    it('returns null for unrecognized bytes', () => {
      expect(sniffExtension(Buffer.from('not a known magic header here'))).toBe(null);
    });
  });

  describe('datAssetId', () => {
    it('strips path + .dat extension to the bare asset id', () => {
      expect(datAssetId('file-ABC123.dat')).toBe('file-ABC123');
      expect(datAssetId('nested/dir/file_DEADBEEF.dat')).toBe('file_DEADBEEF');
    });
  });

  describe('extFromName (fallback extension allowlist)', () => {
    it('accepts inert document/media extensions from the friendly name', async () => {
      const { extFromName } = (await import('./chatgptZipImport.js')).__test;
      expect(extFromName('photo.png')).toBe('.png');
      expect(extFromName('report.pdf')).toBe('.pdf');
      expect(extFromName('clip.WAV')).toBe('.wav');
      expect(extFromName('data.csv')).toBe('.csv');
    });
    it('rejects active-content extensions so the served file can never be executable', async () => {
      const { extFromName } = (await import('./chatgptZipImport.js')).__test;
      // These must fall through to null → caller writes `.bin` (octet-stream).
      for (const evil of ['x.html', 'x.htm', 'x.svg', 'x.xml', 'x.js', 'x.mjs', 'x.xhtml']) {
        expect(extFromName(evil)).toBe(null);
      }
      expect(extFromName('noext')).toBe(null);
    });
  });

  describe('extractChatgptZip', () => {
    it('extracts conversation shards + assets with sniffed extensions and friendly names', async () => {
      const zipPath = await writeZip([
        ['conversations-000.json', JSON.stringify([{ id: 'c1', title: 'A', mapping: {} }])],
        ['conversations-001.json', JSON.stringify([{ id: 'c2', title: 'B', mapping: {} }])],
        ['conversation_asset_file_names.json', JSON.stringify({ 'file-IMG.dat': 'photo.png' })],
        ['file-IMG.dat', PNG],
        ['file-SND.dat', WAV],
        ['chat.html', '<html>ignored</html>'],
        ['export_manifest.json', JSON.stringify({ export_files: [] })],
      ]);
      const { conversationFiles, assets, stats } = await extractChatgptZip(zipPath, { assetDir: join(TMP, 'assets') });

      expect(conversationFiles.length).toBe(2);
      expect(stats.assetCount).toBe(2);

      const img = assets.get('file-IMG');
      expect(img.file).toBe('file-IMG.png');
      expect(img.url).toBe('/data/brain-imports/file-IMG.png');
      expect(img.name).toBe('photo.png');        // friendly name from the map
      expect(img.mime).toBe('image/png');

      const snd = assets.get('file-SND');
      expect(snd.file).toBe('file-SND.wav');      // sniffed even with no map entry
      expect(snd.mime).toBe('audio/wav');

      // Files actually written to the served dir.
      const written = (await readdir(join(TMP, 'assets'))).sort();
      expect(written).toEqual(['file-IMG.png', 'file-SND.wav']);
      // chat.html / export_manifest.json were drained, not extracted.
      expect(written).not.toContain('chat.html');
    });

    it('streams a large multi-chunk asset to disk intact with the sniffed extension, leaving no .part temp', async () => {
      // A multi-MB asset forces the read stream to deliver the `.dat` member in
      // many chunks, exercising the stream-to-disk path (leading bytes sniffed,
      // the rest written without buffering) and the cross-chunk head capture.
      const bigPng = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024, 0x7a)]);
      const assetDir = join(TMP, 'assets');
      const zipPath = await writeZip([
        ['conversations-000.json', JSON.stringify([{ id: 'c1', title: 'A', mapping: {} }])],
        ['file-BIG.dat', bigPng],
      ]);
      const { assets, stats } = await extractChatgptZip(zipPath, { assetDir });

      expect(stats.assetCount).toBe(1);
      expect(assets.get('file-BIG').file).toBe('file-BIG.png');   // sniffed from leading bytes

      const written = (await readdir(assetDir)).sort();
      expect(written).toEqual(['file-BIG.png']);                  // renamed; no `.part` left behind
      const bytes = await readFile(join(assetDir, 'file-BIG.png'));
      expect(bytes.length).toBe(bigPng.length);                   // every chunk landed on disk
      expect(bytes.equals(bigPng)).toBe(true);                    // content intact end to end
    });

    it('falls back to the friendly-name extension when magic bytes are unknown', async () => {
      const zipPath = await writeZip([
        ['conversations-000.json', JSON.stringify([{ id: 'c1', title: 'A', mapping: {} }])],
        ['conversation_asset_file_names.json', JSON.stringify({ 'file-DOC.dat': 'report.csv' })],
        ['file-DOC.dat', 'col1,col2\n1,2\n'],
      ]);
      const { assets } = await extractChatgptZip(zipPath, { assetDir: join(TMP, 'assets') });
      expect(assets.get('file-DOC').file).toBe('file-DOC.csv');
    });

    it('cleans up the streamed temp file when the stream fails (corrupt asset-name map)', async () => {
      // The asset streams to a <id>.part temp before the name map is parsed; a
      // corrupt name map throws mid-stream, so the temp must be unlinked rather
      // than orphaned on disk (the new stream-to-disk cleanup path).
      const zipPath = await writeZip([
        ['conversations-000.json', JSON.stringify([{ id: 'c1', title: 'A', mapping: {} }])],
        ['file-IMG.dat', PNG],
        ['conversation_asset_file_names.json', 'this is { not valid json'],
      ]);
      const assetDir = join(TMP, 'assets');
      await expect(extractChatgptZip(zipPath, { assetDir })).rejects.toThrow();
      const written = await readdir(assetDir).catch(() => []);
      expect(written).toEqual([]);   // no <id>.part temp left behind
    });

    it('cleans up already-written assets and throws a 400 when a conversation shard is corrupt JSON', async () => {
      const zipPath = await writeZip([
        ['conversations-000.json', '[{ "id": "c1", "title": "A", "mapping": {} '], // truncated → JSON.parse throws
        ['conversation_asset_file_names.json', JSON.stringify({ 'file-IMG.dat': 'photo.png' })],
        ['file-IMG.dat', PNG],
      ]);
      const assetDir = join(TMP, 'assets');
      await expect(extractChatgptZip(zipPath, { assetDir }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_CHATGPT_EXPORT' });
      // The asset written before the parse failure must not be orphaned.
      const written = await readdir(assetDir).catch(() => []);
      expect(written).toEqual([]);
    });
  });

  describe('makeAssetResolver', () => {
    it('resolves file-service://, sediment://, and bare-id pointers; null for unknown', () => {
      const assets = new Map([['file-XYZ', { url: '/data/brain-imports/file-XYZ.png', name: 'p.png', mime: 'image/png' }]]);
      const resolve = makeAssetResolver(assets);
      expect(resolve('file-service://file-XYZ').url).toBe('/data/brain-imports/file-XYZ.png');
      expect(resolve('file-XYZ').url).toBe('/data/brain-imports/file-XYZ.png');
      expect(resolve('sediment://file-XYZ').url).toBe('/data/brain-imports/file-XYZ.png');
      expect(resolve('file-service://file-MISSING')).toBe(null);
      expect(resolve(null)).toBe(null);
    });
  });

  describe('importChatgptZip', () => {
    // Drive the full pipeline against a mocked brainStorage + brain PATH so the
    // archive lands in TMP and no real DB/store is touched.
    it('imports conversations and inlines local image assets into the transcript', async () => {
      const { vi } = await import('vitest');
      vi.resetModules();
      const ARCHIVE = await mkdtemp(join(tmpdir(), 'portos-cgptzip-arch-'));
      vi.doMock('../lib/fileUtils.js', async () => {
        const actual = await vi.importActual('../lib/fileUtils.js');
        return { ...actual, PATHS: { ...actual.PATHS, brain: ARCHIVE, brainImportAssets: join(TMP, 'assets') } };
      });
      const created = [];
      vi.doMock('./brainStorage.js', () => ({
        createMemoryEntry: vi.fn(async (d) => { created.push(d); return { id: `mem-${created.length}`, ...d }; })
      }));
      const { importChatgptZip: run } = await import('./chatgptZipImport.js');

      const conv = {
        id: 'c1', title: 'Knot help', create_time: 1700000000, current_node: 'n1',
        mapping: {
          n1: {
            id: 'n1', parent: null, children: [],
            message: {
              id: 'm1', author: { role: 'user' }, create_time: 1700000001,
              content: {
                content_type: 'multimodal_text',
                parts: ['Look at this:', { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-IMG' }]
              }
            }
          }
        }
      };
      const zipPath = await writeZip([
        ['conversations-000.json', JSON.stringify([conv])],
        ['conversation_asset_file_names.json', JSON.stringify({ 'file-IMG.dat': 'knot.png' })],
        ['file-IMG.dat', PNG],
      ]);

      const result = await run(zipPath, { tags: ['chatgpt-import'] });
      expect(result.ok).toBe(true);
      expect(result.imported).toBe(1);
      expect(result.assetStats.assetCount).toBe(1);
      expect(created[0].source).toBe('chatgpt-import');
      // The image part rendered as an inline markdown image pointing at the
      // extracted, served asset (not a `[image]` placeholder).
      expect(created[0].content).toContain('![knot.png](/data/brain-imports/file-IMG.png)');

      await rm(ARCHIVE, { recursive: true, force: true });
      vi.resetModules();
    });

    it('rejects a ZIP with no conversation shards and cleans up extracted assets', async () => {
      const { vi } = await import('vitest');
      vi.resetModules();
      const ASSET_DIR = join(TMP, 'assets-noshards');
      vi.doMock('../lib/fileUtils.js', async () => {
        const actual = await vi.importActual('../lib/fileUtils.js');
        return { ...actual, PATHS: { ...actual.PATHS, brainImportAssets: ASSET_DIR } };
      });
      const { importChatgptZip: run } = await import('./chatgptZipImport.js');

      const zipPath = await writeZip([
        ['export_manifest.json', JSON.stringify({ export_files: [] })],
        ['file-IMG.dat', PNG],
      ]);
      const result = await run(zipPath, {});
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no conversations/i);
      // The asset was extracted before the no-shards check — it MUST be cleaned
      // up so a bad upload doesn't leave orphaned files under the served dir.
      const leftover = await readdir(ASSET_DIR).catch(() => []);
      expect(leftover).toEqual([]);
      vi.resetModules();
    });
  });
});
