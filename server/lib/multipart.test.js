import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import { uploadSingle } from './multipart.js';

vi.mock('fs', () => ({
  createWriteStream: () => {
    const chunks = [];
    const handlers = {};
    return {
      // Node's writable.write returns true (no backpressure) — match that.
      write: (c) => { chunks.push(Buffer.from(c)); return true; },
      // Mirror Node's end signatures: end(), end(buf), end(buf, cb), end(cb).
      end: (data, cb) => {
        let callback;
        if (typeof data === 'function') {
          callback = data;
        } else {
          if (data) chunks.push(Buffer.from(data));
          if (typeof cb === 'function') callback = cb;
        }
        if (callback) callback();
        setImmediate(() => handlers.finish?.());
      },
      destroy: () => {},
      on: (evt, fn) => { handlers[evt] = fn; },
      once: (evt, fn) => { handlers[evt] = fn; },
      _chunks: chunks,
    };
  },
}));

const BOUNDARY = '----WebKitFormBoundaryTEST';

function makeMultipartReq(parts) {
  // parts: [{ name, filename?, contentType?, body }]
  const lines = [];
  for (const p of parts) {
    lines.push(`--${BOUNDARY}\r\n`);
    if (p.filename) {
      lines.push(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`);
      lines.push(`Content-Type: ${p.contentType || 'application/octet-stream'}\r\n\r\n`);
    } else {
      lines.push(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`);
    }
    lines.push(p.body);
    lines.push('\r\n');
  }
  lines.push(`--${BOUNDARY}--\r\n`);

  const bodyBuf = Buffer.concat(lines.map((l) => Buffer.isBuffer(l) ? l : Buffer.from(l)));
  const stream = Readable.from([bodyBuf]);
  stream.headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
  return stream;
}

const runMiddleware = (req) => new Promise((resolve, reject) => {
  const mw = uploadSingle('sourceImage', { limits: { fileSize: 1024 * 1024 } });
  mw(req, {}, (err) => err ? reject(err) : resolve());
});

describe('uploadSingle multipart parser', () => {
  it('parses text fields into req.body when no file is present', async () => {
    const req = makeMultipartReq([
      { name: 'prompt', body: 'a cat' },
      { name: 'width', body: '512' },
      { name: 'tiling', body: 'auto' },
    ]);
    await runMiddleware(req);
    expect(req.body).toEqual({ prompt: 'a cat', width: '512', tiling: 'auto' });
    expect(req.file).toBeUndefined();
  });

  it('parses text fields and an optional file in one request', async () => {
    const req = makeMultipartReq([
      { name: 'prompt', body: 'a dog' },
      { name: 'width', body: '768' },
      { name: 'sourceImage', filename: 'cat.png', contentType: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) },
    ]);
    await runMiddleware(req);
    expect(req.body.prompt).toBe('a dog');
    expect(req.body.width).toBe('768');
    expect(req.file).toBeDefined();
    expect(req.file.originalname).toBe('cat.png');
    expect(req.file.mimetype).toBe('image/png');
  });

  it('handles file as the FIRST part (text fields after)', async () => {
    const req = makeMultipartReq([
      { name: 'sourceImage', filename: 'a.png', contentType: 'image/png', body: Buffer.from([0xff, 0xee]) },
      { name: 'prompt', body: 'leading file' },
    ]);
    await runMiddleware(req);
    expect(req.body.prompt).toBe('leading file');
    expect(req.file?.originalname).toBe('a.png');
  });

  it('does not crash when req end fires while file flush is pending', async () => {
    // Regression: previously, if the file write stream's end() callback ran
    // asynchronously (real disk I/O) and `req.on('end')` fired first, the
    // end handler called tick() while writeStream was already null, crashing
    // with "Cannot read properties of null (reading 'write')".
    vi.resetModules();
    vi.doMock('fs', () => ({
      createWriteStream: () => {
        const handlers = {};
        return {
          write: () => true,
          end: (data, cb) => {
            const callback = typeof data === 'function' ? data : cb;
            // Defer the callback past the current macrotask so the request's
            // 'end' event can fire while we're still "flushing".
            if (callback) setTimeout(callback, 5);
          },
          destroy: () => {},
          on: (evt, fn) => { handlers[evt] = fn; },
          once: (evt, fn) => { handlers[evt] = fn; },
        };
      },
    }));
    const { uploadSingle: uploadSingleAsync } = await import('./multipart.js');
    const req = makeMultipartReq([
      { name: 'sourceImage', filename: 'a.png', contentType: 'image/png', body: Buffer.from([0xaa, 0xbb, 0xcc]) },
      { name: 'prompt', body: 'after-file' },
    ]);
    let uncaught = null;
    const onUncaught = (err) => { uncaught = err; };
    process.once('uncaughtException', onUncaught);
    await new Promise((resolve, reject) => {
      const mw = uploadSingleAsync('sourceImage', { limits: { fileSize: 1024 * 1024 } });
      mw(req, {}, (err) => err ? reject(err) : resolve());
    });
    // Wait for any deferred ws.end callbacks to flush so a stray uncaught
    // exception surfaces before we assert.
    await new Promise((r) => setTimeout(r, 30));
    process.removeListener('uncaughtException', onUncaught);
    expect(uncaught).toBeNull();
    expect(req.file?.originalname).toBe('a.png');
    expect(req.body.prompt).toBe('after-file');
    vi.doUnmock('fs');
  });

  it('rejects requests without the multipart Content-Type', async () => {
    const stream = Readable.from(['nope']);
    stream.headers = { 'content-type': 'application/json' };
    const mw = uploadSingle('sourceImage');
    await new Promise((resolve, reject) => mw(stream, {}, (err) => err ? resolve(err) : reject(new Error('expected error')))).then((err) => {
      expect(err.message).toMatch(/multipart/i);
    });
  });
});
