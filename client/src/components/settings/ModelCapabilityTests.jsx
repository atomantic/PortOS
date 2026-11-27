/**
 * Capability tests for the installed local models.
 *
 * The assessments panel this sits inside answers "how fast is this model here".
 * This one answers the question speed cannot: **can it do what its badges
 * claim?** The badges are the gate — a test is offered exactly where the model
 * made a claim worth checking — and every run keeps the model's full output,
 * because reading what came back is the point.
 *
 * ## Three rules the UI has to carry
 *
 * 1. **An unclaimed capability is not a failure.** A model with no `vision`
 *    badge shows "not applicable" on the image test, in muted grey, never a red
 *    X. A red cell always means "it said it could, and it could not".
 * 2. **No cold-bootstrap LLM calls** (root AGENTS.md). The report loads with the
 *    tab and calls nothing. Running a test goes through a consent gate that
 *    names the runtime, the model, the test and the prompt first.
 * 3. **Show the output.** Every result view leads with what the model actually
 *    produced; the score sits beside it, never in place of it.
 *
 * The drawer is one component in three states (gate → live → result) rather than
 * three drawers, so starting a run never closes and reopens a panel, and the
 * live transcript is already on screen when the first frame arrives.
 */

import ListLoadError from '../ui/ListLoadError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  FlaskConical, Play, RefreshCw, AlertTriangle, Search, Trophy,
} from 'lucide-react';
import socket from '../../services/socket';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import Pill from '../ui/Pill';
import CapabilityTestDrawer from './CapabilityTestDrawer.jsx';
import { TestCell } from './ModelTestCell.jsx';
import CapabilityBadges from '../models/CapabilityBadges.jsx';
import useUrlParams from '../../hooks/useUrlParams';
import useMounted from '../../hooks/useMounted';
import {
  runModelCapabilityTest,
  deleteModelCapabilityTest,
  getModelCapabilityTestResult,
} from '../../services/apiLocalLlm.js';

const modelKey = (backend, modelId) => `${backend}:${modelId}`;

/**
 * How many streamed transcript lines the live view keeps.
 *
 * A ten-minute agent run emits thousands, and every one re-renders the drawer
 * and copies the whole array. The view is a scrolling tail anyway, and the FULL
 * transcript is stored server-side and shown on the Transcript tab once the run
 * finishes — so capping the preview loses nothing a reader can see.
 */
const MAX_LIVE_LINES = 400;

const CLOSED_PARAMS = { capBackend: null, capModel: null, capTest: null };

/** Everything the drawer needs about one model+test pairing. */
const pairFor = (report, backend, modelId, testId) => {
  const model = report?.models?.find((m) => m.backend === backend && m.modelId === modelId) || null;
  const test = report?.tests?.find((t) => t.id === testId) || null;
  const slot = model?.tests?.find((t) => t.testId === testId) || null;
  return { model, test, slot };
};

const TASK_FILTERS = [
  { id: 'all', label: 'All tests' },
  { id: 'coding', label: 'Coding', testIds: ['sandbox-repair'] },
  { id: 'vision', label: 'Vision', testIds: ['image-analysis'] },
  // Older servers shipped only the outline proxy. Prefer the prose check when
  // present, but keep the filter useful during a rolling upgrade.
  { id: 'writing', label: 'Writing', testIds: ['fiction-scene', 'story-outline'] },
  { id: 'rhetoric', label: 'Rhetoric', testIds: ['rhetoric-reference'] },
];

const verdictRank = { passed: 2, partial: 1, failed: 0 };

const taskScore = (taskId, result) => {
  if (!result?.verdict || !Number.isFinite(verdictRank[result.verdict])) return null;
  const detail = result.detail || {};
  if (taskId === 'vision' && Number.isFinite(detail.requiredTotal) && detail.requiredTotal > 0) {
    const required = detail.requiredHit / detail.requiredTotal;
    const bonus = Number.isFinite(detail.bonusTotal) && detail.bonusTotal > 0
      ? detail.bonusHit / detail.bonusTotal
      : 0;
    return required * 0.8 + bonus * 0.2;
  }
  if (taskId === 'writing' && Number.isFinite(detail.requiredTotal) && detail.requiredTotal > 0) {
    const anchors = detail.requiredHit / detail.requiredTotal;
    const beats = Number.isFinite(detail.total) && detail.total > 0 && Number.isFinite(detail.found)
      ? detail.found / detail.total
      : 0;
    const craft = Number.isFinite(detail.wordCount)
      ? Object.values(detail.craft || {}).filter(Boolean).length / Math.max(1, Object.keys(detail.craft || {}).length)
      : 0;
    return detail.total ? beats : anchors * 0.7 + craft * 0.3;
  }
  if (taskId === 'rhetoric' && Number.isFinite(detail.meanAbsoluteError)) {
    return Math.max(0, 1 - detail.meanAbsoluteError / 100);
  }
  return verdictRank[result.verdict] / 2;
};

