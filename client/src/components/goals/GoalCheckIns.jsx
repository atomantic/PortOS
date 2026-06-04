import { ChevronDown, ChevronRight, ClipboardCheck, Wand2 } from 'lucide-react';
import Pill from '../ui/Pill';
import { CHECK_IN_STATUS_CONFIG, CHECK_IN_DOT_COLORS } from './goalConstants';

export default function GoalCheckIns({
  goal, checkInsOpen, setCheckInsOpen, checkingIn, handleCheckIn
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setCheckInsOpen(!checkInsOpen)}
          className="flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-white"
        >
          {checkInsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <ClipboardCheck className="w-3.5 h-3.5" />
          <span>Check-ins ({goal.checkIns?.length || 0})</span>
          {goal.checkIns?.length > 0 && (() => {
            const latest = goal.checkIns[goal.checkIns.length - 1];
            return <span className={`ml-1 w-2 h-2 rounded-full ${CHECK_IN_DOT_COLORS[latest.status] || 'bg-gray-500'}`} />;
          })()}
        </button>
        {goal.status === 'active' && (
          <button
            onClick={handleCheckIn}
            disabled={checkingIn}
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 disabled:opacity-50"
          >
            <Wand2 className={`w-3 h-3 ${checkingIn ? 'animate-spin' : ''}`} />
            {checkingIn ? 'Checking in...' : 'Run Check-In'}
          </button>
        )}
      </div>
      {checkInsOpen && goal.checkIns?.length > 0 && (
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {[...goal.checkIns].reverse().map(ci => {
            const sc = CHECK_IN_STATUS_CONFIG[ci.status] || CHECK_IN_STATUS_CONFIG['behind'];
            return (
              <div key={ci.id} className="p-2 rounded bg-port-bg border border-port-border space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-500">{new Date(ci.date + 'T00:00:00').toLocaleDateString()}</span>
                  <Pill tone="bare" size="xs" bordered={false} className={`${sc.bg} ${sc.color}`}>{sc.label}</Pill>
                </div>
                <div className="text-[10px] text-gray-500">
                  Progress: {ci.actualProgress}%{ci.expectedProgress != null && ` / ${ci.expectedProgress}% expected`}
                  {ci.attendanceRate != null && ` · ${ci.attendanceRate}% activity`}
                </div>
                {ci.assessment && <p className="text-xs text-gray-300">{ci.assessment}</p>}
                {ci.recommendations?.length > 0 && (
                  <ul className="text-[10px] text-gray-400 list-disc pl-3 space-y-0.5">
                    {ci.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
                {ci.encouragement && (
                  <p className="text-[10px] text-port-accent italic">{ci.encouragement}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
