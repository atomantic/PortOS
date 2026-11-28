/**
 * Guard: client source and tests can only reach the server through browser-safe
 * `server/lib` leaves. Walk each leaf's imports and report the first impure edge
 * on each path so failures name the dependency chain that introduced it.
 *
 * This scans the tracked tree. It rides `ALWAYS_RUN_TESTS` because CI's import
 * graph cannot discover every source file the guard reads.
 */
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorktreeGit } from '../../../../lib/gitWorktree.js';
import { resolveImportGrowthBase } from '../../../../scripts/lib/importGrowth.js';
import { moduleSpecifiers } from '../../../../scripts/lib/moduleGraph.js';
import { tokenize } from '../../../../scripts/lib/sourceTokens.js';
import { guardCorpus, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

// resolveRelative already normalized the POSIX path.
const isWithin = (root, file) => file === root || file.startsWith(`${root}/`);

const resolveRelative = (file, specifier) => {
  const path = specifier.replaceAll('\\', '/').split(/[?#]/)[0];
  return /^\.{1,2}\//.test(path) ? posix.join(posix.dirname(file), path) : null;
};

/**
 * A client file can only reach `server/` through a relative specifier spelling `../server`
 * (including intervening dot segments), or a literal with an escape. In the latter case,
 * the text before the first escape must be a prefix of a relative path. Stop at the
 * opening delimiter's next occurrence so an escape in a later literal is irrelevant.
 */
const SERVER_PATH = /\.\.[/\\]+(?:\.{1,2}[/\\]+)*server\b/;
const ESCAPED_RELATIVE_PATH = /(['"`])(?:\.{0,2}|\.{1,2}\/(?:(?!\1)[^\\])*)\\/;
// If "server" itself is split up, it needs a hex/Unicode escape, an
// identity escape in the name, or a continuation that joins the letters.
const POSSIBLE_SERVER_NAME = /server|\\[xesur\r\n]/;
const mayReachServer = (source) => SERVER_PATH.test(source)
  || (POSSIBLE_SERVER_NAME.test(source) && ESCAPED_RELATIVE_PATH.test(source));

function inspectClientImports(clientFiles, readSource) {
  const violations = [];
  const seen = new Set();
  const queue = [];
  for (const file of clientFiles) {
    const source = readSource(file);
    if (source == null || !mayReachServer(source)) continue;
    const { statics: imports, deferred: dynamic } = moduleSpecifiers(source, file);
    for (const specifier of [...imports, ...dynamic]) {
      const target = resolveRelative(file, specifier);
      if (!target || !isWithin('server', target)) continue;
      if (!isWithin('server/lib', target) || target === 'server/lib') {
        violations.push(`${file} imports '${specifier}' → ${target} (resolves outside server/lib)`);
        continue;
      }
      queue.push({ file: target, chain: [file, target] });
    }
  }

  const entryCount = new Set(queue.map(({ file }) => file)).size;
  for (const { file, chain } of queue) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readSource(file);
    const trace = chain.join(' → ');
    if (source == null) {
      violations.push(`${trace} (module does not exist)`);
      continue;
    }
    const { statics: imports, deferred: dynamic } = moduleSpecifiers(source, file);
    for (const specifier of [...imports, ...dynamic]) {
      const target = resolveRelative(file, specifier);
      if (!target) {
        violations.push(`${trace} imports '${specifier}' (non-relative import (Node built-in or npm package))`);
      } else if (!isWithin('server/lib', target) || target === 'server/lib') {
        violations.push(`${trace} imports '${specifier}' → ${target} (resolves outside server/lib)`);
      } else {
        queue.push({ file: target, chain: [...chain, target] });
      }
    }
  }
  return { entryCount, violations };
}

const TABLE_DECLARATION = /\bconst\s+([A-Z][A-Z_0-9]*)\s*=/g;
const TABLE_OPENERS = new Map([['[', ']'], ['{', '}'], ['(', ')']]);

// Compare identically named literal tables, ignoring formatting and an outer
// Object.freeze. Distinct tables may intentionally use the same local name.
function constantTables(source, names = null) {
  if (![...source.matchAll(TABLE_DECLARATION)].some(([, name]) => !names || names.has(name))) return [];
  const tokens = tokenize(source);
  const tables = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const declaration = tokens[i];
    const name = tokens[i + 1];
    if (declaration.t !== 'id' || declaration.v !== 'const'
      || name?.t !== 'id' || !/^[A-Z][A-Z_0-9]*$/.test(name.v) || (names && !names.has(name.v))
      || tokens[i + 2]?.v !== '=') continue;

    const initializer = i + 3;
    const frozen = tokens.slice(initializer, initializer + 4).map(({ v }) => v).join(' ') === 'Object . freeze (';
    const start = initializer + (frozen ? 4 : 0);
    const opening = tokens[start]?.v;
    if (opening !== '[' && opening !== '{') continue;

    const closers = [];
    for (let end = start; end < tokens.length; end += 1) {
      const { t, v } = tokens[end];
      if (t !== 'p') continue;
      if (TABLE_OPENERS.has(v)) closers.push(TABLE_OPENERS.get(v));
      else if (v === closers.at(-1)) closers.pop();
      if (closers.length) continue;
      const next = tokens[end + (frozen ? 2 : 1)];
      // A method call or other continuation makes this a derived value.
      if ((frozen && tokens[end + 1]?.v !== ')') || (next && next.v !== ';' && next.v !== ',')) break;
      const table = tokens.slice(start, end + 1)
        .filter(({ t, v }, index, entries) =>
          t !== 'p' || v !== ',' || ![']', '}'].includes(entries[index + 1]?.v))
        .map(({ t, v, quasis, exprs }) => [t, v, quasis, exprs]);
      if (table.length > 2) tables.push([name.v, JSON.stringify(table)]);
      break;
    }
  }
  return tables;
}

const signature = (table) => JSON.stringify(table);

function changedTables(current, readBase) {
  const tables = constantTables(current);
  if (!tables.length) return tables;
  const prior = new Set(constantTables(readBase()).map(signature));
  return tables.filter((table) => !prior.has(signature(table)));
}

function mirroredTables(changed, counterparts, readSource) {
  const names = new Set(changed.flatMap(({ tables }) => tables.map(([name]) => name)));
  if (!names.size) return [];
  const declarations = new Map();
  for (const file of counterparts) {
    for (const table of constantTables(readSource(file), names)) {
      const key = signature(table);
      const paths = declarations.get(key) || [];
      paths.push(file);
      declarations.set(key, paths);
    }
  }
  return changed.flatMap(({ file, tables }) => tables.flatMap((table) =>
    (declarations.get(signature(table)) || []).map((other) => {
      const [server, client] = file.startsWith('server/') ? [file, other] : [other, file];
      return `${table[0]}: ${server} → ${client}`;
    })));
}

function gitOutput(args) {
  const result = runWorktreeGit(REPO_ROOT, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Cannot read the constant-table comparison base (${args[0]})`);
  return result.stdout;
}

describe('shared literal constant tables', () => {
  it('finds matching declarations across trees and ignores derived values, comments and distinct tables', () => {
    const modules = {
      'server/lib/model.js': "export const MODEL_IDS = Object.freeze(['small', 'large']);",
      'client/src/model.js': `const MODEL_IDS = [
        "small", // first choice
        "large",
      ];`,
      'client/src/unrelated.js': `const MODEL_IDS = ['small'];
        // const MODEL_IDS = ['small', 'large'];
        const unrelated = "const MODEL_IDS = ['small', 'large'];";
        const derived = () => { const MODEL_IDS = ['small', 'large'].reverse(); return MODEL_IDS; };`,
    };
    const serverFile = 'server/lib/model.js';
    const tables = changedTables(modules[serverFile], () => '');
    expect(mirroredTables([{ file: serverFile, tables }], ['client/src/model.js', 'client/src/unrelated.js'], (file) => modules[file]))
      .toEqual(['MODEL_IDS: server/lib/model.js → client/src/model.js']);
    expect(changedTables(modules[serverFile], () => modules['client/src/model.js'])).toEqual([]);
  });

  it('defines newly duplicated server and client tables once', () => {
    const corpus = guardCorpus();
    const { sha } = resolveImportGrowthBase({ repoRoot: REPO_ROOT });
    const sources = new Set(corpus.indexed(['server/*.js', 'server/*.jsx', 'client/src/*.js', 'client/src/*.jsx'])
      .map(({ path }) => path)
      .filter((path) => !/\.(?:test|spec)\.[jt]sx?$/.test(path)));
    const diff = gitOutput(['diff', '--name-status', '--no-renames', '-z', sha, '--', 'server', 'client/src'])
      .split('\0');
    const server = [];
    const client = [];
    for (let i = 0; i + 1 < diff.length; i += 2) {
      const [status, file] = diff.slice(i, i + 2);
      if (status === 'D' || !sources.has(file)) continue;
      const readBase = () => (status === 'A' ? '' : gitOutput(['show', `${sha}:${file}`]));
      const entry = { file, tables: changedTables(corpus.read(file), readBase) };
      (file.startsWith('server/') ? server : client).push(entry);
    }
    const readSource = (file) => corpus.read(file);
    const files = [...sources];
    const duplicates = new Set([
      ...mirroredTables(server, files.filter((file) => file.startsWith('client/')), readSource),
      ...mirroredTables(client, files.filter((file) => file.startsWith('server/')), readSource),
    ]);
    expect([...duplicates].sort(), 'Move shared literal tables to an importable server/lib leaf.').toEqual([]);
  });
});

describe('browser-safe server imports from the client (#6364, #16709)', () => {
  it('walks client imports and rejects direct or transitive edges outside server/lib', () => {
    const corpus = guardCorpus();
    // Read indexed candidates directly instead of checking existence before each read.
    const sources = corpus.indexed(['client/src/*.js', 'client/src/*.jsx']).map(({ path }) => path);
    const { entryCount, violations } = inspectClientImports(sources, (file) => {
      try {
        return corpus.read(file);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }
    });
    // Detect a broken glob or parser producing a vacuous pass.
    expect(entryCount).toBeGreaterThan(10);
    expect(violations, 'The client may only import browser-safe server/lib modules. See the '
      + '"One pure module, one definition" rule in client/src/lib/README.md.').toEqual([]);
  });

  it.each([
    ['../../../server/services/universeBuilder/compile.js', (path) => `import { compile } from '${path}';`],
    ['../../../server/lib/../services/universeBuilder/compile.js', (path) => `export {
      compile,
    } from '${path}';`],
    ['../../../server/services/universeBuilder/compile.js?raw', (path) => `const lazy = () => import('${path}');`],
  ])('names the importing test and resolved edge for %s', (specifier, source) => {
    const file = 'client/src/lib/count.test.js';
    expect(inspectClientImports([file], () => source(specifier)).violations).toEqual([
      `${file} imports '${specifier}' → server/services/universeBuilder/compile.js (resolves outside server/lib)`,
    ]);
  });

  it('follows shared leaves and diagnoses impure edges with the import chain', () => {
    const file = 'client/src/lib/example.js';
    const modules = new Map([
      // A real backslash specifier (`\\` in source): Node's file-URL resolution reads `\` as `/`.
      [file, String.raw`export { result } from '..\\..\\..\\server\\lib\\leaf.js';`],
      ['server/lib/leaf.js', "import './nested.js';"],
      ['server/lib/nested.js', 'export const result = 1;'],
    ]);
    const inspect = () => inspectClientImports([file], (path) => modules.get(path));
    expect(inspect()).toEqual({ entryCount: 1, violations: [] });
    modules.set('server/lib/nested.js', "import 'node:fs';\nexport { helper } from '../services/helper.js';");
    expect(inspect().violations).toEqual(expect.arrayContaining([
      `${file} → server/lib/leaf.js → server/lib/nested.js imports 'node:fs' (non-relative import (Node built-in or npm package))`,
      `${file} → server/lib/leaf.js → server/lib/nested.js imports '../services/helper.js' → server/services/helper.js (resolves outside server/lib)`,
    ]));
  });

  it('still tokenizes files whose specifier hides ../server behind an escape', () => {
    const file = 'client/src/lib/escaped.js';
    const source = String.raw`import { x } from '..\/..\/..\/server\/services\/x.js';`;
    expect(inspectClientImports([file], () => source).violations).toHaveLength(1);
    expect(inspectClientImports([file], () => String.raw`import { x } from '\x2e\x2e/../../server/services/x.js';`).violations).toHaveLength(1);
    expect(inspectClientImports([file], () => String.raw`import { x } from '../../../ser\u0076er/services/x.js';`).violations).toHaveLength(1);
    expect(inspectClientImports([file], () => "import { x } from '../../../ser\\\nver/services/x.js';").violations).toHaveLength(1);
    expect(inspectClientImports([file], () => 'const lazy = () => import(`../../../ser\\u0076er/services/x.js`);').violations).toHaveLength(1);
    expect(inspectClientImports([file], () => "import { x } from '../../.././server/services/x.js';").violations).toHaveLength(1);
    expect(inspectClientImports([file], () => String.raw`import { x } from '../../../\server/services/x.js';`).violations).toHaveLength(1);
    expect(inspectClientImports([file], () => "import { x } from './lib/other.js';").violations).toEqual([]);
  });

  it('ignores unrelated paths and comments', () => {
    const source = `// import '../../../server/index.js';
import './server/local.js';
export * from '../../../server-lookalike/index.js';`;
    expect(inspectClientImports(['client/src/lib/example.js'], () => source)).toEqual({ entryCount: 0, violations: [] });
  });
});
