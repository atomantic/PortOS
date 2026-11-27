import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { BIOME_BIN, SERVER_LINT_ARGS } from '../../run-ci-lint.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const copyServerLintConfig = (root) => {
  for (const file of ['biome.jsonc', 'lint-no-raw-pm2-jlist.grit', 'server/biome.jsonc',
    'server/lint-glab-list-flags.grit', 'server/lint-pg-json.grit']) {
    cpSync(join(repoRoot, file), join(root, file));
  }
  return join(root, 'server');
};

test('fails server lint for unused bindings and inherited warning diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'biome-findings-'));
  try {
    const serverDir = copyServerLintConfig(dir);
    writeFileSync(join(serverDir, 'app.js'), 'const unused = 1;\n');
    const lint = () => spawnSync(process.execPath, [BIOME_BIN, ...SERVER_LINT_ARGS], { cwd: serverDir, encoding: 'utf8' });
    const unused = lint();
    assert.notEqual(unused.status, 0);
    assert.match(unused.stderr, /noUnusedVariables/);
    writeFileSync(join(serverDir, 'app.js'), 'export const used = 1;\n');
    assert.equal(lint().status, 0);
    writeFileSync(join(serverDir, 'biome.jsonc'), JSON.stringify({ linter: { rules: { preset: 'none', correctness: { noUnusedVariables: 'warn' } } } }));
    writeFileSync(join(serverDir, 'app.js'), 'const unused = 1;\n');
    assert.notEqual(lint().status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Vitest's HTML reporter writes JS assets under server/coverage/; lint must
// ignore them while still failing on an undeclared identifier in real source.
test('ignores generated coverage assets but still flags undeclared variables in source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'biome-cov-'));
  try {
    const serverDir = copyServerLintConfig(dir);
    mkdirSync(join(serverDir, 'coverage'));
    writeFileSync(join(serverDir, 'coverage', 'prettify.js'), 'PR.prettyPrint();\n');
    const lint = () => spawnSync(process.execPath, [BIOME_BIN, 'lint', '.'], { cwd: serverDir, encoding: 'utf8' });
    assert.equal(lint().status, 0);
    writeFileSync(join(serverDir, 'app.js'), 'undeclaredThing();\n');
    assert.notEqual(lint().status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enforces runtime syntax rules and their exemptions through Biome', () => {
  const root = mkdtempSync(join(tmpdir(), 'biome-runtime-rules-'));
  try {
    const serverDir = copyServerLintConfig(root);
    const fixture = (path, lines) => {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, lines.join('\n') + '\n');
    };
    fixture('server/services/cli.cjs', [
      "void execPm2(['jlist']);",
      "void execPm2(['describe', 'jlist']);",
      "void args(['issue', 'list', '-F', 'json']);",
      "void args(['mr', 'list', '--repo', project, '--state', 'closed']);",
      "void args(['mr', 'list', '--closed', '--output', 'json']);",
      "const issuePrompt = `* glab issue list --per-page 100 -F json`;",
      "const mrPrompt = `// then run glab mr list --state opened`;",
      "/** glab mr list --state is unsupported. */",
      "const note = 'glab issue list --output json';",
    ]);
    fixture('server/services/cli.test.cjs', ["void execPm2(['jlist']);"]);
    fixture('autofixer/runner.mjs', ['void execPm2(["jlist"]);']);
    fixture('autofixer/shared.js', ["void execPm2(['jlist']);"]);
    fixture('autofixer/runner.test.js', ["void execPm2(['jlist']);"]);
    fixture('server/services/db.js', [
      "await query('UPDATE t SET d = $1::json', [JSON.stringify(record)]);",
      "await db.query(`INSERT INTO t SELECT r::jsonb FROM unnest($1::text[]) AS r`, [rows.map(r => JSON.stringify(r))]);",
      "await query('UPDATE t SET d = $1::jsonb', [toPgJson(record)]);",
      "async function write(record) {",
      "  const sql = 'UPDATE t SET d = $1::jsonb';",
      "  const params = [JSON.stringify(record)];",
      "  params.push(JSON.stringify(record));",
      "  const cacheKey = hash(JSON.stringify(record));",
      "  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(record)]);",
      "  function unrelated() { const keys = [JSON.stringify(record)]; return keys; }",
      "  await db.query(sql, params);",
      "}",
      "// params.push(JSON.stringify(record))",
      "const note = 'JSON.stringify(record)';",
      "const sql = 'UPDATE t SET d = $1::jsonb';",
      "const params = [JSON.stringify(record)];",
    ]);
    for (const path of ['020-cos-agents-from-state', '032-strip-release-candidate-transfer-state']) {
      fixture(`server/scripts/db-migrations/${path}.js`, [
        "await query('UPDATE t SET d = $1::json', [JSON.stringify(record)]);",
        "await query('UPDATE t SET d = $1::jsonb', [JSON.stringify(record)]);",
      ]);
    }
    const diagnostics = (cwd, paths) => {
      const result = spawnSync(process.execPath, [BIOME_BIN, 'lint', '--only=plugin', '--reporter=json', ...paths],
        { cwd, encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      return JSON.parse(result.stdout).diagnostics.map(({ category, severity, location }) => {
        assert.equal(category, 'plugin');
        assert.equal(severity, 'error');
        return `${location.path.replaceAll('\\', '/')}:${location.start.line}`;
      }).sort();
    };
    assert.deepEqual(diagnostics(root, ['autofixer']), ['autofixer/runner.mjs:1']);
    assert.deepEqual(diagnostics(serverDir, ['services', 'scripts']), [
      'scripts/db-migrations/020-cos-agents-from-state.js:2',
      'scripts/db-migrations/032-strip-release-candidate-transfer-state.js:2',
      'services/cli.cjs:1',
      'services/cli.cjs:3',
      'services/cli.cjs:4',
      'services/cli.cjs:6',
      'services/cli.cjs:7',
      'services/db.js:1',
      'services/db.js:16',
      'services/db.js:2',
      'services/db.js:6',
      'services/db.js:7',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
