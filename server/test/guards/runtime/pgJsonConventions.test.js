/**
 * Rule: Values bound to a `::json`/`::jsonb` parameter must be serialized with `toPgJson` (`lib/pgJson.js`), never bare `JSON.stringify` (only the documented `::json` byte-exact migrations are exempt from `::json`; `::jsonb` is enforced everywhere including `scripts/db-migrations/`).
 * Fix: Replace `JSON.stringify(…)` with `toPgJson(…)`.
 * What this guard cannot see:
 *   - Lexer-assisted scan (`lib/sourceScan.js`): misses a stringified value bound to a `json`/`jsonb` column with no `::json` cast in its block, or stringified in one function and bound in another.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { matchBracket } from '../../../lib/sourceScan.js';
import { blankCommentBodies, blankLiterals } from '../../guardSources.js';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');
const SCANNED_DIRS = ['services/', 'lib/', 'routes/', 'scripts/'];
const JSON_CAST = /::jsonb?\b/;
const JSONB_CAST = /::jsonb\b/;
// These ::json migrations assert byte-exact equality against JSON.stringify (020/021).
// They are still checked for ::jsonb parameters via JSONB_CAST.
const BYTE_EXACT_JSON_MIGRATIONS = new Set([
  'scripts/db-migrations/020-cos-agents-from-state.js',
  'scripts/db-migrations/032-strip-release-candidate-transfer-state.js',
]);
const STRINGIFY = /JSON\.stringify\s*\(/g;
const QUERY_CALLEE = /(?:^|[^\w$])(?:query|queryFn|execute|exec|run|q)\s*$/;

/** Every violating `JSON.stringify(` in `src`, as `line N`. */
export function findPgJsonViolations(src, castPattern = JSON_CAST) {
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
    if (queryCall !== undefined) return castPattern.test(text.slice(queryCall, matchBracket(code, queryCall)));
    // Shape 2: a bind-parameter list assembled apart from the SQL.
    const innermost = enclosing[enclosing.length - 1];
    if (innermost === undefined) return false;
    const isParamList = code[innermost] === '['
      || (code[innermost] === '(' && /\.push\s*$/.test(calleeOf(innermost)));
    if (!isParamList) return false;
    const block = [...enclosing].reverse().find((open) => code[open] === '{');
    if (block === undefined) return castPattern.test(text);
    const end = matchBracket(code, block);
    return end !== -1 && castPattern.test(text.slice(block, end));
  }
}

const trackedSources = () => trackedFiles(SERVER_ROOT, ['*.js', '*.mjs']).filter((f) => f
  && SCANNED_DIRS.some((dir) => f.startsWith(dir))
  && !f.includes('.test.'));

describe('json/jsonb parameters are serialized with toPgJson (#12815)', () => {
  it('scans the server tree including db-migrations', () => {
    // A broken `git ls-files` would otherwise let every assertion pass by scanning nothing.
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.startsWith('scripts/db-migrations/'))).toBe(true);
  });

  it('has no bare JSON.stringify feeding a json/jsonb parameter', () => {
    const violations = [];
    for (const file of trackedSources()) {
      const castPattern = BYTE_EXACT_JSON_MIGRATIONS.has(file) ? JSONB_CAST : JSON_CAST;
      const src = readText(join(SERVER_ROOT, file));
      if (!src.includes('JSON.stringify') || !castPattern.test(src)) continue;
      for (const hit of findPgJsonViolations(src, castPattern)) violations.push(`server/${file} ${hit}`);
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

  it('supports narrowing to ::jsonb for byte-exact ::json exemptions', () => {
    expect(findPgJsonViolations("await query('UPDATE t SET d = $1::json', [JSON.stringify(record)]);", /::jsonb\b/))
      .toEqual([]);
    expect(findPgJsonViolations("await query('UPDATE t SET d = $1::jsonb', [JSON.stringify(record)]);", /::jsonb\b/))
      .toEqual(['line 1']);
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
