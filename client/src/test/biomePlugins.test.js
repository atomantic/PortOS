import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const CLIENT_ROOT = resolve(import.meta.dirname, '../..');

it('reports browser bindings, view timers, and raw formats only in code', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-biome-plugins-'));
  try {
    for (const name of readdirSync(CLIENT_ROOT)) {
      if (name === 'biome.jsonc' || name.endsWith('.grit')) {
        copyFileSync(join(CLIENT_ROOT, name), join(root, name));
      }
    }

    const violations = [
      'const { nested: { fetch } } = window;',
      'const [timer, clearTimeout] = [];',
      'setInterval(update, 100);',
      'window.setInterval?.(update, 100);',
      "window['setInterval'](update, 100);",
      'amount.toLocaleString();',
      'amount?.toLocaleString?.();',
      '`${amount.toFixed(1)}% CPU`;',
      '`Cost: $${amount.toFixed(2)}`;',
      "amount.toFixed(1) + '%';",
      '<span>{amount?.toFixed(0)}% CPU</span>;',
      '<b>Cost: ${amount.toFixed(2)}</b>;',
      '<>Rate: {amount.toFixed(1)}%</>;',
    ];

    const source = [
      ...violations,
      'const { fetch: load } = window;',
      'const timerId = setTimeout(update, 100);',
      'formatPercent(amount);',
      '`${amount.toFixed(1)}s`;',
      '"const fetch = x; setInterval(update, 100); amount.toLocaleString();";',
      "'<span>{amount.toFixed(1)}%</span>';",
      '`const fetch = x; setInterval(update, 100); amount.toLocaleString();`;',
      '// const fetch = x; setInterval(update, 100); amount.toLocaleString();',
      '/* <span>{amount.toFixed(1)}%</span> */',
      '// biome-ignore lint/plugin/lint-no-view-interval: This fixture ticks a local display.',
      'setInterval(update, 100);',
    ];

    const fixtureDir = join(root, 'src', 'components');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'probe.jsx'), source.join('\n'));

    const biome = join(CLIENT_ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
    const result = spawnSync(process.execPath, [
      biome, 'lint', '--only=plugin', '--reporter=json', 'src/components/probe.jsx',
    ], { cwd: root, encoding: 'utf8' });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const { diagnostics } = JSON.parse(result.stdout);
    expect(diagnostics.map(({ category, severity, location }) => [
      category, severity, location?.start?.line,
    ])).toEqual(violations.map((_, index) => ['plugin', 'error', index + 1]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
