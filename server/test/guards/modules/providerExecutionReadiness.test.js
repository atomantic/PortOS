import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

describe('managed-runtime wake ownership (issue #8104)', () => {
  // `bootstrap.js`'s boot-time `ensureRunning` import from `ollamaManager.js`
  // is a different symbol (the daemon's own startup hook, not a per-call
  // readiness gate) and stays allowed — this only guards the three symbols
  // `providerExecutionReadiness.js` wraps into `ensureManagedRuntimeReady`.
  const GUARDED_IMPORTS = [
    { module: 'ollamaManager.js', symbol: 'ensureProviderReady' },
    { module: 'ollama/ollamaDaemon.js', symbol: 'ensureProviderReady' },
    { module: 'mtplxServerManager.js', symbol: 'ensureMtplxProviderReady' },
    { module: 'slotstreamServerManager.js', symbol: 'ensureSlotstreamProviderReady' },
  ];

  const servicesDir = join(REPO_ROOT, 'server/services');

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
      if (file === join(servicesDir, 'provider', 'providerExecutionReadiness.js')) continue;
      const source = readText(file);
      for (const { module, symbol } of GUARDED_IMPORTS) {
        const importLine = new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*['"](\\.{1,2}/[^'"]+)['"]`, 'g');
        const target = join(servicesDir, module);
        if (Array.from(source.matchAll(importLine)).some(([, specifier]) => resolve(dirname(file), specifier) === target)) {
          offenders.push(`${relative(servicesDir, file)} imports ${symbol} from ${module}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
