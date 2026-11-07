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
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Present in every PortOS database since the first pg_dump backup. Tables added
// later are deliberately NOT required: an old dump legitimately predates them,
// and schema reconciliation recreates them after replay.
export const REQUIRED_DUMP_TABLES = ['memories', 'memory_links'];

// pg_dump writes this comment block last. Newer pg_dump (17.6/16.10/15.14+)
// follows it with `\unrestrict <key>`; nothing else may come after it.
const COMPLETE_TRAILER = /\n--\r?\n-- PostgreSQL database dump complete\r?\n--\r?\n(?:\s*\\unrestrict [^\r\n]*)?\s*$/;
const CREATE_TABLE_STATEMENT = /^CREATE TABLE (?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"? \(/;
// The scanner omits string contents, retaining only their opening quote.
// Match the complete scanned statement, not arbitrary SQL starting with COMMENT.
const EXTENSION_COMMENT = /^COMMENT ON EXTENSION (?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*) IS (?:E?'|NULL)\s*$/;
// The reset deliberately retains installed extensions. pg_dump --clean still
// emits these drops, which require ownership even with --no-owner/--no-comments.
// Preserve that reset contract; never omit CASCADE or other DROP statements.
const EXTENSION_DROP = /^DROP EXTENSION IF EXISTS (?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s*$/;
const TAIL_BYTES = 4096;
// Bound the buffered line and statement prefix; oversized COPY rows are skipped.
// Oversized SQL lines fail admission rather than losing lexical context.
const MAX_SCANNED_LINE = 64 * 1024;

/**
 * Stream the dump once. Read failures reject — they are never an empty dump.
 * With `spoolTo`, the exact bytes inspected are also written to that new file
 * (created exclusively, owner-only), so a restore can replay what it checked
 * even if the snapshot changes afterwards; a spool write failure rejects too.
 * Offline inspectors may supply a bounded stream from their pinned descriptor
 * and a stricter table inventory. Neither option executes SQL or proves restore.
 * @param {string} path
 * @param {{ spoolTo?: string, omitVersionDirectives?: boolean, rejectPsqlCommands?: boolean, targetServerMajor?: number, inputStream?: import('node:stream').Readable, requiredTables?: string[] }} [options]
 * @returns {Promise<{ sizeBytes: number, sha256: string, tableCount: number, complete: boolean, missingTables: string[], extensionMetadata?: {start: number, end: number}[] }>}
 */
export function inspectDatabaseDump(path, { spoolTo, omitVersionDirectives = false, rejectPsqlCommands = false, targetServerMajor, inputStream, requiredTables = REQUIRED_DUMP_TABLES } = {}) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    // Latin-1 preserves byte offsets and dumps in non-UTF-8 client encodings.
    const decoder = new StringDecoder('latin1');
    const extensionMetadata = [];
    let scannedBytes = 0;
    let statementStart = null;
    const tables = new Set();
    let tableCount = 0;
    let sizeBytes = 0;
    let tail = Buffer.alloc(0);
    let carry = '';
    let skippingLine = false;
    let copyData = false;
    let quote = null;
    let dollarQuote = null;
    let blockDepth = 0;
    let statement = '';
    let statementTruncated = false;
    let unscannable = false;
    // Keep only the statement prefix: COPY rows and SQL values may be huge.
    // Count completed top-level statements, never SQL-looking stored content.
    const scanLine = (line) => {
      const lineStart = scannedBytes;
      scannedBytes += line.length;
      if (copyData) {
        if (line.replace(/\r?\n$/, '') === '\\.') copyData = false;
        return;
      }
      if (!statement && !quote && !dollarQuote && !blockDepth) {
        // Snapshot replay retains psql restrictions. Only the exact pg_dump
        // header unsupported before PG17 is removable, never stored SQL text.
        const timeoutHeader = /^SET transaction_timeout = 0;\r?\n?$/.test(line);
        if ((omitVersionDirectives && (/^\\(?:un)?restrict /.test(line) || timeoutHeader))
          || (Number.isInteger(targetServerMajor) && targetServerMajor > 0 && targetServerMajor < 17 && timeoutHeader)) {
          extensionMetadata.push({ start: lineStart, end: scannedBytes });
          return;
        }
        if (line.startsWith('\\')) { if (rejectPsqlCommands) unscannable = true; return; }
      }
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        const next = line[i + 1];
        if (dollarQuote) {
          if (line.startsWith(dollarQuote, i)) {
            i += dollarQuote.length - 1;
            dollarQuote = null;
          }
          continue;
        }
        if (quote) {
          // This opt-in admission does not interpret SET lexical modes or
          // encoding-dependent backslash escapes. Refuse ambiguous SQL tokens;
          // COPY and dollar-quoted payloads never use those escape rules.
          if (rejectPsqlCommands && c === '\\') unscannable = true;
          if (c === quote.character) {
            if (next === c) i += 1;
            else quote = null;
          } else if (c === '\\' && quote.escapes) i += 1;
          continue;
        }
        if (blockDepth) {
          if (c === '/' && next === '*') { blockDepth += 1; i += 1; }
          else if (c === '*' && next === '/') { blockDepth -= 1; i += 1; }
          continue;
        }
        // Detached rehearsal admission rejects non-data commands before psql's
        // own restriction gate. Only pg_dump's restriction headers were stripped
        // above; command-looking content in quotes/COPY/comments remains data.
        if (c === '\\' && rejectPsqlCommands) unscannable = true;
        if (c === '-' && next === '-') break;
        if (c === '/' && next === '*') { blockDepth = 1; i += 1; continue; }
        if (c === ';') {
          if (spoolTo && !statementTruncated && (EXTENSION_COMMENT.test(statement) || EXTENSION_DROP.test(statement))) {
            extensionMetadata.push({ start: statementStart, end: lineStart + i + 1 });
          }
          const match = statement.match(CREATE_TABLE_STATEMENT);
          if (match) { tableCount += 1; tables.add(match[1]); }
          copyData = /^COPY\s/.test(statement) && / FROM stdin$/.test(statement);
          statement = '';
          statementTruncated = false;
          statementStart = null;
          if (copyData) {
            // psql resumes the command line after consuming COPY's stdin rows.
            // Do not let a trailing command hide behind the scanner's COPY skip.
            if (rejectPsqlCommands && !/^\s*(?:--[^\r\n]*)?$/.test(line.slice(i + 1))) unscannable = true;
            break;
          }
          continue;
        }
        if (statementStart === null && !/\s/.test(c)) statementStart = lineStart + i;
        if (c === '$' && (!rejectPsqlCommands || !/[A-Za-z0-9_$\x80-\xff]/.test(line[i - 1] ?? ''))) {
          const delimiter = line.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
          if (delimiter) { dollarQuote = delimiter; i += delimiter.length - 1; }
        }
        if (c === "'" || c === '"') {
          quote = { character: c, escapes: c === "'" && /(?:^|[^A-Za-z0-9_])E$/i.test(statement) };
        }
        // Double-quoted identifiers in a CREATE header still belong to its
        // prefix. Preserve them separately from SQL string contents below.
        if (c === '"') {
          const identifier = line.slice(i).match(/^"(?:[^"]|"")*"/);
          if (identifier) {
            if (rejectPsqlCommands && identifier[0].includes('\\')) unscannable = true;
            if (statement.length + identifier[0].length <= MAX_SCANNED_LINE) statement += identifier[0];
            else statementTruncated = true;
            i += identifier[0].length - 1;
            quote = null;
            continue;
          }
        }
        if (statement || !/\s/.test(c)) {
          if (statement.length < MAX_SCANNED_LINE) statement += c;
          else statementTruncated = true;
        }
      }
    };
    const scan = (text) => {
      for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) scanLine(line);
    };

    const stream = inputStream ?? createReadStream(path);
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
        if (newline === -1) { scannedBytes += text.length; return; }
        scannedBytes += newline + 1;
        text = text.slice(newline + 1);
        skippingLine = false;
      }
      text = carry + text;
      const lineEnd = text.lastIndexOf('\n') + 1;
      scan(text.slice(0, lineEnd));
      carry = text.slice(lineEnd);
      if (carry.length > MAX_SCANNED_LINE) {
        // An oversized SQL line cannot be safely skipped while retaining its
        // lexical state. pg_dump data uses COPY, whose rows are safe to skip.
        if (!copyData) unscannable = true;
        scannedBytes += carry.length;
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
        complete: !unscannable && !copyData && !quote && !dollarQuote && !blockDepth
          && !statement.trim() && COMPLETE_TRAILER.test(tail.toString('latin1')),
        missingTables: requiredTables.filter(name => !tables.has(name)),
        ...(spoolTo ? { extensionMetadata } : {}),
        ...(omitVersionDirectives ? { replayScanSafe: !unscannable } : {}),
      };
      spooled.then(() => { if (!failed) resolvePromise(result); });
    });
  });
}

