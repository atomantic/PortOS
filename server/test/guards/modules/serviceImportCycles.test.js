/**
 * The static-import-cycle guard for `server/services` (#5693, merged in #16554).
 *
 * A static ESM cycle is a boot-order hazard: whichever member evaluates first
 * sees `undefined` for the others' bindings, so a top-level `const` derived from
 * an imported value anywhere in the ring is a TDZ crash that no behavior test
 * notices until an unrelated import-order change surfaces it.
 *
 * One graph build, one zero-cycle assertion over the whole directory. The
 * tree-wide ratchet reached a hard zero, so the per-cluster acyclicity guards
 * (agent lifecycle #2837, identity/digital-twin #5687, MeatSpace POST #5690,
 * cos.js #5684) folded into it: any cycle touching those clusters is a cycle.
 *
 * What acyclicity cannot see stays as structural rules, mostly as tables:
 * a leaf has no back-edge (a rule even where the edge would not close a ring
 * today), a deferred `import()` is not a fix, a re-export barrel is not an
 * address, and a facade stays outside the graph it fronts. `import()` never
 * enters the static graph (it is deferred to call time), which is why the
 * deferred-import rules read source text.
 *
 * Every rule is a function of a directory, so the fixture tree at the bottom
 * proves each one fails on the violation it exists for.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, posix, relative, resolve } from 'path';
import { buildStaticImportGraph, findImportCycles, findImportCycleComponents } from '../../../lib/staticImportGraph.js';
import { staticExportNames } from '../../../lib/staticExportSurface.js';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

const SERVICES_DIR = join(REPO_ROOT, 'server/services');

/** A memoized source reader rooted at `root`; the walks below revisit the same modules. */
function sourceReader(root) {
  const sources = new Map();
  return (file) => {
    if (!sources.has(file)) sources.set(file, readText(join(root, file)));
    return sources.get(file);
  };
}

/** Every cyclic component, plus the rings closing it, as one failure message (empty when acyclic). */
function cycleReport(graph) {
  const components = findImportCycleComponents(graph);
  if (!components.length) return [];
  const members = new Set(components.flat());
  const rings = findImportCycles(graph).filter(ring => ring.split(' -> ').some(m => members.has(m)));
  return [...components.map(c => c.join(' + ')), ...(rings.length ? ['rings closing it:', ...rings] : [])];
}

