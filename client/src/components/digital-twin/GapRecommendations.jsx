import { useNavigate } from 'react-router-dom';
import { Lightbulb, ChevronRight, MessageCircle, ArrowRight } from 'lucide-react';

const CATEGORY_LABELS = {
  core_memories: 'Core Memories',
  favorite_books: 'Favorite Books',
  favorite_movies: 'Favorite Movies',
  music_taste: 'Music Taste',
  communication: 'Communication',
  decision_making: 'Decision Making',
  values: 'Values',
  aesthetics: 'Aesthetics',
  daily_routines: 'Daily Routines',
  career_skills: 'Career/Skills',
  non_negotiables: 'Non-Negotiables',
  decision_heuristics: 'Decision Heuristics',
  error_intolerance: 'Error Intolerance',
  personality_assessments: 'Personality Assessments'
};

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

function getUrgencyColor(confidence) {
  if (confidence < 0.3) return 'border-red-500/50 bg-red-500/10';
  if (confidence < 0.5) return 'border-orange-500/50 bg-orange-500/10';
  return 'border-yellow-500/50 bg-yellow-500/10';
}

function getUrgencyLabel(confidence) {
  if (confidence < 0.3) return { text: 'Critical', color: 'text-red-400' };
  if (confidence < 0.5) return { text: 'Important', color: 'text-orange-400' };
  return { text: 'Suggested', color: 'text-yellow-400' };
}

export default function GapRecommendations({ gaps, maxDisplay = 3 }) {
  const navigate = useNavigate();

  if (!gaps || gaps.length === 0) {
    return (
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center gap-2 mb-4">
          <Lightbulb size={20} className="text-green-400" />
          <h2 className="text-lg font-semibold text-white">Enrichment Complete!</h2>
        </div>
        <p className="text-gray-400">
          Your digital twin has strong confidence across all dimensions.
          Consider running behavioral tests to validate accuracy.
        </p>
        <button
          onClick={() => navigate('/digital-twin/test')}
          className="mt-4 px-4 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 flex items-center gap-2"
        >
          Run Tests
          <ArrowRight size={16} />
        </button>
      </div>
    );
  }

  const displayGaps = gaps.slice(0, maxDisplay);
  const hasMore = gaps.length > maxDisplay;

  return (
    <div className="bg-port-card rounded-lg border border-port-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Lightbulb size={20} className="text-yellow-400" />
          Recommended Enrichment
        </h2>
        {hasMore && (
          <span className="text-sm text-gray-400">
            +{gaps.length - maxDisplay} more
          </span>
        )}
      </div>

      <p className="text-sm text-gray-400 mb-4">
        These areas need more detail for accurate personality modeling.
      </p>

      <div className="space-y-3">
        {displayGaps.map((gap, index) => {
          const urgency = getUrgencyLabel(gap.confidence);
          const dimensionLabel = DIMENSION_LABELS[gap.dimension] || gap.dimension;
          const categoryLabel = CATEGORY_LABELS[gap.suggestedCategory] || gap.suggestedCategory;

          return (
            <div
              key={gap.dimension}
              className={`p-4 rounded-lg border ${getUrgencyColor(gap.confidence)}`}
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">{dimensionLabel}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${urgency.color} bg-black/20`}>
                      {urgency.text}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {gap.evidenceCount}/{gap.requiredEvidence} evidence points • {Math.round(gap.confidence * 100)}% confidence
                  </div>
                </div>
                <button
                  onClick={() => navigate(`/digital-twin/enrich?category=${gap.suggestedCategory}`)}
                  className="flex items-center gap-1 text-sm text-port-accent hover:text-white transition-colors"
                >
                  Enrich
                  <ChevronRight size={14} />
                </button>
              </div>

              {gap.suggestedQuestions && gap.suggestedQuestions.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="text-xs text-gray-400 flex items-center gap-1">
                    <MessageCircle size={12} />
                    Suggested questions:
                  </div>
                  <ul className="space-y-1">
                    {gap.suggestedQuestions.slice(0, 2).map((question, qi) => (
                      <li
                        key={qi}
                        className="text-sm text-gray-300 pl-4 border-l border-port-border"
                      >
                        "{question}"
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {gap.suggestedCategory && (
                <div className="mt-2 text-xs text-gray-500">
                  Best enrichment category: <span className="text-gray-400">{categoryLabel}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        onClick={() => navigate(`/digital-twin/enrich?category=${gaps[0]?.suggestedCategory || ''}`)}
        className="w-full mt-4 px-4 py-3 bg-port-accent/20 border border-port-accent/50 text-port-accent rounded-lg text-sm hover:bg-port-accent/30 transition-colors flex items-center justify-center gap-2"
      >
        Start Enrichment Session
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
