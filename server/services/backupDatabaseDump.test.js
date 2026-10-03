/**
 * The streamed dump scanner must see table headers and the terminal marker
 * wherever the 64 KiB read chunks happen to split a real file (#8782). The
 * restore-level contracts live in backup.test.js / backup.db.test.js.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { inspectDatabaseDump, prepareDatabaseReplay } from './backupDatabaseDump.js';

const dir = mkdtempSync(join(tmpdir(), 'portos-dump-inspect-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHUNK = 64 * 1024;
const TRAILER = '\n--\n-- PostgreSQL database dump complete\n--\n\n';
const write = (name, text) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe('inspectDatabaseDump', () => {
  it('counts a table header split across a read boundary and skips an oversized COPY row', async () => {
    const lead = '-- PostgreSQL database dump\n';
    // Place `CREATE TABLE public.memories (` so the chunk boundary cuts it.
    const pad = `--${'x'.repeat(CHUNK - lead.length - 10 - 3)}\n`;
    const longRow = `COPY public.memories (id) FROM stdin;\n${'a'.repeat(3 * CHUNK)}\tCREATE TABLE public.fake (\n\\.\n`;
    const sql = `${lead}${pad}CREATE TABLE public.memories (\n);\n${longRow}CREATE TABLE public.memory_links (\n);\n${TRAILER}`;
    expect(sql.indexOf('CREATE TABLE public.memories')).toBeLessThan(CHUNK);
    expect(sql.indexOf('memories (')).toBeGreaterThan(CHUNK);
    const result = await inspectDatabaseDump(write('split.sql', sql));
    expect(result).toEqual({
      sizeBytes: Buffer.byteLength(sql),
      sha256: createHash('sha256').update(sql).digest('hex'),
      tableCount: 2,
      complete: true,
      missingTables: [],
    });
  });

  it.each([
    ['legacy trailer without \\unrestrict', TRAILER, true],
    ['CRLF trailer', TRAILER.replaceAll('\n', '\r\n'), true],
    ['\\unrestrict trailer', `${TRAILER}\\unrestrict k3y\n\n`, true],
    ['statement after the marker', `${TRAILER}SELECT 1;\n`, false],
    ['no marker', '\n', false],
  ])('judges completeness from the %s', async (_case, tail, complete) => {
    const sql = `CREATE TABLE public.memories (\n);\nCREATE TABLE public.memory_links (\n);\n${tail}`;
    expect((await inspectDatabaseDump(write('tail.sql', sql))).complete).toBe(complete);
  });

  it.each([
    ['COPY data', 'COPY public.notes (body) FROM stdin;\nCREATE TABLE public.memory_links (\n\\.\n'],
    ['dollar-quoted function', 'CREATE FUNCTION public.example() RETURNS text AS $body$\nCREATE TABLE public.memory_links (\n$body$ LANGUAGE sql;\n'],
    ['multiline string', "COMMENT ON TABLE public.memories IS '\nCREATE TABLE public.memory_links (\n';\n"],
    ['block comment', '/*\nCREATE TABLE public.memory_links (\n*/\n'],
  ])('does not admit a missing table from DDL embedded in %s', async (_case, embedded) => {
    const sql = `CREATE TABLE public.memories (\n);\n${embedded}${TRAILER}`;
    const result = await inspectDatabaseDump(write('embedded.sql', sql));
    expect(result).toMatchObject({ tableCount: 1, complete: true, missingTables: ['memory_links'] });
  });

  it('rejects a trailer embedded in an unterminated SQL value', async () => {
    const sql = `CREATE TABLE public.memories (\n);\nCREATE TABLE public.memory_links (\n);\nSELECT $body$${TRAILER}`;
    expect((await inspectDatabaseDump(write('unterminated.sql', sql))).complete).toBe(false);
  });

  // #9887: only real top-level extension metadata can be omitted. Stored
  // SQL-looking data and ordinary comments must remain byte-for-byte intact.
  it('stages extension comments across chunks without changing data or original integrity', async () => {
    const ordinary = "COMMENT ON TABLE public.memories IS '\nCOMMENT ON EXTENSION vector IS ''stored'';\n';\n";
    const routine = "CREATE FUNCTION public.example() RETURNS text AS $body$\nCOMMENT ON EXTENSION vector IS 'function';\n$body$ LANGUAGE sql;\n";
    const copy = Buffer.concat([Buffer.from("COPY public.memories (id) FROM stdin;\nCOMMENT ON EXTENSION vector IS 'row';\n"),
      Buffer.alloc(3 * CHUNK, 0xe9), Buffer.from("\n\\.\n")]);
    const extension = `DROP EXTENSION IF EXISTS vector; COMMENT ON EXTENSION "example""name" IS 'first; ''quoted''\n${'x\n'.repeat(CHUNK)}last';`;
    const prefix = Buffer.concat([Buffer.from("CREATE TABLE public.memories (\n);\nCREATE TABLE public.memory_links (\n);\n" + ordinary + routine), copy]);
    const suffix = Buffer.from("\nDROP TABLE public.example; DROP EXTENSION vector CASCADE;\nCOMMENT ON EXTENSION vector IS NULL; SELECT 42;\n" + TRAILER);
    const sql = Buffer.concat([prefix, Buffer.from(extension), suffix]);
    const original = write('comments.sql', sql);
    const spoolTo = join(dir, 'comments-spool.sql');
    const dump = await inspectDatabaseDump(original, { spoolTo });
    expect(dump).toMatchObject({ complete: true, missingTables: [],
      sha256: createHash('sha256').update(sql).digest('hex'), sizeBytes: sql.length });
    expect(dump.extensionMetadata).toHaveLength(3);
    const replayPath = await prepareDatabaseReplay(spoolTo, dump.extensionMetadata);
    expect(readFileSync(original)).toEqual(sql);
    expect(readFileSync(spoolTo)).toEqual(sql);
    expect(readFileSync(replayPath)).toEqual(Buffer.concat([prefix, Buffer.from(" \nDROP TABLE public.example; DROP EXTENSION vector CASCADE;\n SELECT 42;\n" + TRAILER)]));
    if (process.platform !== 'win32') expect(statSync(replayPath).mode & 0o777).toBe(0o600);
  });

  it('retains an oversized statement prefix so invalid SQL still reaches transactional replay', async () => {
    const sql = "CREATE TABLE public.memories (\n);\nCREATE TABLE public.memory_links (\n);\n"
      + `COMMENT ON EXTENSION vector IS NULL${' \n'.repeat(CHUNK)}INVALID SQL;\n` + TRAILER;
    const spoolTo = join(dir, 'invalid-comment-spool.sql');
    const dump = await inspectDatabaseDump(write('invalid-comment.sql', sql), { spoolTo });
    expect(dump.complete).toBe(true);
    expect(dump.extensionMetadata).toEqual([]);
    const replayPath = await prepareDatabaseReplay(spoolTo, dump.extensionMetadata);
    expect(readFileSync(replayPath, 'utf8')).toBe(sql);
  });

  it('rejects a read failure rather than reporting an empty dump', async () => {
    await expect(inspectDatabaseDump(join(dir, 'missing.sql'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
