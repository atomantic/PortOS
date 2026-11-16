import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { writeFile } from 'fs/promises';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as fsPromises from 'fs/promises';

// Every wrapped fs/promises function delegates to the real implementation by default;
// individual tests override with `mockRejectedValueOnce` etc. (see fileUtils.testFixtures.js).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdir: vi.fn((...args) => actual.mkdir(...args)),
    open: vi.fn((...args) => actual.open(...args)),
    readFile: vi.fn((...args) => actual.readFile(...args)),
    rename: vi.fn((...args) => actual.rename(...args)),
    writeFile: vi.fn((...args) => actual.writeFile(...args)),
    chmod: vi.fn((...args) => actual.chmod(...args)),
    readdir: vi.fn((...args) => actual.readdir(...args)),
    stat: vi.fn((...args) => actual.stat(...args)),
  };
});

import { SONGBOOK_ATTACHMENT_EXTENSIONS } from './mimeTypes.js';
import { importFileToDir, saveImageUpload, saveBase64Upload, serveLocalFile } from './uploads.js';
import { loadRealFsPromises } from './fileUtils.testFixtures.js';

beforeAll(loadRealFsPromises);

describe('importFileToDir', () => {
  let dir;
  let source;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'import-file-test-'));
    source = join(dir, 'source.bin');
    await writeFile(source, 'fixture');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a persisted extension outside an explicit allowlist', async () => {
    await expect(importFileToDir(source, 'payload.svg', join(dir, 'dest'), { extensions: ['.png'] }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_FILE_TYPE' });
  });
});

