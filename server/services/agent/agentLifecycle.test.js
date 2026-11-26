import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_LIFECYCLE_SRC = readFileSync(join(__dirname, 'agentLifecycle.js'), 'utf-8');
const AGENT_SPAWN_PREPARATION_SRC = readFileSync(join(__dirname, 'agentSpawnPreparation.js'), 'utf-8');
const AGENT_SPAWN_DISPATCH_SRC = readFileSync(join(__dirname, 'agentSpawnDispatch.js'), 'utf-8');
const AGENT_REGISTRATION_SRC = readFileSync(join(__dirname, '../../lib/agent/agentRegistrationRecord.js'), 'utf-8');

// The preparation harness stubs instance identity resolution at the leaf.
// The spawn harnesses do not exercise the full persisted UI projection.
describe('agent identity and public-review projection', () => {
  it('imports the identity resolver from the instance identity leaf', () => {
    expect(AGENT_SPAWN_PREPARATION_SRC).toMatch(
      /import\s*\{\s*ensureInstanceId\s*\}\s*from\s*'\.\.\/instanceIdentity\.js';/
    );
  });

  it('stamps instanceId into the registerAgent metadata', () => {
    expect(AGENT_REGISTRATION_SRC).toMatch(/\binstanceId,/);
    expect(AGENT_REGISTRATION_SRC.indexOf('instanceId,')).toBeLessThan(AGENT_REGISTRATION_SRC.indexOf('workspacePath,'));
  });

  it('projects the public-review posture so the UI can explain the missing shell link', () => {
    // `spawnHeadless` forces a public-review stage headless even on a TUI
    // provider — unless it is the sandboxed-actions stage on a vendor with an
    // attachable recipe (#6062) — so its card usually gets no "Open Shell"
    // link. Without this projection the card cannot tell that apart from a PTY
    // that failed to attach, and the run reads as wedged.
    expect(AGENT_REGISTRATION_SRC).toMatch(/^\s*publicReviewPosture,$/m);
    // …and the orchestrator still hands it over, so the key cannot go stale.
    expect(AGENT_SPAWN_DISPATCH_SRC).toMatch(/^\s*publicReviewPosture,$/m);
  });
});

// These used to be three source-regex assertions pinning a hand-spread env
// literal (`...forgeTokenEnv, ...provider.envVars, ...opencodeEnv`) inside
// spawnViaRunner. The layering now lives in `lib/cliChildEnv.js#composeProviderEnv`,
// where `cliChildEnv.test.js` asserts the ORDER against the real function instead
// of against source text — which is the point of #3194: a grep-shaped guard was
// what let this exact site miss the #2243/#2190 sweep in the first place.
//
// What is still worth pinning HERE is the wiring: that spawnViaRunner routes
// through the shared composer and feeds it the right inputs.
describe('agentLifecycle — runner OpenCode Ollama env (#2243 / #2190)', () => {
  // Bounded by the NEXT top-level declaration rather than a character count: a
  // fixed window silently shrinks as the function grows a comment, and the
  // assertions below then fail on text that is still there (and would keep
  // passing on a line that had drifted into the following function).
  const runnerBody = () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnViaRunner');
    expect(fnStart, 'spawnViaRunner must exist').toBeGreaterThan(-1);
    const nextExport = AGENT_LIFECYCLE_SRC.indexOf('\nexport ', fnStart + 1);
    return AGENT_LIFECYCLE_SRC.slice(fnStart, nextExport > -1 ? nextExport : undefined);
  };

  it('source: composes the runner envVars through the shared composeProviderEnv', () => {
    expect(AGENT_LIFECYCLE_SRC).toMatch(
      /import\s*\{\s*composeProviderEnv\s*\}\s*from\s*'\.\.\/\.\.\/lib\/cliChildEnv\.js';/
    );
    // The payload must BE the composed env — not a literal that re-spreads it,
    // which is how the layer order drifted from the other spawn sites before.
    expect(runnerBody()).toMatch(/envVars:\s*composeProviderEnv\(\{/);
  });

  it('source: feeds the composer the provider + per-call model so --model ollama/<id> is accepted', () => {
    const fnBody = runnerBody();
    const call = fnBody.slice(fnBody.indexOf('composeProviderEnv({'), fnBody.indexOf('composeProviderEnv({') + 300);
    expect(call, 'the OpenCode declared-models map is built from provider+model').toContain('provider,');
    expect(call).toContain('model,');
  });
});
