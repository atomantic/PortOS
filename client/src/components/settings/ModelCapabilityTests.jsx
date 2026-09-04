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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  FlaskConical, Play, RefreshCw, Trash2, Check, X, AlertTriangle, Terminal, Eye, BookOpen, Wrench, Search, Trophy,
} from 'lucide-react';
import socket from '../../services/socket';
import Drawer from '../Drawer';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import Pill from '../ui/Pill';
import CapabilityBadges, { CAPABILITY_META } from '../models/CapabilityBadges.jsx';
import useUrlParams from '../../hooks/useUrlParams';
import useMounted from '../../hooks/useMounted';
import { formatDurationMs } from '../../utils/formatters';
import { runModelCapabilityTest, deleteModelCapabilityTest, getModelCapabilityTestResult } from '../../services/api';

// Per-test icon and accent. Keyed off the test id the SERVER ships, so a test
// added there renders with a sensible fallback rather than vanishing.
const TEST_META = {
  'sandbox-repair': { Icon: Wrench, cls: 'text-blue-400', border: 'border-blue-400/35' },
  'image-analysis': { Icon: Eye, cls: 'text-amber-400', border: 'border-amber-400/35' },
  'story-outline': { Icon: BookOpen, cls: 'text-port-accent-2', border: 'border-port-accent-2/35' },
  'fiction-scene': { Icon: BookOpen, cls: 'text-pink-400', border: 'border-pink-400/35' },
  'rhetoric-reference': { Icon: BookOpen, cls: 'text-green-400', border: 'border-green-400/35' },
};
const testMeta = (id) => TEST_META[id] || { Icon: FlaskConical, cls: 'text-gray-400', border: 'border-port-border' };

// A verdict's colour and word. `null` is NOT a verdict — it means the test has
// not been run, which every caller renders as its own thing rather than folding
// into "failed".
const VERDICT_META = {
  passed: { label: 'passed', cls: 'text-emerald-400 border-emerald-400/40', Icon: Check },
  partial: { label: 'partial', cls: 'text-port-warning border-port-warning/40', Icon: AlertTriangle },
  failed: { label: 'failed', cls: 'text-port-error border-port-error/40', Icon: X },
};

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

function VerdictChip({ verdict, children, title }) {
  const meta = VERDICT_META[verdict];
  if (!meta) return null;
  // `bare` because the tone is per-verdict rather than one of Pill's semantic
  // trio — Pill still owns the shape, size and icon slot.
  return (
    <Pill tone="bare" size="xs" icon={meta.Icon} title={title} className={meta.cls}>
      {children || meta.label}
    </Pill>
  );
}

/**
 * One cell of the matrix — and the only control that opens the drawer.
 *
 * The four states are deliberately visually distinct: a result is coloured, an
 * unclaimed capability is muted italic text with the reason in its tooltip, a
 * blocked test says what PortOS cannot do, and an untested applicable pairing is
 * a button that offers the run.
 */
function TestCell({ slot, onOpen, disabled }) {
  if (!slot) return null;
  if (slot.state === 'not-applicable') {
    return <span className="text-[11px] text-gray-600 italic" title={slot.reason || undefined}>{slot.reason || 'not applicable'}</span>;
  }
  if (slot.state === 'unavailable') {
    return <span className="text-[11px] text-gray-600 italic" title={slot.reason || undefined}>can&rsquo;t run here</span>;
  }
  const verdict = slot.result?.verdict || null;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className="text-left disabled:opacity-50"
      title={slot.result ? slot.result.summary : 'Not run yet — open to see what this test does'}
    >
      {verdict
        ? <VerdictChip verdict={verdict}>{slot.result.summary}</VerdictChip>
        : (
          <Pill tone="bare" size="xs" icon={Play} className="border-port-border text-gray-400 hover:border-port-accent hover:text-white transition-colors">
            not run
          </Pill>
        )}
    </button>
  );
}

