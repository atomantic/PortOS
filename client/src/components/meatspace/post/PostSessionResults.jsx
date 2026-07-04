import { useState } from 'react';
import { CheckCircle, Save, ArrowLeft, ChevronDown, ChevronUp, Dumbbell } from 'lucide-react';
import { LLM_DRILL_TYPES, DRILL_TO_DOMAIN, DOMAINS, DRILL_LABELS, nBackBalancedAccuracy } from './constants';
import DrillQuestionReview from './DrillQuestionReview';

export default function PostSessionResults({ session, tags = {}, onSaved, onBack }) {
  const { drillResults, sessionScore, state, saveSession, isTraining } = session;
  const [expandedDrill, setExpandedDrill] = useState(null);

  const scoreColor = sessionScore >= 80 ? 'text-port-success' :
    sessionScore >= 50 ? 'text-port-warning' : 'text-port-error';

  async function handleSave() {
    const savedSession = await saveSession(tags);
    if (savedSession) onSaved();
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Overall Score */}
      <div className="text-center py-8">
        <div className="flex items-center justify-center gap-3 mb-2">
          {isTraining ? <Dumbbell size={28} className="text-port-accent-2" /> : <CheckCircle size={28} className={scoreColor} />}
          <span className="text-sm text-gray-400">{isTraining ? 'Training Session' : 'Session Score'}</span>
        </div>
        {isTraining ? (
          <div className="text-2xl text-port-accent-2 font-medium">Practice Complete</div>
        ) : (
          <div className={`text-6xl font-mono font-bold ${scoreColor}`}>
            {sessionScore}
          </div>
        )}
      </div>

      {/* Domain Scores (for multi-domain sessions) */}
      {(() => {
        const byDomain = {};
        for (const r of drillResults) {
          const dk = DRILL_TO_DOMAIN[r.type];
          if (dk) {
            if (!byDomain[dk]) byDomain[dk] = [];
            byDomain[dk].push(r.score || 0);
          }
        }
        const domainKeys = Object.keys(byDomain);
        if (domainKeys.length < 2) return null;
        return (
          <div className="flex justify-center gap-4">
            {domainKeys.map(dk => {
              const d = DOMAINS[dk];
              const avg = Math.round(byDomain[dk].reduce((a, b) => a + b, 0) / byDomain[dk].length);
              const sc = avg >= 80 ? 'text-port-success' : avg >= 50 ? 'text-port-warning' : 'text-port-error';
              return (
                <div key={dk} className={`flex flex-col items-center gap-1 px-3 py-2 rounded-lg ${d?.bgColor || 'bg-port-card'}`}>
                  <span className={`text-xs font-medium ${d?.color || 'text-gray-400'}`}>{d?.label || dk}</span>
                  <span className={`text-lg font-mono font-bold ${sc}`}>{avg}</span>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Per-drill Breakdown */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Drill Breakdown</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3">
          {drillResults.map((result, i) => {
            const isLlm = LLM_DRILL_TYPES.includes(result.type);
            const isExpanded = expandedDrill === i;

            let subtitle;
            if (isLlm) {
              const summary = result.evaluation?.summary;
              subtitle = summary || `${result.responses?.length || 0} responses`;
            } else {
              // Accuracy (answered-only) and speed are shown separately from the
              // blended score (issue #2094). Prefer the server-persisted metrics;
              // this pre-save view falls back to deriving from questions[] since
              // the session hasn't been scored server-side yet. n-back is a go/no-go
              // task: a withheld press ("answered: null") is a deliberate no-match
              // decision, not an unreached trial — every trial counts as reached
              // (completion 100%, matching the server's completion=1), and its
              // accuracy fallback is the balanced signal-detection derivation
              // (raw `correct` averaging would pay ~70% for never pressing).
              const questions = result.questions || [];
              const noGo = result.type === 'n-back';
              const reached = noGo ? questions : questions.filter(q => q.answered !== null);
              const derivedAcc = noGo
                ? nBackBalancedAccuracy(questions)
                : (reached.length > 0 ? reached.filter(q => q.correct).length / reached.length : null);
              const accPct = result.accuracy != null
                ? Math.round(result.accuracy * 100)
                : (derivedAcc != null ? Math.round(derivedAcc * 100) : null);
              const compPct = result.completion != null
                ? Math.round(result.completion * 100)
                : (questions.length > 0 ? Math.round((reached.length / questions.length) * 100) : null);
              const timed = reached.filter(q => q.responseMs > 0);
              const avgMs = result.avgResponseMs != null
                ? result.avgResponseMs
                : (timed.length > 0 ? Math.round(timed.reduce((s, q) => s + q.responseMs, 0) / timed.length) : null);
              const parts = [];
              if (accPct != null) parts.push(`${accPct}% acc`);
              if (avgMs != null) parts.push(`${(avgMs / 1000).toFixed(1)}s`);
              if (compPct != null && compPct < 100) parts.push(`${compPct}% done`);
              subtitle = parts.join(' · ') || `${questions.length} questions`;
            }

            const drillScoreColor = (result.score || 0) >= 80 ? 'text-port-success' :
              (result.score || 0) >= 50 ? 'text-port-warning' : 'text-port-error';

            return (
              <div key={i}>
                <button
                  onClick={() => setExpandedDrill(isExpanded ? null : i)}
                  className="w-full flex items-center justify-between hover:bg-port-bg/50 rounded px-1 py-1 transition-colors"
                >
                  <div className="text-left">
                    <span className="text-white text-sm">{DRILL_LABELS[result.type] || result.type}</span>
                    <span className="text-gray-500 text-xs ml-2">{subtitle}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono font-medium ${drillScoreColor}`}>
                      {result.score || 0}
                    </span>
                    {isExpanded ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
                  </div>
                </button>

                {/* LLM Feedback Expansion */}
                {isLlm && isExpanded && result.evaluation && (
                  <div className="mt-2 ml-2 space-y-2">
                    {(result.responses || []).map((r, ri) => {
                      const score = r.llmScore ?? result.evaluation?.scores?.[ri]?.score;
                      const feedback = r.llmFeedback || result.evaluation?.scores?.[ri]?.feedback;
                      const sc = (score || 0) >= 80 ? 'text-port-success' : (score || 0) >= 50 ? 'text-port-warning' : 'text-port-error';
                      return (
                        <div key={ri} className="bg-port-bg border border-port-border rounded p-3 text-sm">
                          <div className="flex justify-between mb-1">
                            <span className="text-gray-400 text-xs">Response {ri + 1}</span>
                            {score != null && <span className={`font-mono text-xs ${sc}`}>{score}</span>}
                          </div>
                          <p className="text-white text-xs mb-1">{r.response || r.items?.join(', ') || r.answers?.join(', ') || '—'}</p>
                          {feedback && <p className="text-gray-500 text-xs italic">{feedback}</p>}
                        </div>
                      );
                    })}
                    {result.evaluation?.summary && (
                      <p className="text-gray-400 text-xs italic px-1">{result.evaluation.summary}</p>
                    )}
                  </div>
                )}

                {/* Math / Memory / Cognitive per-question review */}
                {!isLlm && isExpanded && (result.questions?.length > 0) && (
                  <div className="mt-2 ml-2 bg-port-bg border border-port-border rounded p-3">
                    <DrillQuestionReview type={result.type} questions={result.questions} drillData={result.drillData} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Save Button */}
      {state === 'complete' && (
        <button
          onClick={handleSave}
          className={`w-full flex items-center justify-center gap-2 px-6 py-3 ${
            isTraining ? 'bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2' : 'bg-port-success hover:bg-port-success/80 text-white'
          } font-medium rounded-lg transition-colors`}
        >
          {isTraining ? <Dumbbell size={18} /> : <Save size={18} />}
          {isTraining ? 'Log Training' : 'Save Session'}
        </button>
      )}

      {state === 'saving' && (
        <div className="text-center text-gray-400 py-3">Saving...</div>
      )}

      {state === 'saved' && (
        <button
          onClick={onBack}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-port-card border border-port-border hover:border-port-accent text-white font-medium rounded-lg transition-colors"
        >
          <ArrowLeft size={18} />
          Back to Launcher
        </button>
      )}
    </div>
  );
}
