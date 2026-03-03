import { CheckCircle, Save, ArrowLeft } from 'lucide-react';

const DRILL_LABELS = {
  'doubling-chain': 'Doubling Chain',
  'serial-subtraction': 'Serial Subtraction',
  'multiplication': 'Multiplication',
  'powers': 'Powers',
  'estimation': 'Estimation'
};

export default function PostSessionResults({ session, tags = {}, onSaved, onBack }) {
  const { drillResults, sessionScore, state, saveSession } = session;

  const scoreColor = sessionScore >= 80 ? 'text-port-success' :
    sessionScore >= 50 ? 'text-port-warning' : 'text-port-error';

  async function handleSave() {
    await saveSession(tags);
    onSaved();
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Overall Score */}
      <div className="text-center py-8">
        <div className="flex items-center justify-center gap-3 mb-2">
          <CheckCircle size={28} className={scoreColor} />
          <span className="text-sm text-gray-400">Session Score</span>
        </div>
        <div className={`text-6xl font-mono font-bold ${scoreColor}`}>
          {sessionScore}
        </div>
      </div>

      {/* Per-drill Breakdown */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Drill Breakdown</h3>
        <div className="space-y-3">
          {drillResults.map((result, i) => {
            const correct = result.questions.filter(q => q.correct).length;
            const total = result.questions.length;
            const accuracyPct = total > 0 ? Math.round((correct / total) * 100) : 0;
            const answered = result.questions.filter(q => q.answered !== null);
            const avgMs = answered.length > 0
              ? Math.round(answered.reduce((s, q) => s + q.responseMs, 0) / answered.length)
              : 0;

            const drillScoreColor = result.score >= 80 ? 'text-port-success' :
              result.score >= 50 ? 'text-port-warning' : 'text-port-error';

            return (
              <div key={i} className="flex items-center justify-between">
                <div>
                  <span className="text-white text-sm">{DRILL_LABELS[result.type] || result.type}</span>
                  <span className="text-gray-500 text-xs ml-2">
                    {accuracyPct}% accuracy · {(avgMs / 1000).toFixed(1)}s avg
                  </span>
                </div>
                <span className={`font-mono font-medium ${drillScoreColor}`}>
                  {result.score}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Save Button */}
      {state === 'complete' && (
        <button
          onClick={handleSave}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-port-success hover:bg-port-success/80 text-white font-medium rounded-lg transition-colors"
        >
          <Save size={18} />
          Save Session
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