describe('saveImageUpload (shared image upload pipeline)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'save-image-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Exactly MIN_IMAGE_BYTES (12) — the shortest payload the floor accepts.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const b64 = (buf) => buf.toString('base64');
  const opts = { maxBytes: 1024 };

  it('persists the bytes verbatim and reports the detected format', async () => {
    const saved = await saveImageUpload(dir, { filename: 'photo.png', data: b64(PNG) }, opts);
    expect(saved.filename).toBe('photo.png');
    expect(saved.size).toBe(12);
    expect(saved.format).toBe('png');
    expect(saved.mime).toBe('image/png');
    expect(readFileSync(saved.filePath)).toEqual(PNG);
  });

  it('rejects a payload over maxBytes with a 400 FILE_TOO_LARGE', async () => {
    await expect(saveImageUpload(dir, { filename: 'photo.png', data: b64(Buffer.alloc(2048)) }, opts))
      .rejects.toMatchObject({ status: 400, code: 'FILE_TOO_LARGE' });
  });

  it('rejects bytes with no recognized image signature', async () => {
    await expect(saveImageUpload(dir, { filename: 'photo.png', data: b64(Buffer.from('not an image!!')) }, opts))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_FILE_TYPE' });
  });

  // The per-format signatures are short (JPEG is 3 bytes, GIF 6) — without an
  // explicit floor a truncated payload "detects" fine and saves as a success,
  // handing the consumer a path to an unreadable file.
  it('rejects a truncated payload whose signature alone would match', async () => {
    for (const truncated of [
      Buffer.from([0xff, 0xd8, 0xff]),                                     // 3-byte JPEG
      Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),                   // 6-byte GIF
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),       // 8-byte PNG
    ]) {
      await expect(saveImageUpload(dir, { filename: 'photo.png', data: b64(truncated) }, opts))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_FILE_TYPE' });
    }
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('forces the extension to the detected format, not the claimed one', async () => {
    const saved = await saveImageUpload(dir, { filename: 'photo.jpg', data: b64(PNG) }, opts);
    expect(saved.filename).toBe('photo.jpg.png');
  });

  it('replaces a matching extension case-insensitively instead of doubling it', async () => {
    const saved = await saveImageUpload(dir, { filename: 'PHOTO.PNG', data: b64(PNG) }, opts);
    expect(saved.filename).toBe('PHOTO.png');
  });

  // A caller that prefixes the name can otherwise push a legitimately-long client
  // filename past NAME_MAX and turn the write into an ENAMETOOLONG 500.
  it('clamps the stored name to NAME_MAX, keeping the extension', async () => {
    const saved = await saveImageUpload(dir, { filename: `${'a'.repeat(300)}.png`, data: b64(PNG) }, opts);
    expect(saved.filename.length).toBe(255);
    expect(saved.filename.endsWith('.png')).toBe(true);
    expect(existsSync(saved.filePath)).toBe(true);
  });

  // #9721: the shared bucket's earlier images are referenced by task records, so
  // a failed replacement must leave the prior bytes intact and no stage behind.
  describe('publication failures (#9721)', () => {
    const OLD = Buffer.concat([PNG, Buffer.from('previously stored image bytes')]);
    const NEW = Buffer.concat([PNG, Buffer.from('replacement')]);

    it('keeps the previous image intact when the write fails mid-way, then a retry succeeds', async () => {
      writeFileSync(join(dir, 'diagram.png'), OLD);
      const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      fsPromises.writeFile.mockImplementationOnce(async (path) => {
        await fsPromises.appendFile(path, NEW.subarray(0, 5)); // partial bytes land, then the write rejects
        throw enospc;
      });
      await expect(saveImageUpload(dir, { filename: 'diagram.png', data: b64(NEW) }, { maxBytes: 4096 }))
        .rejects.toBe(enospc);
      expect(readFileSync(join(dir, 'diagram.png'))).toEqual(OLD);
      expect(readdirSync(dir)).toEqual(['diagram.png']);

      const saved = await saveImageUpload(dir, { filename: 'diagram.png', data: b64(NEW) }, { maxBytes: 4096 });
      expect(readFileSync(saved.filePath)).toEqual(NEW);
      expect(readdirSync(dir)).toEqual(['diagram.png']);
    });

    it('keeps the previous image and removes the stage when the rename fails', async () => {
      writeFileSync(join(dir, 'diagram.png'), OLD);
      const eio = Object.assign(new Error('io error'), { code: 'EIO' });
      fsPromises.rename.mockImplementationOnce(async () => { throw eio; });
      await expect(saveImageUpload(dir, { filename: 'diagram.png', data: b64(NEW) }, { maxBytes: 4096 }))
        .rejects.toBe(eio);
      expect(readFileSync(join(dir, 'diagram.png'))).toEqual(OLD);
      expect(readdirSync(dir)).toEqual(['diagram.png']);
    });

    it('leaves a stage that carries the owner prefix and image extension when cleanup also fails', async () => {
      const prefix = 'mind-11111111-2222-3333-4444-555555555555-';
      const eio = Object.assign(new Error('io error'), { code: 'EIO' });
      fsPromises.rename.mockImplementationOnce(async () => { throw eio; });
      const unlinkSpy = vi.spyOn(fsPromises, 'unlink').mockRejectedValueOnce(new Error('unlink denied'));
      await expect(saveImageUpload(dir, { filename: `${prefix}a.png`, data: b64(NEW) }, { maxBytes: 4096, stagePrefix: prefix }))
        .rejects.toBe(eio);
      unlinkSpy.mockRestore();
      const [left, ...rest] = readdirSync(dir);
      expect(rest).toEqual([]);
      expect(left.startsWith(prefix)).toBe(true);
      expect(left.endsWith('.png')).toBe(true);
    });

    it('stages with a bounded name so a NAME_MAX-length final name still publishes', async () => {
      const saved = await saveImageUpload(dir, { filename: `${'a'.repeat(300)}.png`, data: b64(NEW) }, { maxBytes: 4096 });
      expect(saved.filename.length).toBe(255);
      expect(readFileSync(saved.filePath)).toEqual(NEW);
      expect(readdirSync(dir)).toEqual([saved.filename]);
    });
  });

  it('strips directory components from a traversal-shaped filename', async () => {
    const saved = await saveImageUpload(dir, { filename: '../../evil.png', data: b64(PNG) }, opts);
    expect(saved.filename).toBe('evil.png');
    expect(saved.filePath.startsWith(dir)).toBe(true);
  });
});

