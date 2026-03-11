import { useState, useEffect } from 'react';
import { ChevronRight, Calculator, BookOpen, MessageCircle, Mic, Sparkles } from 'lucide-react';
import { DOMAINS, DRILL_TO_DOMAIN } from './constants';

const DOMAIN_ICONS = {
  math: Calculator,
  memory: BookOpen,
  wordplay: MessageCircle,
  verbal: Mic,
  imagination: Sparkles,
};

const DRILL_LABELS = {
  'doubling-chain': 'Doubling Chain',
  'serial-subtraction': 'Serial Subtraction',
  'multiplication': 'Multiplication',
  'powers': 'Powers',
  'estimation': 'Estimation',
  'word-association': 'Word Association',
  'story-recall': 'Story Recall',
  'verbal-fluency': 'Verbal Fluency',
  'wit-comeback': 'Wit & Comeback',
  'pun-wordplay': 'Pun & Wordplay',
  'memory-fill-blank': 'Memory Fill Blank',
  'memory-sequence': 'Memory Sequence',
  'memory-element-flash': 'Element Flash',
  'what-if': 'What If?',
  'alternative-uses': 'Alternative Uses',
  'story-prompt': 'Story Prompt',
  'invention-pitch': 'Invention Pitch',
  'reframe': 'Reframe',
};

export default function DrillTransition({ nextDrillType, drillIndex, drillCount, completedResults, onContinue }) {
  const [countdown, setCountdown] = useState(3);

  const domainKey = DRILL_TO_DOMAIN[nextDrillType];
  const domain = domainKey ? DOMAINS[domainKey] : null;
  const Icon = domainKey ? DOMAIN_ICONS[domainKey] : ChevronRight;

  // Auto-advance after 3 seconds
  useEffect(() => {
    if (countdown <= 0) {
      onContinue();
      return;
    }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, onContinue]);

  return (
    <div className="max-w-lg mx-auto space-y-8">
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

      {/* Continue button with countdown */}
      <button
        onClick={onContinue}
        className="w-full px-6 py-3 bg-port-accent hover:bg-port-accent/80 text-white font-medium rounded-lg transition-colors"
      >
        Continue {countdown > 0 ? `(${countdown})` : ''}
      </button>
    </div>
  );
}
