/**
 * Regression guard for the agent-lifecycle circular-dependency cluster (#2837).
 *
 * The cluster — agentLifecycle / agentCliSpawning / agentTuiSpawning /
 * agentManagement / subAgentSpawner / cosAgentLifecycle — used to contain two real
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
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative, resolve } from 'path';
import { buildStaticImportGraph, findImportCycles } from '../lib/staticImportGraph.js';

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
  'cosAgentLifecycle.js',
  'agentFinalization.js',
  'agentSummaryExtraction.js',
  'agentRunnerSync.js',
  'agentRunnerOutputBatchers.js',
  'agentOrchestrator.js',
];

// The static-import scan, the services-directory graph build and the cycle walk
// all live in `server/lib/staticImportGraph.js` so this guard and the
// identity/digital-twin one (`twinImportCycles.test.js`) share ONE parser —
// two copies is how a structural guard rots (a fix to one silently
// under-reports in the other). It matches static `import`/`export … from` and
// bare side-effect imports only, never `await import()` (deferred to call time,
// so it can't produce a load-time cycle) and never a specifier inside a comment.
// The walk recurses into subdirectories: a subdirectory module can import back
// up (`agentTuiSpawning/outputSpooler.js` → `../cosAgentLifecycle.js` is a live
// example), so a cycle routed through one subdirectory hop would otherwise be
// invisible here.

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

// What the facade re-exports out of `source`, as `{ declared, exposedAs }` —
// the two sides of `terminateAgent as requestAgentTermination`. `declared` is
// what the defining module calls it; `exposedAs` is the name callers above the
// closure use, which for a renamed export exists ONLY on the facade and so has
// exactly one legitimate source. Both quote styles throughout — `from "./x.js"`
// is valid ESM, and a matcher that only knows `'` reads as green over the exact
// statement it forbids.
//
// One parse shared by every guard that needs the facade's surface, for the same
// reason the static scan lives once in `server/lib/staticImportGraph.js`: two
// copies of a structural matcher is how a guard rots.
const FACADE = 'agentOrchestrator.js';
function reexportedPairs(source) {
  const facade = readFileSync(join(SERVICES_DIR, FACADE), 'utf-8');
  const block = facade.match(new RegExp(
    String.raw`export\s*\{([^}]*)\}\s*from\s*['"]\./${source.replace(/\./g, '\\.')}['"]`));
  expect(block, `facade no longer re-exports from ${source} — did the layering change?`).toBeTruthy();
  return block[1]
    .replace(/\/\/[^\n]*/g, '')       // strip the per-export state-edge comments
    .split(',')
    .map(entry => entry.split(/\s+as\s+/).map(part => part.trim()))
    .filter(([declared]) => declared)
    .map(([declared, exposedAs]) => ({ declared, exposedAs: exposedAs || declared }));
}
const reexportedFrom = (source) => reexportedPairs(source).map(pair => pair.declared);

// Loaders for the modules whose REAL export surface the guards below assert on.
// Spelled out one literal specifier each rather than `import(`./${name}`)` —
// the bundler cannot analyze a fully-variable specifier and warns, and the point
// of reading the live key list is that it is ground truth, so it should not
// depend on runtime path assembly. Every module here is side-effect-free to
// import (their side effects live behind `init()`/`start()`/`initSpawner()`).
const MODULE_LOADERS = {
  'cos.js': () => import('./cos.js'),
  'subAgentSpawner.js': () => import('./subAgentSpawner.js'),
  'agentLifecycle.js': () => import('./agentLifecycle.js'),
};
const exportedNames = async (mod) => Object.keys(await MODULE_LOADERS[mod]());

// Whichever assertion loads first pays for transforming `cos.js`'s whole service
// graph — measured at 5–10s here depending on machine load, i.e. straddling the
// 10s default, which turns a green guard into an intermittent red one that says
// nothing about the invariant. Every `it()` below that calls `exportedNames`
// carries this, not just the one that happens to run first today.
const MODULE_LOAD_TIMEOUT_MS = 60_000;

