/**
 * Source-level wiring invariants for the agent-lifecycle orchestrators.
 *
 * The guard primitives' behavior (withSpawnDedupGuard, withRunnerAgentCleanup,
 * withUpdateInProgressGuard) is tested in agentGuards.test.js; spawn gating and
 * block-and-bail behavior in the sibling agentLifecycle.*.test.js suites. What
 * stays here are the orderings inside the large orchestrators that have no
 * behavioral seam, plus the check that they delegate to the extracted guards.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_LIFECYCLE_SRC = readFileSync(join(__dirname, 'agentLifecycle.js'), 'utf-8');
const AGENT_SPAWN_PREPARATION_SRC = readFileSync(join(__dirname, 'agentSpawnPreparation.js'), 'utf-8');
const AGENT_SPAWN_DISPATCH_SRC = readFileSync(join(__dirname, 'agentSpawnDispatch.js'), 'utf-8');
const AGENT_SPAWN_OWNER_SRC = `${AGENT_SPAWN_PREPARATION_SRC}\n${AGENT_SPAWN_DISPATCH_SRC}`;
// The registerAgent projection — agent.metadata is a hand-picked map of
// task.metadata — moved out of the orchestrator with the same change (#6617).
// The projection-CONTENT guards below follow it; the ORDERING guards (claim
// before register, identity before register) stay on the orchestrator.
const AGENT_REGISTRATION_SRC = readFileSync(join(__dirname, '../../lib/agent/agentRegistrationRecord.js'), 'utf-8');

// ─── Wiring invariants: the orchestrators delegate to the guards ────────────
//
// The behavioral tests in agentGuards.test.js cover the guards themselves; these source
// checks pin that spawnAgentForTask / handleAgentCompletion actually route
// their guard/cleanup through the extracted helpers, so a refactor that
// re-inlines a hand-rolled try/finally (and re-opens the race) fails loudly.

describe('agentLifecycle — guard wiring', () => {
  it('spawnAgentForTask delegates the dedup guard to withSpawnDedupGuard(runAgentSpawn)', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    expect(idx, 'spawnAgentForTask must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 1200);
    expect(body).toMatch(
      /withSpawnDedupGuard\(\s*spawningTasks\s*,\s*task\.id\s*,\s*\(\)\s*=>\s*runAgentSpawn\(task\)\s*\)/
    );
    // The dedup-skip sentinel is honored (returns null to the caller).
    expect(body).toMatch(/SPAWN_DEDUP_SKIP/);
  });

  // Issue #4124: `/api/update/execute` refuses to start while an agent is live,
  // but `update.sh` then runs git pull / submodule update / npm install for
  // seconds before `pm2 delete`. This is the last-line gate for a spawn landing
  // in THAT window.
  it('spawnAgentForTask wraps the spawn in withUpdateInProgressGuard(isUpdateInProgress)', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('export async function spawnAgentForTask');
    expect(idx, 'spawnAgentForTask must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 1200);
    expect(body).toMatch(/withUpdateInProgressGuard\(\s*isUpdateInProgress\s*,/);
    expect(body).toMatch(/SPAWN_UPDATE_SKIP/);
    // The synchronous mirror, not a re-implemented disk read.
    expect(AGENT_LIFECYCLE_SRC).toMatch(/import \{ isUpdateInProgress \} from '\.\.\/updateChecker\.js'/);
  });
});

// ─── Coverage guard for the self-update spawn gate (issue #4124) ────────────
//
// The gate is argued to cover EVERY path that can start an agent because those
// paths funnel through exactly two chokepoints: `task:ready` → subAgentSpawner's
// listener → `spawnAgentForTask` → one of the three low-level spawn helpers.
// Gating fewer files than "every spawn engine" is only sound while that funnel
// holds, so pin it: a new direct caller of `spawnAgentForTask` or of a spawn
// helper would bypass the gate and must fail here rather than in production.

describe('self-update spawn gate — funnel coverage (#4124)', () => {
  const SERVICES_DIR = dirname(__dirname);

  it('subAgentSpawner holds the dispatch on the synchronous update flag', () => {
    const src = readFileSync(join(SERVICES_DIR, 'subAgentSpawner.js'), 'utf-8');
    expect(src).toMatch(/import \{ isUpdateInProgress \} from '\.\/updateChecker\.js'/);
    // The dispatch body lives in `handleTaskReady`, the named function the
    // `task:ready` registration wraps in a `.catch` (a plain EventEmitter would
    // otherwise leak an async listener's rejection).
    const idx = src.indexOf('async function handleTaskReady');
    expect(idx, 'the task:ready dispatch must exist').toBeGreaterThan(-1);
    const spawnIdx = src.indexOf('await spawnAgentForTask(task)', idx);
    expect(spawnIdx).toBeGreaterThan(idx);
    // The hold is BEFORE the spawn, and before the (awaited) runner probe — a
    // synchronous check can't be raced by anything in between.
    const preamble = src.slice(idx, spawnIdx);
    expect(preamble).toMatch(/if \(isUpdateInProgress\(\)\) \{\s*return holdTask\(task,/);
    expect(preamble.indexOf('isUpdateInProgress()')).toBeLessThan(preamble.indexOf('isRunnerReachable()'));
  });

  it('handleAgentCompletion delegates runnerAgents cleanup to withRunnerAgentCleanup', () => {
    const idx = AGENT_LIFECYCLE_SRC.indexOf('export async function handleAgentCompletion');
    expect(idx, 'handleAgentCompletion must exist').toBeGreaterThan(-1);
    const body = AGENT_LIFECYCLE_SRC.slice(idx, idx + 60_000);
    expect(body).toMatch(/withRunnerAgentCleanup\(\s*agentId\s*,/);
  });

});
// ─── Non-negotiable orderings inside runAgentSpawn (no behavioral seam) ──────
//
// These pin control-flow orderings that live inside the ~470-LOC guarded spawn
// body and can't be reached without mocking its 40+ imports. Anchored on
// `runAgentSpawn` (the guarded body extracted from spawnAgentForTask, #2548).

const RUN_SPAWN_BODY = AGENT_SPAWN_OWNER_SRC;

describe('runAgentSpawn source — handedOff pre-spawn vs post-handoff split', () => {
  it('uses a mutable handedOff flag to distinguish the two failure modes', () => {
    expect(AGENT_SPAWN_PREPARATION_SRC).toMatch(/handedOff:\s*false/);
    expect(AGENT_LIFECYCLE_SRC).toMatch(/context\.handedOff/);
    expect(AGENT_LIFECYCLE_SRC).toMatch(/if\s*\(!context\.setupCatchArmed\s*\|\|\s*context\.handedOff\)\s*throw\s+err\s*;/);
    expect(AGENT_LIFECYCLE_SRC).toMatch(
      /await context\.blockAndBail\(\{[\s\S]{0,300}?reason: setupError,[\s\S]{0,200}?category: optionRefusal \? PROVIDER_CONFIG_BLOCKED_CATEGORY : 'private-security-setup-failed',/
    );
    expect(AGENT_LIFECYCLE_SRC).toMatch(/job:spawn-failed/);
    expect(AGENT_LIFECYCLE_SRC).toMatch(/task\.metadata\??\.jobId/);
  });

  it('sets handedOff = true BEFORE the first spawn helper invocation', () => {
    const flipIdx = AGENT_SPAWN_DISPATCH_SRC.indexOf('context.handedOff = true');
    expect(flipIdx, '`context.handedOff = true` must exist in dispatchAgentRun').toBeGreaterThan(-1);
    for (const helper of ['spawnTuiAgent(', 'spawnViaRunner(', 'spawnDirectly(']) {
      const idx = AGENT_SPAWN_DISPATCH_SRC.indexOf(helper);
      expect(idx, `${helper} must appear AFTER \`context.handedOff = true\``).toBeGreaterThan(flipIdx);
    }
  });
});

describe('runAgentSpawn source — durable TUI ownership (#3202)', () => {
  it('routes TUI providers through the runner when it is available', () => {
    expect(RUN_SPAWN_BODY).toMatch(
      /const executionMode = resolveExecutionMode\(\{ spawnHeadless, useRunner: dispatchUseRunner \}\);/
    );
    // The four modes themselves, at their new home.
    expect(AGENT_REGISTRATION_SRC).toMatch(/if \(spawnHeadless\) return useRunner \? 'runner' : 'direct';/);
    expect(AGENT_REGISTRATION_SRC).toMatch(/return useRunner \? 'runner-tui' : 'tui';/);
    expect(RUN_SPAWN_BODY).toMatch(/spawnTuiAgent\(\{[\s\S]{0,1000}?useDurableRunner:\s*dispatchUseRunner/);
    expect(RUN_SPAWN_BODY).not.toMatch(/useRunner:\s*isTui\s*\?\s*false\s*:\s*useRunner/);
  });
});

// ─── Instance provenance stamping + claim ordering (issue #1563) ─────────────
//
// Every spawned agent records the producing machine's federation identity, and
// the cross-instance claim must be acquired (and re-checked against the fresh
// record) BEFORE the agent is registered — otherwise two peers spawn for the
// same task. The guard orderings are covered behaviorally in
// agentSpawnPreparation.test.js; only the dispatch-side stamps are grepped here.
describe('runAgentSpawn source — instance provenance + claim ordering (#1563)', () => {
  it('imports the identity resolver from the instance identity leaf', () => {
    expect(AGENT_SPAWN_PREPARATION_SRC).toMatch(
      /import\s*\{\s*ensureInstanceId\s*\}\s*from\s*'\.\.\/instanceIdentity\.js';/
    );
  });

  it('stamps the federation claim into the in_progress task update', () => {
    expect(AGENT_SPAWN_DISPATCH_SRC).toMatch(/\.\.\.buildClaim\(instanceId\)/);
  });

  it('stamps instanceId into the registerAgent metadata', () => {
    expect(AGENT_REGISTRATION_SRC).toMatch(/\binstanceId,/);
    expect(AGENT_REGISTRATION_SRC.indexOf('instanceId,')).toBeLessThan(AGENT_REGISTRATION_SRC.indexOf('workspacePath,'));
  });

  it('records claimFlow separately from CoS-managed PR/worktree flags', () => {
    expect(AGENT_REGISTRATION_SRC).toContain('configOpenPR: isTruthyMeta(task.metadata?.openPR)');
    // Derived from \`isClaimFlowTask\`, not re-implemented inline: the predicate also
    // recognises a claim run by its \`analysisType\`, which an inline
    // \`isTruthyMeta(task.metadata?.claimFlow)\` would silently drop. Hoisted to one
    // const because \`configCodingOnMain\` reads the same fact.
    expect(AGENT_SPAWN_DISPATCH_SRC).toContain('const claimFlowTask = isClaimFlowTask(task);');
    expect(AGENT_REGISTRATION_SRC).toContain('configClaimFlow: claimFlowTask');
    expect(AGENT_REGISTRATION_SRC.indexOf('configClaimFlow')).toBeGreaterThan(AGENT_REGISTRATION_SRC.indexOf('configOpenPR'));
  });

  it('projects the public-review posture so the UI can explain the missing shell link', () => {
    // `spawnHeadless` forces a public-review stage headless even on a TUI
    // provider — unless it is the sandboxed-actions stage on a vendor with an
    // attachable recipe (#6062) — so its card usually gets no "Open Shell"
    // link. Without this projection the card cannot tell that apart from a PTY
    // that failed to attach, and the run reads as wedged.
    expect(AGENT_REGISTRATION_SRC).toMatch(/^\s*publicReviewPosture,$/m);
    // …and the orchestrator still hands it over, so the key cannot go stale.
    expect(RUN_SPAWN_BODY).toMatch(/^\s*publicReviewPosture,$/m);
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

  it("source: pins GH_TOKEN via resolveForgeTokenEnv so the runner-spawned agent's `gh` uses the repo-owner account", () => {
    const fnBody = runnerBody();
    expect(fnBody).toContain('resolveForgeTokenEnv(workspacePath)');
    // `before` is the slot that sits UNDER provider.envVars, so an explicit
    // provider GH_TOKEN still wins — passing it as `extra` would invert that.
    expect(fnBody).toMatch(/before:\s*\{[^}]*\.\.\.forgeTokenEnv[^}]*\}/);
  });
});

describe('runAgentSpawn source — claim-miss guard (issue #2633)', () => {
  it('only a null in_progress result is fatal — an { error } miss must NOT block the spawn', () => {
    // A truthy `{ error }` is EXPECTED for legitimately-unpersisted autonomous
    // emits (Priority 3 idle-review tasks carry taskType:'internal' but are
    // never written to COS-TASKS.md). Blocking on it would silently kill every
    // idle-review spawn — the pre-#2633 behavior spawned them anyway, so the
    // fatal guard must remain `!updateResult` only.
    const fatalIdx = RUN_SPAWN_BODY.indexOf('if (!updateResult) {');
    expect(fatalIdx, 'the fatal guard must be `!updateResult` alone — the { error } shape must not be fatal').toBeGreaterThan(-1);
    expect(RUN_SPAWN_BODY, 'the { error } shape must not be part of the fatal guard (it would block unpersisted idle-review spawns)')
      .not.toContain('if (!updateResult || updateResult.error)');
  });

  it('warn-logs when the in_progress claim returns an { error } object so silent misses are visible', () => {
    const warnIdx = RUN_SPAWN_BODY.indexOf('if (updateResult?.error) {');
    expect(warnIdx, 'a silent { error } miss must be surfaced via a warn log').toBeGreaterThan(-1);
    const body = RUN_SPAWN_BODY.slice(warnIdx, warnIdx + 400);
    expect(body).toMatch(/emitLog\('warn'/);
    expect(body).toContain('updateResult.error');
  });
});

