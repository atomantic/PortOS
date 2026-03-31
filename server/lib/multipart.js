/**
 * Streaming multipart/form-data parser — multer.diskStorage() replacement.
 * Streams file content directly to disk; never buffers entire body in memory.
 *
 * Returns an Express middleware for a single file field.
 * Populates req.file with { path, originalname, mimetype, size }.
 */

import { createWriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export function uploadSingle(fieldName, { limits = {}, fileFilter } = {}) {
  const maxSize = limits.fileSize ?? Infinity;

  return (req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (!ct.startsWith('multipart/form-data')) return next(new Error('Expected multipart/form-data'));
    const bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return next(new Error('Missing multipart boundary'));
    parseStream(req, bm[1], fieldName, maxSize, fileFilter, next);
  };
}

function parseStream(stream, boundary, fieldName, maxSize, fileFilter, next) {
  const END_MARKER = Buffer.from('\r\n--' + boundary);
  const HEADER_END = Buffer.from('\r\n\r\n');

  let buf = Buffer.alloc(0);      // lookahead buffer while streaming file content
  let ws = null;                   // WriteStream for current file
  let filePath = null;
  let fileMeta = null;
  let fileSize = 0;
  let streaming = false;           // true once past headers, writing file bytes
  let done = false;
  const headerChunks = [];         // accumulates chunks until headers are parsed

  const fail = (err) => {
    if (!done) { done = true; if (ws) ws.destroy(); next(err); }
  };

  const writeChunk = (chunk) => {
    if (done) return;
    const combined = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const idx = combined.indexOf(END_MARKER);
    if (idx !== -1) {
      // End of file content found
      const tail = combined.slice(0, idx);
      fileSize += tail.length;
      if (fileSize > maxSize) return fail(new Error(`File too large (max ${maxSize} bytes)`));
      ws.end(tail);
      ws.once('finish', () => {
        if (!done) {
          done = true;
          stream.file = { path: filePath, ...fileMeta, size: fileSize };
          next();
        }
      });
      buf = Buffer.alloc(0);
    } else {
      // Keep last END_MARKER.length-1 bytes buffered (boundary may span chunks)
      const safe = combined.length - (END_MARKER.length - 1);
      if (safe > 0) {
        fileSize += safe;
        if (fileSize > maxSize) return fail(new Error(`File too large (max ${maxSize} bytes)`));
        ws.write(combined.slice(0, safe));
        buf = combined.slice(safe);
      } else {
        buf = combined;
      }
    }
  };

  stream.on('data', (chunk) => {
    if (done) return;
    if (streaming) return writeChunk(chunk);

    headerChunks.push(chunk);
    const combined = Buffer.concat(headerChunks);
    const hEnd = combined.indexOf(HEADER_END);
    if (hEnd === -1) return;

    // Parse Content-Disposition and Content-Type from headers
    const headerStr = combined.slice(0, hEnd).toString('utf-8');
    const dispMatch = headerStr.match(/Content-Disposition:[^\r\n]*name="([^"]+)"[^\r\n]*filename="([^"]+)"/i);
    if (!dispMatch || dispMatch[1] !== fieldName) return fail(new Error(`Expected field "${fieldName}"`));

    const originalname = dispMatch[2];
    const mimeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
    const mimetype = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';
    const ext = originalname.match(/\.[^.]+$/)?.[0] || '';
    fileMeta = { originalname, mimetype };

    if (fileFilter) {
      let fr = null;
      fileFilter(null, fileMeta, (err, accept) => { fr = { err, accept }; });
      if (fr.err) return fail(fr.err);
      if (!fr.accept) return fail(new Error('File type not allowed'));
    }

    filePath = join(tmpdir(), `upload-${Date.now()}-${randomUUID()}${ext}`);
    ws = createWriteStream(filePath);
    ws.on('error', fail);
    streaming = true;
    writeChunk(combined.slice(hEnd + HEADER_END.length));
  });

  stream.on('end', () => {
    if (!done && !streaming) { stream.file = undefined; next(); }
  });

  stream.on('error', fail);
}
