import { useState } from 'react';
import { Brain, RefreshCw, AlertCircle } from 'lucide-react';
import * as api from '../../services/api';
import toast from 'react-hot-toast';

const BIG_FIVE_LABELS = {
  O: { name: 'Openness', low: 'Practical', high: 'Curious' },
  C: { name: 'Conscientiousness', low: 'Flexible', high: 'Organized' },
  E: { name: 'Extraversion', low: 'Reserved', high: 'Outgoing' },
  A: { name: 'Agreeableness', low: 'Analytical', high: 'Empathetic' },
  N: { name: 'Neuroticism', low: 'Stable', high: 'Sensitive' }
};

const TRAIT_ORDER = ['O', 'C', 'E', 'A', 'N'];

function getConfidenceColor(confidence) {
  if (confidence >= 0.8) return 'text-green-400';
  if (confidence >= 0.6) return 'text-yellow-400';
  return 'text-gray-400';
}

function getConfidenceBg(confidence) {
  if (confidence >= 0.8) return 'bg-green-500';
  if (confidence >= 0.6) return 'bg-yellow-500';
  return 'bg-gray-500';
}

export default function PersonalityMap({ traits, confidence, providers, onAnalyze }) {
  const [analyzing, setAnalyzing] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState(
    providers?.[0] ? { providerId: providers[0].id, model: providers[0].defaultModel } : null
  );
  const [showDetails, setShowDetails] = useState(false);

  const handleAnalyze = async () => {
    if (!selectedProvider) {
      toast.error('Select a provider first');
      return;
    }
    setAnalyzing(true);
    const result = await api.analyzeDigitalTwinTraits(
      selectedProvider.providerId,
      selectedProvider.model,
      true
    ).catch(e => ({ error: e.message }));

    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success('Traits analyzed successfully');
      onAnalyze?.();
    }
    setAnalyzing(false);
  };

  const bigFive = traits?.bigFive;
  const hasTraits = bigFive && Object.keys(bigFive).length > 0;

  // Get dimension confidence from confidence object
  const getDimensionConfidence = (trait) => {
    const dimensionMap = {
      O: 'openness',
      C: 'conscientiousness',
      E: 'extraversion',
      A: 'agreeableness',
      N: 'neuroticism'
    };
    return confidence?.dimensions?.[dimensionMap[trait]] ?? 0.5;
  };

  // Radar chart calculations
  const centerX = 100;
  const centerY = 100;
  const maxRadius = 80;
  const levels = 5;

  const getPoint = (index, value) => {
    const angle = (Math.PI * 2 * index) / 5 - Math.PI / 2;
    const radius = maxRadius * value;
    return {
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle)
    };
  };

  const radarPoints = hasTraits
    ? TRAIT_ORDER.map((trait, i) => getPoint(i, bigFive[trait] || 0.5))
    : TRAIT_ORDER.map((_, i) => getPoint(i, 0.5));

  const radarPath = radarPoints.map((p, i) =>
    `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`
  ).join(' ') + ' Z';

  return (
    <div className="bg-port-card rounded-lg border border-port-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Brain size={20} />
          Personality Traits
        </h2>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-sm text-port-accent hover:text-white transition-colors"
        >
          {showDetails ? 'Hide Details' : 'Show Details'}
        </button>
      </div>

      {!hasTraits ? (
        <div className="text-center py-8">
          <AlertCircle className="w-12 h-12 text-gray-500 mx-auto mb-4" />
          <p className="text-gray-400 mb-4">
            No personality traits analyzed yet. Run an analysis to extract Big Five traits from your documents.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <select
              value={selectedProvider ? `${selectedProvider.providerId}:${selectedProvider.model}` : ''}
              onChange={(e) => {
                const [providerId, model] = e.target.value.split(':');
                setSelectedProvider({ providerId, model });
              }}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-w-[200px]"
            >
              {providers?.map(p => (
                (p.models || [p.defaultModel]).filter(Boolean).map(model => (
                  <option key={`${p.id}:${model}`} value={`${p.id}:${model}`}>
                    {p.name} - {model}
                  </option>
                ))
              ))}
            </select>
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              className="px-4 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 disabled:opacity-50 flex items-center gap-2"
            >
              {analyzing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Analyzing...
                </>
              ) : (
                'Analyze Traits'
              )}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Radar Chart */}
          <div className="flex-shrink-0 mx-auto lg:mx-0">
            <svg width="200" height="200" viewBox="0 0 200 200" className="overflow-visible">
              {/* Background levels */}
              {Array.from({ length: levels }).map((_, i) => {
                const levelRadius = (maxRadius / levels) * (i + 1);
                const levelPoints = TRAIT_ORDER.map((_, j) => {
                  const angle = (Math.PI * 2 * j) / 5 - Math.PI / 2;
                  return {
                    x: centerX + levelRadius * Math.cos(angle),
                    y: centerY + levelRadius * Math.sin(angle)
                  };
                });
                const path = levelPoints.map((p, j) =>
                  `${j === 0 ? 'M' : 'L'} ${p.x} ${p.y}`
                ).join(' ') + ' Z';
                return (
                  <path
                    key={i}
                    d={path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    className="text-port-border"
                    opacity={0.3}
                  />
                );
              })}

              {/* Axis lines */}
              {TRAIT_ORDER.map((_, i) => {
                const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
                const endX = centerX + maxRadius * Math.cos(angle);
                const endY = centerY + maxRadius * Math.sin(angle);
                return (
                  <line
                    key={i}
                    x1={centerX}
                    y1={centerY}
                    x2={endX}
                    y2={endY}
                    stroke="currentColor"
                    strokeWidth="1"
                    className="text-port-border"
                    opacity={0.3}
                  />
                );
              })}

              {/* Data polygon */}
              <path
                d={radarPath}
                fill="currentColor"
                fillOpacity="0.3"
                stroke="currentColor"
                strokeWidth="2"
                className="text-port-accent"
              />

              {/* Data points */}
              {radarPoints.map((point, i) => {
                const traitConfidence = getDimensionConfidence(TRAIT_ORDER[i]);
                return (
                  <circle
                    key={i}
                    cx={point.x}
                    cy={point.y}
                    r="5"
                    className={getConfidenceBg(traitConfidence)}
                  />
                );
              })}

              {/* Labels */}
              {TRAIT_ORDER.map((trait, i) => {
                const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
                const labelRadius = maxRadius + 20;
                const x = centerX + labelRadius * Math.cos(angle);
                const y = centerY + labelRadius * Math.sin(angle);
                const value = bigFive[trait] || 0.5;
                const traitConfidence = getDimensionConfidence(trait);
                return (
                  <g key={trait}>
                    <text
                      x={x}
                      y={y}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className={`text-xs font-medium fill-current ${getConfidenceColor(traitConfidence)}`}
                    >
                      {trait}
                    </text>
                    <text
                      x={x}
                      y={y + 12}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="text-xs fill-current text-gray-500"
                    >
                      {Math.round(value * 100)}%
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Trait Details */}
          <div className="flex-1 space-y-3">
            {TRAIT_ORDER.map(trait => {
              const value = bigFive[trait] || 0.5;
              const traitConfidence = getDimensionConfidence(trait);
              const label = BIG_FIVE_LABELS[trait];
              return (
                <div key={trait} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-white">{label.name}</span>
                    <span className={`text-sm ${getConfidenceColor(traitConfidence)}`}>
                      {Math.round(value * 100)}%
                    </span>
                  </div>
                  <div className="h-2 bg-port-border rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${getConfidenceBg(traitConfidence)}`}
                      style={{ width: `${value * 100}%`, opacity: 0.7 + (traitConfidence * 0.3) }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>{label.low}</span>
                    <span>{label.high}</span>
                  </div>
                </div>
              );
            })}

            {showDetails && (
              <div className="mt-4 pt-4 border-t border-port-border">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-400">Last analyzed</span>
                  <span className="text-sm text-white">
                    {traits.lastAnalyzed
                      ? new Date(traits.lastAnalyzed).toLocaleDateString()
                      : 'Never'}
                  </span>
                </div>
                <button
                  onClick={handleAnalyze}
                  disabled={analyzing}
                  className="w-full mt-2 px-4 py-2 bg-port-bg border border-port-border text-white rounded-lg text-sm hover:bg-port-border disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {analyzing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Reanalyzing...
                    </>
                  ) : (
                    'Reanalyze Traits'
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
