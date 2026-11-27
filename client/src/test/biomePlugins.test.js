import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const CLIENT_ROOT = resolve(import.meta.dirname, '../..');

it('lints browser bindings, view timers, raw formats, and bare click targets', () => {
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
      'findDOMNode(element);',
      'amount.toLocaleString();',
      'amount?.toLocaleString?.();',
      '`${amount.toFixed(1)}% CPU`;',
      '`Cost: $${amount.toFixed(2)}`;',
      '`Cost: $${fee}, $${Number(amount.toFixed(2))}`;',
      "amount.toFixed(1) + '%';",
      '<span>{amount?.toFixed(0)}% CPU</span>;',
      '<b>Cost: ${amount.toFixed(2)}</b>;',
      '<b>Cost: ${fee}<i />Fee: ${Number(amount.toFixed(2))}</b>;',
      '<>Rate: {amount.toFixed(1)}%</>;',
    ];

    const source = [
      ...violations,
      '<div onClick={update}>Click</div>;',
      '<tr onClick={update}><td>Click</td></tr>;',
      'const { fetch: load } = window;',
      'const timerId = setTimeout(update, 100);',
      'formatPercent(amount);',
      '`${amount.toFixed(1)}s`;',
      '`Cost: $${fee}${amount.toFixed(2)}`;',
      '<>{amount.toFixed(1)}<b />%</>;',
      '<>Cost: ${fee}{amount.toFixed(2)}</>;',
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
    for (const extension of ['js', 'jsx']) {
      writeFileSync(join(fixtureDir, `probe.test.${extension}`), 'findDOMNode(element);\n');
    }

    const biome = join(CLIENT_ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
    const result = spawnSync(process.execPath, [
      biome, 'lint', '--only=plugin', '--only=lint/a11y/useKeyWithClickEvents',
      '--reporter=json', 'src/components',
    ], { cwd: root, encoding: 'utf8' });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const { diagnostics } = JSON.parse(result.stdout);
    expect(diagnostics.map(({ category, severity, location }) => [
      category, severity, location?.start?.line,
    ])).toEqual([
      ...violations.map((_, index) => ['plugin', 'error', index + 1]),
      ['lint/a11y/useKeyWithClickEvents', 'error', violations.length + 1],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