/**
 * Run every test that applies to one model, in one click.
 *
 * Only the runnable ones are queued, and the count says how many that is before
 * the click — so "Run 2 tests" is a promise about how many provider calls are
 * about to happen, the same promise a single test's gate makes.
 */
function RunAllButton({ model, disabled, onRun }) {
  const runnable = (model.tests || []).filter((t) => t.state === 'applicable' || t.state === 'unknown');
  if (!runnable.length) return null;
  return (
    <button
      type="button"
      onClick={() => onRun(model.backend, model.modelId, runnable.map((t) => t.testId))}
      disabled={disabled}
      title={`Run the ${runnable.length} test${runnable.length === 1 ? '' : 's'} that apply to ${model.modelId}, one after another`}
      className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white transition-colors disabled:opacity-50 whitespace-nowrap"
    >
      <Play size={10} /> Run {runnable.length}
    </button>
  );
}

// ---- result rendering -------------------------------------------------------

/** Required/bonus keyword scoring for the vision test. */
function KeywordScore({ detail }) {
  const row = (entry, required) => (
    <div key={entry.id} className="flex items-center gap-2 py-1.5 border-b border-port-border/50 last:border-b-0">
      {entry.hit
        ? <Check size={13} className="text-emerald-400 shrink-0" aria-label="found" />
        : <X size={13} className={`${required ? 'text-port-error' : 'text-gray-600'} shrink-0`} aria-label="not found" />}
      <span className={`text-xs ${entry.hit ? 'text-gray-300' : 'text-gray-500'}`}>{entry.label}</span>
      <span className="ml-auto text-[10px] text-gray-600 font-mono">{entry.any.join(' | ')}</span>
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xs font-medium text-gray-400">Required</h4>
          <span className="text-[11px] text-gray-500">{detail.requiredHit} of {detail.requiredTotal} — all needed to pass</span>
        </div>
        {detail.required.map((entry) => row(entry, true))}
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xs font-medium text-gray-400">Bonus</h4>
          <span className="text-[11px] text-gray-500">{detail.bonusHit} of {detail.bonusTotal} — detail work, never fails a run</span>
        </div>
        {detail.bonus.map((entry) => row(entry, false))}
      </div>
    </div>
  );
}

/** Twelve-beat coverage for the story test. */
function BeatScore({ detail }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h4 className="text-xs font-medium text-gray-400">Beat coverage</h4>
        <span className="text-[11px] text-gray-500">
          {detail.found} of {detail.total}{detail.found > 1 && !detail.inOrder ? ' — out of order' : ' — in order'}
        </span>
      </div>
      {detail.beats.map((beat, i) => (
        <div key={beat.id} className="flex items-center gap-2 py-1.5 border-b border-port-border/50 last:border-b-0">
          {beat.hit
            ? <Check size={13} className="text-emerald-400 shrink-0" aria-label="present" />
            : <X size={13} className="text-port-error shrink-0" aria-label="missing" />}
          <span className={`text-xs ${beat.hit ? 'text-gray-300' : 'text-gray-500'}`}>{i + 1} · {beat.label}</span>
          {!beat.hit && <span className="ml-auto text-[10px] text-gray-600">missing</span>}
        </div>
      ))}
      <p className="text-[11px] text-gray-500 mt-2 leading-snug">
        Coverage is structure, not quality — it only says the model held a twelve-part shape across a long
        generation. Whether the outline is any good is above.
      </p>
    </div>
  );
}

