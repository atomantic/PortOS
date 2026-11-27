import { nBackBalancedAccuracy } from './constants';

export function localAccuracyScore(questions) {
  if (!questions.length) return 0;
  const correct = questions.filter(q => q.correct).length;
  return Math.round((correct / questions.length) * 100);
}

// Pre-save mirror of the server's signal-detection n-back score (issue #2094):
// balanced accuracy over targets (hit rate) and non-targets (correct-rejection
// rate), so the results screen matches what the save persists instead of raw
// position accuracy (which pays ~70% for never pressing). Delegates to the
// shared answered+correct derivation in constants.js (buildNBackQuestions marks
// `correct` with exactly the identity that derivation relies on).
export function localNBackScore(_drill, questions) {
  const accuracy = nBackBalancedAccuracy(questions);
  return accuracy == null ? 0 : Math.min(100, Math.max(0, Math.round(accuracy * 100)));
}

// Pre-save mirror of the server's latency-based reaction-time score (issue
// #2094): median RT of VALID trials against the mode's reference curve, scaled
// by the valid-trial rate so false starts pull the headline number down.
export function localReactionTimeScore(drill, questions) {
  const mode = drill?.config?.mode === 'choice' ? 'choice' : 'simple';
  const refMs = mode === 'choice' ? 1200 : 600;
  const fastMs = mode === 'choice' ? 400 : 200;
  const valid = questions.filter(q => q.correct && !q.falseStart && (q.responseMs || 0) > 0);
  if (!questions.length || !valid.length) return 0;
  const sorted = valid.map(q => Math.min(q.responseMs, refMs * 3)).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const latencyScore = Math.min(100, Math.max(0, (100 * (refMs - medianMs)) / (refMs - fastMs)));
  return Math.round(latencyScore * (valid.length / questions.length));
}

// Pre-save mirror of the Schulte server scorer. Every click is an attempt;
// completion advances only on the ordered correct target, while successful
// target latency (including time spent making wrong taps) drives the speed term.
export function localSchulteMetrics(drill, questions) {
  const list = Array.isArray(questions) ? questions : [];
  const totalCount = Array.isArray(drill?.cells) ? drill.cells.length : 0;
  const correct = list.filter(question => question.correct);
  const attemptCount = list.length;
  const answeredCount = correct.length;
  const errorCount = attemptCount - answeredCount;
  const accuracy = attemptCount ? answeredCount / attemptCount : null;
  const completion = totalCount ? answeredCount / totalCount : null;
  const refMs = 1000 + Math.round(Math.sqrt(totalCount)) * 500;
  const avgResponseMs = answeredCount
    ? Math.round(correct.reduce((sum, question) => sum + Math.min(Math.max(question.responseMs || 0, 0), refMs), 0) / answeredCount)
    : null;
  const speedBonus = avgResponseMs == null || refMs <= 0 ? 0 : Math.max(0, 1 - avgResponseMs / refMs);
  const score = Math.round(((accuracy || 0) * 0.8 + speedBonus * 0.2) * (completion || 0) * 100);
  return { score, accuracy, completion, avgResponseMs, answeredCount, totalCount, attemptCount, errorCount };
}

function localAverageLatency(questions) {
  const timed = questions.filter(question => question.correct && question.responseMs > 0);
  return timed.length ? Math.round(timed.reduce((sum, question) => sum + question.responseMs, 0) / timed.length) : null;
}

function localGroupAccuracy(questions, predicate) {
  const group = questions.filter(predicate);
  return group.length ? group.filter(question => question.correct).length / group.length : null;
}

function localCost(questions, costlyPredicate, baselinePredicate) {
  const costly = localAverageLatency(questions.filter(costlyPredicate));
  const baseline = localAverageLatency(questions.filter(baselinePredicate));
  return costly == null || baseline == null ? null : costly - baseline;
}

function localExecutiveMetrics(questions, totalCount = questions.length, refMs = 1800) {
  const answered = questions.filter(question => question.answered != null);
  const accuracy = questions.length ? questions.filter(question => question.correct).length / questions.length : null;
  const completion = totalCount ? questions.length / totalCount : null;
  const avgResponseMs = localAverageLatency(questions);
  const speedBonus = avgResponseMs == null ? 0 : Math.max(0, 1 - avgResponseMs / refMs);
  return {
    score: Math.round(((accuracy || 0) * 0.8 + speedBonus * 0.2) * (completion || 0) * 100),
    accuracy,
    completion,
    avgResponseMs,
    answeredCount: answered.length,
    totalCount,
    commissionErrors: answered.filter(question => !question.correct).length,
    omissions: questions.filter(question => question.answered == null && !question.correct).length,
    latencyDistributionMs: answered.map(question => question.responseMs).filter(ms => ms > 0),
  };
}

