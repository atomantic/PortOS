/**
 * SongAiPanel — AI generate/expand + evaluate for the Song editor.
 *
 * Two single-shot actions (the synchronous universe-builder pattern, not
 * streaming):
 *   - Generate / Expand → POST /api/rounds/:id/generate, merges the returned
 *     fields into the editor draft via `onApplyGenerated` (the parent owns Save,
 *     so generation never silently overwrites a persisted song).
 *   - Evaluate → POST /api/rounds/:id/evaluate, renders a score + strengths /
 *     weaknesses / suggestions verdict inline (read-only, no mutation).
 *
 * Provider/model default to the active provider server-side; no picker here
 * (matches the manuscript/universe one-button generate UX the user asked for).
 */

import { useState } from 'react';
import { Sparkles, Wand2, ClipboardCheck, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { generateRoundFor, evaluateRound } from '../../services/api';

const scoreColor = (n) => {
  if (n == null) return 'text-gray-400';
  if (n >= 80) return 'text-port-success';
  if (n >= 55) return 'text-port-warning';
  return 'text-port-error';
};

export default function SongAiPanel({ songId, onApplyGenerated }) {
  const [brief, setBrief] = useState('');
  const [mood, setMood] = useState('');
  const [busy, setBusy] = useState(null); // 'generate' | 'expand' | 'evaluate' | null
  const [verdict, setVerdict] = useState(null);

  const runGenerate = async (expandExisting) => {
    setBusy(expandExisting ? 'expand' : 'generate');
    const data = await generateRoundFor(
      songId,
      { brief: brief.trim(), mood: mood.trim(), expandExisting },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Generation failed'); return null; });
    setBusy(null);
    if (!data?.song) return;
    // The server already folded the prior draft in when expandExisting was set,
    // so the parent just applies the returned fields either way.
    onApplyGenerated(data.song);
    toast.success(expandExisting ? 'Draft expanded — review and Save' : 'Draft generated — review and Save');
  };

  const runEvaluate = async () => {
    setBusy('evaluate');
    const data = await evaluateRound(songId, {}, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Evaluation failed'); return null; });
    setBusy(null);
    if (data?.evaluation) setVerdict(data.evaluation);
  };

  const anyBusy = busy !== null;
  const labelCls = 'block text-xs text-gray-400 mb-1';
  const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none';

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Sparkles size={15} className="text-port-accent" /> AI assist
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="ai-brief" className={labelCls}>Brief (optional)</label>
          <input id="ai-brief" type="text" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. a travelling lament about leaving home" className={inputCls} />
        </div>
        <div>
          <label htmlFor="ai-mood" className={labelCls}>Mood / feel (optional)</label>
          <input id="ai-mood" type="text" value={mood} onChange={(e) => setMood(e.target.value)} placeholder="e.g. mournful, spacious, hymn-like" className={inputCls} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => runGenerate(false)} disabled={anyBusy} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50">
          {busy === 'generate' ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          Generate draft
        </button>
        <button type="button" onClick={() => runGenerate(true)} disabled={anyBusy} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50">
          {busy === 'expand' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          Expand current
        </button>
        <button type="button" onClick={runEvaluate} disabled={anyBusy} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50">
          {busy === 'evaluate' ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
          Evaluate
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Generate writes a full draft into the editor; Expand builds on what you have. Both replace the
        draft below — review and <strong>Save</strong> to keep. Evaluation is read-only.
      </p>

      {verdict && (
        <div className="border-t border-port-border pt-3 space-y-3">
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-bold ${scoreColor(verdict.score)}`}>{verdict.score ?? '—'}</span>
            <span className="text-xs text-gray-500">/ 100 performance-ready</span>
          </div>
          {verdict.summary && <p className="text-sm text-gray-300">{verdict.summary}</p>}
          {verdict.strengths?.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-port-success mb-1">Strengths</h3>
              <ul className="list-disc list-inside text-xs text-gray-300 space-y-0.5">
                {verdict.strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {verdict.weaknesses?.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-port-warning mb-1">Weaknesses</h3>
              <ul className="list-disc list-inside text-xs text-gray-300 space-y-0.5">
                {verdict.weaknesses.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {verdict.suggestions?.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-port-accent mb-1">Suggestions</h3>
              <ul className="list-disc list-inside text-xs text-gray-300 space-y-0.5">
                {verdict.suggestions.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
