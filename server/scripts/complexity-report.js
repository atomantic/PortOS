import { lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse } from '@babel/parser';
import { execFileSync } from '../lib/childProcess.js';

const SOURCE_LIMIT = 20;
const TEST_LIMIT = 5;
const ERROR_LIMIT = 20;
const SOURCE_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/i;
const EXCLUDED_DIRS = new Set([
  '.git', '.cache', '.next', 'node_modules', 'vendor', 'vendors', 'third_party', 'third-party',
  'dist', 'build', 'coverage', 'generated', '__generated__', 'migrations', 'db-migrations',
]);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const PROPERTIES = new Set(['Property', 'MethodDefinition', 'PropertyDefinition']);
const DECISIONS = new Set([
  'AssignmentPattern', 'CatchClause', 'ConditionalExpression', 'DoWhileStatement',
  'ForInStatement', 'ForOfStatement', 'ForStatement', 'IfStatement', 'LogicalExpression',
  'WhileStatement',
]);
const LOGICAL_ASSIGNMENTS = new Set(['&&=', '||=', '??=']);

function isDecision(node) {
  if (DECISIONS.has(node.type)) return true;
  if (node.type === 'SwitchCase') return node.test !== null;
  if (node.type === 'AssignmentExpression') return LOGICAL_ASSIGNMENTS.has(node.operator);
  if (node.type === 'CallExpression' || node.type === 'MemberExpression') return node.optional === true;
  return false;
}

function functionName(node, property) {
  if (property?.kind === 'constructor') return 'Constructor';
  const words = [];
  if (property?.static) words.push('static');
  if (property?.key.type === 'PrivateIdentifier') words.push('private');
  if (node.async) words.push('async');
  if (node.generator) words.push('generator');
  if (property) {
    words.push({ get: 'getter', set: 'setter' }[property.kind] ?? 'method');
  } else {
    if (node.type === 'ArrowFunctionExpression') words.push('arrow');
    words.push('function');
  }

  const key = property?.key;
  if (key?.type === 'PrivateIdentifier') words.push(`#${key.name}`);
  else if (key?.type === 'Identifier' && !property.computed) words.push(`'${key.name}'`);
  else if (key?.type === 'Literal') words.push(`'${key.value}'`);
  else if (node.id) words.push(`'${node.id.name}'`);

  const name = words.join(' ').replace(/\s+/g, ' ');
  return name[0].toUpperCase() + name.slice(1);
}

function arrowLocation(arrows, bodyStart) {
  let low = 0;
  let high = arrows.length;
  // The arrow immediately preceding the body belongs to this function, including
  // when the parameter list contains a nested arrow or the body is parenthesized.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (arrows[middle].start < bodyStart) low = middle + 1;
    else high = middle;
  }
  return arrows[low - 1].loc.start;
}

function measure(source, path) {
  const { program, tokens } = parse(source, {
    sourceType: path.toLowerCase().endsWith('.cjs') ? 'commonjs' : 'module',
    plugins: ['estree', 'jsx'],
    tokens: true,
    attachComment: false,
  });
  const arrows = tokens.filter(token => token.type.label === '=>');
  const entries = [];

  function startScope(name, { line, column }) {
    const entry = { path, line, column: column + 1, name, score: 1 };
    entries.push(entry);
    return entry;
  }

  function visit(node, parent, scope) {
    // Class field values and static blocks are implicit functions. Computed
    // property keys execute in the enclosing scope.
    if (parent?.type === 'PropertyDefinition' && node === parent.value) {
      scope = startScope('Class field initializer', node.loc.start);
    }
    if (node.type === 'StaticBlock') {
      scope = startScope('Class static block', node.loc.start);
    }
    if (FUNCTIONS.has(node.type)) {
      const property = PROPERTIES.has(parent?.type) && node === parent.value ? parent : null;
      const location = property?.loc.start ?? (node.type === 'ArrowFunctionExpression'
        ? arrowLocation(arrows, node.body.start)
        : node.loc.start);
      scope = startScope(functionName(node, property), location);
    }
    if (scope && isDecision(node)) scope.score += 1;

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child?.type) visit(child, node, scope);
        }
      } else if (value?.type) {
        visit(value, node, scope);
      }
    }
  }

  visit(program, null, null);
  return entries;
}

