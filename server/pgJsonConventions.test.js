/**
 * Repo-wide guard: a value bound to a `json`/`jsonb` parameter is serialized with
 * `toPgJson` (lib/pgJson.js), never bare `JSON.stringify`.
 *
 * PostgreSQL refuses a lone UTF-16 surrogate and NUL inside `jsonb`, which every
 * file store these records came from accepted. `JSON.stringify` writes a lone
 * surrogate as the ASCII escape `\ud83d`, so the value reaches the server intact
 * and is refused — an emoji cut in half by `.slice()` lost a user-promoted CoS
 * task (#12815). `toPgJson` applies the repair the old UTF-8 file writes did.
 *
 * ## The rule
 *
 * A `JSON.stringify(` call is a violation when it feeds a statement that mentions
 * `::json`/`::jsonb`, in either shape:
 *
 *   1. it sits anywhere inside a `query(…)`/`execute(…)`-style call whose text
 *      mentions `::json`/`::jsonb` (the common case, including a `.map(…)` that
 *      builds an `unnest` column), or
 *   2. its innermost bracket is an array literal or a `.push(…)` — a bind-parameter
 *      list assembled apart from the SQL — and the enclosing block mentions
 *      `::json`/`::jsonb`.
 *
 * Hashing, logging, HTTP bodies and advisory-lock keys are not in either shape.
 *
 * ## Allowlist
 *
 * There is none. Applied migrations (`scripts/db-migrations/`) are frozen and
 * skipped wholesale: `020-*` binds to `json` (exact text) on purpose and verifies
 * byte equality. Anything else: swap in `toPgJson`.
 *
 * ## What this guard CANNOT see
 *
 * A lexer-assisted source scan (see lib/sourceScan.js), not a type-aware one. It
 * misses a stringified value bound to a `json`/`jsonb` COLUMN with no `::json`
 * cast anywhere in its block, and a value stringified in one function and bound
 * in another. `db.js` repairs plain-object parameters regardless, which covers
 * the call sites that never stringified at all.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { blankCommentBodies, blankLiterals, matchBracket } from './lib/sourceScan.js';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));
const SCANNED_DIRS = ['services/', 'lib/', 'routes/', 'scripts/'];
const JSON_CAST = /::jsonb?\b/;
const STRINGIFY = /JSON\.stringify\s*\(/g;
const QUERY_CALLEE = /(?:^|[^\w$])(?:query|queryFn|execute|exec|run|q)\s*$/;

/** Every violating `JSON.stringify(` in `src`, as `line N`. */
export function findPgJsonViolations(src) {
  const code = blankLiterals(src);
  const text = blankCommentBodies(src);
  const line = (index) => code.slice(0, index).split('\n').length;
  const calleeOf = (open) => code.slice(Math.max(0, open - 40), open);
  const hits = [];

  // One pass keeps the stack of enclosing brackets for every stringify call.
  const stack = [];
  const stringifyStarts = new Set([...code.matchAll(STRINGIFY)].map((match) => match.index));
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (stringifyStarts.has(i) && violates(stack)) hits.push(`line ${line(i)}`);
    if (ch === '(' || ch === '[' || ch === '{') stack.push(i);
    else if (ch === ')' || ch === ']' || ch === '}') stack.pop();
  }
  return hits;

  function violates(enclosing) {
    // Shape 1: inside a query-style call, whose own text is the statement.
    const queryCall = enclosing.find((open) => code[open] === '(' && QUERY_CALLEE.test(calleeOf(open)));
    if (queryCall !== undefined) return JSON_CAST.test(text.slice(queryCall, matchBracket(code, queryCall)));
    // Shape 2: a bind-parameter list assembled apart from the SQL.
    const innermost = enclosing[enclosing.length - 1];
    if (innermost === undefined) return false;
    const isParamList = code[innermost] === '['
      || (code[innermost] === '(' && /\.push\s*$/.test(calleeOf(innermost)));
    if (!isParamList) return false;
    const block = [...enclosing].reverse().find((open) => code[open] === '{');
    if (block === undefined) return JSON_CAST.test(text);
    const end = matchBracket(code, block);
    return end !== -1 && JSON_CAST.test(text.slice(block, end));
  }
}

