import { Gauge } from 'lucide-react';
import Pill from '../ui/Pill';
import ProgressBar from '../ui/ProgressBar';

/**
 * Renders one autobiography story's storytelling-craft score: the seven moves
 * with a meter and a concrete revision suggestion each, the CART structure as
 * present/absent chips, and the single highest-leverage rewrite.
 *
 * The rubric lives server-side (`server/lib/storytellingCraft.js`) and the
 * evaluation carries its own `label` per row, so adding a move there shows up
 * here with no edit — this component renders whatever rows it is handed.
 */
export default function StoryCraftPanel({ evaluation }) {
  if (!evaluation) return null;

  return (
    <div className="mt-3 bg-port-bg border border-emerald-500/30 rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Gauge size={14} className="text-emerald-400" />
        <span className="text-sm font-medium text-emerald-300">
          Storytelling craft: {evaluation.overallScore}/{evaluation.maxScore}
        </span>
        {evaluation.answersQuestion === false && (
          <Pill tone="warning">Doesn&apos;t answer its question yet</Pill>
        )}
      </div>

      <div className="space-y-2">
        {evaluation.moves?.map((move) => (
          <div key={move.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-300">{move.label}</span>
              <span className="text-xs text-gray-500 shrink-0">
                {move.score}/{evaluation.maxScore}
              </span>
            </div>
            <ProgressBar
              percent={(move.score / evaluation.maxScore) * 100}
              tone="success"
              track="border"
              label={`${move.label} score`}
            />
            {move.evidence && (
              <p className="text-xs text-gray-500">{move.evidence}</p>
            )}
            {move.suggestion && (
              <p className="text-xs text-gray-400">
                <span className="text-emerald-300/80">Try: </span>
                {move.suggestion}
              </p>
            )}
          </div>
        ))}
      </div>

      {evaluation.cart?.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {evaluation.cart.map((stage) => (
              <Pill key={stage.id} tone={stage.present ? 'success' : 'note'}>
                {stage.label}
              </Pill>
            ))}
          </div>
          {/* A MISSING stage's note is the actionable half of CART, so it
              renders as text rather than only a `title` — a tooltip is
              unreachable on touch, which is where this gets read. A present
              stage's note is just confirmation and stays out of the way. */}
          {evaluation.cart.filter((s) => !s.present && s.note).map((stage) => (
            <p key={stage.id} className="text-xs text-gray-500">
              <span className="text-gray-400">{stage.label}: </span>
              {stage.note}
            </p>
          ))}
        </div>
      )}

      {evaluation.revision && (
        <p className="text-xs text-gray-400 leading-relaxed">
          <span className="text-emerald-300">Next revision: </span>
          {evaluation.revision}
        </p>
      )}
    </div>
  );
}