export function localTaskSwitchMetrics(questions, totalCount, refMs) {
  return {
    ...localExecutiveMetrics(questions, totalCount, refMs),
    switchCostMs: localCost(questions, question => question.switched, question => !question.switched),
    switchAccuracy: localGroupAccuracy(questions, question => question.switched),
    repeatAccuracy: localGroupAccuracy(questions, question => !question.switched),
  };
}

export function localGoNoGoMetrics(questions, totalCount = questions.length) {
  const hits = questions.filter(question => !question.noGo && question.answered === 'go').length;
  const omissions = questions.filter(question => !question.noGo && question.answered == null).length;
  const falseAlarms = questions.filter(question => question.noGo && question.answered === 'go').length;
  const correctRejections = questions.filter(question => question.noGo && question.answered == null).length;
  const goCount = hits + omissions;
  const noGoCount = falseAlarms + correctRejections;
  const accuracy = goCount || noGoCount
    ? ((goCount ? hits / goCount : 0.5) + (noGoCount ? correctRejections / noGoCount : 0.5)) / 2
    : null;
  const latencies = questions.filter(question => question.answered === 'go' && question.responseMs > 0).map(question => question.responseMs);
  const sorted = [...latencies].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length ? (sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)) : null;
  const completion = totalCount ? questions.length / totalCount : null;
  return {
    score: accuracy == null ? 0 : Math.round(accuracy * (completion || 0) * 100),
    accuracy,
    completion,
    avgResponseMs: localAverageLatency(questions),
    medianMs,
    bestMs: sorted.length ? sorted[0] : null,
    answeredCount: latencies.length,
    totalCount,
    hits,
    omissions,
    falseAlarms,
    commissionErrors: falseAlarms,
    correctRejections,
    falseAlarmRate: noGoCount ? falseAlarms / noGoCount : null,
    latencyDistributionMs: latencies,
  };
}

export function localFlankerMetrics(questions, totalCount, refMs) {
  return {
    ...localExecutiveMetrics(questions, totalCount, refMs),
    congruencyCostMs: localCost(questions, question => !question.congruent, question => question.congruent),
    congruentAccuracy: localGroupAccuracy(questions, question => question.congruent),
    incongruentAccuracy: localGroupAccuracy(questions, question => !question.congruent),
  };
}

// Shared result-assembly shape every sub-runner hands to `onComplete`. The
// server rescores deterministically from `drillData`/`questions` on save
// (server/services/meatspace/meatspacePostCognitive.js) — this is the client-side
// mirror, and its `index`/`answered`/`responseMs` fields are what that
// rescoring depends on.
export function buildCognitiveResult({ type, drill, questions, totalMs }) {
  // n-back and reaction-time mirror the server's rescoring semantics (SDT
  // balanced accuracy / valid-median latency, issue #2094) so the pre-save
  // results screen doesn't show a number that jumps on save. Other types keep
  // the raw-accuracy approximation (server adds only a small speed bonus).
  const schulteMetrics = type === 'schulte-table' ? localSchulteMetrics(drill, questions) : null;
  const plannedTrials = drill.trials?.length || questions.length;
  const executiveMetrics = type === 'task-switching'
    ? localTaskSwitchMetrics(questions, plannedTrials, drill.config?.responseDeadlineMs || 2200)
    : type === 'go-no-go'
      ? localGoNoGoMetrics(questions, plannedTrials)
      : type === 'flanker' ? localFlankerMetrics(questions, plannedTrials, drill.config?.responseDeadlineMs || 1600) : null;
  const score = type === 'n-back'
    ? localNBackScore(drill, questions)
    : type === 'reaction-time'
      ? localReactionTimeScore(drill, questions)
      : executiveMetrics?.score ?? schulteMetrics?.score ?? localAccuracyScore(questions);
  return {
    module: 'cognitive',
    type,
    config: drill.config,
    drillData: drill,
    questions,
    score,
    ...(schulteMetrics || {}),
    ...(executiveMetrics || {}),
    totalMs,
  };
}

// N-BACK — pure result assembly: given the full letter sequence, the lag `n`,
// and the parallel `answers` array (index-aligned with `seq`, each entry
// `{ answered: 'match'|null, responseMs }`), build the scored `questions[]`.
// Only positions `i >= n` have a defined target (there's no "n back" before
// that), so the first `n` letters are excluded — the off-by-one this guards
// against is including/excluding the boundary position `i === n` itself.
export function buildNBackQuestions(seq, n, answers) {
  return seq
    .map((letter, i) => ({ letter, i }))
    .filter(({ i }) => i >= n)
    .map(({ letter, i }) => {
      const a = answers[i] || {};
      const isTarget = seq[i] === seq[i - n];
      const answeredMatch = a.answered === 'match';
      return {
        prompt: letter,
        index: i,
        // Mirrors the server's scoreNBack recompute exactly ('match'/'no-match')
        // so the results-review UI (DrillQuestionReview) reads one consistent
        // field regardless of whether it's showing the just-finished client
        // result or a server-rescored history record.
        expected: isTarget ? 'match' : 'no-match',
        answered: a.answered ?? null,
        correct: answeredMatch === isTarget,
        responseMs: a.responseMs || 0,
      };
    });
}

