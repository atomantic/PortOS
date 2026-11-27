/**
 * Rule: A statement-level call to a module-scope or relatively-imported `async` function must be `await`ed, end in `.catch(…)`, or start with `void`.
 * Fix: Add `await`, `.catch(…)`, or `void` (only when the function owns its own rejections).
 * What this guard cannot see:
 *   - Nested helpers, member-access calls (`obj.run()`), namespace imports, and re-exports are not resolved.
 */
import { describe, it, expect } from 'vitest';
import { dirname, join, relative, resolve } from 'path';
import { guardCorpus, parseGuardSource, readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';
import { parseRuntimeAst } from '../../guardSources.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');

const isAsyncInit = (node) => (
  (node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression') && node.async === true
);

// These Babel node types cannot contain an expression statement.
const NO_STATEMENTS = new Set([
  'Identifier', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral',
  'BigIntLiteral', 'RegExpLiteral', 'TemplateElement', 'ThisExpression', 'Super',
  'ImportDeclaration', 'ExportAllDeclaration', 'ExportSpecifier', 'ExportNamespaceSpecifier',
]);

function walkStatements(node, visit) {
  if (!node || typeof node.type !== 'string' || NO_STATEMENTS.has(node.type)) return;
  if (node.type === 'ExpressionStatement') visit(node);
  for (const key in node) {
    const child = node[key];
    if (child === null || typeof child !== 'object') continue;
    if (Array.isArray(child)) {
      for (const c of child) walkStatements(c, visit);
    } else if (typeof child.type === 'string') {
      walkStatements(child, visit);
    }
  }
}

/** Module-scope bindings only. Nested helpers can have sync namesakes in sibling scopes. */
function moduleBindings(body, dir) {
  const local = new Set();
  const exported = new Set();
  const exportAliases = [];
  const imports = new Map();
  const addAsync = (name, isExport) => {
    local.add(name);
    if (isExport) exported.add(name);
  };
  for (const stmt of body) {
    const isExport = stmt.type === 'ExportNamedDeclaration';
    const decl = isExport ? stmt.declaration : stmt;
    if (decl?.type === 'FunctionDeclaration' && decl.async && decl.id) addAsync(decl.id.name, isExport);
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && isAsyncInit(d.init)) addAsync(d.id.name, isExport);
      }
    }
    if (isExport && !stmt.source && stmt.specifiers.length) exportAliases.push(...stmt.specifiers);
    if (dir && stmt.type === 'ImportDeclaration' && stmt.source.value.startsWith('.')) {
      for (const spec of stmt.specifiers) {
        if (spec.type !== 'ImportSpecifier') continue;
        const name = spec.local.name;
        if (!imports.has(name)) imports.set(name, []);
        imports.get(name).push({ source: stmt.source.value, imported: spec.imported.name || spec.imported.value });
      }
    }
  }
  for (const spec of exportAliases) {
    if (local.has(spec.local.name)) exported.add(spec.exported.name || spec.exported.value);
  }
  return { local, exported, imports };
}

function summarizeSource(src, dir, { program } = parseGuardSource(src)) {
  return { ...moduleBindings(program.body, dir), program, src };
}

/**
 * The `async` keyword as a token. Babel reads an escaped spelling as an identifier,
 * and a neighbouring [\w$] character makes it part of one, so a source with no match
 * declares (and exports) no async function and Babel need not parse it (#16607).
 */
