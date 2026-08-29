import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Every pm2 app needs BOTH memory bounds, and they have to be in the right order.
 *
 * `max_memory_restart` alone is not a memory policy — it is only the kill switch.
 * Node sizes V8's heap limit from physical memory (~4 GB on any workstation), so
 * without an explicit `--max-old-space-size` the process hits the pm2 ceiling
 * before V8 ever runs the full compacting GC that would have reclaimed the
 * garbage: the restart becomes the routine way memory is freed, and every restart
 * drops in-flight SSE streams and long jobs.
 *
 * portos-ui shipped with neither bound and was measured at 2.7 GB after 18h of
 * uptime — the regression these assertions exist to prevent.
 */
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(repoRoot, 'ecosystem.config.cjs');
const { apps } = require(configPath);

// Deliberately a SECOND implementation of the config's own parser, not an import
// of it: a guard that reuses the parser under test agrees with itself and can no
// longer fail. A bare number is bytes, per pm2.
const UNIT_MB = { K: 1 / 1024, M: 1, G: 1024 };
const toMB = (spec) => {
  const match = String(spec).trim().match(/^(\d+(?:\.\d+)?)\s*([KMG])?B?$/i);
  if (!match) return null;
  return Number(match[1]) * (match[2] ? UNIT_MB[match[2].toUpperCase()] : 1 / (1024 * 1024));
};

const heapCapMB = (app) => {
  const flag = (app.node_args || []).find((a) => a.startsWith('--max-old-space-size='));
  return flag ? Number(flag.split('=')[1]) : null;
};

const APP_CASES = apps.map((app) => [app.name, app]);

// pm2 also manages python/go/docker/static apps, and `--max-old-space-size` is
// meaningless for those — scope the heap-cap assertion to the Node-interpreted
// entries so a future non-Node app doesn't force the guard to be deleted.
const NODE_APP_CASES = APP_CASES.filter(([, app]) =>
  app.interpreter === 'node' || (!app.interpreter && /\.[cm]?js$/i.test(app.script)));

describe('ecosystem.config.cjs memory bounds', () => {
  it('restarts the development UI before CoS reports a 2048 MiB warning', () => {
    const ui = apps.find((app) => app.name === 'portos-ui');
    expect(ui?.max_memory_restart).toBe('1536M');
  });

  it('recognizes every app as Node-interpreted (update the filter if that changes)', () => {
    expect(NODE_APP_CASES).toHaveLength(APP_CASES.length);
  });

  it.each(APP_CASES)('%s declares a restart ceiling', (_name, app) => {
    expect(toMB(app.max_memory_restart)).toBeGreaterThan(0);
  });

  it.each(NODE_APP_CASES)('%s caps V8 below a declared restart ceiling', (_name, app) => {
    const ceiling = toMB(app.max_memory_restart);
    const cap = heapCapMB(app);
    expect(cap).toBeGreaterThan(0);
    // Strictly below, so V8 collects first and pm2 restarts only as a last resort.
    // This is also what a `Math.max(...)` floor on the cap would break: at a small
    // user-set ceiling the floor could raise the cap to or past it.
    expect(cap).toBeLessThan(ceiling);
  });

  // The ceilings are user-overridable via env, and pm2 accepts a BARE NUMBER as
  // bytes — the form a machine that tuned this before the heap cap existed is
  // most likely to already have. A parser that only understood '4G' returned no
  // cap there, leaving precisely the un-collected-heap-under-an-RSS-ceiling setup
  // this policy exists to fix. Asserted through a real config load rather than
  // against the parser directly, so it observes what pm2 would actually receive.
  it('still caps V8 when the ceiling is spelled in pm2 bare bytes', () => {
    const previous = process.env.PORTOS_SERVER_MAX_MEMORY;
    process.env.PORTOS_SERVER_MAX_MEMORY = '4294967296'; // 4 GB, in bytes
    try {
      delete require.cache[require.resolve(configPath)];
      const server = require(configPath).apps.find((a) => a.name === 'portos-server');
      expect(server.max_memory_restart).toBe('4294967296');
      expect(heapCapMB(server)).toBeGreaterThan(0);
      expect(heapCapMB(server)).toBeLessThan(4096);
    } finally {
      if (previous === undefined) delete process.env.PORTOS_SERVER_MAX_MEMORY;
      else process.env.PORTOS_SERVER_MAX_MEMORY = previous;
      // Drop the env-poisoned module so the shared `apps` above stays authoritative
      // for any later require of the config in this process.
      delete require.cache[require.resolve(configPath)];
    }
  });

  // A heap cap must never reach the child processes these apps spawn (agent CLIs,
  // builds, media tooling) — NODE_OPTIONS is inherited by children, node_args is
  // not. server/services/pm2.js additionally strips the `node_args` key pm2
  // re-exports into the app's own environment.
  it.each(NODE_APP_CASES)('%s sets the cap via node_args, not NODE_OPTIONS', (_name, app) => {
    expect(app.env?.NODE_OPTIONS ?? '').not.toContain('max-old-space-size');
  });
});