function gitLines(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
}

function eligible(path) {
  return SOURCE_EXTENSION.test(path)
    && !path.split('/').some(part => EXCLUDED_DIRS.has(part))
    // This in-tree toolkit is vendored despite its directory name.
    && !path.startsWith('server/lib/aiToolkit/')
    && !/\.(?:generated|min)\.(?:js|jsx|mjs|cjs)$/i.test(path);
}

function isTest(path) {
  return /(?:^|\/)(?:test|tests|__tests__|fixtures?|__fixtures__)(?:\/|$)/i.test(path)
    || /\.(?:test|spec|fixture)\.(?:js|jsx|mjs|cjs)$/i.test(path);
}

function compareEntries(a, b) {
  return b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || a.line - b.line || a.column - b.column || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function printSection(label, section, limit) {
  console.log(`${label}: ${section.scanned}/${section.files} files scanned; ${section.count} functions/initializers; top ${limit}`);
  const entries = section.entries;
  for (const entry of entries) console.log(`  ${String(entry.score).padStart(4)}  ${entry.path}:${entry.line}:${entry.column}  ${entry.name}`);
  if (!entries.length) console.log('  (none)');
}

// Repeatable `--exclude <glob>` (or `--exclude=<glob>`): path.matchesGlob patterns over repository-relative paths.
// An unknown argument or a missing value is an error, so a mistyped flag cannot pass as an unfiltered scan.
function parseExcludes(args) {
  const globs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const glob = arg === '--exclude' ? args[++index] : arg.startsWith('--exclude=') ? arg.slice('--exclude='.length) : null;
    if (glob === null) throw new Error(`unknown argument ${arg}; usage: complexity-report.js [--exclude <glob>]...`);
    if (!glob) throw new Error('--exclude needs a glob');
    globs.push(glob);
  }
  return globs;
}

function run() {
  const excludes = parseExcludes(process.argv.slice(2));
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const deleted = new Set(gitLines(root, ['ls-files', '--deleted', '-z']));
  const candidates = [...new Set(gitLines(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))]
    .filter(path => !deleted.has(path) && eligible(path)).sort();
  const paths = candidates.filter(path => !excludes.some(glob => posix.matchesGlob(path, glob)));
  const sections = {
    source: { files: 0, scanned: 0, count: 0, limit: SOURCE_LIMIT, entries: [] },
    tests: { files: 0, scanned: 0, count: 0, limit: TEST_LIMIT, entries: [] },
  };
  const failures = [];

  for (const path of paths) {
    const section = sections[isTest(path) ? 'tests' : 'source'];
    section.files += 1;
    try {
      // Git can track symlinks; never read through one into another tree.
      if (!lstatSync(join(root, path)).isFile()) {
        section.files -= 1;
        continue;
      }
      const entries = measure(readFileSync(join(root, path), 'utf8'), path);
      section.entries.push(...entries);
      section.count += entries.length;
      section.entries.sort(compareEntries);
      section.entries.splice(section.limit);
      section.scanned += 1;
    } catch (error) {
      if (error.loc) {
        failures.push(`${path}:${error.loc.line}:${error.loc.column + 1} Parsing error: ${error.message}`);
      } else {
        failures.push(`${path}: ${error.message}`);
      }
    }
  }

  console.log('Cyclomatic complexity: classic variant (report only; a score is not a finding)');
  console.log('Scope: tracked and unignored untracked JS/JSX/MJS/CJS; excludes generated, vendor, build and migration files. Other languages are not scanned.');
  if (excludes.length) console.log(`Excluded: ${candidates.length - paths.length} file(s) matching ${excludes.length} --exclude glob(s)`);
  printSection('Source', sections.source, SOURCE_LIMIT);
  printSection('Tests and fixtures', sections.tests, TEST_LIMIT);
  if (failures.length) {
    console.error(`Scan incomplete: ${failures.length} error(s):`);
    for (const failure of failures.slice(0, ERROR_LIMIT)) console.error(`  ${failure}`);
    if (failures.length > ERROR_LIMIT) console.error(`  ... ${failures.length - ERROR_LIMIT} more`);
    process.exitCode = 1;
  }
}

try {
  run();
} catch (error) {
  console.error(`Complexity scan failed: ${error.message}`);
  process.exitCode = 1;
}
