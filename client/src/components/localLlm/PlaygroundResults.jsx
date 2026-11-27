import { Brain, Clock, Copy, Gauge, MessageSquare, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import BrailleSpinner from '../BrailleSpinner';
import { copyToClipboard } from '../../lib/clipboard';
import PlaygroundOutput from './PlaygroundOutput';

function formatMs(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatRate(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(value >= 10 ? 1 : 2)} chars/s`;
}

// Ollama auto-evicts an idle model after `keep_alive` (5m default). `/api/ps`
// returns the absolute eviction time as `expires_at`; render it as a short
// "frees in 5m" countdown so the badge says when the slot frees itself. Reuses
// the shared future-relative formatter, returning null (badge hidden) once the
// slot has expired or no eviction time is reported.
function Metric({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-400">
      <Icon size={13} className="text-gray-500" />
      <span>{label}</span>
      <span className="text-gray-200">{value}</span>
    </div>
  );
}

function ResultPanel({ result, backendLabel }) {
  const ok = !result?.error;
  // A failed run that still streamed tokens before it stopped (e.g. a timeout) —
  // show the partial output alongside the error rather than hiding it.
  const hasPartial = Boolean(result?.error && result?.text);
  return (
    <section className={`border rounded-lg bg-port-bg p-3 space-y-3 ${ok ? 'border-port-border' : 'border-port-error/40'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-white truncate">{result.modelId}</div>
          <div className="text-xs text-gray-500">{backendLabel}</div>
        </div>
        <span className={`text-xs px-2 py-1 rounded ${ok ? 'bg-port-success/15 text-port-success' : hasPartial ? 'bg-port-warning/15 text-port-warning' : 'bg-port-error/15 text-port-error'}`}>
          {ok ? 'Done' : hasPartial ? 'Partial' : 'Failed'}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Metric icon={Clock} label="TTFT" value={formatMs(result.timings?.ttftMs)} />
        <Metric icon={Gauge} label="Total" value={formatMs(result.timings?.totalMs)} />
        <Metric icon={MessageSquare} label="Speed" value={formatRate(result.timings?.charsPerSecond)} />
      </div>

      {result.error && (
        <p role="alert" className="text-sm text-port-error whitespace-pre-wrap">{result.error}</p>
      )}
      {result.text && (
        <div className="space-y-1">
          {hasPartial && <div className="text-xs text-port-warning">Partial output before the run stopped</div>}
          <div className="max-h-[28rem] overflow-auto">
            <PlaygroundOutput text={result.text} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {result.runId && (
          <Link to={`/cos/runs?run=${encodeURIComponent(result.runId)}`} className="text-xs text-port-accent hover:underline">
            Run {result.runId.slice(0, 8)}
          </Link>
        )}
        {result.text && (
          <button
            onClick={() => copyToClipboard(result.text, 'Copied output')}
            className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
          >
            <Copy size={12} />
            Copy
          </button>
        )}
      </div>
    </section>
  );
}

// Live panel shown while a chat run streams tokens. Replaced by a final
// ResultPanel (with timings) once the run settles. Reasoning (a reasoning
// model's chain-of-thought) streams on its own channel and renders in a
// distinct "Thinking" block above the answer, so the answer text stays clean.
function StreamingPanel({ stream, backendLabel }) {
  const hasReasoning = Boolean(stream.reasoning);
  const hasText = Boolean(stream.text);
  return (
    <section className="border border-port-accent/40 rounded-lg bg-port-bg p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-white truncate">{stream.modelId}</div>
          <div className="text-xs text-gray-500">{backendLabel}</div>
        </div>
        <span className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-port-accent/15 text-port-accent">
          <BrailleSpinner />
          {!hasText && hasReasoning ? 'Thinking' : 'Streaming'}
        </span>
      </div>
      {hasReasoning && (
        <div className="rounded-lg border border-port-border bg-port-card/40 p-2 space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Brain size={12} className="text-gray-600" />
            Thinking
          </div>
          <div className="max-h-48 overflow-auto text-xs text-gray-400 whitespace-pre-wrap break-words">
            {stream.reasoning}
          </div>
        </div>
      )}
      {hasText
        ? <div className="max-h-[28rem] overflow-auto"><PlaygroundOutput text={stream.text} /></div>
        : !hasReasoning && <div className="text-sm text-gray-500">Waiting for the first token…</div>}
    </section>
  );
}

export default function PlaygroundResults({ activeMode, streamingChat, chatResults, compareResult, backendLabel }) {
  if (activeMode === 'chat') {
    return (
      <section className="space-y-3">
        {streamingChat && <StreamingPanel stream={streamingChat} backendLabel={backendLabel(streamingChat.backend)} />}
        {chatResults.length === 0 && !streamingChat ? (
          <EmptyResult>Pick a model, enter a prompt, and run a chat test.</EmptyResult>
        ) : chatResults.map((result, idx) => (
          <ResultPanel key={`${result.runId || idx}-${result.modelId}`} result={result} backendLabel={backendLabel(result.backend)} />
        ))}
      </section>
    );
  }

  return compareResult ? (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {compareResult.results.map((result, idx) => (
        <ResultPanel key={`${result.runId || idx}-${result.modelId}`} result={result} backendLabel={backendLabel(result.backend)} />
      ))}
    </section>
  ) : <EmptyResult>Select one or more models and run the same prompt through them.</EmptyResult>;
}

function EmptyResult({ children }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-5 text-sm text-gray-500 flex items-center gap-2">
      <TriangleAlert size={16} className="text-gray-600" />
      {children}
    </div>
  );
}
