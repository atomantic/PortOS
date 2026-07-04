import { useState, useEffect } from 'react';
import { ChevronRight, Calculator, BookOpen, MessageCircle, Mic, Sparkles, Pause, Play } from 'lucide-react';
import { DOMAINS, DRILL_TO_DOMAIN, DRILL_LABELS } from './constants';

const DOMAIN_ICONS = {
  math: Calculator,
  memory: BookOpen,
  wordplay: MessageCircle,
  verbal: Mic,
  imagination: Sparkles,
};

export default function DrillTransition({ nextDrillType, drillIndex, drillCount, completedResults, onContinue }) {
  const [countdown, setCountdown] = useState(3);
  // Explicit user pause (Pause/Resume button) vs. transient hover/focus pause —
  // tracked separately so releasing one doesn't silently un-pause another.
  // Hover and focus are ALSO tracked independently of each other (not
  // collapsed into one boolean): a mouseleave while a control inside the
  // card still holds keyboard focus must not resume the countdown, and vice
  // versa for blur while the mouse is still over the card. Any of the three
  // being true halts the countdown.
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [hoveringMouse, setHoveringMouse] = useState(false);
  const [hoveringFocus, setHoveringFocus] = useState(false);
  const paused = manuallyPaused || hoveringMouse || hoveringFocus;

  const domainKey = DRILL_TO_DOMAIN[nextDrillType];
  const domain = domainKey ? DOMAINS[domainKey] : null;
  const Icon = domainKey ? DOMAIN_ICONS[domainKey] : ChevronRight;

  // Auto-advance after 3 seconds, unless paused (manually or via hover/focus).
  useEffect(() => {
    if (paused) return;
    if (countdown <= 0) {
      onContinue();
      return;
    }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, paused, onContinue]);

  return (
    <div
      className="max-w-lg mx-auto space-y-8"
      onMouseEnter={() => setHoveringMouse(true)}
      onMouseLeave={() => setHoveringMouse(false)}
      onFocus={() => setHoveringFocus(true)}
      onBlur={(e) => {
        // Only clear focus-pause once focus has left the whole transition card,
        // not just the individual button — a Tab between the Pause and Continue
        // buttons shouldn't flicker the countdown back on mid-transition. This
        // is independent of hoveringMouse, so leaving the card with the mouse
        // while a control still holds focus (or vice versa) can't resume it.
        if (!e.currentTarget.contains(e.relatedTarget)) setHoveringFocus(false);
      }}
    >
      {/* Completed domains summary */}
      {completedResults.length > 0 && (
        <div className="flex justify-center gap-3">
          {completedResults.map((r, i) => {
            const dk = DRILL_TO_DOMAIN[r.type];
            const d = dk ? DOMAINS[dk] : null;
            const sc = (r.score || 0) >= 80 ? 'text-port-success' : (r.score || 0) >= 50 ? 'text-port-warning' : 'text-port-error';
            return (
              <div key={i} className="flex flex-col items-center gap-1">
                <span className={`text-xs ${d?.color || 'text-gray-400'}`}>{d?.label || r.type}</span>
                <span className={`text-sm font-mono font-medium ${sc}`}>{r.score ?? '—'}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Next domain card */}
      <div className="text-center py-8">
        <div className={`inline-flex items-center justify-center w-16 h-16 rounded-2xl ${domain?.bgColor || 'bg-port-card'} mb-4`}>
          <Icon size={32} className={domain?.color || 'text-gray-400'} />
        </div>
        <div className="text-sm text-gray-500 mb-1">Up Next</div>
        <div className={`text-2xl font-bold ${domain?.color || 'text-white'}`}>
          {domain?.label || 'Next Drill'}
        </div>
        <div className="text-sm text-gray-500 mt-1">
          {DRILL_LABELS[nextDrillType] || nextDrillType}
        </div>
      </div>

      {/* Progress */}
      <div className="flex justify-center gap-2">
        {Array.from({ length: drillCount }, (_, i) => (
          <div
            key={i}
            className={`w-3 h-3 rounded-full ${
              i < drillIndex ? 'bg-port-success' :
              i === drillIndex ? 'bg-port-accent animate-pulse' :
              'bg-port-border'
            }`}
          />
        ))}
      </div>

      {/* Pause/Resume + Continue now controls */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(e) => {
            setManuallyPaused(p => !p);
            // Many browsers (Chrome/Edge, Windows Firefox) keep focus on a
            // <button> after a click, which would otherwise leave
            // hoveringFocus=true forever — so clicking "Resume" would never
            // actually resume (paused still true via hoveringFocus even
            // after manuallyPaused flips off). Blur has relatedTarget=null,
            // which the card's onBlur handler treats as "focus left the
            // card", clearing hoveringFocus so paused can go false again.
            e.currentTarget.blur();
          }}
          aria-pressed={manuallyPaused}
          className="flex items-center gap-1.5 px-4 py-3 bg-port-card border border-port-border hover:border-port-accent text-gray-300 text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          {manuallyPaused ? <Play size={16} /> : <Pause size={16} />}
          {manuallyPaused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="flex-1 px-6 py-3 bg-port-accent hover:bg-port-accent/80 text-white font-medium rounded-lg transition-colors"
        >
          Continue now {!paused && countdown > 0 ? `(${countdown})` : ''}
        </button>
      </div>
      {paused && (
        <p className="text-center text-xs text-gray-500">
          {manuallyPaused ? 'Paused' : 'Paused — hover or focus'} · auto-advance stopped
        </p>
      )}
    </div>
  );
}
