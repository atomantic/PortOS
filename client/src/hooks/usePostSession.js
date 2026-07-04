import { useState, useCallback, useRef, useEffect } from 'react';
import { generatePostDrill, submitPostSession, scorePostLlmDrill, submitTrainingEntry } from '../services/api';
import toast from '../components/ui/Toast';
import { LLM_DRILL_TYPES, MEMORY_DRILL_TYPES, DRILL_TO_DOMAIN, countLlmCorrect } from '../components/meatspace/post/constants';

// sessionStorage key for the single in-progress run. Single-user tool → one
// active run at a time, so a single key is enough. Restored on refresh so a
// mid-drill reload resumes the same drill queue + completed results, and a
// reload on the completed-but-unsaved results screen keeps the results.
const RUN_STORAGE_KEY = 'post.activeRun';
// Only an active or completed-unsaved run is worth resuming. A run that was
// still generating a drill (`loading`) lost its in-flight request to the
// reload, and an `idle`/`saved` run has nothing live to restore.
const RESTORABLE_STATES = new Set(['drilling', 'between-drills', 'complete']);

// uuid v4 usable in non-secure contexts. `crypto.randomUUID` only exists in a
// secure context (HTTPS / localhost) — PortOS is commonly reached over plain
// HTTP via Tailscale, where it's undefined — but `crypto.getRandomValues` is
// available there too, so derive a spec-valid v4 from it (the server validates
// the id with Zod `.uuid()`). Math.random is the last-ditch fallback.
function newRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = [...b].map(x => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

function loadRunSnapshot() {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(RUN_STORAGE_KEY);
  if (!raw) return null;
  let snap = null;
  try { snap = JSON.parse(raw); } catch { return null; } // corrupt storage → start fresh
  if (!snap || typeof snap !== 'object') return null;
  if (snap.state === 'saving') {
    // A scored session re-saves idempotently (client-supplied id → upsert), so
    // restoring a mid-save run to `complete` is safe. A TRAINING save instead
    // loops non-idempotent training-log writes; restoring it would let a re-save
    // double-log every drill — and the entries were most likely already posted —
    // so drop it rather than resume.
    if (snap.isTraining) return null;
    snap.state = 'complete';
  }
  if (!RESTORABLE_STATES.has(snap.state)) return null;
  return snap;
}

function clearRunSnapshot() {
  if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(RUN_STORAGE_KEY);
}

function computeSessionScoreFromResults(results) {
  if (!results.length) return 0;
  // Group by domain — if any drills have domain info, use weighted avg per domain
  const byDomain = {};
  let hasDomains = false;
  for (const r of results) {
    const dk = DRILL_TO_DOMAIN[r.type];
    if (dk) {
      hasDomains = true;
      if (!byDomain[dk]) byDomain[dk] = [];
      byDomain[dk].push(r.score || 0);
    }
  }
  if (hasDomains && Object.keys(byDomain).length > 1) {
    // Average within each domain, then average across domains (equal weight per domain)
    const domainAvgs = Object.values(byDomain).map(scores =>
      Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    );
    return Math.round(domainAvgs.reduce((a, b) => a + b, 0) / domainAvgs.length);
  }
  // Fallback: simple average
  return Math.round(results.reduce((s, r) => s + (r.score || 0), 0) / results.length);
}

// Memory drill questions carry chunk/element attribution the server needs to
// bucket mastery bookkeeping (item.mastery.chunks / item.mastery.elements) —
// chunkId on memory-sequence questions (via findChunkForLine), element on
// memory-element-flash questions. Non-memory questions never have these, so
// this only adds fields when present rather than sending explicit nulls.
function memoryAttribution(q) {
  const attrs = {};
  if (q?.chunkId != null) attrs.chunkId = q.chunkId;
  if (q?.element != null) attrs.element = q.element;
  return attrs;
}

// States: idle → loading → drilling → between-drills → complete → saving → saved
const STATES = {
  IDLE: 'idle',
  LOADING: 'loading',
  DRILLING: 'drilling',
  BETWEEN_DRILLS: 'between-drills',
  COMPLETE: 'complete',
  SAVING: 'saving',
  SAVED: 'saved'
};

export function usePostSession() {
  // Seed once from any persisted in-progress run so a refresh mid-drill (or on
  // the completed-unsaved results screen) resumes instead of dropping the run.
  const [restored] = useState(loadRunSnapshot);
  const [state, setState] = useState(restored?.state ?? STATES.IDLE);
  const [drills, setDrills] = useState(restored?.drills ?? []); // queued drill configs
  const [currentDrillIndex, setCurrentDrillIndex] = useState(restored?.currentDrillIndex ?? 0);
  const [currentDrill, setCurrentDrill] = useState(restored?.currentDrill ?? null); // generated questions
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(restored?.currentQuestionIndex ?? 0);
  const [answers, setAnswers] = useState(restored?.answers ?? []); // answers for current drill
  const [drillResults, setDrillResults] = useState(restored?.drillResults ?? []); // completed drill results
  const [sessionScore, setSessionScore] = useState(restored?.sessionScore ?? 0);
  const [savedSession, setSavedSession] = useState(null);
  const [isTraining, setIsTraining] = useState(restored?.isTraining ?? false);
  // Run id doubles as the client-generated session id (idempotent submit) and
  // the /post/session/:id results URL — so a saved session's URL === its run id.
  const [runId, setRunId] = useState(restored?.runId ?? null);
  const [tags, setTags] = useState(restored?.tags ?? {}); // session tags captured at launch
  const [lastAnswer, setLastAnswer] = useState(null); // { correct, expected, answered } for training feedback
  // Seed the timing refs from the restored snapshot so a mid-drill refresh keeps
  // measuring elapsed time from the ORIGINAL question/drill start — otherwise the
  // in-flight question's responseMs (and the drill's totalMs) would reset to 0 on
  // reload, under-counting time and inflating the speed bonus.
  const questionStartRef = useRef(restored?.questionStartedAt ?? Date.now());
  const drillStartRef = useRef(restored?.drillStartedAt ?? Date.now());
  const finishDrillRef = useRef(null);

  // Persist the live run to sessionStorage on every meaningful change; clear it
  // once idle/saved (nothing live to resume). Kept minimal — only the fields
  // needed to rebuild the runner and results screen after a reload.
  useEffect(() => {
    if (state === STATES.IDLE || state === STATES.SAVED) {
      clearRunSnapshot();
      return;
    }
    // While a drill is generating (initial start, next drill, or LLM scoring),
    // do NOT overwrite the last stable snapshot: `loading` isn't restorable, and
    // the in-flight request can't be resumed — but the COMPLETED results already
    // captured in the prior drilling/between-drills snapshot must survive a
    // refresh during generation. Keeping the last good snapshot lets a refresh
    // resume at the between-drills screen instead of dropping the whole run.
    if (state === STATES.LOADING) return;
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(RUN_STORAGE_KEY, JSON.stringify({
      runId, state, drills, currentDrillIndex, currentDrill, currentQuestionIndex,
      answers, drillResults, sessionScore, isTraining, tags,
      // Persist the timing anchors (mutated synchronously on each question/drill
      // transition, just before the state change that fires this effect) so a
      // refresh resumes the clock instead of restarting it.
      questionStartedAt: questionStartRef.current,
      drillStartedAt: drillStartRef.current,
    }));
  }, [runId, state, drills, currentDrillIndex, currentDrill, currentQuestionIndex, answers, drillResults, sessionScore, isTraining, tags]);

  const startSession = useCallback(async (drillConfigs, training = false, sessionTags = {}) => {
    // drillConfigs: [{ type, config, timeLimitSec }]
    if (!drillConfigs?.length) {
      toast.error('No drills configured');
      return;
    }
    setState(STATES.LOADING);
    setIsTraining(training);
    setDrills(drillConfigs);
    setCurrentDrillIndex(0);
    setDrillResults([]);
    setSavedSession(null);
    setLastAnswer(null);
    // New run → new client-side id (also the future /post/session/:id) and the
    // tags to submit, so both survive a mid-run refresh via the snapshot.
    setRunId(newRunId());
    setTags(sessionTags || {});

    const first = drillConfigs[0];
    const drill = await generatePostDrill(first.type, first.config, first.providerId, first.model, { silent: true }).catch(err => {
      toast.error(`Failed to generate drill: ${err.message}`);
      setState(STATES.IDLE);
      return null;
    });
    if (!drill) return;
    setCurrentDrill({ ...drill, timeLimitSec: first.timeLimitSec });
    setCurrentQuestionIndex(0);
    setAnswers([]);
    questionStartRef.current = Date.now();
    drillStartRef.current = Date.now();
    setState(STATES.DRILLING);
    return drill;
  }, []);

  const finishDrill = useCallback((finalAnswers) => {
    const totalMs = Date.now() - drillStartRef.current;
    const timeLimitMs = (currentDrill?.timeLimitSec || 120) * 1000;

    // Compute score
    const correct = finalAnswers.filter(a => a.correct).length;
    const total = finalAnswers.length;
    const correctRatio = total > 0 ? correct / total : 0;
    const answered = finalAnswers.filter(a => a.answered !== null);
    const totalResponseMs = answered.reduce((sum, a) => sum + a.responseMs, 0);
    const avgResponseMs = answered.length > 0 ? totalResponseMs / answered.length : timeLimitMs;
    const speedBonus = Math.max(0, 1 - avgResponseMs / timeLimitMs);
    const score = Math.min(100, Math.max(0, Math.round((correctRatio * 0.8 + speedBonus * 0.2) * 100)));

    const isMemoryDrill = MEMORY_DRILL_TYPES.includes(currentDrill.type);
    const result = {
      module: isMemoryDrill ? 'memory' : 'mental-math',
      type: currentDrill.type,
      config: currentDrill.config,
      questions: finalAnswers,
      // Memory drills: carry the drilled item's id through to session submit so
      // the server can map this review back to it and advance its
      // spaced-repetition schedule (mirrors the MemoryBuilder practice flow).
      ...(isMemoryDrill && currentDrill.memoryItemId ? { memoryItemId: currentDrill.memoryItemId } : {}),
      score,
      totalMs
    };

    const newResults = [...drillResults, result];
    setDrillResults(newResults);

    // Check if there are more drills
    if (currentDrillIndex + 1 < drills.length) {
      setState(STATES.BETWEEN_DRILLS);
    } else {
      setSessionScore(computeSessionScoreFromResults(newResults));
      setState(STATES.COMPLETE);
    }
  }, [currentDrill, drillResults, currentDrillIndex, drills]);

  // Keep ref current so submitAnswer and timeExpired always call the latest finishDrill
  finishDrillRef.current = finishDrill;

  const submitAnswer = useCallback((value) => {
    if (state !== STATES.DRILLING || !currentDrill) return;

    const q = currentDrill.questions?.[currentQuestionIndex];
    if (!q) return;
    const responseMs = Date.now() - questionStartRef.current;
    const hasFillBlankAnswers = Array.isArray(q.answers) && q.answers.length > 0;
    const isTextAnswer = typeof q.expected === 'string' || hasFillBlankAnswers;

    // For estimation drills, check within tolerance
    let correct;
    let answered;
    if (hasFillBlankAnswers) {
      answered = value;
      const normalized = value !== null ? String(value).toLowerCase().trim() : '';
      correct = q.answers.some(a => String(a).toLowerCase().trim() === normalized);
    } else if (isTextAnswer) {
      answered = value;
      correct = value !== null && String(value).toLowerCase().trim() === String(q.expected).toLowerCase().trim();
    } else if (currentDrill.type === 'estimation') {
      const raw = (value === null || String(value).trim() === '') ? null : Number(value);
      answered = (raw !== null && isNaN(raw)) ? null : raw;
      const tolerance = (currentDrill.config?.tolerancePct || 10) / 100;
      correct = answered !== null && Math.abs(answered - q.expected) <= Math.abs(q.expected * tolerance);
    } else {
      const raw = (value === null || String(value).trim() === '') ? null : Number(value);
      answered = (raw !== null && isNaN(raw)) ? null : raw;
      correct = answered === q.expected;
    }

    const answer = {
      prompt: q.prompt,
      expected: q.expected,
      answered,
      correct,
      responseMs,
      ...memoryAttribution(q)
    };

    const newAnswers = [...answers, answer];
    setAnswers(newAnswers);

    // Training mode: pause to show feedback before advancing
    if (isTraining) {
      setLastAnswer(answer);
      return;
    }

    // Check if drill is complete
    if (currentQuestionIndex + 1 >= (currentDrill.questions?.length ?? 0)) {
      finishDrillRef.current(newAnswers);
    } else {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      questionStartRef.current = Date.now();
    }
  }, [state, currentDrill, currentQuestionIndex, answers, isTraining]);

  const skipQuestion = useCallback(() => {
    submitAnswer(null);
  }, [submitAnswer]);

  // Training mode: advance to next question after user sees feedback
  const acknowledgeAnswer = useCallback(() => {
    setLastAnswer(null);
    if (currentQuestionIndex + 1 >= (currentDrill?.questions?.length ?? 0)) {
      finishDrillRef.current(answers);
    } else {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      questionStartRef.current = Date.now();
    }
  }, [currentQuestionIndex, currentDrill, answers]);

  const nextDrill = useCallback(async () => {
    const nextIndex = currentDrillIndex + 1;
    setCurrentDrillIndex(nextIndex);
    setState(STATES.LOADING);

    const next = drills[nextIndex];
    const drill = await generatePostDrill(next.type, next.config, next.providerId, next.model, { silent: true }).catch(err => {
      toast.error(`Failed to generate drill: ${err.message}`);
      setState(STATES.IDLE);
      return null;
    });
    if (!drill) return false;
    setCurrentDrill({ ...drill, timeLimitSec: next.timeLimitSec });
    setCurrentQuestionIndex(0);
    setAnswers([]);
    questionStartRef.current = Date.now();
    drillStartRef.current = Date.now();
    setState(STATES.DRILLING);
    return true;
  }, [currentDrillIndex, drills]);

  const timeExpired = useCallback(() => {
    if (state !== STATES.DRILLING || !currentDrill) return;

    // Mark remaining questions as unanswered
    const remaining = (currentDrill.questions || []).slice(currentQuestionIndex).map(q => ({
      prompt: q.prompt,
      expected: q.expected,
      answered: null,
      correct: false,
      responseMs: 0,
      ...memoryAttribution(q)
    }));

    const finalAnswers = [...answers, ...remaining];
    setAnswers(finalAnswers);
    finishDrillRef.current(finalAnswers);
  }, [state, currentDrill, currentQuestionIndex, answers]);

  const completeLlmDrill = useCallback(async (drillResult) => {
    const isLlm = LLM_DRILL_TYPES.includes(drillResult.type);
    let scoredResult = drillResult;

    if (isLlm && drillResult.responses?.length > 0) {
      setState(STATES.LOADING);
      const drillConfig = drills[currentDrillIndex];
      const timeLimitMs = (drillConfig?.timeLimitSec || 120) * 1000;
      const scoreResult = await scorePostLlmDrill(
        drillResult.type, drillResult.drillData, drillResult.responses,
        timeLimitMs, drillConfig?.providerId, drillConfig?.model, { silent: true }
      ).catch(err => {
        toast.error(`LLM scoring failed: ${err.message}`);
        return null;
      });

      if (scoreResult) {
        scoredResult = {
          ...drillResult,
          score: scoreResult.score,
          responses: scoreResult.questions || drillResult.responses,
          evaluation: scoreResult.evaluation
        };
      } else {
        scoredResult = { ...drillResult, score: 0 };
      }
    }

    const newResults = [...drillResults, scoredResult];
    setDrillResults(newResults);

    if (currentDrillIndex + 1 < drills.length) {
      setState(STATES.BETWEEN_DRILLS);
    } else {
      setSessionScore(computeSessionScoreFromResults(newResults));
      setState(STATES.COMPLETE);
    }
  }, [drillResults, currentDrillIndex, drills]);

  // Interactive cognitive drills (n-back / digit-span / stroop) build their own
  // fully-formed result (questions + local score) and hand it back here. Unlike
  // LLM drills there is no async scoring call — the server recomputes the score
  // deterministically from drillData on submit. Mirrors completeLlmDrill's
  // advance/complete bookkeeping.
  const completeCognitiveDrill = useCallback((drillResult) => {
    const newResults = [...drillResults, drillResult];
    setDrillResults(newResults);

    if (currentDrillIndex + 1 < drills.length) {
      setState(STATES.BETWEEN_DRILLS);
    } else {
      setSessionScore(computeSessionScoreFromResults(newResults));
      setState(STATES.COMPLETE);
    }
  }, [drillResults, currentDrillIndex, drills]);

  const saveSession = useCallback(async (overrideTags = {}) => {
    setState(STATES.SAVING);
    // Prefer the tags captured at launch (survive a refresh via the snapshot);
    // an explicit arg still wins per-key for a live save.
    const finalTags = { ...tags, ...(overrideTags || {}) };

    // Training mode: log each drill to the training log, don't save scored session
    if (isTraining) {
      for (const r of drillResults) {
        const questionCount = r.questions?.length || r.responses?.length || 0;
        // LLM drills score via completeLlmDrill, which stores the scored
        // responses under `r.responses` (with an `llmScore` field) rather
        // than `r.questions` (with a boolean `correct`) — the two shapes come
        // from two different result-building paths (finishDrill vs
        // completeLlmDrill). Reading `.correct` off `r.questions` for an LLM
        // drill always found `undefined`, so every LLM training entry
        // (including wordplay) silently logged correctCount=0 regardless of
        // actual performance (issue #2097).
        const isLlmDrill = LLM_DRILL_TYPES.includes(r.type);
        const correctCount = isLlmDrill
          ? countLlmCorrect(r.responses || [])
          : (r.questions?.filter(q => q.correct)?.length ?? 0);
        await submitTrainingEntry({
          module: r.module,
          drillType: r.type,
          questionCount,
          correctCount,
          totalMs: r.totalMs || 0,
        }).catch(() => {});
      }
      toast.success('Training session logged');
      setState(STATES.SAVED);
      return { training: true };
    }

    const modules = [...new Set(drillResults.map(r => r.module))];
    const session = await submitPostSession({
      // Client-generated id → an auto-retry after a dropped response upserts the
      // same record server-side instead of double-recording the session.
      id: runId || newRunId(),
      cadence: 'daily',
      modules,
      tasks: drillResults,
      tags: finalTags
    }, { silent: true }).catch(err => {
      toast.error(`Failed to save session: ${err.message}`);
      setState(STATES.COMPLETE);
      return null;
    });
    if (!session) return null;
    setSavedSession(session);
    toast.success(`POST complete — score: ${session.score}`);
    setState(STATES.SAVED);
    return session;
  }, [drillResults, isTraining, tags, runId]);

  const reset = useCallback(() => {
    setState(STATES.IDLE);
    setDrills([]);
    setCurrentDrillIndex(0);
    setCurrentDrill(null);
    setCurrentQuestionIndex(0);
    setAnswers([]);
    setDrillResults([]);
    setSessionScore(0);
    setSavedSession(null);
    setIsTraining(false);
    setRunId(null);
    setTags({});
    setLastAnswer(null);
    clearRunSnapshot();
  }, []);

  return {
    state,
    currentDrill,
    currentQuestionIndex,
    currentDrillIndex,
    drills,
    drillCount: drills.length,
    answers,
    drillResults,
    sessionScore,
    savedSession,
    isTraining,
    runId,
    lastAnswer,
    startSession,
    submitAnswer,
    skipQuestion,
    acknowledgeAnswer,
    nextDrill,
    timeExpired,
    completeLlmDrill,
    completeCognitiveDrill,
    saveSession,
    reset
  };
}
