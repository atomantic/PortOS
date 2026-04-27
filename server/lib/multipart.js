/**
 * Streaming multipart/form-data parser — multer.diskStorage() replacement.
 * Streams the matching file part directly to disk; collects text fields
 * into req.body. The file field is OPTIONAL — a multipart request that
 * carries only text fields populates req.body and leaves req.file undefined.
 *
 * Returns an Express middleware. Populates:
 *   - req.body[name]  — for text parts (Content-Disposition has no filename)
 *   - req.file = { path, originalname, mimetype, size } — for the matching
 *     file part (Content-Disposition has filename and name === fieldName).
 *     Other file parts (different field names) are skipped silently.
 */

import { createWriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export function uploadSingle(fieldName, { limits = {}, fileFilter } = {}) {
  const maxSize = limits.fileSize ?? Infinity;

  return async (req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (!ct.startsWith('multipart/form-data')) return next(new Error('Expected multipart/form-data'));
    const bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return next(new Error('Missing multipart boundary'));
    const result = await parseMultipart(req, bm[1], fieldName, maxSize, fileFilter).catch((err) => ({ err }));
    if (result.err) return next(result.err);
    req.body = result.body;
    if (result.file) req.file = result.file;
    next();
  };
}

// Read the full request body into a single Buffer with an upper bound. We
// enforce maxBodySize while accumulating chunks and destroy the stream the
// moment we exceed it — a malicious client can't blow heap by streaming
// gigabytes through. The cap is `maxSize + 1MB` for headers/boundary
// overhead — text fields stay small in practice and the file part is the
// only thing that approaches maxSize.
function readAllBytes(stream, maxBodySize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (c) => {
      total += c.length;
      if (total > maxBodySize) {
        stream.destroy();
        reject(new Error(`Request body too large (max ${maxBodySize} bytes)`));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function parseMultipart(stream, boundary, fileFieldName, maxSize, fileFilter) {
  // Cap the in-memory buffer at maxSize + 1MB for headers/text-field overhead.
  // If maxSize is Infinity (no limit) we still cap at 100 MB so a runaway
  // upload can't OOM the server.
  const overheadBytes = 1024 * 1024;
  const maxBodySize = Number.isFinite(maxSize) ? maxSize + overheadBytes : 100 * 1024 * 1024;
  const buf = await readAllBytes(stream, maxBodySize);
  const PART_DELIM = Buffer.from('--' + boundary);
  const HEADER_END = Buffer.from('\r\n\r\n');
  const CRLF = Buffer.from('\r\n');

  const body = {};
  let file = null;

  // Walk the body part-by-part. Each boundary is `--<boundary>` followed
  // by either `\r\n` (more parts) or `--` (end-of-stream).
  let cursor = 0;
  // Skip preamble: find first boundary.
  const firstBoundary = buf.indexOf(PART_DELIM, cursor);
  if (firstBoundary === -1) throw new Error('Missing first multipart boundary');
  cursor = firstBoundary + PART_DELIM.length;

  while (cursor < buf.length) {
    // Check for end-of-stream marker.
    if (buf.slice(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    // Skip CRLF after boundary.
    if (!buf.slice(cursor, cursor + 2).equals(CRLF)) throw new Error('Malformed multipart: missing CRLF after boundary');
    cursor += 2;

    // Find headers/body split.
    const headerEnd = buf.indexOf(HEADER_END, cursor);
    if (headerEnd === -1) throw new Error('Malformed multipart part: missing header terminator');
    const headerStr = buf.slice(cursor, headerEnd).toString('utf-8');
    const partBodyStart = headerEnd + HEADER_END.length;

    // Find this part's terminator (next CRLF--<boundary>).
    const partTerminator = Buffer.concat([CRLF, PART_DELIM]);
    const partBodyEnd = buf.indexOf(partTerminator, partBodyStart);
    if (partBodyEnd === -1) throw new Error('Malformed multipart part: missing terminating boundary');
    const partBody = buf.slice(partBodyStart, partBodyEnd);

    // Parse Content-Disposition. The negative-lookbehind prevents `name=`
    // inside `filename=` from being matched as the part name (that bug
    // caused file parts to be parsed as text fields keyed on the filename).
    const nameMatch = headerStr.match(/(?<!file)name="([^"]+)"/i);
    if (!nameMatch) throw new Error('Multipart part missing Content-Disposition name');
    const name = nameMatch[1];
    const filenameMatch = headerStr.match(/filename="([^"]*)"/i);
    const filename = filenameMatch?.[1];

    if (filename != null && filename !== '') {
      // File part. Stream-to-disk only the matching field; skip others.
      if (name === fileFieldName) {
        if (partBody.length > maxSize) throw new Error(`File too large (max ${maxSize} bytes)`);
        const mimeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
        const mimetype = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';
        const rawExt = filename.match(/\.[^.]+$/)?.[0] || '';
        const ext = rawExt.replace(/[^a-zA-Z0-9.]/g, '');
        const fileMeta = { originalname: filename, mimetype };

        if (fileFilter) {
          let fr = null;
          fileFilter(null, fileMeta, (err, accept) => { fr = { err, accept }; });
          if (fr.err) throw fr.err;
          if (!fr.accept) throw new Error('File type not allowed');
        }

        const filePath = join(tmpdir(), `upload-${randomUUID()}${ext}`);
        await new Promise((resolve, reject) => {
          const ws = createWriteStream(filePath);
          ws.on('error', reject);
          ws.on('finish', resolve);
          ws.end(partBody);
        });
        file = { path: filePath, originalname: filename, mimetype, size: partBody.length };
      }
      // Other file fields are silently skipped (no req.file/body entry).
    } else {
      // Text field — append into req.body. Repeated names become arrays.
      const value = partBody.toString('utf-8');
      if (Object.prototype.hasOwnProperty.call(body, name)) {
        if (Array.isArray(body[name])) body[name].push(value);
        else body[name] = [body[name], value];
      } else {
        body[name] = value;
      }
    }

    // Advance past the part body + terminating CRLF--boundary.
    cursor = partBodyEnd + partTerminator.length;
  }

  return { body, file };
}
