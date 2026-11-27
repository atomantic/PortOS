import { describe, it, expect } from 'vitest';
import { collectServerSources, readServerSource } from '../../guardSources.js';

// Source invariant. The whole point of this module is that the next env-level
// concern is a ONE-file change — which only holds if no spawn site quietly
// rebuilds the tuple by hand again. Three separate fixes (the OpenCode models
// map, the CLAUDECODE strip, the PWD pin) each had to sweep every site because
// nothing failed when one was missed.
//
// Deliberately DISCOVERS the offenders rather than listing the known call sites:
// an allowlist of "these files must call the builder" passes the day someone
// adds a ninth spawn site, which is exactly when the guard needs to fire.
describe('no spawn site rebuilds the CLI child env by hand', () => {
  // Files allowed to compose the tuple themselves, each with the reason.
  const EXEMPT = new Map([
    ['lib/cliChildEnv.js', 'this module IS the shared composer'],
    // Worth stating both halves: the import constraint is why it cannot call the
    // composer, and the dormancy is why its missing CLAUDECODE strip / OpenCode
    // map is not a live PortOS gap someone needs to chase.
    ['lib/aiToolkit/internal/cliExecutor.js', 'vendored toolkit — must not import out to other PortOS modules, and its spawn is dormant under PortOS\'s setCliRunner override'],
    // `providerCatalogService.js`'s Codex probe moved its spawn into this leaf
    // (#8497) so a host caller with no toolkit `provider` record — the
    // Harnesses page refresh in `services/harnesses.js` — can drive the same
    // JSON-RPC handshake; the file that now spreads `provider.envVars` next to
    // a `spawn(` call is this one, not `providerCatalogService.js`.
    ['lib/aiToolkit/internal/codexModelListProbe.js', 'vendored toolkit catalog probe — must not import out to other PortOS modules'],
  ]);

  // Two independent markers, because either one alone has a blind spot: a new
  // site could strip CLAUDECODE without spreading provider.envVars, or spread
  // provider.envVars while forgetting the strip (which is itself the bug).
  //
  // Marker A — the CLAUDECODE strip. Crisp: every path that runs a coding CLI
  // strips it, and nothing else in the tree does.
  const STRIPS_CLAUDECODE = /delete\s+[A-Za-z_$][\w$]*\.CLAUDECODE\b/;

  // Marker B — a `provider.envVars` spread that reaches a child process.
  //
  // Keyed on the spread + the handoff, NOT on a `...process.env` base. An
  // earlier draft anchored on the base env and had to be widened once already
  // (for cliProviderRun's `baseEnv` parameter name) — and it still could not see
  // the two sites that compose a DELTA someone else bases: agentLifecycle's
  // runner payload and agentTuiSpawning's shell overlay, which is exactly where
  // the OpenCode sweep was missed once before. Requiring only the spread and a
  // nearby handoff catches both shapes.
  //
  // The handoff requirement is what separates a real child env from the two
  // shapes that merge the same objects for a different purpose and correctly
  // need none of this: a model-id LOOKUP env (`resolveBedrockCliModel({ env })`,
  // `resolveWindowsExecutable(…, searchEnv)`) and a capability PROBE
  // (`agy models`, `--version`) — neither runs a model, writes files, nor has a
  // workspace to be misrouted into.
  //
  // A window rather than a parser, sized from the real tree: the widest real gap
  // is ~1400 chars (agentTuiSpawning's `env:` overlay sits that far below its
  // `createShellSession(`, behind a long comment block), so the back-window is
  // 1500. Verified empirically — at 1500 the only files flagged across all of
  // `server/` are the two EXEMPT ones, and every pre-refactor hand-rolled site
  // is caught. Over-matching costs one EXEMPT line; under-matching silently
  // reopens the N-file sweep, so the bias is deliberate.
  //
  // The optional `(` in the spread pattern matters: `...(provider.envVars || {})`
  // is the shape two sites use, and a pattern without it reads them as clean.
  const HANDS_OFF_TO_CHILD = /\b(?:spawn|ptySpawn|spawnImpl|pty\.spawn|createShellSession|spawnAgentViaRunner)\s*\(|\benvVars:/;
  const SPREADS_PROVIDER_ENV_INTO_SPAWN = (src) => {
    for (const m of src.matchAll(/\.\.\.\s*\(?\s*[A-Za-z_$][\w$]*\??\.envVars\b/g)) {
      if (HANDS_OFF_TO_CHILD.test(src.slice(Math.max(0, m.index - 1500), m.index + 900))) return true;
    }
    return false;
  };

  const isOffender = (src) => STRIPS_CLAUDECODE.test(src) || SPREADS_PROVIDER_ENV_INTO_SPAWN(src);
  const offenders = () => collectServerSources()
    .filter((rel) => !EXEMPT.has(rel) && isOffender(readServerSource(rel)));

  it('finds the exempt files (guard is not vacuous)', () => {
    // If the markers stop matching even the composer itself, the scan broke and
    // the assertion below would pass for the wrong reason.
    for (const rel of EXEMPT.keys()) {
      expect(
        isOffender(readServerSource(rel)),
        `${rel} no longer matches either marker — the scan broke`,
      ).toBe(true);
    }
  });

  it('every AI-CLI spawn composes its child env through buildCliChildEnv', () => {
    expect(
      offenders(),
      'These files build an AI-CLI child environment by hand instead of calling '
      + 'buildCliChildEnv (server/lib/cliChildEnv.js). That is what made the OpenCode '
      + 'models map (#2190), the CLAUDECODE strip, and the PWD pin (#3193) each cost an '
      + 'N-file sweep, with a missed site failing silently. Route the spawn through the '
      + 'shared builder, or add the file to EXEMPT above with the reason it must not.',
    ).toEqual([]);
  });
});