const taskTest = (tests, task) => (task?.testIds || [])
  .map((id) => tests.find((test) => test.id === id))
  .find(Boolean) || null;

// A structural pass is the primary evidence. When several models tie, prefer
// an explicit specialization in the installed model id before falling back to
// a stable name sort; this keeps a coding-specialist or fiction-tuned model
// from losing to an unrelated model merely because its name sorts later.
const specializationScore = (taskId, model) => {
  const id = String(model?.modelId || '').toLowerCase();
  if (taskId === 'coding') return /coder|code/.test(id) ? 2 : 0;
  if (taskId === 'writing') return /fable|fiction|writer|story/.test(id) ? 2 : 0;
  if (taskId === 'rhetoric') return /writer|story|reason|instruct/.test(id) ? 2 : 0;
  return 0;
};

const bestForTask = (models, tests, task) => {
  if (!task || task.id === 'all') return null;
  const candidates = (models || []).flatMap((model) => {
    const test = taskTest(tests, task);
    const slot = test && model.tests?.find((entry) => entry.testId === test.id);
    const score = taskScore(task.id, slot?.result);
    return score === null ? [] : [{ model, test, slot, score }];
  });
  return candidates.sort((a, b) => b.score - a.score
    || (verdictRank[b.slot.result.verdict] - verdictRank[a.slot.result.verdict])
    || (specializationScore(task.id, b.model) - specializationScore(task.id, a.model))
    || String(a.model.modelId).localeCompare(String(b.model.modelId)))[0] || null;
};

// ---- small shared bits ------------------------------------------------------

const isRunnable = (slot) => slot?.state === 'applicable' || slot?.state === 'unknown';

function RunAllButton({ model, tests, disabled, onReview }) {
  const runnable = (model.tests || []).filter(isRunnable)
    .flatMap((slot) => {
      const test = tests.find((entry) => entry.id === slot.testId);
      return test ? [{ ...test, unverified: slot.state === 'unknown' }] : [];
    });
  if (!runnable.length) return null;
  return (
    <button
      type="button"
      onClick={() => onReview(model, runnable)}
      disabled={disabled}
      title={`Review the ${runnable.length} test${runnable.length === 1 ? '' : 's'} that apply to ${model.modelId}, one after another`}
      className="inline-flex items-center gap-1.5 px-2 py-1 pointer-coarse:min-h-11 text-[11px] rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white transition-colors disabled:opacity-50 whitespace-nowrap"
    >
      <Play size={10} /> Run {runnable.length}
    </button>
  );
}