/**
 * Omit admitted extension comments and clean-dump extension drops from the
 * private replay copy, along with admitted incompatible version headers. The snapshot, checksum, completion proof and recovery
 * receipt retain the original bytes.
 * All other bytes pass through unchanged, including non-UTF-8 COPY data.
 */
export async function prepareDatabaseReplay(spoolPath, extensionMetadata) {
  if (!extensionMetadata.length) return spoolPath;
  const replayPath = `${spoolPath}.replay`;
  let offset = 0;
  let rangeIndex = 0;
  const omitMetadata = new Transform({
    transform(chunk, _encoding, callback) {
      const end = offset + chunk.length;
      let cursor = offset;
      while (rangeIndex < extensionMetadata.length) {
        const range = extensionMetadata[rangeIndex];
        if (range.start >= end) break;
        if (range.start > cursor) this.push(chunk.subarray(cursor - offset, range.start - offset));
        cursor = Math.max(cursor, Math.min(end, range.end));
        if (range.end > end) break;
        rangeIndex += 1;
      }
      if (cursor < end) this.push(chunk.subarray(cursor - offset));
      offset = end;
      callback();
    },
  });
  await pipeline(createReadStream(spoolPath), omitMetadata,
    createWriteStream(replayPath, { flags: 'wx', mode: 0o600 }));
  return replayPath;
}
