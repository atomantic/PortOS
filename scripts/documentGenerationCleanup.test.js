import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitestTempFixture, fixtureReadyFailureSource } from './lib/vitestTempRootFixture.js';

// A sibling fails only once document authoring is inside its provider call.
// The cancelled body must finish staging its candidate before teardown removes
// the lazy data root; otherwise that staging write recreates the root (#12254).
it('settles document authoring before fail-fast data-root cleanup', () => {
  const host = mkdtempSync(join(tmpdir(), 'mv-document-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const events = join(fixture, 'events');
    const finished = join(fixture, 'finished');
    const { args, options } = createVitestTempFixture(host, 'server', '');
    const sourcePath = fileURLToPath(new URL('../server/services/musicVideo/documentGeneration.test.js', import.meta.url));
    const header = "it('preflights selected media before a provider call and stages a reviewable 30-second document', async () => {";
    const generate = "const { document: candidate } = await generateMixedMediaDocument(id, { providerId: 'stub-provider', model: 'fixture-model' });";
    const end = "expect(await readFile(join(PATHS.data, candidate.directory, 'generated.js'), 'utf8')).toContain('function render(ctx, env)');";
    const source = readFileSync(sourcePath, 'utf8')
      // Only module/URL specifiers: the suite also quotes `from './x.js'` inside
      // runtime-source rewrite strings, which must stay verbatim.
      .replace(/^(import [^\n]*?from\s+|[^\n]*?(?:import|mock|URL)\()(['"])(\.\.?\/[^'"]+)\2/gm, (_, lead, quote, specifier) => lead + JSON.stringify(resolve(dirname(sourcePath), specifier)))
      // Registered before the suite's own teardown, so under stack-ordered
      // after-hooks it observes settlement AFTER that teardown has run, even
      // in the broken control where teardown does not wait for the body.
      .replace("const { PATHS } = await import(", `afterAll(async () => {
        const { existsSync } = await import('node:fs');
        await vi.waitFor(() => expect(existsSync(${JSON.stringify(finished)})).toBe(true), { timeout: 1000 });
      });
      const { PATHS } = await import(`)
      .replace(header, `${header.replace('async () =>', 'async ({ signal }) =>')}
        const { appendFileSync, existsSync, writeFileSync } = await import('node:fs');
        const record = event => appendFileSync(${JSON.stringify(events)}, event + '\\n');
        const cancelled = new Promise(resolve => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
        try {`)
      .replace(generate, `h.onSubmit = async () => {
          record('provider-ready');
          writeFileSync(${JSON.stringify(ready)}, 'ready');
          await cancelled;
          record('root-at-resume:' + existsSync(PATHS.data));
        };
        ${generate}`)
      .replace(end, `${end}
          record('authoring-assertions-complete');
        } finally {
          record('body-settled');
          writeFileSync(${JSON.stringify(finished)}, 'finished');
        }`);
    expect(source).toContain('await cancelled;');
    expect(source).toContain("record('authoring-assertions-complete');");
    expect(source).toContain(`existsSync(${JSON.stringify(finished)})`);
    writeFileSync(join(fixture, 'lifecycle.test.js'), source);
    writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
    args[args.indexOf('--maxWorkers') + 1] = '2';
    args.push('--bail=1', '--testNamePattern', 'preflights selected media before a provider call|controlled sibling failure');
    const result = spawnSync(process.execPath, args, options);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain('controlled sibling failure');
    expect(readFileSync(events, 'utf8'), output).toBe('provider-ready\nroot-at-resume:true\nauthoring-assertions-complete\nbody-settled\n');
    expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, 25000);
