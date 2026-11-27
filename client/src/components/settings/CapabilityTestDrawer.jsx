import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Eye, FlaskConical, Play, Terminal, Trash2, Wrench } from 'lucide-react';
import { formatDurationMs } from '../../utils/formatters';
import BrailleSpinner from '../BrailleSpinner';
import Drawer from '../Drawer';
import { CAPABILITY_META } from '../models/CapabilityBadges.jsx';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import CapabilityTestScore from './CapabilityTestScore.jsx';
import { VerdictChip } from './ModelTestCell.jsx';

// Per-test icon and accent. Keyed off the test id the SERVER ships, so a test
// added there renders with a sensible fallback rather than vanishing.
const TEST_META = {
  'sandbox-repair': { Icon: Wrench, cls: 'text-blue-400' },
  'image-analysis': { Icon: Eye, cls: 'text-amber-400' },
  'story-outline': { Icon: BookOpen, cls: 'text-port-accent-2' },
  'fiction-scene': { Icon: BookOpen, cls: 'text-pink-400' },
  'rhetoric-reference': { Icon: BookOpen, cls: 'text-green-400' },
};
const testMeta = (id) => TEST_META[id] || { Icon: FlaskConical, cls: 'text-gray-400' };

const runButtonClass = 'flex items-center gap-1.5 px-3 py-1.5 pointer-coarse:min-h-11 text-xs font-medium rounded bg-port-accent text-port-on-accent hover:opacity-90 transition-opacity disabled:opacity-50';

const SandboxNote = () => (
  <p className="text-xs text-gray-500 leading-snug">
    The broken module, its test and the data file are copied into a throwaway sandbox first. The
    model only ever edits the copy, and PortOS runs the test itself afterwards to decide the verdict.
  </p>
);

function TestPrompt({ prompt }) {
  return <pre className="text-[11px] text-gray-300 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-56 overflow-y-auto">{prompt}</pre>;
}

function BatchConsent({ batch, disabled, onRun, onClose }) {
  const count = batch.tests.length;
  const label = count === 1 ? '1 capability test' : `${count} capability tests`;
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-300 break-words">
        This runs <span className="font-mono">{batch.modelId}</span> on {batch.runtimeLabel}.
        Tests run in the order shown and can hold the runtime for several minutes each. Results stay on this machine.
      </p>
      <ol className="list-decimal pl-5 space-y-3">
        {batch.tests.map(({ id, label, blurb, prompt, unverified }) => (
          <li key={id} className="pl-1.5 space-y-1 text-xs text-gray-300">
            <h3 className="font-medium">{label}</h3>
            <p className="text-gray-400">{blurb}</p>
            {unverified && <p className="text-port-warning">This runtime does not report whether the model claims this capability.</p>}
            {id === 'sandbox-repair' && <SandboxNote />}
            <details>
              <summary className="cursor-pointer text-gray-400 pointer-coarse:min-h-11 pointer-coarse:content-center">What PortOS will send</summary>
              <TestPrompt prompt={prompt} />
            </details>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={onRun} disabled={disabled} className={runButtonClass}>
          <Play size={12} /> Run {label}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 pointer-coarse:min-h-11 text-xs rounded border border-port-border text-gray-300 hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function DiscardResult({ onDelete, deleting }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <ConfirmButtonPair
        prompt="Discard the saved result and transcript?"
        confirmText="Discard result"
        confirmIcon={Trash2}
        onConfirm={onDelete}
        onCancel={() => setConfirming(false)}
        busy={deleting}
        busyText="Discarding…"
        className="flex-wrap"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      disabled={deleting}
      className="flex items-center gap-1.5 px-3 py-1.5 pointer-coarse:min-h-11 text-xs rounded border border-port-border text-gray-300 hover:border-port-error hover:text-port-error transition-colors disabled:opacity-50"
    >
      <Trash2 size={12} /> Discard this result
    </button>
  );
}

/** Consent, live progress and saved results share one drawer. */
export default function CapabilityTestDrawer({
  modelId, test, slot, model, prompt, runtimeLabel, resultKey,
  batch, disabled, running, liveLines, progress, onRun, onDelete, onClose, deleting, queue,
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

  if (batch) {
    return (
      <Drawer open onClose={onClose} size="lg" title="Review capability tests" closeLabel="Close">
        <BatchConsent batch={batch} disabled={disabled} onRun={onRun} onClose={onClose} />
      </Drawer>
    );
  }
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
              <TestPrompt prompt={prompt} />
            </div>
            <p className="text-xs text-gray-500 leading-snug">
              This runs <span className="text-gray-300 font-mono break-all">{modelId}</span> on{' '}
              <span className="text-gray-300">{runtimeLabel}</span> once. It loads the model into memory and
              can hold the runtime for several minutes. The result stays on this machine — it describes this
              hardware and this install, so it is never synced to a peer.
            </p>
            {test.id === 'sandbox-repair' && <SandboxNote />}
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
            {tab === 'score' && <CapabilityTestScore testId={test.id} detail={result.detail} />}
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
            disabled={disabled || running || deleting}
            className={runButtonClass}
          >
            <Play size={12} /> {running ? 'Running…' : (result ? 'Run again' : `Run ${test.label.toLowerCase()}`)}
          </button>
          {result && !running && (
            <DiscardResult
              key={resultKey}
              onDelete={onDelete}
              deleting={deleting}
            />
          )}
          {model?.capabilities === null && (
            <span className="text-[11px] text-gray-500">claim unverified</span>
          )}
        </div>
      </div>
    </Drawer>
  );
}
