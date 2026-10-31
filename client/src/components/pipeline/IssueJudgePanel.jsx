/**
 * IssueJudgePanel (#2167, CWQE Phase 3) — the calibrated quality judge surface
 * on the issue page. Shows the composite `qualityScore = judge − slop penalty`
 * as a chip, the 9-dimension breakdown, the quote-test evidence, and the top
 * revisions, with a button to (re-)run the judge. The judge is a distinct model
 * from the writer (the writer/judge split), so the score is an adversarial second
 * opinion, not self-congratulation.
 *
 * Renders only for text stages (prose / comic script / teleplay) that have
 * drafted content — nothing to judge otherwise. The judge call is an explicit
 * user action (AI-provider policy).
 */

import { useEffect, useRef, useState } from 'react';
import { Scale, RefreshCw, AlertTriangle } from 'lucide-react';
import { getIssueJudge, judgeIssue } from '../../services/apiPipeline';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import ListLoadError from '../ui/ListLoadError';
import { timeAgo } from '../../utils/formatters';

// The 9 rubric dimensions in display order + short labels (mirrors the server's
// JUDGE_DIMENSIONS).
const DIMENSION_LABELS = [
  ['voiceAdherence', 'Voice'],
  ['beatCoverage', 'Beats'],
  ['characterVoice', 'Character voice'],
  ['plantsSeeded', 'Plants'],
  ['proseQuality', 'Prose'],
  ['continuity', 'Continuity'],
  ['canonCompliance', 'Canon'],
  ['loreIntegration', 'Lore'],
  ['engagement', 'Engagement'],
];

const TEXT_STAGES = new Set(['prose', 'comicScript', 'teleplay']);

const stageText = (stage) => (stage?.input?.trim() || stage?.output?.trim() || '');

// Pick the judgeable stage for the current view: the active text stage if it has
// content, else prose → comicScript → teleplay (mirrors pickJudgeContent).
function resolveJudgeStage(issue, stageId) {
  const stages = issue?.stages || {};
  if (TEXT_STAGES.has(stageId) && stageText(stages[stageId])) return stageId;
  for (const id of ['prose', 'comicScript', 'teleplay']) {
    if (stageText(stages[id])) return id;
  }
  return null;
}

const scoreTone = (v) => {
  if (v == null) return 'text-gray-400 border-port-border';
  if (v >= 7) return 'text-port-success border-port-success/40';
  if (v >= 5) return 'text-port-warning border-port-warning/40';
  return 'text-port-error border-port-error/40';
};

const dimTone = (v) => {
  if (v >= 7) return 'text-port-success';
  if (v >= 5) return 'text-port-warning';
  return 'text-port-error';
};

