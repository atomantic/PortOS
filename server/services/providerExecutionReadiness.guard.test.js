import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

describe('managed-runtime wake ownership (issue #8104)', () => {
  // `bootstrap.js`'s boot-time `ensureRunning` import from `ollamaManager.js`
  // is a different symbol (the daemon's own startup hook, not a per-call
  // readiness gate) and stays allowed — this only guards the three symbols
  // `providerExecutionReadiness.js` wraps into `ensureManagedRuntimeReady`.
  const GUARDED_IMPORTS = [
    { module: './ollamaManager.js', symbol: 'ensureProviderReady' },
    { module: './mtplxServerManager.js', symbol: 'ensureMtplxProviderReady' },
    { module: './slotstreamServerManager.js', symbol: 'ensureSlotstreamProviderReady' },
  ];

  const servicesDir = dirname(fileURLToPath(import.meta.url));

  function listServiceFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) return listServiceFiles(full);
      if (!name.endsWith('.js') || name.endsWith('.test.js')) return [];
      return [full];
    });
  }

  it('lets only providerExecutionReadiness.js import the raw per-runtime wake functions', () => {
    const offenders = [];
    for (const file of listServiceFiles(servicesDir)) {
      if (relative(servicesDir, file) === 'providerExecutionReadiness.js') continue;
      const source = readFileSync(file, 'utf8');
      for (const { module, symbol } of GUARDED_IMPORTS) {
        const escapedModule = module.replace(/[.]/g, '\\.');
        const importLine = new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*['"]${escapedModule}['"]`);
        if (importLine.test(source)) {
          offenders.push(`${relative(servicesDir, file)} imports ${symbol} from ${module}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