// DIGIT SPAN — pure scoring for one recalled sequence. `direction` decides
// whether the expected answer is the digits in shown order ('forward') or
// reversed ('backward') — the bug this guards against is comparing the
// typed answer against the wrong ordering. Returns both the persisted
// `question` (what `finish()` assembles into the result) and the raw
// `expected`/`answeredRaw` strings the training-mode feedback UI displays.
export function scoreDigitSpanRecall({ digits, direction, index, answeredStr, responseMs }) {
  const ordered = direction === 'backward' ? [...digits].reverse() : digits;
  const expected = ordered.join('');
  const answeredRaw = (answeredStr || '').replace(/\D/g, '');
  return {
    question: {
      prompt: `${digits.length}-digit (${direction})`,
      index,
      // Shown digits in recall order — matches the server's scoreDigitSpan
      // recompute so the review UI shows "shown vs recalled" from either the
      // client's local result or a server-rescored history record.
      expected,
      answered: answeredRaw.length ? answeredRaw : null,
      correct: answeredRaw.length > 0 && answeredRaw === expected,
      responseMs,
      length: digits.length,
    },
    expected,
    answeredRaw,
  };
}

// STROOP — pure scoring for one trial: correct iff the picked color name
// matches the word's INK color (`trial.inkColor`), not the word text itself
// — the bug this guards against is accidentally grading against the word.
export function scoreStroopTrial({ trial, index, colorName, responseMs }) {
  return {
    prompt: trial.word,
    index,
    // Ink color is the answer key — mirrors the server's scoreStroop recompute.
    expected: trial.inkColor,
    answered: colorName,
    correct: colorName === trial.inkColor,
    responseMs,
  };
}

// MENTAL ROTATION — pure scoring for one trial: correct iff the picked option
// index is the option that's the SAME shape (just rotated), not a mirror or
// distractor. Mirrors `scoreStroopTrial`'s shape so both trial-based drills
// share one testable pattern.
export function scoreMentalRotationTrial({ trial, index, optionIndex, responseMs }) {
  return {
    prompt: `shape ${trial.shape || ''}`,
    index,
    // Mirrors the server's scoreMentalRotation recompute.
    expected: trial.correctIndex,
    answered: optionIndex,
    correct: optionIndex === trial.correctIndex,
    responseMs,
  };
}

// SCHULTE — one ordered click event. `expected` is the current target when the
// click happened; wrong selections stay in the stream and do not advance it.
// The server recomputes these fields from event order, so this is feedback data,
// never an authority boundary.
export function scoreSchulteClick({ target, value, responseMs }) {
  return {
    prompt: `${target}`,
    index: target - 1,
    expected: target,
    answered: value,
    correct: value === target,
    responseMs,
  };
}

const TASK_SWITCH_VALUES = {
  color: ['blue', 'orange'],
  shape: ['circle', 'triangle'],
  fill: ['solid', 'outline'],
};

export function scoreTaskSwitchTrial({ trial, index, answer, responseMs }) {
  const values = TASK_SWITCH_VALUES[trial?.rule] || [];
  const valueIndex = values.indexOf(trial?.stimulus?.[trial?.rule]);
  const expected = valueIndex === 0 ? 'left' : valueIndex === 1 ? 'right' : null;
  return {
    prompt: trial?.rule || '',
    index,
    expected,
    answered: answer,
    correct: expected != null && answer === expected,
    responseMs,
    rule: trial?.rule,
    switched: trial?.switched === true,
    incongruent: trial?.incongruent === true,
  };
}

export function scoreGoNoGoTrial({ trial, index, pressed, responseMs }) {
  const noGo = trial?.kind === 'no-go';
  const answered = pressed ? 'go' : null;
  return {
    prompt: trial?.symbol || '',
    index,
    expected: noGo ? 'withhold' : 'go',
    answered,
    correct: noGo ? answered == null : answered === 'go',
    responseMs,
    noGo,
  };
}

export function scoreFlankerTrial({ trial, index, answer, responseMs }) {
  const expected = trial?.target === 'left' || trial?.target === 'right' ? trial.target : null;
  return {
    prompt: `${trial?.flanker || ''}-${trial?.target || ''}`,
    index,
    expected,
    answered: answer,
    correct: expected != null && answer === expected,
    responseMs,
    congruent: trial?.congruent === true,
  };
}
