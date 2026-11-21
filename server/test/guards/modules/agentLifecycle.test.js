/**
 * Funnel guard for the self-update spawn gate (#4124): scans server/services for
 * callers of the spawn entry points. Split from agentLifecycle.test.js, which
 * covers the lifecycle guards' behaviour and the named-file source assertions.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

// ─── Coverage guard for the self-update spawn gate (issue #4124) ────────────
//
// The gate is argued to cover EVERY path that can start an agent because those
// paths funnel through exactly two chokepoints: `task:ready` → subAgentSpawner's
// listener → `spawnAgentForTask` → one of the three low-level spawn helpers.
// Gating fewer files than "every spawn engine" is only sound while that funnel
// holds, so pin it: a new direct caller of `spawnAgentForTask` or of a spawn
// helper would bypass the gate and must fail here rather than in production.

describe('self-update spawn gate — funnel coverage (#4124)', () => {
  const SERVICES_DIR = join(REPO_ROOT, 'server/services');

  /** Every non-test .js under server/services (recursively), with its source. */
  const serviceSources = () => {
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
        out.push({ path: full, src: readText(full) });
      }
    };
    walk(SERVICES_DIR);
    return out;
  };

  /**
   * Files whose source invokes `name(` somewhere other than its own
   * declaration, relative to server/services and sorted. Listing the DEFINING
   * file too keeps the assertions non-vacuous: a regex that silently stopped
   * matching would drop that file and fail, instead of passing as an empty set.
   */
  const invokersOf = (name) => serviceSources()
    .filter(({ src }) => new RegExp(`(?<!function )\\b${name}\\(`).test(src))
    .map(({ path }) => path.slice(SERVICES_DIR.length + 1))
    .sort();

  it('spawnAgentForTask is invoked from exactly one place — the gated task:ready listener', () => {
    expect(
      invokersOf('spawnAgentForTask'),
      'a new caller of spawnAgentForTask must also carry the self-update hold (see subAgentSpawner.js)'
    ).toEqual(['subAgentSpawner.js']);
  });

  it('the three low-level spawn helpers are invoked only from the gated dispatch', () => {
    // If any other module called these directly it would create an agent
    // process without passing spawnAgentForTask's update guard at all.
    for (const helper of ['spawnTuiAgent', 'spawnViaRunner', 'spawnDirectly']) {
      expect(
        invokersOf(helper),
        `${helper} must stay reachable only through spawnAgentForTask`
      ).toEqual(['agent/agentSpawnDispatch.js']);
    }
  });
});
