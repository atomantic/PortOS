import { useState } from 'react';
import { Gauge, RefreshCw, TrendingUp, TrendingDown } from 'lucide-react';
import * as api from '../../services/api';
import toast from 'react-hot-toast';

const DIMENSION_LABELS = {
  openness: 'Openness',
  conscientiousness: 'Conscientiousness',
  extraversion: 'Extraversion',
  agreeableness: 'Agreeableness',
  neuroticism: 'Neuroticism',
  values: 'Values',
  communication: 'Communication',
  decision_making: 'Decision Making',
  boundaries: 'Boundaries',
  identity: 'Identity'
};

const DIMENSION_ICONS = {
  openness: '🎨',
  conscientiousness: '📋',
  extraversion: '👥',
  agreeableness: '🤝',
  neuroticism: '💭',
  values: '⭐',
  communication: '💬',
  decision_making: '🎯',
  boundaries: '🛡️',
  identity: '🪪'
};

function getConfidenceColor(score) {
  if (score >= 0.8) return { text: 'text-green-400', bg: 'bg-green-500', border: 'border-green-500/30' };
  if (score >= 0.6) return { text: 'text-yellow-400', bg: 'bg-yellow-500', border: 'border-yellow-500/30' };
  return { text: 'text-red-400', bg: 'bg-red-500', border: 'border-red-500/30' };
}

function getConfidenceLabel(score) {
  if (score >= 0.8) return 'Strong';
  if (score >= 0.6) return 'Moderate';
  return 'Needs Work';
}

export default function ConfidenceGauge({ confidence, onRecalculate }) {
  const [calculating, setCalculating] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const handleRecalculate = async () => {
    setCalculating(true);
    const result = await api.calculateDigitalTwinConfidence().catch(e => ({ error: e.message }));
    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success('Confidence recalculated');
      onRecalculate?.();
    }
    setCalculating(false);
  };

  const overall = confidence?.overall ?? 0;
  const dimensions = confidence?.dimensions ?? {};
  const overallColor = getConfidenceColor(overall);

  // Sort dimensions by score (lowest first for attention)
  const sortedDimensions = Object.entries(dimensions)
    .sort((a, b) => a[1] - b[1]);

  const displayDimensions = showAll ? sortedDimensions : sortedDimensions.slice(0, 5);

  return (
    <div className="bg-port-card rounded-lg border border-port-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Gauge size={20} />
          Twin Confidence
        </h2>
        <button
          onClick={handleRecalculate}
          disabled={calculating}
          className="text-sm text-port-accent hover:text-white transition-colors flex items-center gap-1"
        >
          {calculating ? (
            <>
              <RefreshCw className="w-3 h-3 animate-spin" />
              Calculating...
            </>
          ) : (
            'Recalculate'
          )}
        </button>
      </div>

      {/* Overall Score */}
      <div className="flex items-center gap-6 mb-6">
        <div className="relative w-24 h-24 flex-shrink-0">
          <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
            <circle
              cx="50"
              cy="50"
              r="40"
              stroke="currentColor"
              strokeWidth="8"
              fill="none"
              className="text-port-border"
            />
            <circle
              cx="50"
              cy="50"
              r="40"
              stroke="currentColor"
              strokeWidth="8"
              fill="none"
              strokeDasharray={`${overall * 251.2} 251.2`}
              strokeLinecap="round"
              className={overallColor.text}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-xl font-bold ${overallColor.text}`}>
              {Math.round(overall * 100)}%
            </span>
          </div>
        </div>

        <div className="flex-1">
          <div className={`text-lg font-semibold ${overallColor.text}`}>
            {getConfidenceLabel(overall)}
          </div>
          <p className="text-sm text-gray-400 mt-1">
            {overall >= 0.8
              ? 'Your digital twin is well-defined and ready for use.'
              : overall >= 0.6
              ? 'Good foundation, but some areas need more detail.'
              : 'More enrichment needed for accurate personality modeling.'}
          </p>
          {confidence?.lastCalculated && (
            <p className="text-xs text-gray-500 mt-2">
              Last calculated: {new Date(confidence.lastCalculated).toLocaleString()}
            </p>
          )}
        </div>
      </div>

      {/* Dimension Breakdown */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm text-gray-400 mb-2">
          <span>Dimensions</span>
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-port-accent hover:text-white transition-colors"
          >
            {showAll ? 'Show Less' : `Show All (${sortedDimensions.length})`}
          </button>
        </div>

        {displayDimensions.map(([dimension, score]) => {
          const color = getConfidenceColor(score);
          const label = DIMENSION_LABELS[dimension] || dimension;
          const icon = DIMENSION_ICONS[dimension] || '📊';
          const isLow = score < 0.6;

          return (
            <div
              key={dimension}
              className={`flex items-center gap-3 p-2 rounded-lg ${
                isLow ? 'bg-red-500/5 border border-red-500/20' : ''
              }`}
            >
              <span className="text-lg">{icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white truncate">{label}</span>
                  <span className={`text-sm font-medium ${color.text}`}>
                    {Math.round(score * 100)}%
                  </span>
                </div>
                <div className="h-1.5 bg-port-border rounded-full overflow-hidden mt-1">
                  <div
                    className={`h-full transition-all ${color.bg}`}
                    style={{ width: `${score * 100}%` }}
                  />
                </div>
              </div>
              {isLow && (
                <TrendingDown className="w-4 h-4 text-red-400 flex-shrink-0" />
              )}
              {score >= 0.8 && (
                <TrendingUp className="w-4 h-4 text-green-400 flex-shrink-0" />
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-4 pt-4 border-t border-port-border text-xs">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-gray-400">Strong (80%+)</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-yellow-500" />
          <span className="text-gray-400">Moderate (60-79%)</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-red-500" />
          <span className="text-gray-400">Needs Work (&lt;60%)</span>
        </div>
      </div>
    </div>
  );
}
