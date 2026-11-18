/**
 * Rule: A statement-level call to a module-scope or relatively-imported `async` function must be `await`ed, end in `.catch(…)`, or start with `void`.
 * Fix: Add `await`, `.catch(…)`, or `void` (only when the function owns its own rejections).
 * What this guard cannot see:
 *   - Nested helpers, member-access calls (`obj.run()`), namespace imports, and re-exports are not resolved.
 */
import { existingPaths } from '../scripts/lib/trackedFiles.js';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, mkdtempSync, rmSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { parse } from '@babel/parser';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

const parseSource = (src) => parse(src, { sourceType: 'module', errorRecovery: true, allowReturnOutsideFunction: true, attachComment: false });

const isAsyncInit = (node) => (
  (node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression') && node.async === true
);

// Without the TypeScript or Flow plugins these never hold a child node; they are about half of all nodes.
const LEAF_TYPES = new Set(['Identifier', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral',
  'BigIntLiteral', 'RegExpLiteral', 'TemplateElement', 'ThisExpression', 'Super']);

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  if (LEAF_TYPES.has(node.type)) return;
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

/**
 * The `async` keyword as a token. Babel reads an escaped spelling as an identifier,
 * and a neighbouring [\w$] character makes it part of one, so a source with no match
 * declares (and exports) no async function and Babel need not parse it (#16607).
 */
const ASYNC_KEYWORD = /(?<![\w$])async(?![\w$])/;
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

// Bump whenever recognition or parser options change; summaries never contain verdicts.
const SUMMARY_VERSION = 1;
const PARSER_VERSION = createRequire(import.meta.url)('@babel/parser/package.json').version;
const SUMMARY_CACHE_FILE = join(SERVER_ROOT, '../.cache/floating-async/summaries.json');
const blobSha = (src, algorithm = 'sha1') => createHash(algorithm).update(`blob ${Buffer.byteLength(src)}\0`).update(src).digest('hex');

function validSummary(value) {
  const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  return value && strings(value.local) && strings(value.exported)
    && Array.isArray(value.imports) && value.imports.every((i) => i && typeof i.source === 'string'
      && Array.isArray(i.names) && i.names.every((n) => n && typeof n.imported === 'string' && typeof n.local === 'string'))
    && Array.isArray(value.calls) && value.calls.every((c) => c && typeof c.name === 'string' && Number.isInteger(c.line) && c.line > 0);
}

function createSummaryCache(file, blobs) {
  let entries = {};
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.version === SUMMARY_VERSION && saved.parser === PARSER_VERSION && saved.entries
      && typeof saved.entries === 'object' && !Array.isArray(saved.entries)
      && Object.entries(saved.entries).every(([sha, summary]) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) && validSummary(summary))) {
      entries = saved.entries;
    }
  } catch {
    // Missing or corrupt optimization data always falls back to recognition.
  }
  const used = {};
  return {
    summarize: (path, src, recognize) => {
      const indexed = blobs.get(path);
      // The index alone cannot identify dirty working bytes (including CRLF checkouts).
      const sha = indexed && blobSha(src, indexed.length === 64 ? 'sha256' : 'sha1') === indexed ? indexed : null;
      if (sha && entries[sha]) {
        const saved = entries[sha];
        used[sha] = saved;
        return { ...saved, local: new Set(saved.local), exported: new Set(saved.exported) };
      }
      const summary = recognize(src);
      if (sha) used[sha] = { ...summary, local: [...summary.local], exported: [...summary.exported] };
      return summary;
    },
    save: () => {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const currentBlobs = new Set(blobs.values());
        const retained = Object.fromEntries(Object.entries({ ...entries, ...used }).filter(([sha]) => currentBlobs.has(sha)));
        writeFileSync(temporary, JSON.stringify({ version: SUMMARY_VERSION, parser: PARSER_VERSION, entries: retained }));
        renameSync(temporary, file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    },
  };
}

