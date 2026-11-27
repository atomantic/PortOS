import { CheckCircle2, Circle } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';

export default function InstallStageList({ stages, installing, installingStage, progressMsg, testIdPrefix, gridClass, ariaLabel }) {
  const currentStageId = installingStage || (installing ? stages.find((stage) => !stage.ready)?.id : null);

  return (
    <ol className={`grid ${gridClass} gap-2 list-none p-0`} aria-label={ariaLabel}>
      {stages.map((stage) => {
        const current = installing && currentStageId === stage.id;
        const waiting = installing && !stage.ready && currentStageId && currentStageId !== stage.id;
        return (
          <li
            key={stage.id}
            data-testid={`${testIdPrefix}-${stage.id}`}
            data-ready={stage.ready ? 'true' : 'false'}
            className="flex items-start gap-2 rounded-lg border border-port-border/70 bg-port-bg/40 px-3 py-2"
          >
            <span className="mt-0.5 shrink-0" aria-hidden="true">
              {stage.ready ? (
                <CheckCircle2 size={14} className="text-port-success" />
              ) : current ? (
                <BrailleSpinner />
              ) : (
                <Circle size={14} className={waiting ? 'text-gray-600' : 'text-port-warning'} />
              )}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs font-medium text-white">{stage.label}</p>
                <span className={`text-[11px] ${stage.ready ? 'text-port-success' : current ? 'text-gray-300' : 'text-gray-500'}`}>
                  {stage.ready ? 'Ready' : current ? 'Installing…' : waiting ? 'Waiting' : 'Not ready'}
                </span>
              </div>
              <details className="mt-1 text-xs text-gray-400">
                <summary className="cursor-pointer hover:text-port-accent">Details</summary>
                <p className="mt-1 leading-relaxed">{stage.description}</p>
              </details>
              {stage.id === 'python' && !stage.ready && (
                <a href="https://www.python.org/downloads/" target="_blank" rel="noopener noreferrer" className="text-xs text-port-accent hover:underline">Install Python, then refresh status</a>
              )}
              {current && progressMsg && <p className="text-[11px] text-gray-400 mt-1">{progressMsg}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
