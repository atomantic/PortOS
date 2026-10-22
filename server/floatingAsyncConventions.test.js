/**
 * Repo-wide guard: a statement-level call to an `async` function must say who
 * owns its rejection (#12978).
 *
 *   announceSelf(peer);        // ← bare: a rejection before its own catch is unowned
 *
 * Nobody holds the promise, so a rejection becomes an `unhandledRejection`.
 * `setupProcessErrorHandlers` tags that critical, broadcasts it to the UI and
 * `autoFixer` files an AI task for what was meant to be best-effort bookkeeping.
 *
 * ## The rule
 *
 * An `ExpressionStatement` that calls an `async` function must be `await`ed,
 * end in `.catch(…)`, or start with `void`. `void` is the explicit spelling of
 * "this function owns its rejections and is intentionally fire-and-forget" —
 * confirm that is true before adding it.
 *
 * "Async function" means a module-scope `async` function declaration / `const f =
 * async …` (nested helpers are not resolved — names shadow across scopes), or a name imported from a relative module whose same-named export
 * is one of those. Calls through member access (`obj.run()`), namespace imports
 * and re-exports are not resolved. A local binding that shadows an async name
 * would be flagged; rename it.
 *
 * There is no allowlist: fix the call site.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse } from '@babel/parser';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

const parseSource = (src) => parse(src, { sourceType: 'module', errorRecovery: true, allowReturnOutsideFunction: true });

const isAsyncInit = (node) => (
  (node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression') && node.async === true
);

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'extra') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => walk(c, visit));
    else if (child && typeof child === 'object') walk(child, visit);
  }
}

/** Module-scope async functions declared in `ast`, plus which are exported. Nested ones are skipped: the same name is routinely a sync helper in a sibling scope. */
function asyncDeclarations(ast) {
  const local = new Set();
  const exported = new Set();
  const addDeclaration = (decl) => {
    if (decl?.type === 'FunctionDeclaration' && decl.async && decl.id) local.add(decl.id.name);
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && isAsyncInit(d.init)) local.add(d.id.name);
      }
    }
  };
  for (const stmt of ast.program.body) {
    addDeclaration(stmt);
    if (stmt.type === 'ExportNamedDeclaration') addDeclaration(stmt.declaration);
  }
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration') continue;
    const decl = stmt.declaration;
    if (decl?.type === 'FunctionDeclaration' && decl.async) exported.add(decl.id.name);
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && isAsyncInit(d.init)) exported.add(d.id.name);
      }
    }
    for (const spec of stmt.specifiers || []) {
      if (!stmt.source && local.has(spec.local.name)) exported.add(spec.exported.name || spec.exported.value);
    }
  }
  return { local, exported };
}

const exportCache = new Map();

function asyncExportsOf(absPath) {
  if (!exportCache.has(absPath)) {
    const candidates = [absPath, `${absPath}.js`, join(absPath, 'index.js')];
    const file = candidates.find((p) => p.endsWith('.js') && existsSync(p) && !p.endsWith('/'));
    exportCache.set(absPath, file ? asyncDeclarations(parseSource(readFileSync(file, 'utf8'))).exported : new Set());
  }
  return exportCache.get(absPath);
}

/**
 * Lines of every bare `asyncFn();` statement in `src`. `dir` resolves relative
 * imports; omit it to scan local declarations only.
 */
export function findFloatingAsyncCalls(src, dir = null) {
  const ast = parseSource(src);
  const asyncNames = new Set(asyncDeclarations(ast).local);
  if (dir) {
    for (const stmt of ast.program.body) {
      if (stmt.type !== 'ImportDeclaration' || !stmt.source.value.startsWith('.')) continue;
      const exported = asyncExportsOf(resolve(dir, stmt.source.value));
      for (const spec of stmt.specifiers) {
        if (spec.type === 'ImportSpecifier' && exported.has(spec.imported.name || spec.imported.value)) {
          asyncNames.add(spec.local.name);
        }
      }
    }
  }
  const hits = [];
  walk(ast, (node) => {
    if (node.type !== 'ExpressionStatement') return;
    const call = node.expression;
    if (call.type === 'CallExpression' && call.callee.type === 'Identifier' && asyncNames.has(call.callee.name)) {
      hits.push(`line ${node.loc.start.line}: ${call.callee.name}()`);
    }
  });
  return hits;
}

const trackedServerSources = () => execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs'], {
  cwd: SERVER_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => f && !f.includes('.test.'));

describe('async calls own their rejections (#12978)', () => {
  it('scans the server tree', () => {
    expect(trackedServerSources().length).toBeGreaterThan(200);
  });

  it('has no bare statement-level call to an async function', () => {
    const violations = [];
    for (const file of trackedServerSources()) {
      const src = readFileSync(join(SERVER_ROOT, file), 'utf8');
      for (const hit of findFloatingAsyncCalls(src, dirname(join(SERVER_ROOT, file)))) {
        violations.push(`server/${file} ${hit}`);
      }
    }
    expect(
      violations,
      'These statements call an `async` function without `await`, `.catch(…)` or `void`, so a '
      + 'rejection has no owner and becomes an unhandledRejection (which the auto-fixer turns into '
      + 'an AI task). Fix: make the callee own its rejections and prefix the call with `void`, or '
      + `append \`.catch(…)\`.\nOffenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('the floating-async recognizer', () => {
  it('flags a bare call to a local async function, declaration or arrow', () => {
    expect(findFloatingAsyncCalls('async function f() {}\nfunction g() { f(); }')).toEqual(['line 2: f()']);
    expect(findFloatingAsyncCalls('const f = async () => {};\nf();')).toEqual(['line 2: f()']);
  });

  it('accepts await, void, a trailing .catch, and a returned or assigned promise', () => {
    expect(findFloatingAsyncCalls(`
      async function f() {}
      async function g() { await f(); void f(); f().catch(() => {}); return f(); }
      const p = f();
    `)).toEqual([]);
  });

  it('ignores synchronous functions and member calls', () => {
    expect(findFloatingAsyncCalls('function f() {}\nf();\nobj.run();')).toEqual([]);
  });

  it('resolves an async export imported from a relative module', () => {
    const src = "import { announce as a, plain } from './services/instances.js';\na();\nplain();";
    // `announceSelf` is module-private, so use a known async export instead.
    expect(findFloatingAsyncCalls(src, SERVER_ROOT)).toEqual([]);
    expect(findFloatingAsyncCalls("import { logAction as log } from './services/history.js';\nlog();", SERVER_ROOT))
      .toEqual(['line 2: log()']);
  });
});
