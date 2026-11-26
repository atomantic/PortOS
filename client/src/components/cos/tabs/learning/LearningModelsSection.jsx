import { Zap, ChevronDown, ChevronRight } from 'lucide-react';
import { pluralize } from '../../../../lib/textUtils';
import { getSuccessRateColor, getSuccessRateBg } from './learningPresentation';

export default function LearningModelsSection({ models, expanded, onToggle }) {
  if (!models?.length) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left mb-3"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <Zap size={16} className="text-yellow-400" />
        <span className="font-medium text-white">Model Performance</span>
        <span className="text-xs text-gray-500">
          ({models.length} tiers)
        </span>
      </button>
      {expanded && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {models.map((model, idx) => {
            const tierLabels = {
              'light': { label: 'Haiku', desc: 'Fast, simple tasks' },
              'medium': { label: 'Sonnet', desc: 'Balanced performance' },
              'heavy': { label: 'Opus', desc: 'Complex tasks' },
              'user-specified': { label: 'User Selected', desc: 'Manual override' }
            };
            const info = tierLabels[model.tier] || { label: model.tier, desc: '' };

            return (
              <div key={idx} className="bg-port-card border border-port-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-white">{info.label}</span>
                  <span className={`text-lg font-bold ${getSuccessRateColor(model.successRate)}`}>
                    {model.successRate}%
                  </span>
                </div>
                <div className="w-full bg-port-border rounded-full h-2 mb-2">
                  <div
                    className={`h-2 rounded-full ${getSuccessRateBg(model.successRate)}`}
                    style={{ width: `${model.successRate}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-500">
                  <span>{info.desc}</span>
                  <span>{pluralize(model.completed, 'task')} • {model.avgDurationMin}m avg</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