describe('agent lifecycle cluster — no static import cycles (#2837)', () => {
  const graph = buildStaticImportGraph(SERVICES_DIR);

  it('has no static import cycle touching the agent-lifecycle cluster', () => {
    const offending = findImportCycles(graph).filter(cycle => CLUSTER.some(m => cycle.includes(m)));
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

  it('keeps prompt section modules as leaves under agentPromptBuilder (#4896)', () => {
    const sections = [...graph.keys()].filter(file => file.startsWith('promptSections/'));
    expect(sections.length, 'prompt section extraction is missing').toBeGreaterThan(5);

    const backEdges = sections.filter(file => (graph.get(file) || []).includes('agentPromptBuilder.js'));
    expect(backEdges, `prompt sections must not import agentPromptBuilder.js: ${backEdges.join(', ')}`).toEqual([]);

    const sectionCycles = findImportCycles(graph).filter(cycle => sections.some(file => cycle.split(' -> ').includes(file)));
    expect(sectionCycles, `prompt section cycle(s) introduced:\n${sectionCycles.join('\n')}`).toEqual([]);
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

  it('no longer needs the state-layer forwarders into the process layer (#3450)', async () => {
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
    // Both quote styles throughout — `from "./x.js"` is valid ESM, and a matcher
    // that only knows `'` reads as green over the exact statement it forbids.
    const stateLayer = new Set(reexportedFrom('cosAgentLifecycle.js'));
    const forbidden = reexportedFrom('agentManagement.js').filter(name => !stateLayer.has(name));
    expect(forbidden.length, 'derived nothing to forbid — check the facade export blocks').toBeGreaterThan(0);

    // Then assert against each barrel's REAL export surface, not its source
    // text. Every regex for this was bypassable by a form it did not anticipate
    // — a second re-export statement, a different source module, double quotes,
    // `export *`, `import` + a bare `export { … }` with no `from` at all. The
    // module's own key list is ground truth and has no syntax to outrun.
    //
    // `subAgentSpawner.js` joined this loop in #3450. It used to be excluded on
    // purpose — it re-exported the same three transitions as its back-compat
    // barrel, so the rule could only be stated for `cos.js`. With that barrel
    // retired the rule generalizes, which is the point of having retired it.
    for (const barrel of ['cos.js', 'subAgentSpawner.js']) {
      const barrelExports = await exportedNames(barrel);
      expect(barrelExports, `${barrel} exports nothing — did the import fail?`).not.toEqual([]);
      for (const name of forbidden) {
        expect(barrelExports, `${barrel} must not re-export ${name} — it is a process-layer transition, ask the facade`)
          .not.toContain(name);
      }
    }
  }, MODULE_LOAD_TIMEOUT_MS);

  it('keeps the cluster orchestrators from re-growing a re-export barrel (#3450)', async () => {
    // `subAgentSpawner.js` re-exported ~40 symbols from nine siblings, and
    // `agentLifecycle.js` re-exported the leaves that had been extracted out of
    // it for that barrel to forward. So "where does finalizeAgent live" had
    // three answers, and a caller could reach a transition through a module that
    // merely forwards it. Both surfaces are gone; this keeps them gone.
    //
    // Stated as "every export is DECLARED here", which is the only form that
    // survives contact with the syntax: `export *`, `export { x } from …`, and
    // `import` + a bare `export { x }` all fail it identically, and so does a
    // re-export from a module this test has never heard of. The real key list is
    // ground truth for what is exported; the source scan only answers what is
    // declared, and if that scan ever misses a legitimate local declaration the
    // test fails LOUD rather than going green over a live re-export.
    for (const mod of ['subAgentSpawner.js', 'agentLifecycle.js']) {
      const src = readFileSync(join(SERVICES_DIR, mod), 'utf-8');
      const declared = new Set(
        [...src.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)]
          .map(m => m[1])
      );
      const actual = await exportedNames(mod);
      expect(actual, `${mod} exports nothing — did the import fail?`).not.toEqual([]);
      const forwarded = actual.filter(name => !declared.has(name)).sort();
      expect(forwarded,
        `${mod} must declare what it exports — ${forwarded.join(', ')} is forwarded from another module; import it from the one that defines it`
      ).toEqual([]);
    }
  }, MODULE_LOAD_TIMEOUT_MS);

  it('makes every transition caller name the facade or the defining module, never a barrel (#3450)', () => {
    // Step 3 of the #3450 sequencing, for the callers the "move the caller out"
    // recipe cannot reach. `agentManagement.js` and `agentLifecycle.js` DEFINE
    // transitions the facade re-exports, and `agentFinalization.js` /
    // `agentCliSpawning.js` are leaves those two must call — all four sit inside
    // the facade's closure permanently, so importing the facade is a cycle, not
    // an option. What is still achievable there is the property the facade was
    // built for: ONE address per transition. Above the closure that address is
    // the facade; inside it, the module that declares the function. A barrel is
    // never an answer — that is the third address this sequencing keeps deleting.
    //
    // Derived from the facade's own export blocks, so a transition added there
    // is guarded the moment it lands and `agentOrchestrator.js` stays the only
    // file anyone edits to change the rule.
    const declaringModules = ['agentManagement.js', 'cosAgentLifecycle.js', 'agentLifecycle.js'];
    const declaredBy = new Map(); // transition name → the modules allowed to serve it
    const allow = (name, source) => {
      if (!declaredBy.has(name)) declaredBy.set(name, new Set());
      declaredBy.get(name).add(source);
    };
    for (const source of declaringModules) {
      for (const { declared, exposedAs } of reexportedPairs(source)) {
        allow(declared, source);
        // A RENAMED export (`terminateAgent as requestAgentTermination`) has a
        // public name that exists nowhere but the facade, so the facade is its
        // only legitimate source. Registering it is what stops a barrel from
        // re-exporting the alias and slipping past a map keyed on `terminateAgent`.
        if (exposedAs !== declared) allow(exposedAs, FACADE);
      }
    }
    // `terminateAgent` lands in two declaring modules: the process-side one and
    // the state-side one the facade renames. Both are real definitions, so both
    // stay allowed — the rule here is "not a barrel", and that collision is a
    // naming question the facade already answered.
    expect(declaredBy.size, 'derived no transitions — check the facade export blocks').toBeGreaterThan(3);
    expect([...declaredBy.keys()], 'the facade rename is no longer covered — check reexportedPairs')
      .toContain('requestAgentTermination');

    // A FORWARDER is any module that re-exports its way to a declaring module, at
    // any depth: `cos.js` is one hop (`export { … } from './cosAgentLifecycle.js'`).
    // It used to be two, through the `cosAgents.js` barrel that sat between them;
    // that barrel is retired (#3450), leaving `cos.js`'s agent re-export block as
    // the last forwarder. Walking the re-export edges instead of listing the
    // barrels means a NEW barrel is covered the day it is written. Asserted
    // rather than merely computed, so collapsing this last one has to come here
    // and say so.
    const reexportEdges = (file) => [
      ...readFileSync(join(SERVICES_DIR, file), 'utf-8')
        .matchAll(/export\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/g)
    ].map(m => relative(SERVICES_DIR, resolve(dirname(join(SERVICES_DIR, file)), m[1])));

    const forwarders = new Set();
    for (const file of graph.keys()) {
      if (file === FACADE || declaringModules.includes(file)) continue; // both are answers, not forwarders
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
    expect([...forwarders].sort(), 'the set of barrels still forwarding a transition changed — intended?')
      .toEqual(['cos.js']);

    // Production sources only. A test mirrors whatever its subject imports (a
    // mock pointed at a module the subject no longer imports silently stops
    // applying), so tests follow this rule rather than defining it.
    const allowed = new Set([FACADE, ...declaringModules]);
    const offenders = [];
    for (const file of graph.keys()) {
      if (file === FACADE) continue;
      const src = readFileSync(join(SERVICES_DIR, file), 'utf-8');
      const resolveSpec = (spec) => relative(SERVICES_DIR, resolve(dirname(join(SERVICES_DIR, file)), spec));

      // Named imports — `import { completeAgent as done } from './cos.js'`. The
      // binding's LEFT side is the transition name; renaming it on the way in
      // does not change where it came from.
      for (const [, names, spec] of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const target = resolveSpec(spec);
        if (allowed.has(target)) continue;
        for (const entry of names.split(',')) {
          const name = entry.split(/\s+as\s+/)[0].trim();
          if (!declaredBy.has(name) || declaredBy.get(name).has(target)) continue;
          offenders.push(`${file} imports ${name} from ${target}`);
        }
      }

      // DEFERRED forms. `await import()` is invisible to the static graph — by
      // design, it cannot produce a load-time cycle — but reaching across a
      // blocked layer with one is this cluster's whole habit, and the exact
      // pattern this PR deleted from `cleanupOrphanedAgents` was
      // `const { completeAgent } = await import('./cos.js')`. A guard that only
      // reads static syntax would go green the day someone writes it again.
      // In a destructure the LEFT of `a: b` is the exported name, same role `as`
      // plays in a static import.
      for (const [, names, spec] of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const target = resolveSpec(spec);
        if (allowed.has(target)) continue;
        for (const entry of names.split(',')) {
          const name = entry.split(':')[0].trim();
          if (!declaredBy.has(name) || declaredBy.get(name).has(target)) continue;
          offenders.push(`${file} defer-imports ${name} from ${target}`);
        }
      }
      // `(await import('./cos.js')).completeAgent` — the same reach, one step
      // shorter. `?.` and `['name']` are the same property read to the engine,
      // so a matcher that only knows the dot reads green over both.
      for (const [, spec, dotted, bracketed] of src.matchAll(
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)[\s)]*(?:\?)?(?:\.\s*(\w+)|\.?\s*\[\s*['"`](\w+)['"`]\s*\])/g)) {
        const name = dotted || bracketed;
        const target = resolveSpec(spec);
        if (allowed.has(target) || !declaredBy.has(name) || declaredBy.get(name).has(target)) continue;
        offenders.push(`${file} defer-imports ${name} from ${target}`);
      }

      // HANDLES onto a whole module — `import * as cos from './cos.js'` and its
      // deferred twin `const cos = await import('./cos.js')`. Neither names a
      // binding, so the loops above cannot see them, yet each hands the caller
      // every transition the barrel forwards. Banning the handle outright is too
      // blunt (that is how a dozen modules reach the task store, which is not
      // this issue's business), so check the two ways a transition comes back
      // OFF it: a property read and a destructure. Both, because either one
      // alone reads green over the other — and the property read covers `?.`
      // and `['name']` alongside the dot, since all three compile to the same
      // access and a dot-only matcher waves the other two straight through.
      const handles = [
        ...src.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*['"]([^'"]+)['"]/g),
        ...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
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

  it('keeps cos.js out of every static import cycle (#5684)', () => {
    // cos.js re-exports cosState/cosTaskStore for backward compat with
    // `import * as cos`. Two leaf services used to reach THROUGH that barrel for
    // one symbol each (memoryEmbeddings -> getConfig, character -> getAllTasks),
    // and because cos.js transitively reaches the CoS tool registry -> voice
    // tools -> askService -> both of those leaves, each one-symbol forward closed
    // a 7-module ring. Both now import the DECLARING module, which is the same
    // rule the transition-caller guard above enforces for the agent cluster.
    const offending = findImportCycles(graph).filter(cycle => cycle.split(' -> ').includes('cos.js'));
    expect(offending, `cos.js is back in a static import cycle:\n${offending.join('\n')}`).toEqual([]);

    // Name the two back-edges directly, so a reintroduced one-symbol import of
    // the barrel fails with the reason rather than as an opaque ring.
    expect(graph.get('memoryEmbeddings.js'), 'memoryEmbeddings must import getConfig from cosState.js').not.toContain('cos.js');
    expect(graph.get('memoryEmbeddings.js')).toContain('cosState.js');
    expect(graph.get('character.js'), 'character must import getAllTasks from cosTaskStore.js').not.toContain('cos.js');
    expect(graph.get('character.js')).toContain('cosTaskStore.js');
  });

  it('no longer needs the dynamic-import workaround for handleOrphanedTask', () => {
    // The cycle-dodge this issue was filed for: agentLifecycle reached
    // agentManagement via `await import()` because agentManagement imported it back.
    expect(importsDynamically('agentLifecycle.js', 'agentManagement.js')).toBe(false);
    expect(graph.get('agentLifecycle.js')).toContain('agentManagement.js');
  });
});