// Resolve quoted specifiers even with interleaved comments or a template literal,
// so moving a target under a domain directory does not hide a deferred back-edge.
function importsDynamically(read, file, mod) {
  const calls = read(file).matchAll(/\bimport\s*\(\s*[^)]*?(['"`])(\.{1,2}\/[^'"`]+)\1[^)]*\)/g);
  return [...calls].some(([, , specifier]) => posix.join(posix.dirname(file), specifier) === mod);
}

/** Static edges a `NO_BACK_EDGE` row forbids, as `from -> to` strings. `to: ANY` forbids every edge. */
const ANY = Symbol('any import');
function backEdgeViolations(graph, rows) {
  return rows.flatMap(({ from, to }) => from.flatMap(leaf =>
    (graph.get(leaf) || []).filter(dep => to === ANY || to.includes(dep)).map(dep => `${leaf} -> ${dep}`)));
}

/** Names `mod` exports that it does not DECLARE — forwarded from somewhere, by any syntax. */
function forwardedExports(root, read, mod) {
  // Stated as "every export is declared here", the only form that survives the
  // syntax: `export *`, `export { x } from …`, and `import` + a bare `export { x }`
  // all fail it identically, as does a re-export from a module never heard of.
  // The parsed key list is ground truth; if the declaration scan misses a real
  // local declaration the rule fails LOUD rather than going green.
  const declared = new Set([...read(mod).matchAll(
    /^export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1]));
  const actual = staticExportNames(join(root, mod));
  expect(actual, `${mod} exports nothing — did the parse fail?`).not.toEqual([]);
  return actual.filter(name => !declared.has(name)).sort();
}

/** Modules reachable FROM `facade` that import it back, statically or via `import()`. */
function facadeBackEdges(graph, read, facade) {
  // The forbidden set is derived, not listed: everything reachable from the
  // facade, so it grows with the cluster and cannot fall behind a hand list.
  // Modules outside the closure may import the facade freely; they close no loop.
  const reachable = new Set();
  const walk = (node) => {
    for (const dep of graph.get(node) || []) {
      if (reachable.has(dep)) continue;
      reachable.add(dep);
      walk(dep);
    }
  };
  walk(facade);
  expect(reachable.size, `${facade} closure looks empty — did the module move?`).toBeGreaterThan(0);
  return [...reachable].filter(file =>
    (graph.get(file) || []).includes(facade) || importsDynamically(read, file, facade)).sort();
}

// --- The structural rules for server/services --------------------------------

const AGENT_ORCHESTRATORS = ['agent/agentLifecycle.js', 'agent/agentCliSpawning.js', 'agent/agentTuiSpawning.js', 'agent/agentManagement.js', 'subAgentSpawner.js'];
const FACADE = 'agent/agentOrchestrator.js';

const promptSectionsOf = (graph) => [...graph.keys()].filter(file => file.startsWith('promptSections/'));

/** Each `from` module must have no static edge to any `to` module. */
const noBackEdgeRules = (graph) => [
  {
    why: 'extracted agent leaves exist only to be depended on (#2837); the TUI session controller takes its collaborators as arguments so it never needs a spawner (#8021)',
    from: [
      'agent/agentFinalization.js', 'agent/agentPrVerification.js', 'agent/agentGoalFidelity.js', 'agent/agentOutputHookDispatch.js', 'agent/agentRunFinalize.js', 'agent/agentSummaryExtraction.js', 'agent/agentRunnerSync.js', 'agent/agentRunnerOutputBatchers.js',
      ...Array.from(graph.keys()).filter(file => file.startsWith('agentTuiSpawning/')),
    ],
    to: AGENT_ORCHESTRATORS,
  },
  {
    why: 'prompt section modules stay leaves under agentPromptBuilder (#4896)',
    from: promptSectionsOf(graph),
    to: ['agent/agentPromptBuilder.js'],
  },
  {
    why: 'agentState.js is how modules that cannot import each other share state; one import there closes a cycle for every such pair (#3450)',
    from: ['agent/agentState.js'],
    to: ANY,
  },
  {
    why: 'identity/digital-twin leaves name the declaring module, never the barrel over them (#5687)',
    from: ['taste-questionnaire.js'],
    to: ['digital-twin.js'],
  },
  {
    why: 'identity/digital-twin leaves name the declaring module, never the barrel over them (#5687)',
    from: ['digital-twin-export.js', 'digital-twin-avatar-bio.js'],
    to: ['identity.js'],
  },
  {
    why: 'the POST service and its data leaves cannot depend on higher-level analytics or policy orchestration (#5690)',
    from: [
      'meatspace/meatspacePost.js', 'meatspace/postConfig.js', 'meatspace/postSessions.js',
      'meatspace/postSessionHistory.js', 'meatspace/postProgress.js', 'meatspace/postSkillEvidence.js',
    ],
    to: ['meatspace/meatspacePostStats.js', 'meatspace/meatspacePostRecommendations.js', 'meatspace/meatspacePostAdaptive.js'],
  },
];

/** Deferring an import hides a cycle from the static graph without removing the hazard. */
const NO_DEFERRED_IMPORT = [
  { from: 'cos/cosAgentLifecycle.js', to: 'agent/agentManagement.js', why: 'the agent STATE layer must not forward into the process layer — ask the facade (#3450)' },
  { from: 'agent/agentLifecycle.js', to: 'agent/agentManagement.js', why: 'the handleOrphanedTask cycle-dodge this cluster was fixed to remove (#2837)' },
  { from: 'agent/agents.js', to: 'subAgentSpawner.js', why: 'agent/agents.js reaches the kill transition through the facade, statically (#3450)' },
];

/** Modules that must declare everything they export (#3450: both were forwarding barrels). */
const NO_FORWARDING_BARREL = ['subAgentSpawner.js', 'agent/agentLifecycle.js'];

describe('server/services — static import graph (#5693)', () => {
  const graph = buildStaticImportGraph(SERVICES_DIR);
  const read = sourceReader(SERVICES_DIR);
  const backEdgeRules = noBackEdgeRules(graph);

  it('sees the whole services graph and every module a rule names', () => {
    // Every rule here is a negative, so a resolver gap or a renamed module would
    // read as a clean sweep. Pin the scale and the names first.
    expect(graph.size, 'services graph looks empty — did the scan root move?').toBeGreaterThan(500);
    expect([...graph.values()].filter(deps => deps.length > 0).length,
      'no module has any resolved edge — the specifier resolver is broken').toBeGreaterThan(100);
    expect(promptSectionsOf(graph).length, 'prompt section extraction is missing').toBeGreaterThan(5);
    const named = [
      ...backEdgeRules.flatMap(({ from, to }) => [...from, ...(to === ANY ? [] : to)]),
      ...NO_DEFERRED_IMPORT.flatMap(({ from, to }) => [from, to]),
      ...NO_FORWARDING_BARREL, FACADE, 'cos/cos.js',
    ];
    expect([...new Set(named)].filter(file => !graph.has(file)), 'a rule names a module that no longer exists').toEqual([]);
  });

  it('closes no static import cycle anywhere', () => {
    const report = cycleReport(graph);
    expect(report, [
      'static import cycle in server/services:',
      ...report,
      '',
      'Break the cycle — import the module that DECLARES the symbol, not the barrel that',
      'forwards it. Deferring the import with `await import()` hides it from this guard',
      'without removing the boot-order hazard, so it is not a fix.',
    ].join('\n')).toEqual([]);
  });

  it('keeps every leaf free of its forbidden back-edges', () => {
    const violations = backEdgeViolations(graph, backEdgeRules);
    const why = backEdgeRules.filter(rule => backEdgeViolations(graph, [rule]).length).map(rule => rule.why);
    expect(violations, `forbidden back-edge(s):\n${violations.join('\n')}\n\n${why.join('\n')}`).toEqual([]);
  });

  it('dodges no cycle with a deferred import', () => {
    const offenders = NO_DEFERRED_IMPORT.filter(({ from, to }) => importsDynamically(read, from, to))
      .map(({ from, to, why }) => `${from} defer-imports ${to}: ${why}`);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the former barrels declaring what they export (#3450)', () => {
    for (const mod of NO_FORWARDING_BARREL) {
      const forwarded = forwardedExports(SERVICES_DIR, read, mod);
      expect(forwarded,
        `${mod} must declare what it exports — ${forwarded.join(', ')} is forwarded from another module; import it from the one that defines it`
      ).toEqual([]);
    }
  });

  it('keeps the agentOrchestrator facade outside the graph it fronts (#3450)', () => {
    const offenders = facadeBackEdges(graph, read, FACADE);
    expect(offenders, `${FACADE} must not be imported by ${offenders.join(', ')}`).toEqual([]);
  });

  // What the facade re-exports out of `source`, as `{ declared, exposedAs }` —
  // the two sides of an `a as b` re-export. A renamed export's public name exists
  // ONLY on the facade, so the facade is its one legitimate source.
  const reexportedPairs = (source) => {
    const relativeSource = posix.relative(posix.dirname(FACADE), source);
    const specifier = relativeSource.startsWith('.') ? relativeSource : `./${relativeSource}`;
    const block = read(FACADE).match(new RegExp(
      String.raw`export\s*\{([^}]*)\}\s*from\s*['"]${specifier.replace(/\./g, '\\.')}['"]`));
    expect(block, `facade no longer re-exports from ${source} — did the layering change?`).toBeTruthy();
    return block[1]
      .replace(/\/\/[^\n]*/g, '')
      .split(',')
      .map(entry => entry.split(/\s+as\s+/).map(part => part.trim()))
      .filter(([declared]) => declared)
      .map(([declared, exposedAs]) => ({ declared, exposedAs: exposedAs || declared }));
  };
  const reexportedFrom = (source) => reexportedPairs(source).map(pair => pair.declared);

  it('keeps process-layer transitions off cos.js and subAgentSpawner.js (#3450)', () => {
    // `cos.js` re-exporting pause/kill/stats is what gave the old state-layer
    // forwarders their callers. The forbidden names are derived from the facade
    // (everything it takes from the process layer, minus what it ALSO serves
    // from the state layer, which cos.js is right to export), and checked
    // against each module's REAL export surface, so a declared wrapper of the
    // same name fails as surely as a re-export.
    const stateLayer = new Set(reexportedFrom('cos/cosAgentLifecycle.js'));
    const forbidden = reexportedFrom('agent/agentManagement.js').filter(name => !stateLayer.has(name));
    expect(forbidden.length, 'derived nothing to forbid — check the facade export blocks').toBeGreaterThan(0);
    for (const barrel of ['cos/cos.js', 'subAgentSpawner.js']) {
      const exported = staticExportNames(join(SERVICES_DIR, barrel));
      expect(exported, `${barrel} exports nothing — did the parse fail?`).not.toEqual([]);
      const leaked = forbidden.filter(name => exported.includes(name));
      expect(leaked, `${barrel} must not export ${leaked.join(', ')} — process-layer transitions come from the facade`).toEqual([]);
    }
  });

  it('makes every transition caller name the facade or the defining module, never a barrel (#3450)', () => {
    // ONE address per transition: above the facade's closure that address is
    // the facade; inside it (agentManagement / agentLifecycle and the leaves
    // they call, which can never import the facade), the declaring module.
    // Derived from the facade's export blocks, so a new transition is guarded
    // the moment it lands there.
    const declaringModules = ['agent/agentManagement.js', 'cos/cosAgentLifecycle.js', 'agent/agentLifecycle.js'];
    const declaredBy = new Map(); // transition name → the modules allowed to serve it
    const allow = (name, source) => {
      if (!declaredBy.has(name)) declaredBy.set(name, new Set());
      declaredBy.get(name).add(source);
    };
    for (const source of declaringModules) {
      for (const { declared, exposedAs } of reexportedPairs(source)) {
        allow(declared, source);
        // Registering the alias stops a barrel re-exporting it past a map keyed on the declared name.
        if (exposedAs !== declared) allow(exposedAs, FACADE);
      }
    }
    expect(declaredBy.size, 'derived no transitions — check the facade export blocks').toBeGreaterThan(3);

    // A FORWARDER is any module that re-exports its way to a declaring module,
    // at any depth. Walking re-export edges rather than listing barrels covers a
    // new barrel the day it is written. Memoized: every module is a BFS start.
    const edgeCache = new Map();
    const reexportEdges = (file) => {
      if (!edgeCache.has(file)) {
        edgeCache.set(file, [
          ...read(file).matchAll(/export\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/g),
        ].map(m => relative(SERVICES_DIR, resolve(dirname(join(SERVICES_DIR, file)), m[1]))));
      }
      return edgeCache.get(file);
    };
    const forwarders = new Set();
    for (const file of graph.keys()) {
      if (file === FACADE || declaringModules.includes(file)) continue;
      const seen = new Set([file]);
      const queue = [file];
      while (queue.length) {
        for (const target of reexportEdges(queue.pop())) {
          if (seen.has(target) || !graph.has(target)) continue;
          if (declaringModules.includes(target)) { forwarders.add(file); queue.length = 0; break; }
          seen.add(target);
          queue.push(target);
        }
      }
    }
    expect([...forwarders].sort(), 'a barrel forwards a transition again — import the declaring module instead')
      .toEqual([]);

    // Production sources only: a test mirrors whatever its subject imports.
    const allowed = new Set([FACADE, ...declaringModules]);
    const offenders = [];
    for (const file of graph.keys()) {
      if (file === FACADE) continue;
      const src = read(file);
      const resolveSpec = (spec) => relative(SERVICES_DIR, resolve(dirname(join(SERVICES_DIR, file)), spec));

      // Named imports: the binding's LEFT side is the transition name.
      for (const [, names, spec] of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const target = resolveSpec(spec);
        if (allowed.has(target)) continue;
        for (const entry of names.split(',')) {
          const name = entry.split(/\s+as\s+/)[0].trim();
          if (!declaredBy.has(name) || declaredBy.get(name).has(target)) continue;
          offenders.push(`${file} imports ${name} from ${target}`);
        }
      }

      // DEFERRED forms, invisible to the static graph but this cluster's old
      // habit (`const { completeAgent } = await import('./cos/cos.js')`). In a
      // destructure the LEFT of `a: b` is the exported name. Skip the scans for
      // the majority of modules with no `import(` at all.
      const hasDeferredImport = /\bimport\s*\(/.test(src);
      for (const [, names, spec] of hasDeferredImport ? src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g) : []) {
        const target = resolveSpec(spec);
        if (allowed.has(target)) continue;
        for (const entry of names.split(',')) {
          const name = entry.split(':')[0].trim();
          if (!declaredBy.has(name) || declaredBy.get(name).has(target)) continue;
          offenders.push(`${file} defer-imports ${name} from ${target}`);
        }
      }
      // `(await import('./cos/cos.js')).completeAgent`, and its `?.` / `['name']` twins.
      for (const [, spec, dotted, bracketed] of hasDeferredImport ? src.matchAll(
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)[\s)]*(?:\?)?(?:\.\s*(\w+)|\.?\s*\[\s*['"`](\w+)['"`]\s*\])/g) : []) {
        const name = dotted || bracketed;
        const target = resolveSpec(spec);
        if (allowed.has(target) || !declaredBy.has(name) || declaredBy.get(name).has(target)) continue;
        offenders.push(`${file} defer-imports ${name} from ${target}`);
      }

      // HANDLES onto a forwarder (`import * as cos` / `const cos = await import(…)`):
      // banning the handle is too blunt, so check both ways a transition comes
      // back off it — a property read (dot, `?.`, `['name']`) and a destructure.
      const handles = [
        ...src.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*['"]([^'"]+)['"]/g),
        ...(hasDeferredImport ? src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g) : []),
      ];
      for (const [, ns, spec] of handles) {
        const target = resolveSpec(spec);
        if (!forwarders.has(target)) continue;
        for (const name of declaredBy.keys()) {
          const reached = new RegExp(
            String.raw`\b${ns}\s*(?:\?)?(?:\.\s*${name}\b|\.?\s*\[\s*['"\`]${name}['"\`]\s*\])`).test(src)
            || new RegExp(String.raw`\{[^}]*\b${name}\b[^}]*\}\s*=\s*(?:await\s+)?${ns}\b`).test(src);
          if (reached) offenders.push(`${file} reaches ${name} through the forwarder ${target}`);
        }
      }
    }
    expect(offenders.sort(),
      `a transition must come from the facade or the module that declares it:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});

describe('each rule fails on the violation it exists for (fixture tree)', () => {
  const tempRoots = [];
  afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  const fixture = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'portos-import-cycles-'));
    tempRoots.push(root);
    for (const [file, src] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), src);
    }
    return { root, graph: buildStaticImportGraph(root), read: sourceReader(root) };
  };

  it('detects cycles in a hand-built graph, and nothing in an acyclic one', () => {
    // Without this, a detector that always returned [] would pass the zero-cycle assertion forever.
    const cyclic = new Map([['a.js', ['b.js']], ['b.js', ['c.js']], ['c.js', ['a.js']], ['leaf.js', ['a.js']]]);
    expect(findImportCycleComponents(cyclic)).toEqual([['a.js', 'b.js', 'c.js']]);
    expect(findImportCycleComponents(new Map([['a.js', ['b.js']], ['b.js', []]]))).toEqual([]);
    // A self-import is a cycle of one; the members-length test is all that separates it from every acyclic singleton.
    expect(findImportCycleComponents(new Map([['a.js', ['a.js']]]))).toEqual([['a.js']]);
  });

  it('fails an introduced cycle routed through a subdirectory, but not the deferred form', () => {
    const { graph } = fixture({
      'barrel.js': "export { goal } from './leaf/goals.js';\n",
      'leaf/goals.js': "import { other } from '../barrel.js';\nexport const goal = 1;\n",
      'clean.js': "export const x = await import('./clean2.js');\n",
      'clean2.js': "import './clean.js';\n",
    });
    expect(cycleReport(graph)[0]).toBe('barrel.js + leaf/goals.js');
    expect(cycleReport(graph).some(line => line.includes('clean'))).toBe(false);
  });

  it('fails a back-edge into a leaf, and an import-free leaf that grows any import', () => {
    const { graph } = fixture({
      'orchestrator.js': "import './leaf.js';\n",
      'leaf.js': "import { a } from './orchestrator.js';\n",
      'state.js': "import { b } from './unrelated.js';\n",
      'unrelated.js': 'export const b = 1;\n',
      'okLeaf.js': "import { b } from './unrelated.js';\n",
    });
    const rules = [{ from: ['leaf.js', 'okLeaf.js'], to: ['orchestrator.js'] }, { from: ['state.js'], to: ANY }];
    expect(backEdgeViolations(graph, rules)).toEqual(['leaf.js -> orchestrator.js', 'state.js -> unrelated.js']);
  });

  it('fails a re-export barrel in every syntax, and passes a module that declares its exports', () => {
    const { root, read } = fixture({
      'x.js': 'export const x = 1;\nexport function y() {}\nexport const z = 3;\n',
      'barrel.js': "export { x } from './x.js';\nexport * from './x.js';\nimport { z } from './x.js';\nexport { z };\nexport const own = 1;\n",
      'honest.js': "import { x } from './x.js';\nexport const own = x;\nexport async function run() {}\n",
    });
    expect(forwardedExports(root, read, 'barrel.js')).toEqual(['x', 'y', 'z']);
    expect(forwardedExports(root, read, 'honest.js')).toEqual([]);
  });

  it('fails a facade imported back from inside its closure, statically or deferred', () => {
    const { graph, read } = fixture({
      'facade.js': "import './inner.js';\nimport './deferring.js';\n",
      'inner.js': "import { f } from './facade.js';\n",
      'deferring.js': "export const load = () => import ( './facade.js' );\n",
      'outside.js': "import './facade.js';\n",
    });
    expect(facadeBackEdges(graph, read, 'facade.js')).toEqual(['deferring.js', 'inner.js']);
  });

  it('fails a deferred import of a banned module in any spelling', () => {
    const { read } = fixture({
      'a.js': "const m = await import(`./sub/target.js`);\n",
      'sibling/b.js': "export const go = () => import(/* lazy */ '../sub/target.js').then(m => m.go());\n",
      'c.js': "import { go } from './sub/target.js';\n",
      'other.js': "const m = await import('./target.js');\n",
    });
    expect(['a.js', 'sibling/b.js', 'c.js', 'other.js'].map(file => importsDynamically(read, file, 'sub/target.js')))
      .toEqual([true, true, false, false]);
  });
});
