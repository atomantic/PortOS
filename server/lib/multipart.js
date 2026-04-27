/**
 * Streaming multipart/form-data parser — multer.diskStorage() replacement.
 *
 * True streaming: file content is written to disk in chunks as it arrives,
 * never buffered in memory. Text fields are buffered (small by definition).
 * Boundary detection keeps a small lookback (boundary length) between
 * chunks so a boundary spanning a chunk edge isn't missed.
 *
 * Returns an Express middleware. Populates:
 *   - req.body[name]  — for text parts (Content-Disposition has no filename)
 *   - req.file = { path, originalname, mimetype, size } — for the matching
 *     file part (Content-Disposition has filename and name === fieldName).
 *     Other file parts (different field names) are silently skipped.
 */

import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
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
    streamMultipart(req, bm[1], fieldName, maxSize, fileFilter, next);
  };
}

function streamMultipart(req, boundary, fileFieldName, maxSize, fileFilter, next) {
  const PART_DELIM = Buffer.from('\r\n--' + boundary);
  const FIRST_DELIM = Buffer.from('--' + boundary);
  const HEADER_END = Buffer.from('\r\n\r\n');

  const STATE_PREAMBLE = 0;       // before first boundary
  const STATE_HEADERS = 1;        // accumulating part headers
  const STATE_BODY = 2;           // streaming part body (text or file)
  const STATE_AFTER_BOUNDARY = 3; // just past a boundary; expect CRLF or `--`
  const STATE_DONE = 4;

  let state = STATE_PREAMBLE;
  let buf = Buffer.alloc(0);
  let done = false;
  let pendingFlush = 0;       // outstanding async ws.end callbacks
  let endSeen = false;        // 'end' event fired but we may still be flushing
  let textCharCount = 0;
  const TEXT_FIELD_TOTAL_CAP = 1024 * 1024; // 1MB cap on aggregate text fields

  // Per-part state
  let currentName = null;
  let currentFilename = null;
  let isMatchingFile = false;     // true when current part is the file we want
  let writeStream = null;
  let writePath = null;
  let bytesWritten = 0;
  let textBuf = null;             // Buffer when current part is a text field

  const body = {};
  let fileResult = null;

  const fail = (err) => {
    if (done) return;
    done = true;
    state = STATE_DONE;
    if (writeStream) {
      writeStream.destroy();
      // Best-effort cleanup of the partially-written file.
      if (writePath) unlink(writePath).catch(() => {});
    }
    req.removeAllListeners('data');
    next(err);
  };

  const finish = () => {
    if (done) return;
    // If 'end' fires before we hit the terminal `--<boundary>--`, the
    // request is truncated/malformed — reject with 400 instead of silently
    // accepting a partial upload (could matter for a 2GB Apple Health
    // import that gets cut off mid-stream).
    if (state !== STATE_DONE) {
      // Clean up any partially-written file before failing.
      if (writeStream) writeStream.destroy();
      if (writePath) unlink(writePath).catch(() => {});
      // Also drop the in-progress fileResult if endPart already finalized
      // a file from a part that was followed by truncated data.
      if (fileResult?.path) unlink(fileResult.path).catch(() => {});
      done = true;
      const err = new Error('Truncated multipart request — never reached terminal boundary');
      err.code = 'INVALID_MULTIPART';
      err.status = 400;
      next(err);
      return;
    }
    done = true;
    req.body = body;
    if (fileResult) req.file = fileResult;
    next();
  };

  // Start a new part — parse headers, set up text buffer or file write stream.
  const startPart = (headerBlock) => {
    const headerStr = headerBlock.toString('utf-8');
    // Negative lookbehind keeps `name=` inside `filename=` from matching.
    const nameMatch = headerStr.match(/(?<!file)name="([^"]+)"/i);
    if (!nameMatch) return fail(new Error('Multipart part missing Content-Disposition name'));
    currentName = nameMatch[1];
    const filenameMatch = headerStr.match(/filename="([^"]*)"/i);
    currentFilename = filenameMatch?.[1];

    if (currentFilename != null && currentFilename !== '') {
      isMatchingFile = currentName === fileFieldName;
      const mimeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
      currentFileMimetype = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';
      if (isMatchingFile) {
        const fileMeta = { originalname: currentFilename, mimetype: currentFileMimetype };

        if (fileFilter) {
          let fr = null;
          fileFilter(req, fileMeta, (err, accept) => { fr = { err, accept }; });
          if (fr.err) return fail(fr.err);
          if (!fr.accept) {
            // Set status/code so the centralized error middleware returns a
            // 400 to the client instead of a 500 (the err thrown by the
            // filter rejection is a client-input error, not a server bug).
            const rejectErr = new Error('File type not allowed');
            rejectErr.status = 400;
            rejectErr.code = 'INVALID_FILE_TYPE';
            return fail(rejectErr);
          }
        }

        const rawExt = currentFilename.match(/\.[^.]+$/)?.[0] || '';
        const ext = rawExt.replace(/[^a-zA-Z0-9.]/g, '');
        writePath = join(tmpdir(), `upload-${randomUUID()}${ext}`);
        writeStream = createWriteStream(writePath);
        writeStream.on('error', fail);
        bytesWritten = 0;
      }
      // Non-matching file part: no buffer, no stream — bytes are silently
      // discarded as the body advances past them.
    } else {
      textBuf = Buffer.alloc(0);
    }
  };

  // Emit `chunk` to the current part's destination (file write or text buffer
  // or the void). Enforces maxSize for the matching file and the global
  // text-field cap. Returns true to keep streaming, false on error/abort.
  const writePartChunk = (chunk) => {
    if (chunk.length === 0) return true;
    if (currentFilename != null && currentFilename !== '') {
      if (isMatchingFile) {
        bytesWritten += chunk.length;
        if (bytesWritten > maxSize) { fail(new Error(`File too large (max ${maxSize} bytes)`)); return false; }
        if (!writeStream.write(chunk)) {
          // Backpressure: pause the request stream and resume on drain.
          req.pause();
          writeStream.once('drain', () => req.resume());
        }
      }
      // Non-matching file: drop bytes silently.
    } else {
      textCharCount += chunk.length;
      if (textCharCount > TEXT_FIELD_TOTAL_CAP) { fail(new Error(`Text fields too large (max ${TEXT_FIELD_TOTAL_CAP} bytes)`)); return false; }
      textBuf = Buffer.concat([textBuf, chunk]);
    }
    return true;
  };

  // Finalize the current part — flush any pending data, then move on.
  const endPart = (cb) => {
    if (currentFilename != null && currentFilename !== '') {
      if (isMatchingFile && writeStream) {
        const ws = writeStream;
        const path = writePath;
        const size = bytesWritten;
        const filename = currentFilename;
        const mimetype = currentFileMimetype || 'application/octet-stream';
        writeStream = null;
        writePath = null;
        pendingFlush += 1;
        ws.end(() => {
          fileResult = { path, originalname: filename, mimetype, size };
          pendingFlush -= 1;
          cb();
          // If 'end' arrived while we were still flushing, finalize now.
          if (endSeen && pendingFlush === 0 && !done) finish();
        });
      } else {
        cb();
      }
    } else if (textBuf != null) {
      const value = textBuf.toString('utf-8');
      if (Object.prototype.hasOwnProperty.call(body, currentName)) {
        if (Array.isArray(body[currentName])) body[currentName].push(value);
        else body[currentName] = [body[currentName], value];
      } else {
        body[currentName] = value;
      }
      textBuf = null;
      cb();
    } else {
      cb();
    }
  };

  // Captured by startPart so endPart's async cb has the right mimetype even
  // after the next part may have started.
  let currentFileMimetype = null;

  const tick = () => {
    if (done) return;

    while (true) {
      if (state === STATE_PREAMBLE) {
        const idx = buf.indexOf(FIRST_DELIM);
        if (idx === -1) {
          // Need more bytes; drop everything past the last possible boundary start.
          const safe = buf.length - (FIRST_DELIM.length - 1);
          if (safe > 0) buf = buf.slice(safe);
          return;
        }
        buf = buf.slice(idx + FIRST_DELIM.length);
        state = STATE_AFTER_BOUNDARY;
        continue;
      }

      if (state === STATE_AFTER_BOUNDARY) {
        if (buf.length < 2) return;
        const trailing = buf.slice(0, 2);
        if (trailing[0] === 0x2d && trailing[1] === 0x2d) { // `--`
          buf = Buffer.alloc(0);
          // Mark clean termination so finish() can distinguish a proper
          // end from a truncated request that hit 'end' mid-stream.
          state = STATE_DONE;
          return finish();
        }
        if (trailing[0] !== 0x0d || trailing[1] !== 0x0a) return fail(new Error('Malformed multipart: missing CRLF after boundary'));
        buf = buf.slice(2);
        state = STATE_HEADERS;
        continue;
      }

      if (state === STATE_HEADERS) {
        const hEnd = buf.indexOf(HEADER_END);
        if (hEnd === -1) return; // wait for more bytes
        const headers = buf.slice(0, hEnd);
        buf = buf.slice(hEnd + HEADER_END.length);
        startPart(headers);
        if (done) return;
        state = STATE_BODY;
        continue;
      }

      if (state === STATE_BODY) {
        const idx = buf.indexOf(PART_DELIM);
        if (idx === -1) {
          // No boundary yet — emit what's safe and hold back PART_DELIM.length-1
          // trailing bytes so a boundary spanning the next chunk isn't missed.
          const safe = buf.length - (PART_DELIM.length - 1);
          if (safe > 0) {
            if (!writePartChunk(buf.slice(0, safe))) return;
            buf = buf.slice(safe);
          }
          return;
        }
        // Found end of part. Emit everything before the boundary, then advance.
        if (!writePartChunk(buf.slice(0, idx))) return;
        buf = buf.slice(idx + PART_DELIM.length);
        // endPart may be async (file flush) — pause the request, resume after.
        req.pause();
        endPart(() => {
          state = STATE_AFTER_BOUNDARY;
          req.resume();
          tick(); // process anything already buffered
        });
        return;
      }

      return; // unknown state
    }
  };

  req.on('data', (chunk) => {
    if (done) return;
    buf = Buffer.concat([buf, chunk]);
    tick();
  });

  req.on('end', () => {
    if (done) return;
    endSeen = true;
    // Drain anything still in buf as part of the current state.
    tick();
    // If a file flush is still pending, the endPart callback will finalize.
    if (!done && pendingFlush === 0) finish();
  });

  req.on('error', fail);
}