const ASYNC_KEYWORD = /(?<![\w$])async(?![\w$])/;
const NO_EXPORTS = new Set();
/** An escape straight after a quote can spell a leading `.` or continue the line. */
const ESCAPED_LITERAL_START = /['"]\\[.xu0-9\s]/;

/**
 * Every value a quoted literal starting with `.` has, a superset of the relative
 * import sources, or null when an escape makes one unknowable. Without a backslash a
 * literal's value is its raw text, and it closes at the next same quote on its line.
 */
function relativeLiteralValues(src) {
  if (ESCAPED_LITERAL_START.test(src)) return null;
  const values = [];
  for (const { index, 0: opening } of src.matchAll(/['"]\./g)) {
    const end = src.indexOf(opening[0], index + 1);
    const lineEnd = src.indexOf('\n', index + 1);
    const closesOnLine = end !== -1 && (lineEnd === -1 || end < lineEnd);
    const raw = src.slice(index + 1, closesOnLine ? end : (lineEnd === -1 ? src.length : lineEnd));
    if (raw.includes('\\')) return null;
    if (closesOnLine) values.push(raw);
  }
  return values;
}

// Import spellings share a binding summary. Only a caller visit walks its
// program, which is then discarded while the async exports stay cached.
function createFloatingAsyncScanner(readSource = readText, onParsed = () => {}) {
  const parseFile = readSource === readText ? parseRuntimeAst : (_file, src) => parseGuardSource(src);
  const summaries = new Map();
  const resolutions = new Map();
  const summaryOf = (file) => {
    if (!summaries.has(file)) {
      const src = readSource(file);
      // Nothing here is async; a visit still needs the text to check what it imports.
      if (ASYNC_KEYWORD.test(src)) {
        summaries.set(file, summarizeSource(src, dirname(file), parseFile(file, src)));
        onParsed(file);
      } else {
        summaries.set(file, { exported: NO_EXPORTS, src });
      }
    }
    return summaries.get(file);
  };
  const asyncExportsOf = (absPath) => {
    if (!resolutions.has(absPath)) {
      const candidates = [absPath, `${absPath}.js`, join(absPath, 'index.js')];
      // The corpus stats each path once for every guard in the process.
      const isFile = (p) => {
        const stats = p.endsWith('.js') ? guardCorpus().lstat(relative(REPO_ROOT, p)) : null;
        return stats !== null && !stats.isDirectory();
      };
      const file = candidates.find(isFile);
      resolutions.set(absPath, file ?? null);
    }
    const file = resolutions.get(absPath);
    return file ? summaryOf(file).exported : NO_EXPORTS;
  };
  // A source with no local async function can only float a call it imports.
  const mayImportAsync = (src, dir) => {
    // Named static imports require both keywords and a binding list.
    if (!src.includes('import') || !src.includes('from') || !src.includes('{')) return false;
    const values = relativeLiteralValues(src);
    if (values === null) return true;
    // Without escapes, a named import must spell the async export in the
    // source. Leave aliases and escaped identifiers or strings to Babel.
    const hasEscape = src.includes('\\');
    return values.some((value) => {
      const exported = asyncExportsOf(resolve(dir, value));
      return exported.size > 0 && (hasEscape || exported.values().some((name) => src.includes(name)));
    });
  };
  const findCalls = ({ local, imports, program, src }, dir) => {
    const importedAsync = new Map();
    const isAsyncImport = (name) => {
      if (!importedAsync.has(name)) {
        importedAsync.set(name, imports.get(name).some(({ source, imported }) =>
          asyncExportsOf(resolve(dir, source)).has(imported)));
      }
      return importedAsync.get(name);
    };

    const hits = [];
    // A sync export from a module that also exports async functions cannot yield a hit.
    if (local.size === 0 && !imports.keys().some(isAsyncImport)) return hits;

    walkStatements(program, (node) => {
      const call = node.expression;
      if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return;
      const name = call.callee.name;
      if (local.has(name) || (imports.has(name) && isAsyncImport(name))) {
        const line = src.slice(0, node.start).split(/\r\n?|[\n\u2028\u2029]/).length;
        hits.push(`line ${line}: ${name}()`);
      }
    });
    return hits;
  };
  return {
    findInSource: (src, dir = null) => findCalls(summarizeSource(src, dir), dir),
    findInFile: (file) => {
      let summary = summaryOf(file);
      if (summary.hits) return summary.hits;
      if (!summary.program) {
        if (!mayImportAsync(summary.src, dirname(file))) {
          summaries.set(file, { exported: summary.exported, hits: [] });
          return [];
        }
        summary = summarizeSource(summary.src, dirname(file), parseFile(file, summary.src));
      }
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

function scanFiles(files, readSource) {
  const remaining = new Set(files);
  const pending = [];
  const scanner = createFloatingAsyncScanner(readSource, (file) => {
    if (remaining.has(file)) pending.push(file);
  });
  // Give parsed imports their own caller visit promptly so programs only used
  // here do not accumulate in memory while waiting for filename order.
  const visit = (file) => {
    if (remaining.delete(file)) scanner.findInFile(file);
  };
  for (const file of remaining) {
    visit(file);
    while (pending.length) visit(pending.pop());
  }
  return files.flatMap((file) => scanner.findInFile(file).map((hit) => `${relative(REPO_ROOT, file).replaceAll('\\', '/')} ${hit}`));
}

const files = trackedFiles(SERVER_ROOT, ['*.js', '*.mjs', '*.cjs']).filter((file) => !file.includes('.test.'));

describe('async calls own their rejections (#12978)', () => {
  it('scans the server tree', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('has no bare statement-level call to an async function', () => {
    const violations = scanFiles(files.map((file) => join(SERVER_ROOT, file)));
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

  it('reports the statement start across every JavaScript line terminator', () => {
    const source = 'async function f() {}\r\n// one\r// two\u2028// three\u2029(\nf)();';
    expect(findFloatingAsyncCalls(source)).toEqual(['line 5: f()']);
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

  it('resolves a forward export alias without reading later unused imports', () => {
    const scanner = createFloatingAsyncScanner((file) => {
      if (file !== join(SERVER_ROOT, 'services/history.js')) throw new Error('unneeded import read');
      return 'export { run as renamed }; const run = async () => {};';
    });
    const source = `import { renamed as run } from './services/history.js';
import { getAllowedCommands } from './services/commands.js';
function check() { run(); run(); }`;
    expect(scanner.findInSource(source, SERVER_ROOT)).toEqual(['line 3: run()', 'line 3: run()']);
  });

  it('checks named imports against the async exports of a mixed module', () => {
    const caller = join(SERVER_ROOT, 'floating-async-caller.js');
    const check = (callerSource) => createFloatingAsyncScanner((file) => (
      file === caller
        ? callerSource
        : 'export function sync() {} export async function run() {}'
    )).findInFile(caller);
    expect(check("import { sync } from './services/history.js';\nsync();\nrun();")).toEqual([]);
    expect(check("import { sync, run } from './services/history.js';\nsync();\nrun();")).toEqual(['line 3: run()']);
    // Even though the target exports run, this caller cannot import it.
    expect(check("import { sync } from './services/history.js';\nfunction (")).toEqual([]);
  });

  it('reuses one file summary across import spellings and the whole-tree visit', () => {
    const reads = new Map();
    const scanner = createFloatingAsyncScanner((file) => {
      reads.set(file, (reads.get(file) || 0) + 1);
      return readText(file);
    });
    const source = (specifier) => `import { logAction as log } from '${specifier}';\nlog();`;
    expect(scanner.findInSource(source('./services/history'), SERVER_ROOT)).toEqual(['line 2: log()']);
    expect(scanner.findInFile(join(SERVER_ROOT, 'services/history.js'))).toEqual([]);
    expect(scanner.findInSource(source('./services/history.js'), SERVER_ROOT)).toEqual(['line 2: log()']);
    expect(scanner.findInFile(join(SERVER_ROOT, 'services/history.js'))).toEqual([]);
    expect(reads.get(join(SERVER_ROOT, 'services/history.js'))).toBe(1);
  });

  it('reports calls in imported files that are also part of the tree scan', () => {
    const caller = join(SERVER_ROOT, 'floating-async-caller.js');
    const importer = join(SERVER_ROOT, 'services/commands.js');
    const imported = join(SERVER_ROOT, 'services/history.js');
    const sources = new Map([
      [caller, "import { run } from './services/history.js';\nrun();"],
      [importer, 'async function check() {}\ncheck();'],
      [imported, 'export async function run() {}\nrun();'],
    ]);
    expect(scanFiles([caller, importer, imported], (file) => sources.get(file))).toEqual([
      'server/floating-async-caller.js line 2: run()',
      'server/services/commands.js line 2: check()',
      'server/services/history.js line 2: run()',
    ]);
    expect(scanFiles([caller], (file) => sources.get(file)))
      .toEqual(['server/floating-async-caller.js line 2: run()']);
  });

  it('starts a fresh import cache for each scan and propagates unreadable or invalid imports', () => {
    const source = "import { run } from './services/history.js';\nrun();";
    expect(createFloatingAsyncScanner(() => 'export async function run() {}')
      .findInSource(source, SERVER_ROOT)).toEqual(['line 2: run()']);
    expect(createFloatingAsyncScanner(() => 'export function run() {}')
      .findInSource(source, SERVER_ROOT)).toEqual([]);
    expect(() => createFloatingAsyncScanner(() => { throw new Error('unreadable import'); })
      .findInSource(source, SERVER_ROOT)).toThrow('unreadable import');
    expect(() => createFloatingAsyncScanner(() => 'export async function {')
      .findInSource(source, SERVER_ROOT)).toThrow();
    // Without the keyword nothing can be async, so the text is never parsed.
    expect(createFloatingAsyncScanner(() => 'export function {')
      .findInSource(source, SERVER_ROOT)).toEqual([]);
  });

  it('still flags a caller with no `async` of its own, and skips one that imports nothing async', () => {
    const scanFile = (callerSource) => {
      const caller = join(SERVER_ROOT, 'floating-async-caller.js');
      return createFloatingAsyncScanner((file) => (file === caller ? callerSource : readText(file)))
        .findInFile(caller);
    };
    expect(scanFile("import { logAction as log } from './services/history.js';\nlog();")).toEqual(['line 2: log()']);
    expect(scanFile('import { "logAction" as log } from "./services/history";\nlog();')).toEqual(['line 2: log()']);
    // An escape could spell the specifier, so the caller is parsed rather than judged by its text.
    expect(scanFile(String.raw`import { logAction as log } from '\x2e/services/history.js';` + '\nlog();')).toEqual(['line 2: log()']);
    expect(scanFile(String.raw`import { logAction as log } from '.\/services/history.js';` + '\nlog();')).toEqual(['line 2: log()']);
    expect(scanFile(String.raw`import { log\u0041ction as log } from './services/history.js';` + '\nlog();')).toEqual(['line 2: log()']);
    // Unparsable on purpose: a skipped caller is never handed to Babel.
    expect(scanFile("import { getAllowedCommands } from './services/commands.js';\nfunction (")).toEqual([]);
    expect(scanFile("import { logAction as log } from './missing-module.js';\nfunction (")).toEqual([]);
  });
});
