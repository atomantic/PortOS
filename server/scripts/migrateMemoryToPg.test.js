import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('./migrateMemoryToPg.js', import.meta.url));
const dirs = [];
afterEach(async () => Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))));

async function fixture(failure = '') {
  const dir = await mkdtemp(join(tmpdir(), 'memory-migration-cli-'));
  dirs.push(dir);
  const id = '00000000-0000-4000-8000-000000000001';
  const target = '00000000-0000-4000-8000-000000000002';
  await mkdir(join(dir, 'memories', id), { recursive: true });
  const sources = {
    'index.json': JSON.stringify({ memories: [{ id, type: 'fact' }, { id: target, type: 'fact', summary: 'Fallback record' }] }),
    'embeddings.json': JSON.stringify({ vectors: {} }),
    [`memories/${id}/memory.json`]: JSON.stringify({ id, type: 'fact', content: 'Synthetic memory', relatedMemories: [target] }),
  };
  await Promise.all(Object.entries(sources).map(([name, data]) => writeFile(join(dir, name), data)));
  // Only the database and source root are doubled. Node runs the shipped CLI,
  // including its argument parsing, direct-invocation guard and exit handling.
  const dbSource = `
    export async function query(sql) {
      if (/^(DELETE|INSERT|UPDATE)/.test(sql.trim())) console.log('DB_WRITE');
      if (${JSON.stringify(failure)} === 'record' && sql.includes('INSERT INTO memories')) throw new Error('injected record failure');
      if (${JSON.stringify(failure)} === 'link' && sql.includes('INSERT INTO memory_links')) throw new Error('injected link failure');
      if (sql.includes('information_schema')) return { rows: [{ has_table: true }] };
      if (sql.includes('COUNT')) return { rows: [{ count: 0 }] };
      return { rows: [], rowCount: 1 };
    }
    export const withTransaction = fn => fn({ query });
    export async function close() { console.log('DB_CLOSED'); }
  `;
  const loader = join(dir, 'loader.mjs');
  await writeFile(loader, `
    import { registerHooks } from 'node:module';
    const modules = {
      '../lib/db.js': ${JSON.stringify(dbSource)},
      '../lib/fileUtils.js': ${JSON.stringify(`export const PATHS = { memory: ${JSON.stringify(dir)} };`)},
    };
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith('/migrateMemoryToPg.js') && modules[specifier]) {
        return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    } });
  `);
  const run = async (args = []) => execFileAsync(process.execPath, ['--import', pathToFileURL(loader).href, script, ...args], { timeout: 15000 })
    .then(result => ({ ...result, code: 0 }), error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
  const importModule = () => execFileAsync(process.execPath, ['--import', pathToFileURL(loader).href, '--input-type=module', '-e',
    `await import(${JSON.stringify(pathToFileURL(script).href)})`], { timeout: 15000 });
  return { dir, sources, run, importModule };
}

describe('memory migration CLI', () => {
  it('defaults to a dry run without writes or source changes', async () => {
    const { dir, sources, run } = await fixture();
    const result = await run(['--clear']);
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('DRY RUN');
    expect(result.stdout).not.toContain('DB_WRITE');
    expect(result.stdout).toContain('DB_CLOSED');
    for (const [name, bytes] of Object.entries(sources)) expect(await readFile(join(dir, name), 'utf8')).toBe(bytes);
  });

  it('preflights malformed source before any destructive write', async () => {
    const { dir, sources, run } = await fixture();
    const memoryFile = Object.keys(sources).find(name => name.endsWith('/memory.json'));
    await writeFile(join(dir, memoryFile), '{ malformed');
    const result = await run(['--execute', '--clear']);
    expect(result.code, result.stderr || result.stdout).toBe(1);
    expect(result.stdout).not.toContain('DB_WRITE');
    expect(result.stdout).toContain('DB_CLOSED');
  });

  it('can be imported without starting the CLI or closing the caller pool', async () => {
    const { importModule } = await fixture();
    expect((await importModule()).stdout).toBe('');
  });

  it.each(['record', 'link'])('fails the process and closes the pool on a %s write failure', async failure => {
    const { run } = await fixture(failure);
    const result = await run(['--execute', '--clear']);
    expect(result.code, result.stderr || result.stdout).toBe(1);
    expect(result.stderr).toContain(`injected ${failure} failure`);
    expect(result.stdout).toContain('DB_CLOSED');
    expect(result.stdout).not.toContain('Migration Summary');
  });
});
