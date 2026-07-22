import { AlertCircle, Wand2, Loader2, Lock } from 'lucide-react';
import { SEVERITY_COLORS } from './shared.js';

export default function VerifyResults({ issues, onDismiss, onResolveAll, onResolveOne, resolvingAll, resolvingIdx, title = 'Verification', lockedNote = null }) {
  const busy = resolvingAll || (resolvingIdx && resolvingIdx.size > 0);
  return (
    <div className="border border-port-border rounded p-3 bg-port-bg/50 space-y-2">
      {lockedNote ? (
        <p className="text-[11px] text-port-warning italic flex items-center gap-1.5">
          <Lock size={11} /> {lockedNote}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-xs uppercase tracking-wider text-gray-500">{title} — {issues.length} issue{issues.length === 1 ? '' : 's'}</h3>
        <div className="flex items-center gap-2">
          {onResolveAll ? (
            <button
              type="button"
              onClick={onResolveAll}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border bg-port-accent/10 text-port-accent border-port-accent/40 hover:bg-port-accent/20 disabled:opacity-40"
              title="Run an LLM pass that rewrites the arc to resolve every finding"
            >
              {resolvingAll ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              Resolve all
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="text-xs text-gray-400 hover:text-white disabled:opacity-40"
          >
            Dismiss
          </button>
        </div>
      </div>
      <ul className="space-y-2">
        {issues.map((iss, i) => {
          const resolvingThis = resolvingIdx && resolvingIdx.has(i);
          return (
            <li key={i} className={`text-xs p-2 rounded border ${SEVERITY_COLORS[iss.severity] || SEVERITY_COLORS.medium}`}>
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle size={12} />
                <span className="uppercase tracking-wider font-semibold">{iss.severity}</span>
                {iss.location ? <span className="text-gray-500">— {iss.location}</span> : null}
                {onResolveOne ? (
                  <button
                    type="button"
                    onClick={() => onResolveOne(i, iss)}
                    disabled={busy}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border border-port-border bg-port-bg text-gray-300 hover:text-white hover:border-port-accent/40 disabled:opacity-40"
                    title="Run an LLM pass that rewrites the arc to resolve only this finding"
                  >
                    {resolvingThis ? <Loader2 size={10} className="animate-spin" /> : <Wand2 size={10} />}
                    Resolve
                  </button>
                ) : null}
              </div>
              <p className="text-gray-200">{iss.problem}</p>
              {iss.suggestion ? <p className="mt-1 text-gray-400 italic">→ {iss.suggestion}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
