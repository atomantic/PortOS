import {
  ChevronDown, ChevronRight, Wand2, ArrowUp, ArrowDown, Trash2, Plus,
  CalendarPlus, CalendarX, RefreshCw
} from 'lucide-react';

export default function GoalPlanSection({
  goal, planOpen, setPlanOpen, generatingPhases, handleGeneratePhases,
  proposedPhases, setProposedPhases, handleAcceptPhases,
  schedulingBusy, handleSchedule, handleReschedule, handleRemoveSchedule
}) {
  return (
    <div>
      <button
        onClick={() => setPlanOpen(!planOpen)}
        className="flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-white w-full"
      >
        {planOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Wand2 className="w-3.5 h-3.5" />
        <span>Plan</span>
      </button>
      {planOpen && (
        <div className="mt-2 space-y-2">
          <button
            onClick={handleGeneratePhases}
            disabled={!goal.targetDate || generatingPhases}
            className="w-full px-3 py-1.5 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50 flex items-center justify-center gap-1"
          >
            <Wand2 className="w-3 h-3" />
            {generatingPhases ? 'Generating...' : 'Generate Plan'}
          </button>
          {!goal.targetDate && (
            <p className="text-[10px] text-gray-600">Set a target date first to generate phases</p>
          )}
          {proposedPhases && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-gray-500">{proposedPhases.length} phases proposed</p>
              {proposedPhases.map((phase, idx) => (
                <div key={idx} className="p-2 rounded bg-port-bg border border-port-border space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col gap-0.5">
                      <button
                        onClick={() => {
                          if (idx === 0) return;
                          const next = [...proposedPhases];
                          [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                          next.forEach((p, i) => { p.order = i; });
                          setProposedPhases(next);
                        }}
                        disabled={idx === 0}
                        className="text-gray-600 hover:text-white disabled:opacity-30"
                      >
                        <ArrowUp className="w-2.5 h-2.5" />
                      </button>
                      <button
                        onClick={() => {
                          if (idx === proposedPhases.length - 1) return;
                          const next = [...proposedPhases];
                          [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                          next.forEach((p, i) => { p.order = i; });
                          setProposedPhases(next);
                        }}
                        disabled={idx === proposedPhases.length - 1}
                        className="text-gray-600 hover:text-white disabled:opacity-30"
                      >
                        <ArrowDown className="w-2.5 h-2.5" />
                      </button>
                    </div>
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        value={phase.title}
                        onChange={e => {
                          const next = [...proposedPhases];
                          next[idx] = { ...next[idx], title: e.target.value };
                          setProposedPhases(next);
                        }}
                        className="w-full bg-port-card border border-port-border rounded px-2 py-0.5 text-xs text-white"
                      />
                      <input
                        type="text"
                        value={phase.description || ''}
                        onChange={e => {
                          const next = [...proposedPhases];
                          next[idx] = { ...next[idx], description: e.target.value };
                          setProposedPhases(next);
                        }}
                        placeholder="Description..."
                        className="w-full bg-port-card border border-port-border rounded px-2 py-0.5 text-xs text-gray-400 mt-0.5"
                      />
                    </div>
                    <div className="flex flex-col items-end gap-0.5">
                      <input
                        type="date"
                        value={phase.targetDate}
                        onChange={e => {
                          const next = [...proposedPhases];
                          next[idx] = { ...next[idx], targetDate: e.target.value };
                          setProposedPhases(next);
                        }}
                        className="bg-port-card border border-port-border rounded px-1 py-0.5 text-[10px] text-white"
                      />
                      <button
                        onClick={() => setProposedPhases(proposedPhases.filter((_, i) => i !== idx).map((p, i) => ({ ...p, order: i })))}
                        className="text-gray-600 hover:text-red-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => setProposedPhases([...proposedPhases, { title: '', description: '', targetDate: goal.targetDate, order: proposedPhases.length }])}
                className="text-xs text-port-accent hover:text-blue-300 flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> Add phase
              </button>
              <div className="flex gap-2">
                <button
                  onClick={handleAcceptPhases}
                  className="px-3 py-1.5 text-xs rounded bg-port-accent text-white hover:bg-blue-600"
                >
                  Accept Plan
                </button>
                <button
                  onClick={() => setProposedPhases(null)}
                  className="px-3 py-1.5 text-xs rounded bg-port-border text-gray-300"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          {/* Schedule Controls */}
          {goal.milestones?.length > 0 && goal.timeBlockConfig && (
            <div className="pt-2 border-t border-port-border space-y-2">
              <div className="text-[10px] text-gray-500">
                <CalendarPlus className="w-3 h-3 inline mr-1" />
                {goal.scheduledEvents?.length
                  ? `${goal.scheduledEvents.length} events scheduled`
                  : 'No events scheduled'}
              </div>
              {!goal.scheduledEvents?.length ? (
                <button
                  onClick={handleSchedule}
                  disabled={schedulingBusy}
                  className="w-full px-3 py-1.5 text-xs rounded bg-green-500/20 text-green-400 disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  <CalendarPlus className="w-3 h-3" />
                  {schedulingBusy ? 'Scheduling...' : 'Schedule Time Blocks'}
                </button>
              ) : (
                <div className="flex gap-1">
                  <button
                    onClick={handleReschedule}
                    disabled={schedulingBusy}
                    className="flex-1 px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Reschedule
                  </button>
                  <button
                    onClick={handleRemoveSchedule}
                    disabled={schedulingBusy}
                    className="px-2 py-1 text-xs rounded bg-red-500/20 text-red-400 disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    <CalendarX className="w-3 h-3" />
                    Remove
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
