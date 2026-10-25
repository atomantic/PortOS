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
import { trackedFiles } from '../scripts/lib/trackedFiles.js';

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse } from '@babel/parser';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

const parseSource = (src) => parse(src, { sourceType: 'module', errorRecovery: true, allowReturnOutsideFunction: true, attachComment: false });

const isAsyncInit = (node) => (
  (node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression') && node.async === true
);

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key in node) {
    if (key === 'loc' || key === 'extra' || key === 'comments' || key === 'errors') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visit);
    }
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

/** Retain recognition facts rather than every imported module's AST. */
function summarizeSource(src) {
  const ast = parseSource(src);
  const { local, exported } = asyncDeclarations(ast);
  const imports = ast.program.body.filter((stmt) => stmt.type === 'ImportDeclaration' && stmt.source.value.startsWith('.'))
    .map((stmt) => ({
      source: stmt.source.value,
      names: stmt.specifiers.filter((spec) => spec.type === 'ImportSpecifier')
        .map((spec) => ({ imported: spec.imported.name || spec.imported.value, local: spec.local.name })),
    }));
  const calls = [];
  walk(ast, (node) => {
    if (node.type !== 'ExpressionStatement') return;
    const call = node.expression;
    if (call.type === 'CallExpression' && call.callee.type === 'Identifier') {
      calls.push({ name: call.callee.name, line: node.loc.start.line });
    }
  });
  return { local, exported, imports, calls };
}

/** One scan owns its cache; import spellings share the resolved file's summary. */
function createFloatingAsyncScanner(readSource = (file) => readFileSync(file, 'utf8')) {
  const summaries = new Map();
  const resolutions = new Map();
  const summaryOf = (file) => {
    if (!summaries.has(file)) summaries.set(file, summarizeSource(readSource(file)));
    return summaries.get(file);
  };
  const asyncExportsOf = (absPath) => {
    if (!resolutions.has(absPath)) {
      const candidates = [absPath, `${absPath}.js`, join(absPath, 'index.js')];
      const file = candidates.find((p) => p.endsWith('.js') && existsSync(p) && !p.endsWith('/'));
      resolutions.set(absPath, file ?? null);
    }
    const file = resolutions.get(absPath);
    return file ? summaryOf(file).exported : new Set();
  };
  const findCalls = ({ local, imports, calls }, dir) => {
    const asyncNames = new Set(local);
    if (dir) {
      for (const imported of imports) {
        const exported = asyncExportsOf(resolve(dir, imported.source));
        for (const name of imported.names) {
          if (exported.has(name.imported)) asyncNames.add(name.local);
        }
      }
    }
    return calls.filter((call) => asyncNames.has(call.name))
      .map((call) => `line ${call.line}: ${call.name}()`);
  };
  return {
    findInSource: (src, dir = null) => findCalls(summarizeSource(src), dir),
    findInFile: (file) => {
      const summary = summaryOf(file);
      if (summary.hits) return summary.hits;
      const hits = findCalls(summary, dirname(file));
      // After visiting a file, only its exports and verdict can be needed again.
      summaries.set(file, { exported: summary.exported, hits });
      return hits;
    },
  };
}

/** Lines of every bare `asyncFn();` statement; omit `dir` to scan local declarations only. */
export function findFloatingAsyncCalls(src, dir = null) {
  return createFloatingAsyncScanner().findInSource(src, dir);
}

const trackedServerSources = () => trackedFiles(SERVER_ROOT, ['*.js', '*.mjs', '*.cjs']).filter((f) => f && !f.includes('.test.'));

describe('async calls own their rejections (#12978)', () => {
  it('scans the server tree', () => {
    expect(trackedServerSources().length).toBeGreaterThan(200);
  });

  it('has no bare statement-level call to an async function', () => {
    const violations = [];
    const scanner = createFloatingAsyncScanner();
    for (const file of trackedServerSources()) {
      for (const hit of scanner.findInFile(join(SERVER_ROOT, file))) {
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
    // A sync export imported by name must not be flagged.
    expect(findFloatingAsyncCalls("import { getAllowedCommands as sync } from './services/commands.js';\nsync();", SERVER_ROOT)).toEqual([]);
    expect(findFloatingAsyncCalls("import { logAction as log } from './services/history.js';\nlog();", SERVER_ROOT))
      .toEqual(['line 2: log()']);
  });

  it('reuses one file summary across import spellings and the whole-tree visit', () => {
    const reads = new Map();
    const scanner = createFloatingAsyncScanner((file) => {
      reads.set(file, (reads.get(file) || 0) + 1);
      return readFileSync(file, 'utf8');
    });
    const source = (specifier) => `import { logAction as log } from '${specifier}';\nlog();`;
    expect(scanner.findInSource(source('./services/history'), SERVER_ROOT)).toEqual(['line 2: log()']);
    expect(scanner.findInFile(join(SERVER_ROOT, 'services/history.js'))).toEqual([]);
    expect(scanner.findInSource(source('./services/history.js'), SERVER_ROOT)).toEqual(['line 2: log()']);
    expect(scanner.findInFile(join(SERVER_ROOT, 'services/history.js'))).toEqual([]);
    expect(reads.get(join(SERVER_ROOT, 'services/history.js'))).toBe(1);
  });

  it('starts a fresh import cache for each scan and propagates unreadable or invalid imports', () => {
    const source = "import { run } from './services/history.js';\nrun();";
    expect(createFloatingAsyncScanner(() => 'export async function run() {}')
      .findInSource(source, SERVER_ROOT)).toEqual(['line 2: run()']);
    expect(createFloatingAsyncScanner(() => 'export function run() {}')
      .findInSource(source, SERVER_ROOT)).toEqual([]);
    expect(() => createFloatingAsyncScanner(() => { throw new Error('unreadable import'); })
      .findInSource(source, SERVER_ROOT)).toThrow('unreadable import');
    expect(() => createFloatingAsyncScanner(() => 'export function {')
      .findInSource(source, SERVER_ROOT)).toThrow();
  });
});
