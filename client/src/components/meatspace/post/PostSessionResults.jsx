import { Save, ArrowLeft, Dumbbell } from 'lucide-react';
import PostSessionSummary from './PostSessionSummary';

export default function PostSessionResults({ session, tags = {}, onSaved, onBack }) {
  const { drillResults, sessionScore, state, saveSession, isTraining } = session;

  async function handleSave() {
    const savedSession = await saveSession(tags);
    if (savedSession) onSaved(savedSession);
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PostSessionSummary drillResults={drillResults} sessionScore={sessionScore} isTraining={isTraining} />

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
