/** Defines POST benchmark forms and validates and identifies compatible benchmark runs. */

import { ServerError } from '../../lib/errorHandler.js';
import { getPostSessions } from './postSessionHistory.js';

// The first fixed benchmark battery is intentionally small and deterministic:
// one seeded arithmetic drill plus one seeded executive-control drill. It is a
// protocol, not a projection of the user's adaptive configuration, so later
// forms can be added without changing the meaning of an existing result.
export const POST_BENCHMARK_PROTOCOL = Object.freeze({
  protocolId: 'post-foundation-battery',
  protocolVersion: 1,
  // v2: benchmark scoring now ignores the user's live config.scoring.weights
  // and mentalMath.drillTypes[type].timeLimitSec, using the protocol's fixed
  // weighting (uniform) and the registered form's timeLimitSec instead — a
  // scoring-contract change, so the version bumps (issue #4442 codex
  // review). A v1-scored session (weighted by whatever config was active at
  // submit time) is no longer "compatible" with a v2 one — benchmarkCompatibility()
  // correctly buckets it as legacy/excluded rather than blending two
  // different scoring formulas into one trend.
  scorerVersion: 'post-deterministic-v2',
  forms: Object.freeze([
    Object.freeze({
      formId: 'a',
      tasks: Object.freeze([
        Object.freeze({ type: 'doubling-chain', domain: 'mental-math', config: Object.freeze({ startValue: 5, steps: 8 }), timeLimitSec: 60 }),
        Object.freeze({ type: 'task-switching', domain: 'cognitive', config: Object.freeze({ seed: 'post-foundation-a', count: 12, ruleCount: 2, switchRatePct: 50, cueStimulusIntervalMs: 700, incongruentPct: 50, responseDeadlineMs: 2200 }) }),
      ]),
    }),
    Object.freeze({
      formId: 'b',
      tasks: Object.freeze([
        Object.freeze({ type: 'doubling-chain', domain: 'mental-math', config: Object.freeze({ startValue: 7, steps: 8 }), timeLimitSec: 60 }),
        Object.freeze({ type: 'task-switching', domain: 'cognitive', config: Object.freeze({ seed: 'post-foundation-b', count: 12, ruleCount: 2, switchRatePct: 50, cueStimulusIntervalMs: 700, incongruentPct: 50, responseDeadlineMs: 2200 }) }),
      ]),
    }),
  ]),
});

// Scorer versions retired by a scoring-contract change (e.g. v1 → v2's fixed
// weights/timeLimit) but still ACCEPTABLE on submit — never rejected/lost —
// so an in-flight benchmark run started under the old formula (client
// fetched the old protocol before a server upgrade landed mid-session) can
// still be saved after the upgrade (issue #4442 codex review; mirrors the
// PROMPT_VERSIONS/integrity-snapshot cross-version pattern in
// taskPromptDefaults.js). Task/config shape is unchanged across scorer versions —
// only the scoring formula moved — so accepting it costs nothing: the
// submission is scored under the CURRENT rules regardless (submitPostSession
// only branches on `sessionData.benchmark` truthiness, not on which scorer
// version it names), and its stored scorerVersion is preserved as submitted,
// so benchmarkCompatibility() still correctly excludes it from the current
// trend as legacy rather than silently blending two formulas together.
const PREVIOUS_BENCHMARK_SCORER_VERSIONS = Object.freeze(['post-deterministic-v1']);

const cloneBenchmarkProtocol = (protocol) => JSON.parse(JSON.stringify(protocol));

export function getPostBenchmarkForm(formId) {
  return POST_BENCHMARK_PROTOCOL.forms.find((form) => form.formId === formId) || null;
}

export async function getPostBenchmarkProtocol() {
  const sessions = await getPostSessions();
  const formIds = new Set(sessions
    .filter((session) => session?.benchmark?.protocolId === POST_BENCHMARK_PROTOCOL.protocolId)
    .slice(-POST_BENCHMARK_PROTOCOL.forms.length)
    .map((session) => session.benchmark.formId));
  const nextForm = POST_BENCHMARK_PROTOCOL.forms.find((form) => !formIds.has(form.formId))
    || POST_BENCHMARK_PROTOCOL.forms[0];
  return { ...cloneBenchmarkProtocol(POST_BENCHMARK_PROTOCOL), nextFormId: nextForm.formId };
}

// A benchmark session is "compatible" only when its stored protocol/version/
// scorer triple exactly matches the CURRENTLY registered protocol — never
// fabricated, never inferred by shape. `null` marks a plain (non-benchmark)
// session so trend code can tell "not a benchmark run" apart from "a
// benchmark run under a retired protocol/scorer version" (issue #4442);
// both are excluded from the compatible series, but for different reasons.
export function benchmarkCompatibility(session) {
  const benchmark = session?.benchmark;
  if (!benchmark) return null;
  return benchmark.protocolId === POST_BENCHMARK_PROTOCOL.protocolId
    && benchmark.protocolVersion === POST_BENCHMARK_PROTOCOL.protocolVersion
    && benchmark.scorerVersion === POST_BENCHMARK_PROTOCOL.scorerVersion
    ? 'compatible'
    : 'legacy';
}

export function assertBenchmarkSession(benchmark, tasks, modules) {
  if (!benchmark) return;
  // Accept the current scorer version OR a recognized-but-retired one — see
  // PREVIOUS_BENCHMARK_SCORER_VERSIONS. Rejecting an in-flight run just
  // because the server's scorer version moved on mid-session would lose the
  // user's completed work; the form/task shape hasn't changed, only scoring.
  const versionRecognized = benchmark.scorerVersion === POST_BENCHMARK_PROTOCOL.scorerVersion
    || PREVIOUS_BENCHMARK_SCORER_VERSIONS.includes(benchmark.scorerVersion);
  const form = benchmark.protocolId === POST_BENCHMARK_PROTOCOL.protocolId
    && benchmark.protocolVersion === POST_BENCHMARK_PROTOCOL.protocolVersion
    && versionRecognized
    ? getPostBenchmarkForm(benchmark.formId)
    : null;
  const expectedModules = form ? [...new Set(form.tasks.map((task) => task.domain))] : [];
  const modulesMatch = expectedModules.length === modules.length
    && expectedModules.every((module) => modules.includes(module));
  const tasksMatch = form
    && tasks.length === form.tasks.length
    && form.tasks.every((expected, index) => {
      const actual = tasks[index];
      return actual?.type === expected.type
        && Object.entries(expected.config).every(([key, value]) => actual.config?.[key] === value);
    });
  if (!form || !modulesMatch || !tasksMatch) {
    throw new ServerError('Benchmark session does not match its registered protocol form', {
      status: 400,
      code: 'INVALID_BENCHMARK',
    });
  }
}
