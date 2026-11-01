import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Linter } from 'eslint';
import { execFileSync } from '../lib/childProcess.js';

const { version } = createRequire(import.meta.url)('eslint/package.json');
const SOURCE_LIMIT = 20;
const TEST_LIMIT = 5;
const ERROR_LIMIT = 20;
const SOURCE_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/i;
const EXCLUDED_DIRS = new Set([
  '.git', '.cache', '.next', 'node_modules', 'vendor', 'vendors', 'third_party', 'third-party',
  'dist', 'build', 'coverage', 'generated', '__generated__', 'migrations', 'db-migrations',
]);
const CONFIG = {
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
  rules: { complexity: ['warn', { max: 0, variant: 'classic' }] },
};

function gitLines(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
}

function eligible(path) {
  return SOURCE_EXTENSION.test(path)
    && !path.split('/').some(part => EXCLUDED_DIRS.has(part))
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

function run() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const deleted = new Set(gitLines(root, ['ls-files', '--deleted', '-z']));
  const paths = [...new Set(gitLines(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))]
    .filter(path => !deleted.has(path) && eligible(path)).sort();
  const sections = {
    source: { files: 0, scanned: 0, count: 0, limit: SOURCE_LIMIT, entries: [] },
    tests: { files: 0, scanned: 0, count: 0, limit: TEST_LIMIT, entries: [] },
  };
  const failures = [];
  const linter = new Linter();

  for (const path of paths) {
    const section = sections[isTest(path) ? 'tests' : 'source'];
    section.files += 1;
    try {
      // Git can track symlinks; never read through one into another tree.
      if (!lstatSync(join(root, path)).isFile()) {
        section.files -= 1;
        continue;
      }
      const config = path.toLowerCase().endsWith('.cjs') ? { ...CONFIG, languageOptions: { ...CONFIG.languageOptions, sourceType: 'commonjs' } } : CONFIG;
      const messages = linter.verify(readFileSync(join(root, path), 'utf8'), config, { allowInlineConfig: false });
      const errors = messages.filter(message => message.ruleId !== 'complexity');
      if (errors.length) {
        for (const error of errors) failures.push(`${path}:${error.line || 1}:${error.column || 1} ${error.message}`);
        continue;
      }
      const entries = messages.map(message => {
        const match = /^(.*?) has a complexity of (\d+)\. Maximum allowed is 0\.$/s.exec(message.message);
        if (!match) throw new Error(`Unrecognized ESLint complexity message: ${message.message}`);
        return { path, line: message.line, column: message.column, name: match[1].replace(/\s+/g, ' '), score: Number(match[2]) };
      });
      section.entries.push(...entries);
      section.count += entries.length;
      section.entries.sort(compareEntries);
      section.entries.splice(section.limit);
      section.scanned += 1;
    } catch (error) {
      failures.push(`${path}: ${error.message}`);
    }
  }

  console.log(`Cyclomatic complexity: ESLint ${version}, classic variant (report only; a score is not a finding)`);
  console.log('Scope: tracked and unignored untracked JS/JSX/MJS/CJS; excludes generated, vendor, build and migration files. Other languages are not scanned.');
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
