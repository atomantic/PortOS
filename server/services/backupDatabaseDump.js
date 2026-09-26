/**
 * Admission of a snapshot's plain-format pg_dump before a full restore (#8782).
 *
 * A full restore resets every application table before replaying the dump, so
 * a dump that merely parses is not enough: a truncated file that ends between
 * complete statements (or holds only its header comments) would commit the
 * reset and leave empty tables behind. Historical snapshots carry no checksum
 * to catch that, so completeness is proven from the dump's own envelope.
 */
import { createReadStream, createWriteStream } from 'fs';
import { createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';

// Present in every PortOS database since the first pg_dump backup. Tables added
// later are deliberately NOT required: an old dump legitimately predates them,
// and schema reconciliation recreates them after replay.
export const REQUIRED_DUMP_TABLES = ['memories', 'memory_links'];

// pg_dump writes this comment block last. Newer pg_dump (17.6/16.10/15.14+)
// follows it with `\unrestrict <key>`; nothing else may come after it.
const COMPLETE_TRAILER = /\n--\r?\n-- PostgreSQL database dump complete\r?\n--\r?\n(?:\s*\\unrestrict [^\r\n]*)?\s*$/;
const CREATE_TABLE_LINE = /^CREATE TABLE (?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"? \(/gm;
const TAIL_BYTES = 4096;
// A CREATE TABLE header is short. Past this, a line is data (a COPY row, or a
// file that is not SQL at all) and is skipped rather than buffered whole.
const MAX_SCANNED_LINE = 64 * 1024;

/**
 * Stream the dump once. Read failures reject — they are never an empty dump.
 * With `spoolTo`, the exact bytes inspected are also written to that new file
 * (created exclusively, owner-only), so a restore can replay what it checked
 * even if the snapshot changes afterwards; a spool write failure rejects too.
 * @param {string} path
 * @param {{ spoolTo?: string }} [options]
 * @returns {Promise<{ sizeBytes: number, sha256: string, tableCount: number, complete: boolean, missingTables: string[] }>}
 */
export function inspectDatabaseDump(path, { spoolTo } = {}) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const decoder = new StringDecoder('utf8');
    const tables = new Set();
    let tableCount = 0;
    let sizeBytes = 0;
    let tail = Buffer.alloc(0);
    let carry = '';
    let skippingLine = false;
    const scan = (text) => {
      for (const [, name] of text.matchAll(CREATE_TABLE_LINE)) {
        tableCount += 1;
        tables.add(name);
      }
    };

    const stream = createReadStream(path);
    const spool = spoolTo ? createWriteStream(spoolTo, { flags: 'wx', mode: 0o600 }) : null;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      stream.destroy();
      spool?.destroy();
      reject(err);
    };
    stream.on('error', fail);
    // pipe() ends the spool after the last chunk; the result waits until it is on disk.
    const spooled = spool
      ? new Promise((resolveSpool) => spool.on('finish', resolveSpool))
      : Promise.resolve();
    spool?.on('error', fail);
    if (spool) stream.pipe(spool);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
      tail = chunk.length >= TAIL_BYTES
        ? chunk.subarray(chunk.length - TAIL_BYTES)
        : Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);

      let text = decoder.write(chunk);
      if (skippingLine) {
        const newline = text.indexOf('\n');
        if (newline === -1) return;
        text = text.slice(newline + 1);
        skippingLine = false;
      }
      text = carry + text;
      const lineEnd = text.lastIndexOf('\n') + 1;
      scan(text.slice(0, lineEnd));
      carry = text.slice(lineEnd);
      if (carry.length > MAX_SCANNED_LINE) {
        scan(carry);
        carry = '';
        skippingLine = true;
      }
    });
    stream.on('end', () => {
      if (!skippingLine) scan(carry + decoder.end());
      const result = {
        sizeBytes,
        sha256: hash.digest('hex'),
        tableCount,
        complete: COMPLETE_TRAILER.test(tail.toString('latin1')),
        missingTables: REQUIRED_DUMP_TABLES.filter(name => !tables.has(name)),
      };
      spooled.then(() => { if (!failed) resolvePromise(result); });
    });
  });
}