/** Structural checks for the fiction scene, kept distinct from prose quality. */
function FictionScore({ detail }) {
  const row = (entry, required) => (
    <div key={entry.id} className="flex items-center gap-2 py-1.5 border-b border-port-border/50 last:border-b-0">
      {entry.hit
        ? <Check size={13} className="text-emerald-400 shrink-0" aria-label="found" />
        : <X size={13} className={`${required ? 'text-port-error' : 'text-gray-600'} shrink-0`} aria-label="not found" />}
      <span className={`text-xs ${entry.hit ? 'text-gray-300' : 'text-gray-500'}`}>{entry.label}</span>
      <span className="ml-auto text-[10px] text-gray-600 font-mono">{entry.any.join(' | ')}</span>
    </div>
  );
  const craftChecks = Object.entries(detail.craft || {});
  const craftPassed = craftChecks.filter(([, passed]) => passed).length;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div><dt className="text-gray-500">Words</dt><dd className="text-gray-200">{detail.wordCount ?? '—'}</dd></div>
        <div><dt className="text-gray-500">Paragraphs</dt><dd className="text-gray-200">{detail.paragraphCount ?? '—'}</dd></div>
        <div><dt className="text-gray-500">Dialogue</dt><dd className="text-gray-200">{detail.hasDialogue ? 'yes' : 'no'}</dd></div>
      </dl>
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xs font-medium text-gray-400">Scene anchors</h4>
          <span className="text-[11px] text-gray-500">{detail.requiredHit} of {detail.requiredTotal} — all needed to pass</span>
        </div>
        {(detail.required || []).map((entry) => row(entry, true))}
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xs font-medium text-gray-400">Scene signals</h4>
          <span className="text-[11px] text-gray-500">{detail.bonusHit} of {detail.bonusTotal}</span>
        </div>
        {(detail.bonus || []).map((entry) => row(entry, false))}
      </div>
      <p className="text-[11px] text-gray-500">Minimum craft checks: {craftPassed} of {craftChecks.length}</p>
      <p className="text-[11px] text-gray-500 leading-snug">
        This is a structural screen for a saved scene, not a literary-quality score. Read the scene above
        before choosing a writing model.
      </p>
    </div>
  );
}