const trackedSources = () => execFileSync('git', ['ls-files', '*.js', '*.mjs'], {
  cwd: SERVER_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => f
  && SCANNED_DIRS.some((dir) => f.startsWith(dir))
  && !f.includes('.test.')
  && !f.includes('db-migrations/'));

describe('json/jsonb parameters are serialized with toPgJson (#12815)', () => {
  it('scans the server tree', () => {
    // A broken `git ls-files` would otherwise let every assertion pass by scanning nothing.
    expect(trackedSources().length).toBeGreaterThan(200);
  });

  it('has no bare JSON.stringify feeding a json/jsonb parameter', () => {
    const violations = [];
    for (const file of trackedSources()) {
      const src = readFileSync(join(SERVER_ROOT, file), 'utf8');
      if (!src.includes('JSON.stringify') || !JSON_CAST.test(src)) continue;
      for (const hit of findPgJsonViolations(src)) violations.push(`server/${file} ${hit}`);
    }
    expect(
      violations,
      'PostgreSQL rejects a lone surrogate and NUL inside jsonb, so a bare JSON.stringify parameter '
      + 'loses the write when a string was cut mid-emoji (#12815).\n'
      + 'Fix: import { toPgJson } from the lib/pgJson.js module and use it in place of JSON.stringify.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});

// Guards the guard: if the recognizer stops seeing the bad shape the scan above goes green.
describe('the pgJson recognizer', () => {
  it('flags a stringified value inside a jsonb query', () => {
    expect(findPgJsonViolations("await query('INSERT INTO t (d) VALUES ($1::jsonb)', [JSON.stringify(record)]);"))
      .toEqual(['line 1']);
    expect(findPgJsonViolations(`await client.query(
      'INSERT INTO t SELECT u.d::jsonb FROM unnest($1::text[]) AS u(d)',
      [rows.map((row) => JSON.stringify(row.task))],
    );`)).toEqual(['line 3']);
  });

  it('flags a parameter list assembled apart from the SQL', () => {
    expect(findPgJsonViolations(`function update(patch) {
      const sets = ['payload = $2::jsonb'];
      const params = [];
      params.push(JSON.stringify(patch));
      return run(sets, params);
    }`)).toEqual(['line 4']);
    expect(findPgJsonViolations(`function insert(id, doc) {
      const sql = 'INSERT INTO t (id, doc) VALUES ($1, $2::jsonb)';
      const values = [id, JSON.stringify(doc)];
      return pool.query(sql, values);
    }`)).toEqual(['line 3']);
  });

  it('accepts toPgJson and stringification that is not a bind parameter', () => {
    expect(findPgJsonViolations("await query('INSERT INTO t (d) VALUES ($1::jsonb)', [toPgJson(record)]);")).toEqual([]);
    expect(findPgJsonViolations(`function bind(doc, a, b) {
      const sql = 'INSERT INTO t (doc) VALUES ($1::jsonb)';
      const key = createHash('sha256').update(JSON.stringify(doc)).digest('hex');
      const same = JSON.stringify(a) === JSON.stringify(b);
      return query(sql, [toPgJson(doc), key, same]);
    }`)).toEqual([]);
    // A stringified lock key in a query with no json cast, beside a jsonb statement.
    expect(findPgJsonViolations(`async function tx(client) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([a, b])]);
      await client.query("UPDATE t SET d = '{}'::jsonb");
    }`)).toEqual([]);
  });

  it('ignores JSON.stringify named in a comment or a string', () => {
    expect(findPgJsonViolations(`// params.push(JSON.stringify(x)) with ::jsonb
      const note = 'values = [JSON.stringify(x)] ::jsonb';`)).toEqual([]);
  });
});
