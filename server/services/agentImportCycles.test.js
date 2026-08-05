/**
 * Regression guard for the agent-lifecycle circular-dependency cluster (#2837).
 *
 * The cluster — agentLifecycle / agentCliSpawning / agentTuiSpawning /
 * agentManagement / subAgentSpawner / cosAgents — used to contain two real
 * STATIC cycles plus three `await import(...)` workarounds whose only job was to
 * dodge the load-time cycle. Both were fixed by extracting the shared pieces
 * (finalize, summary extraction, runner sync, runner output batchers) into leaf
 * modules that nothing in the cluster is imported BY.
 *
 * This test re-derives the static import graph of `server/services` from source
 * and asserts the cluster is acyclic. It scans STATIC imports/re-exports only —
 * `await import()` is deferred to call time and therefore harmless for module
 * initialization order; a static cycle is what produces TDZ/undefined-binding
 * failures at boot.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative, resolve } from 'path';
import { staticImportSpecifiers } from '../lib/staticImportGraph.js';

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));

// The modules the #2837 audit named, plus the leaf modules extracted to break
// the cycle. A cycle anywhere in `server/services` will be reported, but only a
// cycle TOUCHING one of these fails the assertion — unrelated pre-existing
// cycles elsewhere are out of scope for this guard.
const CLUSTER = [
  'agentLifecycle.js',
  'agentCliSpawning.js',
  'agentTuiSpawning.js',
  'agentManagement.js',
  'subAgentSpawner.js',
  'cosAgents.js',
  'cosAgentLifecycle.js',
  'agentFinalization.js',
  'agentSummaryExtraction.js',
  'agentRunnerSync.js',
  'agentRunnerOutputBatchers.js',
  'agentOrchestrator.js',
];

// The static-import scan itself lives in `server/lib/staticImportGraph.js` so
// this guard and the sprites sharp-free guard share ONE parser — two copies is
// how a structural guard rots (a fix to one silently under-reports in the
// other). It matches static `import`/`export … from` and bare side-effect
// imports only, never `await import()` (deferred to call time, so it can't
// produce a load-time cycle) and never a specifier inside a comment.
// Every non-test `.js` under SERVICES_DIR, keyed by its path relative to that
// directory (`agentLifecycle.js`, `agentTuiSpawning/outputSpooler.js`). The
// walk recurses: scanning only top-level files left a hole big enough to drive
// the cycle back through, because a subdirectory module can import back up
// (`agentTuiSpawning/outputSpooler.js` → `../cosAgents.js` is a live example),
// so a cycle routed through one subdirectory hop was invisible to this guard.
function listServiceFiles(dir = SERVICES_DIR, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listServiceFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) out.push(rel);
  }
  return out;
}

function buildStaticGraph() {
  const files = listServiceFiles();
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const abs = join(SERVICES_DIR, file);
    const deps = new Set();
    for (const spec of staticImportSpecifiers(abs)) {
      if (!spec.startsWith('.')) continue;
      // Resolve relative to the importing file, then re-key against SERVICES_DIR
      // so `./x.js` from a subdirectory and `../x.js` from a sibling land on the
      // same node. Anything resolving outside the services dir is out of scope.
      const rel = relative(SERVICES_DIR, resolve(dirname(abs), spec));
      if (known.has(rel)) deps.add(rel);
    }
    graph.set(file, [...deps]);
  }
  return graph;
}

// Does `file` reach `mod` with a DEFERRED import? The static graph deliberately
// ignores `import()` — correct for cycle detection, since a deferred import
// cannot produce a load-time cycle — but reaching across a blocked layer that
// way is exactly this cluster's habit, so several guards below need to see it.
// One implementation, because two copies of a structural matcher is how a guard
// rots: a fix to one silently under-reports in the other (the same reason the
// static scan lives once in `server/lib/staticImportGraph.js`).
//
// The match is deliberately loose — anything between the paren and the closing
// paren that names the module — so quotes, template literals, an interleaved
// comment and any path depth all count. `await` is NOT required, so a
// `return import(...).then(...)` back-edge is caught too, and whitespace before
// the paren is allowed because `import ('./x.js')` is valid ESM that a `import\(`
// matcher would wave straight through. A mention inside a comment trips it as
// well; that fails CLOSED, which is the correct bias for a structural guard (the
// alternative is a green suite over a live back-edge).
function importsDynamically(file, mod) {
  const src = readFileSync(join(SERVICES_DIR, file), 'utf-8');
  return new RegExp(String.raw`\bimport\s*\(\s*[^)]*\b${mod.replace(/\./g, '\\.')}[^)]*\)`).test(src);
}

function findCycles(graph) {
  const cycles = new Set();
  const stack = [];
  const state = new Map(); // 1 = on stack, 2 = done
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (state.get(dep) === 1) {
        cycles.add(stack.slice(stack.indexOf(dep)).concat(dep).join(' -> '));
      } else if (!state.has(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return [...cycles];
}

describe('agent lifecycle cluster — no static import cycles (#2837)', () => {
  const graph = buildStaticGraph();

  it('has no static import cycle touching the agent-lifecycle cluster', () => {
    const offending = findCycles(graph).filter(cycle => CLUSTER.some(m => cycle.includes(m)));
    expect(offending, `static import cycle(s) reintroduced:\n${offending.join('\n')}`).toEqual([]);
  });

  it('keeps the extracted leaves free of back-edges into the cluster orchestrators', () => {
    // These four exist ONLY to be depended on. If any of them grows an import of
    // an orchestrator, the cycle comes straight back — fail loudly and early
    // rather than waiting for the graph walk above to go red for a subtler reason.
    const orchestrators = ['agentLifecycle.js', 'agentCliSpawning.js', 'agentTuiSpawning.js', 'agentManagement.js', 'subAgentSpawner.js'];
    for (const leaf of ['agentFinalization.js', 'agentSummaryExtraction.js', 'agentRunnerSync.js', 'agentRunnerOutputBatchers.js']) {
      const back = (graph.get(leaf) || []).filter(dep => orchestrators.includes(dep));
      expect(back, `${leaf} must not import ${back.join(', ')}`).toEqual([]);
    }
  });

  it('keeps the agentOrchestrator facade outside the graph it fronts (#3450)', () => {
    // The facade only stays a facade while its edges point one way: it imports
    // the cluster, the cluster never imports it back.
    //
    // The forbidden set is derived, not listed. It is everything reachable FROM
    // the facade — an import back from any of those closes a loop, and the set
    // grows on its own as the cluster does, so it can't fall behind the way a
    // hand-maintained list of seven names would (that list omitted
    // agentCliSpawning/agentTuiSpawning, both reachable via agentLifecycle).
    // Modules outside the closure may import the facade freely: they close no
    // loop, and forbidding them would freeze the remaining call-site migrations.
    const reachable = new Set();
    const walk = (node) => {
      for (const dep of graph.get(node) || []) {
        if (reachable.has(dep)) continue;
        reachable.add(dep);
        walk(dep);
      }
    };
    walk('agentOrchestrator.js');
    expect(reachable.size, 'facade closure looks empty — did the module move?').toBeGreaterThan(3);

    // Deferred imports count as back-edges here too — see `importsDynamically`.
    const offenders = [...reachable].filter(file =>
      (graph.get(file) || []).includes('agentOrchestrator.js') ||
      importsDynamically(file, 'agentOrchestrator.js')
    ).sort();
    expect(offenders, `agentOrchestrator.js must not be imported by ${offenders.join(', ')}`).toEqual([]);
  });

  it('no longer needs the state-layer forwarders into the process layer (#3450)', () => {
    // Step 4 of the #3450 sequencing. `cosAgentLifecycle.js` — the agent STATE
    // layer — used to forward pause/kill/stats into the PROCESS layer with
    // `await import()`, purely so a caller holding a `cos.js` handle could reach
    // across a boundary the state layer cannot import across statically. Those
    // callers go through the facade now.
    //
    // Guard the mechanism, not the three names: ANY deferred import of
    // `agentManagement.js` from here is a new forwarder. A *static* one needs no
    // assertion — it closes a cycle the walk above already fails on.
    expect(importsDynamically('cosAgentLifecycle.js', 'agentManagement.js'),
      'cosAgentLifecycle.js must not defer-import the process layer — ask the facade').toBe(false);

    // The other half: `cos.js` re-exporting those transitions is what gave the
    // forwarders callers in the first place. Derive which names are off-limits
    // from the facade itself — everything it takes from the process layer —
    // rather than listing them, so the rule tracks the facade as it grows.
    //
    // Minus the names the facade ALSO serves from the state layer. That set is
    // `terminateAgent`, the one genuine collision in this cluster: `cos.js`
    // legitimately re-exports the state-layer function of that name, and it is
    // only unambiguous inside the facade because the facade renames it to
    // `requestAgentTermination`. Subtracting is what keeps this derivation from
    // failing on a name `cos.js` is right to export.
    const facade = readFileSync(join(SERVICES_DIR, 'agentOrchestrator.js'), 'utf-8');
    const reexportedFrom = (source) => {
      const block = facade.match(new RegExp(String.raw`export\s*\{([^}]*)\}\s*from\s*'\./${source}'`));
      expect(block, `facade no longer re-exports from ${source} — did the layering change?`).toBeTruthy();
      return block[1]
        .replace(/\/\/[^\n]*/g, '')       // strip the per-export state-edge comments
        .split(',')
        .map(entry => entry.split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
    };
    const stateLayer = new Set(reexportedFrom('cosAgentLifecycle.js'));
    const forbidden = reexportedFrom('agentManagement.js').filter(name => !stateLayer.has(name));
    expect(forbidden.length, 'derived nothing to forbid — check the facade export blocks').toBeGreaterThan(0);

    // Scope to cos.js's re-export statements, not the whole file: `completeAgent`
    // and friends legitimately appear elsewhere in it. But scope to ALL of them,
    // from ANY source — the two realistic regressions are a second
    // `export { pauseAgent } from './cosAgents.js';` statement (which a
    // first-match-only scan never sees) and a re-export sourced straight from
    // `./agentManagement.js` (which a cosAgents-only scan never sees). Either one
    // restores the surface with the guard fully green.
    const cosSrc = readFileSync(join(SERVICES_DIR, 'cos.js'), 'utf-8');
    const cosReexports = [...cosSrc.matchAll(/export\s*\{[^}]*\}\s*from\s*'[^']+'/g)].map(m => m[0]).join('\n');
    expect(cosReexports, "cos.js re-exports nothing from './cosAgents.js' — did the block move?")
      .toMatch(/cosAgents\.js/);
    for (const name of forbidden) {
      expect(cosReexports, `cos.js must not re-export ${name} — it is a process-layer transition, ask the facade`)
        .not.toMatch(new RegExp(String.raw`\b${name}\b`));
    }

    // Scoped to `cos.js` on purpose: `subAgentSpawner.js` still re-exports these
    // same three from `agentManagement.js`. That barrel is the cluster's declared
    // back-compat surface and retiring it is its own slice of #3450, so widening
    // this to "no module may re-export a facade transition" would fail today. The
    // narrower rule holds the line where the forwarders actually had callers.
  });

  it('keeps agentState.js an import-free leaf, so agents.js can use the facade (#3450)', () => {
    // `agentState.js` is what lets modules that cannot import each other share
    // state — the pid map moved here so `agentManagement.js` no longer had to
    // import it out of `agents.js`. One import of a cluster module here would
    // close a cycle for every such pair at once, so it must stay import-free.
    expect(graph.get('agentState.js')).toEqual([]);

    // The payoff: with that back-edge gone, agents.js is outside the facade's
    // closure and reaches the kill transition through a plain static import.
    expect(importsDynamically('agents.js', 'subAgentSpawner.js'),
      'agents.js must not defer-import the spawner barrel — the facade is a static import now').toBe(false);
    expect(graph.get('agents.js')).toContain('agentOrchestrator.js');
  });

  it('no longer needs the dynamic-import workaround for handleOrphanedTask', () => {
    // The cycle-dodge this issue was filed for: agentLifecycle reached
    // agentManagement via `await import()` because agentManagement imported it back.
    expect(importsDynamically('agentLifecycle.js', 'agentManagement.js')).toBe(false);
    expect(graph.get('agentLifecycle.js')).toContain('agentManagement.js');
  });
});