/** On-disk checks for the sandbox test. */
function SandboxChecks({ detail }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-500 leading-snug">
        Every check reads the sandbox on disk after the agent stopped, never the transcript. A model that
        says it fixed the module scores nothing for saying so.
      </p>
      {(detail.checks || []).map((check) => (
        <div key={check.id} className="flex items-center gap-2 py-1.5 border-b border-port-border/50 last:border-b-0">
          {check.ok
            ? <Check size={13} className="text-emerald-400 shrink-0" aria-label="passed" />
            : <X size={13} className="text-port-error shrink-0" aria-label="failed" />}
          <span className={`text-xs ${check.ok ? 'text-gray-300' : 'text-gray-500'}`}>{check.label}</span>
        </div>
      ))}
      <dl className="grid grid-cols-2 gap-2 text-xs pt-1">
        <div><dt className="text-gray-500">Tool calls</dt><dd className="text-gray-200">{detail.toolCalls ?? 0}</dd></div>
        <div><dt className="text-gray-500">Verify exit code</dt><dd className="text-gray-200">{detail.verifyExitCode ?? '—'}</dd></div>
        <div className="col-span-2">
          <dt className="text-gray-500">Verified with</dt>
          <dd className="text-gray-300 font-mono break-all">{detail.verifyCommand}</dd>
        </div>
        {detail.sandboxPath && (
          <div className="col-span-2">
            <dt className="text-gray-500">Sandbox kept at</dt>
            <dd className="text-gray-400 font-mono break-all text-[11px]">{detail.sandboxPath}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Calibration summary for the committed rhetoric reference corpus. */
function RhetoricReferenceScore({ detail }) {
  const worst = [...(detail.items || [])]
    .sort((a, b) => b.absoluteError - a.absoluteError)
    .slice(0, 5);
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500 leading-snug">
        PortOS compares the model&rsquo;s scores with a fixed, fictional gold set. Lower error is better;
        the verdict also requires broad agreement so a model cannot hide a few extreme misses behind an average.
      </p>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div><dt className="text-gray-500">References</dt><dd className="text-gray-200">{detail.evaluatedCount ?? detail.referenceCount ?? '—'}</dd></div>
        <div><dt className="text-gray-500">Mean error</dt><dd className="text-gray-200">{detail.meanAbsoluteError ?? '—'} pts</dd></div>
        <div><dt className="text-gray-500">Within 10</dt><dd className="text-gray-200">{detail.within10Count ?? '—'}</dd></div>
        <div><dt className="text-gray-500">Within 20</dt><dd className="text-gray-200">{detail.within20Count ?? '—'}</dd></div>
      </dl>
      {worst.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-gray-400 mb-1">Largest calibration gaps</h4>
          {worst.map((item) => (
            <div key={item.id} className="flex items-center gap-2 py-1.5 border-b border-port-border/50 last:border-b-0 text-xs">
              <span className="font-mono text-gray-500">{item.id}</span>
              <span className="ml-auto text-gray-400">gold {item.expected}</span>
              <span className="text-gray-400">model {item.predicted}</span>
              <span className="text-port-warning">Δ {item.absoluteError}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SCORE_VIEWS = {
  'image-analysis': KeywordScore,
  'story-outline': BeatScore,
  'fiction-scene': FictionScore,
  'rhetoric-reference': RhetoricReferenceScore,
  'sandbox-repair': SandboxChecks,
};

// ---- the drawer -------------------------------------------------------------

/**
 * Gate → live → result, in one panel.
 *
 * Consent copy names the runtime, the model and the exact prompt before the
 * first call goes out — the same contract the assessment gate honours.
 */
function CapabilityTestDrawer({
  modelId, test, slot, model, prompt, runtimeLabel,
  running, liveLines, progress, onRun, onDelete, onClose, deleting, queue,
}) {
  const [tab, setTab] = useState('output');
  const liveRef = useRef(null);
  const result = slot?.result || null;
  const meta = testMeta(test?.id);

  // Follow the tail while the agent works — a transcript you have to scroll to
  // keep up with is not a live view.
  useEffect(() => {
    if (running && liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [running, liveLines]);

  // A finished run lands on its output rather than leaving the reader on the
  // transcript they were watching.
  useEffect(() => { if (!running && result) setTab('output'); }, [running, result]);

  if (!test) return null;
  const Icon = meta.Icon;
  const showTabs = Boolean(result) || running;
  // `undefined` transcript = still fetching, so the tab is offered rather than
  // hidden and then appearing under the reader a moment later.
  const hasTranscript = result?.transcript === undefined ? Boolean(result) : Boolean(result.transcript || liveLines.length);

  const tabs = showTabs
    ? [
      { id: 'output', label: 'Output' },
      { id: 'score', label: 'Checks' },
      ...(hasTranscript ? [{ id: 'transcript', label: 'Transcript' }] : []),
    ]
    : null;

  const ScoreView = SCORE_VIEWS[test.id];

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={test.label}
      subtitle={queue ? `${modelId} · ${runtimeLabel} · test ${queue.index} of ${queue.total}` : `${modelId} · ${runtimeLabel}`}
      tabs={tabs}
      activeTab={showTabs ? tab : undefined}
      onTabChange={setTab}
      // Closing IS stopping while a run is in flight, so both accidental
      // dismissal paths are shut off and the close button says what it will do.
      closeLabel={running ? (queue ? 'Stop the remaining tests' : 'Stop this test') : 'Close'}
      closeOnEsc={!running}
      closeOnBackdrop={!running}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <Icon size={16} className={`${meta.cls} shrink-0 mt-0.5`} />
          <div className="min-w-0">
            <p className="text-sm text-gray-300 leading-snug">{test.blurb}</p>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <span className="text-[11px] text-gray-500">needs</span>
              {test.capabilities.map((c) => (
                <span key={c} className="px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400">
                  {CAPABILITY_META[c]?.label || c}
                </span>
              ))}
            </div>
          </div>
        </div>

        {slot?.state === 'unknown' && (
          <p className="text-xs text-port-warning flex items-start gap-1.5" role="alert">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {runtimeLabel} lists model ids only, so PortOS cannot confirm this model claims the capability.
            Running the test is how you find out.
          </p>
        )}

        {/* ---- gate: shown until the first run of this pairing ---- */}
        {!showTabs && (
          <>
            <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
              <h3 className="text-xs font-medium text-gray-400">What PortOS will send</h3>
              <pre className="text-[11px] text-gray-300 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-56 overflow-y-auto">{prompt}</pre>
            </div>
            <p className="text-xs text-gray-500 leading-snug">
              This runs <span className="text-gray-300 font-mono break-all">{modelId}</span> on{' '}
              <span className="text-gray-300">{runtimeLabel}</span> once. It loads the model into memory and
              can hold the runtime for several minutes. The result stays on this machine — it describes this
              hardware and this install, so it is never synced to a peer.
            </p>
            {test.id === 'sandbox-repair' && (
              <p className="text-xs text-gray-500 leading-snug">
                The broken module, its test and the data file are copied into a throwaway sandbox first. The
                model only ever edits the copy, and PortOS runs the test itself afterwards to decide the verdict.
              </p>
            )}
          </>
        )}

        {/* ---- live ---- */}
        {running && (
          <div className="border border-port-accent/30 rounded-lg overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-port-border">
              <Terminal size={12} className="text-port-accent" />
              <span className="text-xs text-gray-300">{progress || 'Starting…'}</span>
              <BrailleSpinner className="ml-auto" />
            </div>
            {liveLines.length > 0 && (
              <div ref={liveRef} className="bg-port-bg p-3 max-h-72 overflow-y-auto">
                {liveLines.map((line, i) => (
                  // Lines are append-only and never reordered, so the index is a
                  // stable key here; the model's own text has no id to key on.
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={i} className="text-[11px] font-mono text-gray-400 whitespace-pre-wrap leading-relaxed">{line}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---- result ---- */}
        {showTabs && !running && result && (
          <>
            {tab === 'output' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <VerdictChip verdict={result.verdict}>{result.summary}</VerdictChip>
                  <span className="text-[11px] text-gray-500">
                    {formatDurationMs(result.elapsedMs)}
                    {result.timings?.tokensPerSecond ? ` · ${result.timings.tokensPerSecond} tok/s` : ''}
                  </span>
                </div>
                {result.error && (
                  <p className="text-xs text-port-warning flex items-start gap-1.5" role="alert">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {result.error}
                  </p>
                )}
                <div className="bg-port-bg border border-port-border rounded-lg p-3">
                  {/* `undefined` = the full record has not arrived yet (the report
                      carries summaries only); `''` = it arrived and the model
                      genuinely said nothing. Collapsing the two would show a
                      loading drawer as a silent model. */}
                  {result.output === undefined
                    ? <BrailleSpinner text="Loading the output" />
                    : (result.output.trim()
                      ? <pre className="text-sm text-gray-200 whitespace-pre-wrap break-all leading-relaxed font-sans">{result.output}</pre>
                      : <p className="text-xs text-gray-500 italic">The model returned no text.</p>)}
                </div>
              </div>
            )}
            {tab === 'score' && (result.detail && ScoreView
              ? <ScoreView detail={result.detail} />
              : <p className="text-xs text-gray-500">Nothing was scored — the run failed before it produced anything.</p>)}
            {tab === 'transcript' && (
              <div className="bg-port-bg border border-port-border rounded-lg p-3 max-h-[28rem] overflow-y-auto">
                {result.transcript === undefined && liveLines.length === 0
                  ? <BrailleSpinner text="Loading the transcript" />
                  : (
                    <pre className="text-[11px] font-mono text-gray-400 whitespace-pre-wrap break-all leading-relaxed">
                      {result.transcript?.trim() || liveLines.join('\n') || 'No agent transcript for this test.'}
                    </pre>
                  )}
              </div>
            )}
          </>
        )}

        <div className="flex items-center gap-2 pt-1 flex-wrap">
          <button
            type="button"
            onClick={onRun}
            disabled={running || deleting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-port-accent text-port-on-accent hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Play size={12} /> {running ? 'Running…' : (result ? 'Run again' : `Run ${test.label.toLowerCase()}`)}
          </button>
          {result && !running && (
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-port-border text-gray-300 hover:border-port-error hover:text-port-error transition-colors disabled:opacity-50"
            >
              <Trash2 size={12} /> Discard this result
            </button>
          )}
          {model?.capabilities === null && (
            <span className="text-[11px] text-gray-500">claim unverified</span>
          )}
        </div>
      </div>
    </Drawer>
  );
}

function CapabilityRecommendations({ report, onOpen }) {
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
      <div className="grid gap-2 sm:grid-cols-3">
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
                    className="text-[10px] text-port-accent hover:underline"
                  >
                    Read the result
                  </button>
                </>
              ) : (
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

export default function ModelCapabilityTests({ report, loading, onReload, disabled = false }) {
  const [searchParams, updateParams] = useUrlParams();
  const backend = searchParams.get('capBackend') || '';
  const modelId = searchParams.get('capModel') || '';
  const testId = searchParams.get('capTest') || '';
  const open = Boolean(backend && modelId && testId);

  const [liveLines, setLiveLines] = useState([]);
  const [progress, setProgress] = useState('');
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Position within a multi-test run, or `null` for a single one. The server
  // deliberately takes ONE test per request — a client that could post a list
  // would turn one click into a batch of provider calls the gate never counted —
  // so "run everything applicable" is a queue here, not a wider endpoint.
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

  const closeTest = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    activeRef.current = null;
    setRunning(false);
    setQueue(null);
    setProgress('');
    // `replace` so closing does not leave a Back button that reopens a run the
    // user just stopped.
    updateParams(CLOSED_PARAMS, { replace: true });
  }, [updateParams]);

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
  useEffect(() => {
    if (!open || !slot?.result) { setFullResult(null); return undefined; }
    let live = true;
    // The drawer renders its own empty state, so the default toast is silenced
    // (client/src/AGENTS.md: custom catch ⇒ silent).
    getModelCapabilityTestResult(backend, modelId, testId, { silent: true })
      .then((record) => { if (live) setFullResult(record); })
      .catch(() => { if (live) setFullResult(null); });
    return () => { live = false; };
  }, [open, backend, modelId, testId, slot?.result?.ranAt]);

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
    const list = (testIds || []).filter(Boolean);
    if (!list.length) return;
    let completed = 0;

    for (const [index, id] of list.entries()) {
      setQueue(list.length > 1 ? { total: list.length, index: index + 1 } : null);
      // `replace` after the first, so Back does not walk through every test of a
      // queue the user already watched finish.
      updateParams({ capBackend: runBackend, capModel: runModel, capTest: id }, { replace: index > 0 });

      const controller = new AbortController();
      controllerRef.current = controller;
      activeRef.current = { backend: runBackend, modelId: runModel, testId: id };
      setLiveLines([]);
      setProgress('Starting…');
      setRunning(true);

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
      setRunning(false);
      activeRef.current = null;
      controllerRef.current = null;

      // A stop or a failure ends the queue: pressing on would run minutes of
      // work the user just interrupted.
      if (!result || result.cancelled) break;
      completed += 1;
      toast.success(`${result.testId}: ${result.verdict} — ${result.summary}`);
    }

    setQueue(null);
    if (completed) await onReload();
  }, [updateParams, onReload, mountedRef]);

  const removeResult = useCallback(async () => {
    setDeleting(true);
    const ok = await deleteModelCapabilityTest(backend, modelId, testId, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Could not discard that result'); return false; });
    if (!mountedRef.current) return;
    setDeleting(false);
    if (ok) {
      setLiveLines([]);
      await onReload();
    }
  }, [backend, modelId, testId, onReload, mountedRef]);

  // Summary first (it is always present and always current), with the fetched
  // output/transcript layered on when they arrive.
  const mergedSlot = useMemo(() => (slot?.result
    ? { ...slot, result: { ...slot.result, output: fullResult?.output, transcript: fullResult?.transcript } }
    : slot), [slot, fullResult]);

  const tests = report?.tests || [];
  const models = report?.models || [];
  const busy = disabled || running;
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

  const openRecommended = useCallback((b, m, t) => {
    setLiveLines([]);
    setProgress('');
    updateParams({ capBackend: b, capModel: m, capTest: t });
  }, [updateParams]);

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
        Speed says how fast a model runs here; it cannot say whether the model can do the job. Each test below
        runs only where the model claims the matching capability — a model with no{' '}
        <span className="text-gray-400">vision</span> badge shows <em>not applicable</em> on the image test,
        never a failure. Nothing here calls a model until you press a button that names it, and every run keeps
        the full output.
      </p>

      {tests.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-3">
          {tests.map((t) => {
            const meta = testMeta(t.id);
            const Icon = meta.Icon;
            return (
              <div key={t.id} className={`bg-port-card border ${meta.border} rounded p-2.5 space-y-1.5`}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Icon size={13} className={meta.cls} />
                  <span className="text-xs font-medium text-gray-200">{t.label}</span>
                  <span className="text-[10px] text-gray-500">{t.capabilities.join(' · ')}</span>
                </div>
                <p className="text-[11px] text-gray-500 leading-snug">{t.blurb}</p>
              </div>
            );
          })}
        </div>
      )}

      <CapabilityRecommendations report={report} onOpen={openRecommended} />

      {/* A runtime PortOS could not reach. Every line carries the fix: for the
          runtimes PortOS can start, a link to the page that starts them; for the
          ones it cannot (vLLM and SGLang are containers the user runs), the
          docs. When PortOS listed the weights on disk anyway, it says so — those
          models ARE in the table below, just not runnable yet. */}
      {report?.listErrors?.length > 0 && (
        <div className="border border-port-warning/30 rounded p-2.5 space-y-1.5" role="alert">
          {report.listErrors.map((runtime) => (
            <p key={runtime.id} className="text-[11px] text-gray-400 flex items-start gap-1.5 leading-snug">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-port-warning" />
              <span>
                <span className="text-gray-300">{runtime.label}</span>{' '}
                {runtime.offline ? 'is not running' : 'could not be listed'}
                {runtime.recovered > 0
                  ? ` — showing the ${runtime.recovered} model${runtime.recovered === 1 ? '' : 's'} PortOS has on disk for it. Start it to run anything against them.`
                  : ' — any models it serves are missing from this table.'}
                {runtime.manageUrl
                  ? <> <Link to={runtime.manageUrl} className="text-port-accent hover:underline">Start {runtime.label}</Link></>
                  : (runtime.docsUrl && <> <a href={runtime.docsUrl} target="_blank" rel="noreferrer" className="text-port-accent hover:underline">How to start it</a></>)}
              </span>
            </p>
          ))}
        </div>
      )}

      {report?.readError && (
        <p className="text-xs text-port-warning flex items-center gap-1.5" role="alert">
          <AlertTriangle size={12} /> {report.readError} — the next run will start a fresh record.
        </p>
      )}

      {loading && !report ? (
        <BrailleSpinner text="Loading capability tests" />
      ) : models.length === 0 ? (
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
          {visibleModels.length === 0 ? (
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
                    <RunAllButton model={m} disabled={busy} onRun={runTests} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
            </div>
          )}
        </>
      )}

      {open && (
        <CapabilityTestDrawer
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
          onRun={() => runTests(backend, modelId, [testId])}
          onDelete={removeResult}
          onClose={closeTest}
        />
      )}
    </div>
  );
}

export { VerdictChip, TestCell };
