import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const routeFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const filepath = join(directory, entry.name);
  if (entry.isDirectory()) return routeFiles(filepath);
  return entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [filepath] : [];
});

describe('PM2 log route validation', () => {
  it('validates the bounded lines query in every route handler that reads PM2 logs', () => {
    const routesDirectory = new URL('.', import.meta.url);
    const files = routeFiles(routesDirectory.pathname);
    const callSites = files.flatMap((filepath) => {
      const source = readFileSync(filepath, 'utf8');
      return [...source.matchAll(/pm2Service\.getLogs\s*\(/g)].map((match) => {
        const routeStart = source.lastIndexOf('router.get(', match.index);
        const handlerSource = source.slice(routeStart, match.index);
        return {
          file: filepath.slice(routesDirectory.pathname.length),
          validated: routeStart >= 0 && handlerSource.includes('validateRequest(logsQuerySchema'),
        };
      });
    });

    expect(callSites.length).toBeGreaterThan(0);
    expect(callSites.filter(({ validated }) => !validated)).toEqual([]);
  });
});