/** One scan owns its cache; import spellings share the resolved file's summary. */
function createFloatingAsyncScanner(readSource = (file) => readFileSync(file, 'utf8'), cache = null, recognize = summarizeSource) {
  const summarize = (file, src) => cache ? cache.summarize(file, src, recognize) : recognize(src);
  const summaries = new Map();
  const resolutions = new Map();
  const summaryOf = (file) => {
    if (!summaries.has(file)) {
      const src = readSource(file);
      // Nothing here is async; a visit still needs the text to check what it imports.
      summaries.set(file, ASYNC_KEYWORD.test(src) ? summarize(file, src) : { exported: new Set(), src });
    }
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
  // A source with no local async function can only float a call it imports.
  const mayImportAsync = (src, dir) => {
    const values = relativeLiteralValues(src);
    return values === null || values.some((value) => asyncExportsOf(resolve(dir, value)).size > 0);
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
      let summary = summaryOf(file);
      if (summary.hits) return summary.hits;
      if (summary.src !== undefined) {
        if (!mayImportAsync(summary.src, dirname(file))) {
          summaries.set(file, { exported: summary.exported, hits: [] });
          return [];
        }
        summary = summarize(file, summary.src);
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

// One index read supplies both the scan inventory and identities for imported targets.
function trackedInventory() {
  const root = resolve(SERVER_ROOT, '..');
  const records = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const blobs = new Map();
  const paths = new Set();
  for (const record of records) {
    const [metadata, path] = [record.slice(0, record.indexOf('\t')), record.slice(record.indexOf('\t') + 1)];
    const [mode, sha, stage] = metadata.split(' ');
    paths.add(join(root, path));
    if (stage === '0' && (mode === '100644' || mode === '100755')) blobs.set(join(root, path), sha);
  }
  const files = existingPaths(SERVER_ROOT, [...paths].filter((p) => p.startsWith(`${SERVER_ROOT}${sep}`))
    .map((p) => p.slice(SERVER_ROOT.length + 1)).filter((p) => /\.(?:js|mjs|cjs)$/.test(p) && !p.includes('.test.')));
  return { files, blobs };
}
const inventory = trackedInventory();

describe('async calls own their rejections (#12978)', () => {
  it('scans the server tree', () => {
    expect(inventory.files.length).toBeGreaterThan(200);
  });

  it('has no bare statement-level call to an async function', () => {
    const violations = [];
    const cache = createSummaryCache(SUMMARY_CACHE_FILE, inventory.blobs);
    const scanner = createFloatingAsyncScanner(undefined, cache);
    for (const file of inventory.files) {
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
    cache.save();
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
    expect(() => createFloatingAsyncScanner(() => 'export async function {')
      .findInSource(source, SERVER_ROOT)).toThrow();
    // Without the keyword nothing can be async, so the text is never parsed.
    expect(createFloatingAsyncScanner(() => 'export function {')
      .findInSource(source, SERVER_ROOT)).toEqual([]);
  });

  it('still flags a caller with no `async` of its own, and skips one that imports nothing async', () => {
    const scanFile = (callerSource) => {
      const caller = join(SERVER_ROOT, 'floating-async-caller.js');
      return createFloatingAsyncScanner((file) => (file === caller ? callerSource : readFileSync(file, 'utf8')))
        .findInFile(caller);
    };
    expect(scanFile("import { logAction as log } from './services/history.js';\nlog();")).toEqual(['line 2: log()']);
    expect(scanFile('import { "logAction" as log } from "./services/history";\nlog();')).toEqual(['line 2: log()']);
    // An escape could spell the specifier, so the caller is parsed rather than judged by its text.
    expect(scanFile(String.raw`import { logAction as log } from '\x2e/services/history.js';` + '\nlog();')).toEqual(['line 2: log()']);
    expect(scanFile(String.raw`import { logAction as log } from '.\/services/history.js';` + '\nlog();')).toEqual(['line 2: log()']);
    // Unparsable on purpose: a skipped caller is never handed to Babel.
    expect(scanFile("import { getAllowedCommands } from './services/commands.js';\nfunction (")).toEqual([]);
  });
});

describe('floating-async persistent summaries (#16626)', () => {
  function fixture(run) {
    const root = mkdtempSync(join(tmpdir(), 'floating-async-'));
    const file = join(root, 'caller.js');
    const target = join(root, 'target.js');
    const cacheFile = join(root, 'cache.json');
    const caller = "import { run } from './target.js';\nrun();";
    const source = 'export async function run() {}';
    writeFileSync(file, caller);
    writeFileSync(target, source);
    const blobs = new Map([[file, blobSha(caller)], [target, blobSha(source)]]);
    const parsed = [];
    const scan = (index = blobs) => {
      const cache = createSummaryCache(cacheFile, index);
      const scanner = createFloatingAsyncScanner(undefined, cache, (src) => {
        parsed.push(src);
        return summarizeSource(src);
      });
      const hits = scanner.findInFile(file);
      cache.save();
      return hits;
    };
    try { run({ file, target, cacheFile, blobs, parsed, scan, caller, source }); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('reuses warm blobs, re-parses changed indexed and dirty bytes, and resolves new exports', () => {
    fixture(({ file, target, blobs, parsed, scan, caller }) => {
      expect(scan()).toEqual(['line 2: run()']);
      expect(parsed).toHaveLength(2);
      parsed.length = 0;
      expect(scan()).toEqual(['line 2: run()']);
      expect(parsed).toHaveLength(0);
      const sync = 'export function run() {}';
      writeFileSync(target, sync);
      // No async token: the changed export must still invalidate the cached caller's verdict.
      expect(scan()).toEqual([]);
      const changed = 'export async function other() {}';
      writeFileSync(target, changed);
      blobs.set(target, blobSha(changed));
      expect(scan()).toEqual([]);
      expect(parsed).toEqual([changed]);
      parsed.length = 0;
      const dirty = `${caller}\nasync function local() {}\nlocal();`;
      writeFileSync(file, dirty);
      expect(scan()).toEqual(['line 4: local()']);
      expect(parsed).toEqual([dirty]);
    });
  });

  it.each(['corrupt', 'scanner-version', 'parser-version', 'invalid-summary'])('fully re-parses a %s cache with identical findings', (kind) => {
    fixture(({ cacheFile, parsed, scan }) => {
      const cold = scan();
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (kind === 'scanner-version') saved.version++;
      if (kind === 'parser-version') saved.parser = '0.0.0';
      if (kind === 'invalid-summary') Object.values(saved.entries)[0].calls = null;
      writeFileSync(cacheFile, kind === 'corrupt' ? '{' : JSON.stringify(saved));
      parsed.length = 0;
      expect(scan()).toEqual(cold);
      expect(parsed).toHaveLength(2);
    });
  });

  it.each([
    'async function f() {}\nfunction g() { f(); }',
    'const f = async () => {};\nf();',
    'async function f() {}\nasync function g() { await f(); void f(); f().catch(() => {}); return f(); }\nconst p = f();',
    'function f() {}\nf();\nobj.run();',
    'const f = async function() {}; export { f as other }; f();',
    "import { run as log } from './target.js';\nlog();",
    String.raw`import { run } from '\x2e/target.js';` + '\nrun();',
  ])('matches cold, warm and uncached recognition of %s', (source) => {
    fixture(({ file, blobs, parsed, scan }) => {
      writeFileSync(file, source);
      blobs.set(file, blobSha(source));
      const uncached = createFloatingAsyncScanner().findInFile(file);
      expect(scan()).toEqual(uncached);
      parsed.length = 0;
      expect(scan()).toEqual(uncached);
      expect(parsed).toHaveLength(0);
    });
  });

  it('never persists untracked sources or import targets', () => {
    fixture(({ file, target, blobs, parsed, scan, cacheFile }) => {
      blobs.delete(target);
      expect(scan()).toEqual(['line 2: run()']);
      parsed.length = 0;
      expect(scan()).toEqual(['line 2: run()']);
      expect(parsed).toHaveLength(1);
      blobs.delete(file);
      parsed.length = 0;
      expect(scan()).toEqual(['line 2: run()']);
      expect(parsed).toHaveLength(2);
      expect(JSON.parse(readFileSync(cacheFile, 'utf8')).entries).toEqual({});
    });
  });
});