describe('saveBase64Upload (shared attachment upload pipeline)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'save-b64-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = { allowedExtensions: SONGBOOK_ATTACHMENT_EXTENSIONS, maxBytes: 10 };
  const b64 = (s) => Buffer.from(s).toString('base64');

  it('persists within the cap and returns the uuid-prefixed name, buffer, size, and mime', async () => {
    const saved = await saveBase64Upload(dir, { filename: 'sheet.txt', data: b64('ten bytes!') }, opts);
    expect(saved.filename).toMatch(/^[0-9a-f]{8}-sheet\.txt$/);
    expect(saved.size).toBe(10);
    expect(saved.mime).toBe('text/plain');
    expect(saved.buffer.toString('utf-8')).toBe('ten bytes!');
    expect(existsSync(saved.filePath)).toBe(true);
    expect(saved.filePath.startsWith(dir)).toBe(true);
  });

  it('rejects a payload over maxBytes with a 400 FILE_TOO_LARGE', async () => {
    await expect(saveBase64Upload(dir, { filename: 'big.txt', data: b64('eleven bytes') }, opts))
      .rejects.toMatchObject({ status: 400, code: 'FILE_TOO_LARGE' });
  });

  it('rejects an extension outside the allowlist with a 400 INVALID_FILE_TYPE', async () => {
    await expect(saveBase64Upload(dir, { filename: 'app.exe', data: b64('x') }, opts))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_FILE_TYPE' });
  });

  it('rejects a traversal-shaped filename ("../x") with a 400', async () => {
    await expect(saveBase64Upload(dir, { filename: '../x', data: b64('x') }, opts))
      .rejects.toMatchObject({ status: 400 });
  });

  it('sanitizes a traversal filename with an allowed extension to a basename inside the dir', async () => {
    const saved = await saveBase64Upload(dir, { filename: '../../evil.txt', data: b64('x') }, opts);
    expect(saved.filename).toMatch(/^[0-9a-f]{8}-evil\.txt$/); // directory parts stripped
    expect(saved.filePath.startsWith(dir)).toBe(true);
    expect(existsSync(saved.filePath)).toBe(true);
  });
});

describe('serveLocalFile (shared attachment serving pipeline)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'serve-local-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const mockRes = () => ({
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    type: vi.fn(function type() { return this; }),
    sendFile: vi.fn(),
  });

  it('serves a benign MIME inline with nosniff and no attachment disposition', async () => {
    writeFileSync(join(dir, 'safe.txt'), 'hello');
    const res = mockRes();
    await serveLocalFile(res, dir, 'safe.txt');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Disposition']).toBeUndefined();
    expect(res.sendFile).toHaveBeenCalledWith(join(dir, 'safe.txt'));
  });

  it('forces Content-Disposition: attachment for a risky MIME (svg)', async () => {
    writeFileSync(join(dir, 'sheet.svg'), '<svg/>');
    const res = mockRes();
    await serveLocalFile(res, dir, 'sheet.svg');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="sheet.svg"');
    expect(res.sendFile).toHaveBeenCalledWith(join(dir, 'sheet.svg'));
  });

  it('404s with the parametrized missingError for absent bytes', async () => {
    const res = mockRes();
    await expect(serveLocalFile(res, dir, 'nope.txt', {
      missingError: { message: 'Attachment file is not on this machine', code: 'NOT_ON_THIS_MACHINE' },
    })).rejects.toMatchObject({ status: 404, code: 'NOT_ON_THIS_MACHINE' });
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  // The declared `contentType` override (Beeper attachment mirror, #37/SEC-1):
  // a remote sender's declared type is normalized (case folded, parameters
  // dropped) and the disposition decision is taken on BOTH the declared value
  // and whatever the type is bounded down to — so downgrading a risky
  // `text/html` to `application/octet-stream` never costs it the attachment
  // header it earned.
  it.each([
    ['text/HTML'],
    ['TEXT/html'],
    [' text/html ;charset=utf-8'],
    ['Image/SVG+xml'],
    ['application/xhtml+xml'],
    ['text/xml'],
  ])('forces Content-Disposition: attachment for a contentType override of %j', async (contentType) => {
    writeFileSync(join(dir, 'override.bin'), 'x');
    const res = mockRes();
    await serveLocalFile(res, dir, 'override.bin', { contentType });
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="override.bin"');
  });

  it('bounds a contentType override outside the mirrored set to application/octet-stream instead of echoing it', async () => {
    writeFileSync(join(dir, 'mystery.bin'), 'x');
    const res = mockRes();
    await serveLocalFile(res, dir, 'mystery.bin', { contentType: 'application/x-not-a-mirrored-type' });
    expect(res.type).toHaveBeenCalledWith('application/octet-stream');
    // Not risky, and the bounded type isn't either — no disposition override.
    expect(res.headers['Content-Disposition']).toBeUndefined();
  });
});