export default function IssueJudgePanel({ issue, stageId }) {
  // The stored score is tagged with the issue it describes: PipelineIssue stays
  // mounted across an issue switch, so an untagged score would keep showing the
  // previous issue's verdict until (or, on a failed read, instead of) the new one.
  const [read, setRead] = useState({ issueId: null, status: 'loading', judge: null, error: null });
  const [readAttempt, setReadAttempt] = useState(0);
  const [judgingFor, setJudgingFor] = useState(null);
  const [open, setOpen] = useState(false);
  const issueId = issue?.id;
  const issueIdRef = useRef(issueId);
  issueIdRef.current = issueId;
  // Bumped by every stored-score read and by a landed judge verdict, so a read
  // that started before the verdict (e.g. on returning to the issue mid-judge)
  // cannot put the pre-judge snapshot back.
  const readSeqRef = useRef(0);

  const judgeStageId = resolveJudgeStage(issue, stageId);
  // `stale` is computed server-side on the stored read only (the judge POST
  // returns none), so re-read whenever the judged draft changes.
  const judgedText = judgeStageId ? stageText(issue?.stages?.[judgeStageId]) : '';

  useEffect(() => {
    if (!issueId) return undefined;
    let canceled = false;
    const seq = ++readSeqRef.current;
    const isLatest = () => !canceled && seq === readSeqRef.current;
    getIssueJudge(issueId, { silent: true })
      .then((res) => { if (isLatest()) setRead({ issueId, status: 'ready', judge: res && res.status !== 'none' ? res : null, error: null }); })
      // A failed refresh keeps the score this issue already shows; the error row says it may be out of date.
      .catch((error) => {
        if (isLatest()) setRead((prev) => ({ issueId, status: 'error', judge: prev.issueId === issueId ? prev.judge : null, error }));
      });
    return () => { canceled = true; };
  }, [issueId, readAttempt, judgedText]);

  const [runJudge, running] = useAsyncAction(async () => {
    const forIssue = issueId;
    setJudgingFor(forIssue);
    const res = await judgeIssue(forIssue, judgeStageId ? { stageId: judgeStageId, force: true } : { force: true }, { silent: true });
    // A judge run outlives an issue switch; its verdict belongs to the issue it scored.
    if (issueIdRef.current === forIssue && res && res.status !== 'no-content') {
      readSeqRef.current++;
      setRead({ issueId: forIssue, status: 'ready', judge: res, error: null });
      setOpen(true);
      // Re-read the snapshot the POST just saved: it carries the authoritative
      // `stale` flag for a draft that changed while the judge ran.
      setReadAttempt((n) => n + 1);
    }
    return res;
  }, { errorMessage: 'Failed to judge issue' });

  const current = read.issueId === issueId ? read : { status: 'loading', judge: null, error: null };
  const judge = current.judge;
  const judgingHere = running && judgingFor === issueId;

  // Nothing drafted yet on any text stage → no judge surface.
  if (!judgeStageId) return null;

  const scored = judge && judge.status === 'complete';
  const quality = scored ? judge.qualityScore : null;

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Scale size={16} className="text-port-accent" />
          <span className="text-sm font-semibold text-white">Quality judge</span>
          {scored ? (
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm font-bold ${scoreTone(quality)}`}
              title="qualityScore = judge overall − deterministic slop penalty"
            >
              {quality?.toFixed(1)}
              <span className="text-[10px] font-normal text-gray-400">/ 10</span>
            </span>
          ) : (
            <span className="text-xs text-gray-500">
              {current.status === 'ready' ? 'not judged yet' : current.status === 'error' ? 'score unavailable' : 'loading…'}
            </span>
          )}
          {scored && judge.stale ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-port-warning" title="The draft changed since it was judged">
              <AlertTriangle size={11} /> stale
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => runJudge()}
          disabled={running}
          title={running && !judgingHere ? 'Another issue is still being judged' : undefined}
          className="inline-flex items-center gap-1.5 rounded-md border border-port-border px-2.5 py-1 text-xs text-gray-200 hover:bg-port-bg disabled:opacity-50"
        >
          <RefreshCw size={12} className={judgingHere ? 'animate-spin' : ''} />
          {judgingHere ? 'Judging…' : scored ? 'Re-judge' : 'Judge quality'}
        </button>
      </div>

      {current.status === 'error' ? (
        <ListLoadError what="the stored quality score" error={current.error} onRetry={() => setReadAttempt((n) => n + 1)} />
      ) : null}

      {scored ? (
        <div className="text-xs text-gray-400 flex items-center gap-3 flex-wrap">
          <span>overall <span className={`font-semibold ${dimTone(judge.overall)}`}>{judge.overall?.toFixed(1)}</span></span>
          <span>− slop <span className="font-semibold text-gray-300">{judge.slopPenalty?.toFixed(2)}</span></span>
          {judge.sceneVsSummaryRatio != null ? (
            <span>in-scene <span className="font-semibold text-gray-300">{Math.round(judge.sceneVsSummaryRatio * 100)}%</span></span>
          ) : null}
          {judge.judgedAt || judge.completedAt ? <span>{timeAgo(judge.completedAt || judge.judgedAt)}</span> : null}
          <button type="button" className="text-port-accent hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? 'hide breakdown' : 'show breakdown'}
          </button>
        </div>
      ) : null}

      {scored && judge.oneLineVerdict ? (
        <p className="text-xs italic text-gray-300 border-l-2 border-port-border pl-2">{judge.oneLineVerdict}</p>
      ) : null}

      {scored && open ? (
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {DIMENSION_LABELS.map(([key, label]) => {
              const d = judge.dimensions?.[key];
              if (!d) return null;
              return (
                <div key={key} className="bg-port-bg border border-port-border rounded px-2 py-1.5" title={d.weakestMoment || ''}>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-400 truncate">{label}</span>
                    <span className={`text-xs font-bold ${dimTone(d.score)}`}>{d.score}</span>
                  </div>
                  {d.fix ? <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-2">{d.fix}</p> : null}
                </div>
              );
            })}
          </div>

          {Array.isArray(judge.topRevisions) && judge.topRevisions.length ? (
            <div>
              <h4 className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Top revisions</h4>
              <ol className="list-decimal list-inside space-y-0.5 text-xs text-gray-300">
                {judge.topRevisions.map((r, i) => <li key={i}>{r}</li>)}
              </ol>
            </div>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Array.isArray(judge.weakestSentences) && judge.weakestSentences.length ? (
              <div>
                <h4 className="text-[11px] uppercase tracking-wide text-port-error/80 mb-1">Weakest lines</h4>
                <ul className="space-y-0.5 text-[11px] text-gray-400">
                  {judge.weakestSentences.map((s, i) => <li key={i} className="italic">“{s}”</li>)}
                </ul>
              </div>
            ) : null}
            {Array.isArray(judge.strongestSentences) && judge.strongestSentences.length ? (
              <div>
                <h4 className="text-[11px] uppercase tracking-wide text-port-success/80 mb-1">Strongest lines</h4>
                <ul className="space-y-0.5 text-[11px] text-gray-400">
                  {judge.strongestSentences.map((s, i) => <li key={i} className="italic">“{s}”</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
