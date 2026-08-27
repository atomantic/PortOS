import { ArrowLeft } from 'lucide-react';
import PostSessionSummary from './PostSessionSummary';
import PostCompletionActions from './PostCompletionActions';

export default function PostSessionResults({ session, conditions = {}, onSaved, onBack }) {
  const { drillResults, sessionScore, state, saveSession, isTraining, sessionPlan, benchmark, savedSession } = session;

  async function handleSave(continueDaily) {
    const savedSession = await saveSession(conditions);
    if (savedSession) onSaved(savedSession, { continueDaily });
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PostSessionSummary
        drillResults={drillResults}
        sessionScore={sessionScore}
        isTraining={isTraining}
        plan={sessionPlan}
        actualDurationMs={savedSession?.actualDurationMs}
        initialExpandedDrill={drillResults?.findIndex(result => result.type === 'digit-span') ?? -1}
      />

      {benchmark && (
        <p className="text-center text-xs text-gray-500">
          Fixed benchmark · form {benchmark.formId.toUpperCase()} · protocol v{benchmark.protocolVersion}
        </p>
      )}

      {/* Every completed assessment offers the same explicit daily-routine fork. */}
      {state === 'complete' && (
        <PostCompletionActions
          saveLabel={isTraining ? 'Log Training' : 'Save Session'}
          onSave={() => handleSave(false)}
          onContinue={() => handleSave(true)}
        />
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