function CapabilityRecommendations({ report, onOpen, stale, disabled }) {
  const tests = report?.tests || [];
  const models = report?.models || [];
  const tasks = TASK_FILTERS.filter((task) => task.id !== 'all');
  return (
    <div className="bg-port-bg border border-port-accent/30 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-gray-300">
        <Trophy size={12} className="text-port-accent" />
        <h4 className="font-medium">Evidence-based task picks</h4>
        <span className="text-[10px] text-gray-500">recorded checks only</span>
      </div>
      <p className="text-[11px] text-gray-500 leading-snug">
        These leaders are task-specific, not a generic model rank. Unmeasured models are left out; the
        writing result is a structural screen, so open the saved scene before choosing a voice. Tied
        structural results favor an explicitly task-specialized model name.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {tasks.map((task) => {
          const winner = bestForTask(models, tests, task);
          return (
            <div key={task.id} className="bg-port-card border border-port-border/70 rounded p-2 space-y-1.5">
              <div className="text-[11px] text-gray-300">Best {task.label.toLowerCase()} evidence</div>
              {winner ? (
                <>
                  <div className="text-[11px] text-white font-mono break-all">{winner.model.modelId}</div>
                  <div className="text-[10px] text-gray-500">{winner.model.runtimeLabel} · {winner.slot.result.summary}</div>
                  <button
                    type="button"
                    onClick={() => onOpen(winner.model.backend, winner.model.modelId, winner.test.id)}
                    disabled={disabled}
                    className="px-2 py-1 pointer-coarse:min-h-11 rounded border border-port-border text-[10px] text-port-accent hover:border-port-accent disabled:opacity-50"
                  >
                    Read the result
                  </button>
                </>
              ) : !stale && (
                <span className="text-[10px] text-gray-600 italic">Run the {task.label.toLowerCase()} check to rank it.</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- the panel --------------------------------------------------------------

export default function ModelCapabilityTests({ report, loading, error, onReload, disabled = false }) {
  const [searchParams, updateParams] = useUrlParams();
  const backend = searchParams.get('capBackend') || '';
  const modelId = searchParams.get('capModel') || '';
  const testId = searchParams.get('capTest') || '';
  const open = Boolean(backend && modelId && testId);

  const [liveLines, setLiveLines] = useState([]);
  const [progress, setProgress] = useState('');
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Consent snapshots the reviewed selection. Each request still runs one test.
  const [batch, setBatch] = useState(null);
  const [queue, setQueue] = useState(null);
  const [modelQuery, setModelQuery] = useState('');
  const [taskFilter, setTaskFilter] = useState('all');
  const mountedRef = useMounted();

  // Which pairing is in flight. A ref, not state: the socket handler subscribes
  // once and must read the CURRENT target, not the one captured at registration.
  const activeRef = useRef(null);
  // A run occupies the local runtime for minutes. Without an abort, closing the
  // drawer would leave it running with nobody listening.
  const controllerRef = useRef(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const openTest = useCallback((b, m, t) => {
    setLiveLines([]);
    setProgress('');
    updateParams({ capBackend: b, capModel: m, capTest: t });
  }, [updateParams]);

  const reviewBatch = (model, tests) => setBatch({
    backend: model.backend,
    modelId: model.modelId,
    runtimeLabel: model.runtimeLabel || model.backend,
    tests: tests.map((test) => ({ ...test, prompt: report?.prompts?.[test.id] || '' })),
  });

  const closeTest = useCallback(() => {
    if (batch) {
      setBatch(null);
      return;
    }
    controllerRef.current?.abort();
    controllerRef.current = null;
    activeRef.current = null;
    setRunning(false);
    setQueue(null);
    setProgress('');
    // `replace` so closing does not leave a Back button that reopens a run the
    // user just stopped.
    updateParams(CLOSED_PARAMS, { replace: true });
  }, [batch, updateParams]);

  useEffect(() => {
    const onFrame = (frame) => {
      if (!mountedRef.current) return;
      if (frame?.scope !== 'capability-test') return;
      const active = activeRef.current;
      // Frames for a pairing this panel is not running (another tab, a run the
      // user already cancelled) are dropped: a stale line is worse than none.
      if (!active || frame.backend !== active.backend || frame.modelId !== active.modelId || frame.testId !== active.testId) return;
      if (frame.event === 'output' && frame.line) {
        setLiveLines((lines) => (lines.length >= MAX_LIVE_LINES
          ? [...lines.slice(1 - MAX_LIVE_LINES), frame.line]
          : [...lines, frame.line]));
        return;
      }
      if (frame.event === 'complete') { setProgress(''); return; }
      if (frame.message) setProgress(frame.message);
    };
    socket.on('localLlm:progress', onFrame);
    return () => socket.off('localLlm:progress', onFrame);
  }, [mountedRef]);

  const { model, test, slot } = useMemo(
    () => pairFor(report, backend, modelId, testId),
    [report, backend, modelId, testId],
  );

  // The report ships a SUMMARY of each result (verdict, score detail) — the
  // model output and the agent transcript are fetched only for the pairing the
  // drawer actually opens, so a page load does not carry every stored
  // transcript. `null` = not fetched yet, which renders as loading rather than
  // as "the model returned nothing".
  const [fullResult, setFullResult] = useState(null);
  const hasResult = Boolean(slot?.result);
  const resultKey = JSON.stringify([backend, modelId, testId, slot?.result?.ranAt]);
  useEffect(() => {
    if (batch || !open || !hasResult) { setFullResult(null); return undefined; }
    let live = true;
    // The drawer renders its own empty state, so the default toast is silenced
    // (client/src/AGENTS.md: custom catch ⇒ silent).
    getModelCapabilityTestResult(backend, modelId, testId, { silent: true })
      .then((record) => { if (live) setFullResult({ key: resultKey, record }); })
      .catch(() => { if (live) setFullResult(null); });
    return () => { live = false; };
  }, [batch, open, backend, modelId, testId, resultKey, hasResult]);

  /**
   * Run one or more tests against one model, in sequence.
   *
   * Sequential rather than parallel because they all contend for the same local
   * runtime: two at once would measure the contention, and the sandbox test
   * holds an agent loop for minutes. Stopping (closing the drawer) ends the
   * whole queue rather than advancing to the next test — the user asked for it
   * to stop.
   */
  const runTests = useCallback(async (runBackend, runModel, testIds) => {
    if (disabled || deleting || controllerRef.current || !testIds.length) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBatch(null);
    setRunning(true);
    let completed = 0;

    for (const [index, id] of testIds.entries()) {
      setQueue(testIds.length > 1 ? { total: testIds.length, index: index + 1 } : null);
      // Back skips the intermediate steps in a batch.
      updateParams({ capBackend: runBackend, capModel: runModel, capTest: id }, { replace: index > 0 });
      activeRef.current = { backend: runBackend, modelId: runModel, testId: id };
      setLiveLines([]);
      setProgress('Starting…');

      // The panel renders its own progress and error state, so the default toast
      // is silenced (client/src/AGENTS.md: custom catch ⇒ silent).
      const result = await runModelCapabilityTest(
        { backend: runBackend, modelId: runModel, testId: id },
        { signal: controller.signal, silent: true },
      ).catch((err) => {
        // Our own abort rejects with the generic unreachable message — that is
        // the user stopping the run, not a failure worth shouting about.
        if (!controller.signal.aborted) toast.error(err?.message || 'The capability test could not run');
        return null;
      });

      if (!mountedRef.current) return;
      if (controller.signal.aborted || !result || result.cancelled) break;
      completed += 1;
      toast.success(`${result.testId}: ${result.verdict} — ${result.summary}`);
    }

    if (controllerRef.current === controller) {
      controllerRef.current = null;
      activeRef.current = null;
      setRunning(false);
      setQueue(null);
    }
    if (completed) await onReload();
  }, [disabled, deleting, updateParams, onReload, mountedRef]);

  const removeResult = useCallback(async () => {
    setDeleting(true);
    const ok = await deleteModelCapabilityTest(backend, modelId, testId, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Could not discard that result'); return false; });
    if (!mountedRef.current) return;
    if (ok) {
      setLiveLines([]);
      await onReload();
    }
    if (mountedRef.current) setDeleting(false);
  }, [backend, modelId, testId, onReload, mountedRef]);

  // Summary first (it is always present and always current), with the fetched
  // output/transcript layered on when they arrive.
  const record = fullResult?.key === resultKey ? fullResult.record : null;
  const mergedSlot = useMemo(() => (slot?.result
    ? { ...slot, result: { ...slot.result, output: record?.output, transcript: record?.transcript } }
    : slot), [slot, record]);

  const tests = report?.tests || [];
  const models = report?.models || [];
  const busy = disabled || running || deleting;
  const selectedTask = TASK_FILTERS.find((task) => task.id === taskFilter) || TASK_FILTERS[0];
  const visibleTests = selectedTask.id === 'all'
    ? tests
    : tests.filter((test) => selectedTask.testIds.includes(test.id));
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return models.filter((model) => {
      const matchesQuery = !query || [model.modelId, model.runtimeLabel, ...(model.capabilities || [])]
        .some((value) => String(value).toLowerCase().includes(query));
      const matchesTask = selectedTask.id === 'all'
        || visibleTests.some((test) => model.tests?.some((slot) => slot.testId === test.id));
      return matchesQuery && matchesTask;
    });
  }, [models, modelQuery, selectedTask, visibleTests]);

  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <FlaskConical size={13} className="text-port-accent-2" />
          <h3 className="text-xs font-medium text-gray-300">Capability test suite</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-gray-500">
            {report
              ? [
                `${report.counts.models} model${report.counts.models === 1 ? '' : 's'}`,
                `${report.counts.applicable} applicable test${report.counts.applicable === 1 ? '' : 's'}`,
                report.counts.passed ? `${report.counts.passed} passed` : null,
                report.counts.failed ? `${report.counts.failed} failed` : null,
              ].filter(Boolean).join(' · ')
              : '—'}
          </span>
          <button
            type="button"
            onClick={onReload}
            disabled={loading}
            title="Refresh capability tests"
            aria-label="Refresh capability tests"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed">
        Each run saves its full output. A model missing a required capability shows as not applicable.
      </p>
      {report && <CapabilityRecommendations report={report} onOpen={openTest} stale={Boolean(error)} disabled={busy} />}

      {report?.listErrors?.length > 0 && (
        <div className="border border-port-warning/30 rounded p-2.5 space-y-1.5" role="alert">
          {report.listErrors.map((runtime) => (
            <p key={runtime.id} className="text-[11px] text-gray-400 flex items-start gap-1.5 leading-snug">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-port-warning" />
              <span>
                Could not list {runtime.label} models: {runtime.error}.
                {runtime.recovered > 0 && ` Showing ${runtime.recovered} cached model${runtime.recovered === 1 ? '' : 's'}.`}
                {runtime.docsUrl && !runtime.manageUrl && (
                  <> <a href={runtime.docsUrl} target="_blank" rel="noreferrer" className="text-port-accent hover:underline">Runtime documentation</a></>
                )}
              </span>
            </p>
          ))}
          <Link to="/models/llms-runtimes" className="text-[11px] text-port-accent hover:underline">View runtimes</Link>
        </div>
      )}

      {report?.readError && (
        <p className="text-xs text-port-warning flex items-center gap-1.5" role="alert">
          <AlertTriangle size={12} /> {report.readError} — the next run will start a fresh record.
        </p>
      )}

      {error && <ListLoadError what="capability tests" error={error} onRetry={onReload} retrying={loading} />}
      {loading && !report ? (
        <BrailleSpinner text="Loading capability tests" />
      ) : models.length === 0 ? !error && (
        <p className="text-xs text-gray-500">
          No local models are installed, so there is nothing to test yet.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor="capability-model-search" className="sr-only">Search models</label>
            <div className="relative min-w-[14rem] flex-1">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                id="capability-model-search"
                type="search"
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder="Search model, runtime, or capability"
                className="w-full bg-port-bg border border-port-border rounded pl-7 pr-2 py-1.5 text-xs text-white placeholder:text-gray-600"
              />
            </div>
            <label htmlFor="capability-task-filter" className="text-[11px] text-gray-500">Show</label>
            <select
              id="capability-task-filter"
              value={taskFilter}
              onChange={(event) => setTaskFilter(event.target.value)}
              className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white"
            >
              {TASK_FILTERS.map((task) => <option key={task.id} value={task.id}>{task.label}</option>)}
            </select>
            <span className="text-[10px] text-gray-600">{visibleModels.length} of {models.length} models</span>
          </div>
          {visibleModels.length === 0 ? !error && (
            <p className="text-xs text-gray-500">No models match this filter.</p>
          ) : (
            <div className="border border-port-border rounded overflow-x-auto">
          <table className="w-full min-w-[42rem] text-left">
            <thead>
              <tr className="bg-port-bg/60 border-b border-port-border">
                <th scope="col" className="px-3 py-2 text-[11px] font-normal text-gray-500">Model</th>
                {visibleTests.map((t) => (
                  <th key={t.id} scope="col" className="px-3 py-2 text-[11px] font-normal text-gray-500">{t.label}</th>
                ))}
                <th scope="col" className="px-3 py-2 text-[11px] font-normal text-gray-500 text-right">Run</th>
              </tr>
            </thead>
            <tbody>
              {visibleModels.map((m) => (
                <tr key={modelKey(m.backend, m.modelId)} className="border-b border-port-border/60 last:border-b-0">
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-200 font-mono break-all">{m.modelId}</span>
                      <span className="text-[10px] text-gray-500">{m.runtimeLabel}</span>
                      {m.offline && (
                        <Pill tone="bare" size="xs" className="border-port-warning/40 text-port-warning" title={`Found on disk — ${m.runtimeLabel} is not running, so nothing can be run against it yet.`}>
                          not running
                        </Pill>
                      )}
                    </div>
                    <div className="flex items-center gap-1 mt-1 flex-wrap">
                      <CapabilityBadges capabilities={m.capabilities} />
                    </div>
                  </td>
                  {visibleTests.map((t) => (
                    <td key={t.id} className="px-3 py-2 align-top">
                      <TestCell
                        slot={m.tests.find((s) => s.testId === t.id)}
                        disabled={busy}
                        onOpen={() => openTest(m.backend, m.modelId, t.id)}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2 align-top text-right">
                    <RunAllButton model={m} tests={tests} disabled={busy} onReview={reviewBatch} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
            </div>
          )}
        </>
      )}

      {(open || batch) && (
        <CapabilityTestDrawer
          batch={batch}
          resultKey={resultKey}
          disabled={disabled}
          modelId={modelId}
          test={test}
          slot={mergedSlot}
          model={model}
          prompt={report?.prompts?.[testId] || ''}
          runtimeLabel={model?.runtimeLabel || backend}
          running={running}
          liveLines={liveLines}
          progress={progress}
          deleting={deleting}
          queue={queue}
          onRun={batch
            ? () => runTests(batch.backend, batch.modelId, batch.tests.map((test) => test.id))
            : () => runTests(backend, modelId, [testId])}
          onDelete={removeResult}
          onClose={closeTest}
        />
      )}
    </div>
  );
}

