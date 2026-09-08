import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

// Boot guard, run in a real Node process. Vitest's module transform turns a
// missing named import into `undefined` instead of the SyntaxError Node throws,
// so the merge-forward of v2.60.0 (which moved PORTOS_UI_URL / PORTOS_API_URL
// from lib/ports.js to lib/portosUrls.js) passed the whole suite and crashed
// the real server at startup. Importing the router under Node's own ESM loader
// catches that class before pm2 does.
describe('routes/beeper.js loads under Node ESM', () => {
  it('imports without a linking error and exports a router', () => {
    const routerUrl = pathToFileURL(join(HERE, 'beeper.js')).href;
    const script = [
      `const mod = await import(${JSON.stringify(routerUrl)});`,
      "if (typeof mod.default !== 'function' || !Array.isArray(mod.default.stack)) {",
      "  throw new Error('routes/beeper.js did not export an Express router');",
      '}',
      'process.stdout.write(String(mod.default.stack.length));',
      'process.exit(0);',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: HERE,
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    expect(Number(out)).toBeGreaterThan(20);
  });
});
